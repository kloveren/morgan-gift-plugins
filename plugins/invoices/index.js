/**
 * Invoices plugin -- secure invoices, receipts, and wallet verification on TON.
 *
 * Tools:
 *   inv_begin_verification   - create wallet ownership verification challenge
 *   inv_confirm_verification - confirm verification by on-chain proof
 *   inv_register_agent       - alias of inv_begin_verification (safe)
 *   inv_create               - create an invoice + TON deep links
 *   inv_check                - verify payment on-chain via cached indexer
 *   inv_receipt              - generate a receipt for a paid invoice
 */

import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const _require = createRequire(realpathSync(process.argv[1]));
let Address = null;
try {
  ({ Address } = _require("@ton/core"));
} catch {
  Address = null;
}

export const manifest = {
  name: "invoices",
  version: "1.0.0",
};

const WALLET_FILE = join(homedir(), ".teleton", "wallet.json");
const CONFIG_FILE = join(homedir(), ".teleton", "config.yaml");
const API_BASE = "https://tonapi.io";

const VERIFY_DEFAULT_TON = "0.01";
const VERIFY_TTL_MINUTES = 60;

const EVENT_PAGE_LIMIT = 50;
const EVENT_MAX_PAGES_NEW = 3;
const EVENT_MAX_PAGES_OLD = 6;
const SYNC_MIN_INTERVAL_MS = 3000;

const RATE_DEFAULT_WINDOW_MS = 60000;
const RATE_DEFAULT_MAX = 60;
const RATE_TOOL_DEFAULTS = {
  inv_begin_verification: 10,
  inv_confirm_verification: 10,
  inv_register_agent: 10,
  inv_create: 20,
  inv_check: 20,
  inv_receipt: 30,
};

const CONFIG_CACHE_MS = 5000;
let cachedConfigRaw = null;
let cachedConfigAt = 0;

function loadApiKey() {
  if (process.env.TONAPI_KEY) return process.env.TONAPI_KEY;
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const match = raw.match(/^tonapi_key:\s*"?([^"\n]+)"?/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

const API_KEY = loadApiKey();
const RATE_LIMIT_MS = API_KEY ? 1000 : 4000;
let lastRequestTime = 0;

function loadConfigRaw() {
  const now = Date.now();
  if (cachedConfigRaw && now - cachedConfigAt < CONFIG_CACHE_MS) return cachedConfigRaw;
  try {
    cachedConfigRaw = readFileSync(CONFIG_FILE, "utf-8");
  } catch {
    cachedConfigRaw = null;
  }
  cachedConfigAt = now;
  return cachedConfigRaw;
}

function getConfigValue(key) {
  const raw = loadConfigRaw();
  if (!raw) return null;
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const match = raw.match(re);
  if (!match) return null;
  return match[1].trim().replace(/^"|"$/g, "");
}

function getConfigBool(key) {
  const val = getConfigValue(key);
  if (!val) return null;
  const v = val.toLowerCase();
  if (["true", "yes", "1"].includes(v)) return true;
  if (["false", "no", "0"].includes(v)) return false;
  return null;
}

function getConfigNumber(key) {
  const val = getConfigValue(key);
  if (!val) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function parseIdList(value) {
  if (!value) return [];
  const cleaned = value.replace(/[\[\]]/g, "");
  const parts = cleaned.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
  return parts
    .map((p) => Number(p))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function getAccessPolicy(context) {
  const adminIds = context.config?.telegram?.admin_ids ?? [];
  const ctxAllowlist = context.config?.invoices?.allowlist ?? null;
  const ctxMode = context.config?.invoices?.access ?? context.config?.invoices?.mode ?? null;

  const fileAllowlist = parseIdList(getConfigValue("invoices_allowlist"));
  const adminOnly = getConfigBool("invoices_admin_only");
  const openAccess = getConfigBool("invoices_open");

  const allowlist = Array.isArray(ctxAllowlist) ? ctxAllowlist : fileAllowlist;

  let mode = "open";
  if (openAccess === true || ctxMode === "open") {
    mode = "open";
  } else if (adminOnly === true || ctxMode === "admin") {
    mode = "admin";
  } else if (allowlist.length > 0) {
    mode = "allowlist";
  } else if (adminIds.length > 0) {
    mode = "admin";
  }

  return { mode, allowlist, adminIds };
}

function assertAccess(context, toolName) {
  const senderId = context.senderId;
  if (!senderId || !Number.isInteger(senderId)) {
    return { ok: false, error: "senderId is missing" };
  }

  const policy = getAccessPolicy(context);
  if (policy.adminIds.includes(senderId)) {
    return { ok: true, role: "admin" };
  }
  if (policy.mode === "open") {
    return { ok: true, role: "open" };
  }
  if (policy.mode === "allowlist") {
    if (policy.allowlist.includes(senderId)) return { ok: true, role: "allowlist" };
    return { ok: false, error: `Access denied for tool ${toolName}` };
  }
  return { ok: false, error: `Admin only for tool ${toolName}` };
}

function getRateLimitConfig(context, toolName) {
  const windowMs =
    Number(context.config?.invoices?.rate_limit_window_ms) ||
    getConfigNumber("invoices_rate_limit_window_ms") ||
    RATE_DEFAULT_WINDOW_MS;

  const defaultMax =
    Number(context.config?.invoices?.rate_limit_max) ||
    getConfigNumber("invoices_rate_limit_max") ||
    RATE_DEFAULT_MAX;

  const toolKey = `invoices_rate_limit_${toolName}`;
  const toolOverride =
    Number(context.config?.invoices?.rate_limits?.[toolName]) ||
    getConfigNumber(toolKey) ||
    RATE_TOOL_DEFAULTS[toolName] ||
    defaultMax;

  return {
    windowMs: Math.max(1000, windowMs),
    max: Math.max(1, toolOverride),
  };
}

async function tonapiFetch(path, params = {}) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();

  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = { Accept: "application/json" };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`TONAPI error: ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function tonapiFetchWithRetry(path, params = {}, maxAttempts = 3) {
  let attempt = 0;
  let lastErr = null;
  while (attempt < maxAttempts) {
    try {
      return await tonapiFetch(path, params);
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? null;
      const retryable =
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        status === 522 ||
        status === null;

      attempt += 1;
      if (!retryable || attempt >= maxAttempts) break;
      const delay = 300 * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function normalizeAddress(addr) {
  if (!addr) return null;
  const str = String(addr).trim();
  if (!str) return null;
  if (Address) {
    try {
      return Address.parse(str).toRawString();
    } catch {
      return str.toLowerCase();
    }
  }
  return str.toLowerCase();
}

function sameAddress(a, b) {
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  return na && nb && na === nb;
}

function toNanoString(amount) {
  if (amount === null || amount === undefined) {
    throw new Error("amount_ton is required");
  }
  const raw = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error("amount_ton must be a positive number string");
  }
  const [intPart, fracPart = ""] = raw.split(".");
  const frac = (fracPart + "000000000").slice(0, 9);
  const nano = BigInt(intPart) * 1000000000n + BigInt(frac);
  if (nano <= 0n) {
    throw new Error("amount_ton must be greater than 0");
  }
  return nano.toString();
}

function formatTon(nanoStr) {
  try {
    const nano = BigInt(nanoStr);
    const intPart = nano / 1000000000n;
    const frac = nano % 1000000000n;
    const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
    return fracStr ? `${intPart}.${fracStr}` : intPart.toString();
  } catch {
    return null;
  }
}

function sanitizeTag(value, maxLen = 32) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_@.\-]/g, "");
  return cleaned.slice(0, maxLen);
}

function buildInvoiceId() {
  return `inv_${randomBytes(8).toString("hex")}`;
}

function buildInvoiceComment(invoiceId, payerAgent) {
  const tag = `INV#${invoiceId}`;
  const payer = sanitizeTag(payerAgent, 32);
  return payer ? `${tag}|payer:${payer}` : tag;
}

function buildVerificationTag(agentId) {
  const safe = sanitizeTag(agentId, 24) || "agent";
  const code = randomBytes(4).toString("hex");
  return `REG#${safe}#${code}`;
}

function buildLinks(recipient, amountNano, comment) {
  const text = encodeURIComponent(comment);
  return {
    ton_link: `ton://transfer/${recipient}?amount=${amountNano}&text=${text}`,
    tonkeeper_link: `https://app.tonkeeper.com/transfer/${recipient}?amount=${amountNano}&text=${text}`,
    tonhub_link: `https://tonhub.com/transfer/${recipient}?amount=${amountNano}&text=${text}`,
  };
}

function getAgentWalletAddress() {
  let data;
  try {
    data = JSON.parse(readFileSync(WALLET_FILE, "utf-8"));
  } catch {
    throw new Error("Agent wallet not found at " + WALLET_FILE);
  }
  if (!data.address) {
    throw new Error("wallet.json missing address field");
  }
  return String(data.address).trim();
}

function parseIso(ts) {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

function commentTag(comment) {
  if (!comment) return null;
  const head = String(comment).split("|")[0].trim();
  return head || null;
}

function eventTimeMs(ts) {
  if (ts === null || ts === undefined) return null;
  const n = Number(ts);
  if (!Number.isFinite(n)) return null;
  return n * 1000;
}

function toBigIntSafe(val) {
  try {
    if (val === null || val === undefined) return null;
    return BigInt(val);
  } catch {
    return null;
  }
}

function maxBigInt(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

function minBigInt(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

// ---------------------------------------------------------------------------
// DB and cache
// ---------------------------------------------------------------------------

let dbReady = false;
let stmtAgentGet;
let stmtAgentUpsert;
let stmtAgentVerify;
let stmtInvoiceInsert;
let stmtInvoiceGet;
let stmtInvoiceMarkPaid;
let stmtInvoiceUpdateStatus;
let stmtInvoiceUpdateLastCheck;
let stmtRateGet;
let stmtRateSet;
let stmtWalletSyncGet;
let stmtWalletSyncUpsert;
let stmtTransferInsert;
let stmtTransferQuery;

function ensureColumns(db, table, columns) {
  const existing = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  );
  for (const col of columns) {
    if (!existing.has(col.name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type}`);
    }
  }
}

function initDb(db) {
  if (dbReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS inv_agents (
      agent_id TEXT PRIMARY KEY,
      wallet_address TEXT,
      status TEXT NOT NULL,
      challenge_tag TEXT,
      challenge_amount_ton TEXT,
      challenge_amount_nano TEXT,
      challenge_created_at TEXT,
      challenge_expires_at TEXT,
      verified_at TEXT,
      proof_event_id TEXT,
      proof_sender_wallet TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inv_invoices (
      invoice_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      amount_ton TEXT NOT NULL,
      amount_nano TEXT NOT NULL,
      recipient_wallet TEXT NOT NULL,
      expected_sender_wallet TEXT,
      payer_agent TEXT,
      payer_agent_verified INTEGER,
      description TEXT,
      comment TEXT NOT NULL,
      status TEXT NOT NULL,
      strict_sender INTEGER,
      paid_at TEXT,
      tx_event_id TEXT,
      tx_sender_wallet TEXT,
      tx_amount_nano TEXT,
      tx_amount_ton TEXT,
      last_checked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS inv_rate_limits (
      key TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inv_wallet_sync (
      wallet TEXT PRIMARY KEY,
      last_sync_at INTEGER,
      max_lt TEXT,
      min_lt TEXT,
      max_ts INTEGER,
      min_ts INTEGER
    );

    CREATE TABLE IF NOT EXISTS inv_transfers (
      wallet TEXT NOT NULL,
      event_id TEXT NOT NULL,
      action_index INTEGER NOT NULL,
      lt TEXT,
      timestamp INTEGER,
      sender TEXT,
      recipient TEXT,
      amount_nano TEXT,
      comment TEXT,
      comment_tag TEXT,
      inserted_at TEXT NOT NULL,
      PRIMARY KEY (wallet, event_id, action_index)
    );

    CREATE INDEX IF NOT EXISTS inv_transfers_wallet_tag_idx ON inv_transfers(wallet, comment_tag);
    CREATE INDEX IF NOT EXISTS inv_transfers_wallet_time_idx ON inv_transfers(wallet, timestamp DESC);
  `);

  ensureColumns(db, "inv_agents", [
    { name: "wallet_address", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "challenge_tag", type: "TEXT" },
    { name: "challenge_amount_ton", type: "TEXT" },
    { name: "challenge_amount_nano", type: "TEXT" },
    { name: "challenge_created_at", type: "TEXT" },
    { name: "challenge_expires_at", type: "TEXT" },
    { name: "verified_at", type: "TEXT" },
    { name: "proof_event_id", type: "TEXT" },
    { name: "proof_sender_wallet", type: "TEXT" },
    { name: "updated_at", type: "TEXT" },
  ]);

  ensureColumns(db, "inv_invoices", [
    { name: "expected_sender_wallet", type: "TEXT" },
    { name: "payer_agent", type: "TEXT" },
    { name: "payer_agent_verified", type: "INTEGER" },
    { name: "description", type: "TEXT" },
    { name: "comment", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "strict_sender", type: "INTEGER" },
    { name: "paid_at", type: "TEXT" },
    { name: "tx_event_id", type: "TEXT" },
    { name: "tx_sender_wallet", type: "TEXT" },
    { name: "tx_amount_nano", type: "TEXT" },
    { name: "tx_amount_ton", type: "TEXT" },
    { name: "last_checked_at", type: "TEXT" },
  ]);

  stmtAgentGet = db.prepare("SELECT * FROM inv_agents WHERE agent_id = ?");
  stmtAgentUpsert = db.prepare(`
    INSERT INTO inv_agents (
      agent_id, wallet_address, status,
      challenge_tag, challenge_amount_ton, challenge_amount_nano,
      challenge_created_at, challenge_expires_at,
      verified_at, proof_event_id, proof_sender_wallet,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      wallet_address = excluded.wallet_address,
      status = excluded.status,
      challenge_tag = excluded.challenge_tag,
      challenge_amount_ton = excluded.challenge_amount_ton,
      challenge_amount_nano = excluded.challenge_amount_nano,
      challenge_created_at = excluded.challenge_created_at,
      challenge_expires_at = excluded.challenge_expires_at,
      verified_at = excluded.verified_at,
      proof_event_id = excluded.proof_event_id,
      proof_sender_wallet = excluded.proof_sender_wallet,
      updated_at = excluded.updated_at
  `);

  stmtAgentVerify = db.prepare(`
    UPDATE inv_agents
    SET status = 'verified', verified_at = ?, proof_event_id = ?, proof_sender_wallet = ?,
        updated_at = ?
    WHERE agent_id = ?
  `);

  stmtInvoiceInsert = db.prepare(`
    INSERT INTO inv_invoices (
      invoice_id, created_at, expires_at, amount_ton, amount_nano, recipient_wallet,
      expected_sender_wallet, payer_agent, payer_agent_verified, description,
      comment, status, strict_sender
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmtInvoiceGet = db.prepare("SELECT * FROM inv_invoices WHERE invoice_id = ?");

  stmtInvoiceMarkPaid = db.prepare(`
    UPDATE inv_invoices
    SET status = 'paid', paid_at = ?, tx_event_id = ?, tx_sender_wallet = ?,
        tx_amount_nano = ?, tx_amount_ton = ?
    WHERE invoice_id = ?
  `);

  stmtInvoiceUpdateStatus = db.prepare(
    "UPDATE inv_invoices SET status = ? WHERE invoice_id = ?"
  );

  stmtInvoiceUpdateLastCheck = db.prepare(
    "UPDATE inv_invoices SET last_checked_at = ? WHERE invoice_id = ?"
  );

  stmtRateGet = db.prepare("SELECT * FROM inv_rate_limits WHERE key = ?");
  stmtRateSet = db.prepare(
    "INSERT OR REPLACE INTO inv_rate_limits (key, window_start, count) VALUES (?, ?, ?)"
  );

  stmtWalletSyncGet = db.prepare("SELECT * FROM inv_wallet_sync WHERE wallet = ?");
  stmtWalletSyncUpsert = db.prepare(`
    INSERT INTO inv_wallet_sync (wallet, last_sync_at, max_lt, min_lt, max_ts, min_ts)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet) DO UPDATE SET
      last_sync_at = excluded.last_sync_at,
      max_lt = excluded.max_lt,
      min_lt = excluded.min_lt,
      max_ts = excluded.max_ts,
      min_ts = excluded.min_ts
  `);

  stmtTransferInsert = db.prepare(`
    INSERT OR IGNORE INTO inv_transfers (
      wallet, event_id, action_index, lt, timestamp, sender, recipient,
      amount_nano, comment, comment_tag, inserted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmtTransferQuery = db.prepare(`
    SELECT * FROM inv_transfers
    WHERE wallet = ? AND comment_tag = ? AND timestamp IS NOT NULL
      AND timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
    LIMIT ?
  `);

  dbReady = true;
}

function checkRateLimit(db, senderId, toolName, cfg) {
  const key = `${toolName}:${senderId}`;
  const now = Date.now();
  const row = stmtRateGet.get(key);

  if (!row || now - row.window_start >= cfg.windowMs) {
    stmtRateSet.run(key, now, 1);
    return { allowed: true, remaining: cfg.max - 1 };
  }

  if (row.count >= cfg.max) {
    const retryAfter = cfg.windowMs - (now - row.window_start);
    return { allowed: false, retryAfterMs: retryAfter };
  }

  stmtRateSet.run(key, row.window_start, row.count + 1);
  return { allowed: true, remaining: cfg.max - row.count - 1 };
}

function getWalletSync(db, wallet) {
  return stmtWalletSyncGet.get(wallet) ?? null;
}

function updateWalletSync(db, wallet, stats) {
  const current = getWalletSync(db, wallet);
  let maxLt = current?.max_lt ?? null;
  let minLt = current?.min_lt ?? null;
  let maxTs = current?.max_ts ?? null;
  let minTs = current?.min_ts ?? null;

  if (stats.max_lt) maxLt = stats.max_lt;
  if (stats.min_lt) minLt = stats.min_lt;
  if (stats.max_ts) maxTs = stats.max_ts;
  if (stats.min_ts) minTs = stats.min_ts;

  stmtWalletSyncUpsert.run(wallet, Date.now(), maxLt, minLt, maxTs, minTs);
}

function ingestEvents(db, wallet, events) {
  const nowIso = new Date().toISOString();
  let minLt = null;
  let maxLt = null;
  let minTs = null;
  let maxTs = null;

  for (const ev of events) {
    const eventId = ev.event_id ?? ev.id ?? null;
    const ltVal = ev.lt ?? ev.event_lt ?? null;
    const tsMs = eventTimeMs(ev.timestamp ?? ev.utime ?? ev.time);

    if (tsMs !== null) {
      minTs = minTs === null ? tsMs : Math.min(minTs, tsMs);
      maxTs = maxTs === null ? tsMs : Math.max(maxTs, tsMs);
    }

    const ltBig = toBigIntSafe(ltVal);
    if (ltBig !== null) {
      minLt = minBigInt(minLt, ltBig);
      maxLt = maxBigInt(maxLt, ltBig);
    }

    const actions = ev.actions ?? [];
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (action.type !== "TonTransfer" || !action.TonTransfer) continue;
      const t = action.TonTransfer;

      const recipient = t.recipient?.address ?? t.recipient ?? null;
      if (!sameAddress(recipient, wallet)) continue;

      const sender = t.sender?.address ?? t.sender ?? null;
      const amount = t.amount ?? "0";
      const comment = t.comment ?? "";
      const tag = commentTag(comment);

      stmtTransferInsert.run(
        wallet,
        eventId ?? `${ltVal ?? "ev"}_${i}`,
        i,
        ltVal ? String(ltVal) : null,
        tsMs,
        normalizeAddress(sender),
        normalizeAddress(recipient),
        String(amount),
        comment,
        tag,
        nowIso
      );
    }
  }

  return {
    min_lt: minLt !== null ? minLt.toString() : null,
    max_lt: maxLt !== null ? maxLt.toString() : null,
    min_ts: minTs,
    max_ts: maxTs,
  };
}

function queryCachedTransfer(db, wallet, tag, startMs, endMs, minAmountNano, expectedSender, strictSender) {
  const rows = stmtTransferQuery.all(wallet, tag, startMs, endMs, 50);
  for (const row of rows) {
    const amountVal = toBigIntSafe(row.amount_nano);
    if (amountVal === null) continue;
    if (amountVal < minAmountNano) continue;
    if (expectedSender && strictSender && !sameAddress(row.sender, expectedSender)) continue;
    return row;
  }
  return null;
}

function eventWithinWindow(evMs, createdAt, expiresAt) {
  if (!evMs) return false;
  const createdMs = parseIso(createdAt);
  if (createdMs && evMs < createdMs) return false;
  const expiresMs = parseIso(expiresAt);
  if (expiresMs && evMs > expiresMs) return false;
  return true;
}

function extractTonTransfers(events, params) {
  const {
    recipientWallet,
    tag,
    amountNanoMin,
    expectedSender,
    strictSender,
    createdAt,
    expiresAt,
  } = params;

  const matches = [];
  const mismatches = [];

  for (const ev of events) {
    const actions = ev.actions ?? [];
    for (const action of actions) {
      if (action.type !== "TonTransfer" || !action.TonTransfer) continue;
      const t = action.TonTransfer;
      const recipient = t.recipient?.address ?? t.recipient ?? null;
      if (!sameAddress(recipient, recipientWallet)) continue;

      const comment = t.comment ?? "";
      if (!comment) continue;
      if (commentTag(comment) !== tag) continue;

      const tsMs = eventTimeMs(ev.timestamp ?? ev.utime ?? ev.time);
      if (!eventWithinWindow(tsMs, createdAt, expiresAt)) {
        mismatches.push({
          event_id: ev.event_id ?? null,
          reason: "outside_time_window",
          sender: t.sender?.address ?? t.sender ?? null,
          amount_nano: String(t.amount ?? "0"),
          comment,
        });
        continue;
      }

      const amountNano = BigInt(t.amount ?? 0);
      if (amountNano < amountNanoMin) {
        mismatches.push({
          event_id: ev.event_id ?? null,
          reason: "amount_too_low",
          sender: t.sender?.address ?? t.sender ?? null,
          amount_nano: amountNano.toString(),
          comment,
        });
        continue;
      }

      const sender = t.sender?.address ?? t.sender ?? null;
      if (expectedSender && strictSender && !sameAddress(sender, expectedSender)) {
        mismatches.push({
          event_id: ev.event_id ?? null,
          reason: "sender_mismatch",
          sender,
          amount_nano: amountNano.toString(),
          comment,
        });
        continue;
      }

      matches.push({
        event_id: ev.event_id ?? null,
        timestamp: ev.timestamp ?? ev.utime ?? null,
        sender,
        amount_nano: amountNano.toString(),
        comment,
      });
    }
  }

  return { matches, mismatches };
}

async function syncNewEvents(db, wallet, startMs, endMs) {
  const sync = getWalletSync(db, wallet);
  let afterLt = sync?.max_lt ?? null;
  let page = 0;
  let anyEvents = 0;
  let stats = { min_lt: null, max_lt: null, min_ts: null, max_ts: null };

  while (page < EVENT_MAX_PAGES_NEW) {
    const sortOrder = afterLt ? "asc" : "desc";
    const params = { limit: EVENT_PAGE_LIMIT, sort_order: sortOrder };
    if (afterLt) params.after_lt = afterLt;
    if (startMs) params.start_date = Math.floor(startMs / 1000);
    if (endMs) params.end_date = Math.floor(endMs / 1000);

    const data = await tonapiFetchWithRetry(`/v2/accounts/${wallet}/events`, params);
    const events = data.events ?? [];
    if (events.length === 0) break;

    anyEvents += events.length;
    const pageStats = ingestEvents(db, wallet, events);

    if (pageStats.max_lt) {
      afterLt = pageStats.max_lt;
      stats.max_lt = stats.max_lt ? String(maxBigInt(toBigIntSafe(stats.max_lt), toBigIntSafe(pageStats.max_lt))) : pageStats.max_lt;
    }
    if (pageStats.min_lt) {
      stats.min_lt = stats.min_lt ? String(minBigInt(toBigIntSafe(stats.min_lt), toBigIntSafe(pageStats.min_lt))) : pageStats.min_lt;
    }
    if (pageStats.max_ts !== null && pageStats.max_ts !== undefined) {
      stats.max_ts = stats.max_ts ? Math.max(stats.max_ts, pageStats.max_ts) : pageStats.max_ts;
    }
    if (pageStats.min_ts !== null && pageStats.min_ts !== undefined) {
      stats.min_ts = stats.min_ts ? Math.min(stats.min_ts, pageStats.min_ts) : pageStats.min_ts;
    }

    page += 1;
    if (!afterLt) break;
    if (events.length < EVENT_PAGE_LIMIT) break;
  }

  if (anyEvents > 0) updateWalletSync(db, wallet, stats);
  return anyEvents;
}

async function syncOlderEvents(db, wallet, startMs, endMs) {
  const sync = getWalletSync(db, wallet);
  let beforeLt = sync?.min_lt ?? null;
  if (!beforeLt) return 0;

  let page = 0;
  let anyEvents = 0;
  let stats = { min_lt: null, max_lt: null, min_ts: null, max_ts: null };

  while (page < EVENT_MAX_PAGES_OLD) {
    const params = { limit: EVENT_PAGE_LIMIT, sort_order: "desc", before_lt: beforeLt };
    if (startMs) params.start_date = Math.floor(startMs / 1000);
    if (endMs) params.end_date = Math.floor(endMs / 1000);

    const data = await tonapiFetchWithRetry(`/v2/accounts/${wallet}/events`, params);
    const events = data.events ?? [];
    if (events.length === 0) break;

    anyEvents += events.length;
    const pageStats = ingestEvents(db, wallet, events);

    if (pageStats.min_lt) beforeLt = pageStats.min_lt;

    if (pageStats.max_lt) {
      stats.max_lt = stats.max_lt ? String(maxBigInt(toBigIntSafe(stats.max_lt), toBigIntSafe(pageStats.max_lt))) : pageStats.max_lt;
    }
    if (pageStats.min_lt) {
      stats.min_lt = stats.min_lt ? String(minBigInt(toBigIntSafe(stats.min_lt), toBigIntSafe(pageStats.min_lt))) : pageStats.min_lt;
    }
    if (pageStats.max_ts !== null && pageStats.max_ts !== undefined) {
      stats.max_ts = stats.max_ts ? Math.max(stats.max_ts, pageStats.max_ts) : pageStats.max_ts;
    }
    if (pageStats.min_ts !== null && pageStats.min_ts !== undefined) {
      stats.min_ts = stats.min_ts ? Math.min(stats.min_ts, pageStats.min_ts) : pageStats.min_ts;
    }

    page += 1;

    if (pageStats.min_ts && startMs && pageStats.min_ts <= startMs) break;
    if (events.length < EVENT_PAGE_LIMIT) break;
    if (!beforeLt) break;
  }

  if (anyEvents > 0) updateWalletSync(db, wallet, stats);
  return anyEvents;
}

async function findTransferWithSync(db, wallet, criteria) {
  const {
    tag,
    minAmountNano,
    expectedSender,
    strictSender,
    startMs,
    endMs,
  } = criteria;

  const cached = queryCachedTransfer(db, wallet, tag, startMs, endMs, minAmountNano, expectedSender, strictSender);
  if (cached) {
    return { match: cached, source: "cache" };
  }

  const sync = getWalletSync(db, wallet);
  const now = Date.now();
  if (sync?.last_sync_at && now - sync.last_sync_at < SYNC_MIN_INTERVAL_MS) {
    return { match: null, source: "throttled" };
  }

  await syncNewEvents(db, wallet, startMs, endMs);

  const cachedAfterNew = queryCachedTransfer(db, wallet, tag, startMs, endMs, minAmountNano, expectedSender, strictSender);
  if (cachedAfterNew) {
    return { match: cachedAfterNew, source: "sync_new" };
  }

  const syncAfter = getWalletSync(db, wallet);
  const shouldFetchOlder = !syncAfter?.min_ts || (startMs && syncAfter.min_ts > startMs);
  if (shouldFetchOlder) {
    await syncOlderEvents(db, wallet, startMs, endMs);
  }

  const cachedAfterOld = queryCachedTransfer(db, wallet, tag, startMs, endMs, minAmountNano, expectedSender, strictSender);
  if (cachedAfterOld) {
    return { match: cachedAfterOld, source: "sync_old" };
  }

  return { match: null, source: "not_found" };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const invBeginVerification = {
  name: "inv_begin_verification",
  category: "action",
  description:
    "Start wallet ownership verification for an agent. Creates a challenge tag and deep links for a small verification transfer.",
  parameters: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "Agent identifier (username, handle, or id)",
      },
      wallet_address: {
        type: "string",
        description: "TON wallet address to verify",
      },
      amount_ton: {
        type: "string",
        description: "Verification amount in TON (default 0.01)",
      },
      expires_in_minutes: {
        type: "integer",
        description: "Challenge expiry in minutes (default 60)",
        minimum: 1,
        maximum: 10080
      },
    },
    required: ["agent_id", "wallet_address"],
  },
  execute: async (params, context) => {
    try {
      const access = assertAccess(context, "inv_begin_verification");
      if (!access.ok) return { success: false, error: access.error };
      if (!context.db) throw new Error("Database not available in context");
      initDb(context.db);

      const rl = checkRateLimit(context.db, context.senderId, "inv_begin_verification", getRateLimitConfig(context, "inv_begin_verification"));
      if (!rl.allowed) return { success: false, error: `Rate limit exceeded. Retry in ${rl.retryAfterMs}ms.` };

      const agentId = String(params.agent_id ?? "").trim();
      const wallet = String(params.wallet_address ?? "").trim();
      if (!agentId) return { success: false, error: "agent_id is required" };
      if (!wallet) return { success: false, error: "wallet_address is required" };
      if (agentId.length > 64) {
        return { success: false, error: "agent_id is too long (max 64)" };
      }

      const amountTon = params.amount_ton ? String(params.amount_ton).trim() : VERIFY_DEFAULT_TON;
      const amountNano = toNanoString(amountTon);
      const challengeTag = buildVerificationTag(agentId);

      const now = new Date().toISOString();
      const ttl = params.expires_in_minutes ?? VERIFY_TTL_MINUTES;
      const expiresAt = new Date(Date.now() + Number(ttl) * 60000).toISOString();

      stmtAgentUpsert.run(
        agentId,
        wallet,
        "pending",
        challengeTag,
        amountTon,
        amountNano,
        now,
        expiresAt,
        null,
        null,
        null,
        now
      );

      const recipient = getAgentWalletAddress();
      const links = buildLinks(recipient, amountNano, challengeTag);

      return {
        success: true,
        data: {
          agent_id: agentId,
          wallet_address: wallet,
          status: "pending",
          challenge_tag: challengeTag,
          amount_ton: amountTon,
          amount_nano: amountNano,
          recipient_wallet: recipient,
          created_at: now,
          expires_at: expiresAt,
          links,
          next_step: "Use inv_confirm_verification after payment is sent from the wallet.",
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

const invConfirmVerification = {
  name: "inv_confirm_verification",
  category: "action",
  description:
    "Confirm wallet ownership by checking the verification transfer on-chain. Marks the agent wallet as verified.",
  parameters: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "Agent identifier to confirm",
      },
    },
    required: ["agent_id"],
  },
  execute: async (params, context) => {
    try {
      const access = assertAccess(context, "inv_confirm_verification");
      if (!access.ok) return { success: false, error: access.error };
      if (!context.db) throw new Error("Database not available in context");
      initDb(context.db);

      const rl = checkRateLimit(context.db, context.senderId, "inv_confirm_verification", getRateLimitConfig(context, "inv_confirm_verification"));
      if (!rl.allowed) return { success: false, error: `Rate limit exceeded. Retry in ${rl.retryAfterMs}ms.` };

      const agentId = String(params.agent_id ?? "").trim();
      if (!agentId) return { success: false, error: "agent_id is required" };

      const agent = stmtAgentGet.get(agentId);
      if (!agent) return { success: false, error: `agent_id ${agentId} not found` };

      if (agent.status === "verified") {
        return {
          success: true,
          data: {
            agent_id: agentId,
            status: agent.status,
            wallet_address: agent.wallet_address,
            verified_at: agent.verified_at,
            proof_event_id: agent.proof_event_id,
          },
        };
      }

      if (parseIso(agent.challenge_expires_at) && Date.now() > parseIso(agent.challenge_expires_at)) {
        return {
          success: true,
          data: {
            agent_id: agentId,
            status: "expired",
            challenge_expires_at: agent.challenge_expires_at,
          },
        };
      }

      const recipient = normalizeAddress(getAgentWalletAddress());
      const tag = agent.challenge_tag;
      const amountNanoMin = BigInt(agent.challenge_amount_nano ?? "0");
      const startMs = parseIso(agent.challenge_created_at);
      const endMs = parseIso(agent.challenge_expires_at) ?? Date.now();

      const result = await findTransferWithSync(context.db, recipient, {
        tag,
        minAmountNano: amountNanoMin,
        expectedSender: agent.wallet_address,
        strictSender: true,
        startMs,
        endMs,
      });

      if (!result.match) {
        const status = result.source === "throttled" ? "throttled" : "pending";
        return {
          success: true,
          data: {
            agent_id: agentId,
            status,
            expected_wallet: agent.wallet_address,
            challenge_tag: tag,
          },
        };
      }

      const verifiedAt = result.match.timestamp
        ? new Date(Number(result.match.timestamp) * 1000).toISOString()
        : new Date().toISOString();
      const now = new Date().toISOString();

      stmtAgentVerify.run(verifiedAt, result.match.event_id, result.match.sender, now, agentId);

      return {
        success: true,
        data: {
          agent_id: agentId,
          status: "verified",
          wallet_address: agent.wallet_address,
          verified_at: verifiedAt,
          proof_event_id: result.match.event_id,
          proof_sender_wallet: result.match.sender,
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

const invRegisterAgent = {
  name: "inv_register_agent",
  category: "action",
  description:
    "Alias for inv_begin_verification. Creates a wallet verification challenge for an agent.",
  parameters: invBeginVerification.parameters,
  execute: invBeginVerification.execute,
};

const invCreate = {
  name: "inv_create",
  category: "action",
  description:
    "Create a TON invoice with a unique comment tag and deep links for payment. For 100% identity, use a verified payer wallet.",
  parameters: {
    type: "object",
    properties: {
      amount_ton: {
        type: "string",
        description: "Amount in TON (e.g. 1.5)",
      },
      description: {
        type: "string",
        description: "Short description of the service or invoice",
      },
      payer_agent: {
        type: "string",
        description: "Expected payer agent id/username (must be verified for strict mode)",
      },
      payer_wallet: {
        type: "string",
        description: "Expected payer wallet address (strong identity check)",
      },
      recipient_wallet: {
        type: "string",
        description: "Recipient wallet address (defaults to the agent wallet)",
      },
      expires_in_minutes: {
        type: "integer",
        description: "Invoice expiry in minutes (optional)",
        minimum: 1,
        maximum: 43200
      },
      invoice_id: {
        type: "string",
        description: "Custom invoice id (optional)",
      },
      strict_sender: {
        type: "boolean",
        description: "If true, require sender wallet match (default true)",
      },
      allow_unverified_payer: {
        type: "boolean",
        description: "Allow creating invoice without verified payer (default false)",
      },
    },
    required: ["amount_ton"],
  },
  execute: async (params, context) => {
    try {
      const access = assertAccess(context, "inv_create");
      if (!access.ok) return { success: false, error: access.error };
      if (!context.db) throw new Error("Database not available in context");
      initDb(context.db);

      const rl = checkRateLimit(context.db, context.senderId, "inv_create", getRateLimitConfig(context, "inv_create"));
      if (!rl.allowed) return { success: false, error: `Rate limit exceeded. Retry in ${rl.retryAfterMs}ms.` };

      const amountNano = toNanoString(params.amount_ton);
      const amountTon = String(params.amount_ton).trim();

      const recipient = params.recipient_wallet
        ? normalizeAddress(String(params.recipient_wallet).trim())
        : normalizeAddress(getAgentWalletAddress());

      const payerAgent = params.payer_agent ? String(params.payer_agent).trim() : null;
      const payerWallet = params.payer_wallet ? normalizeAddress(String(params.payer_wallet).trim()) : null;
      const allowUnverified = params.allow_unverified_payer ?? false;
      let strictSender = params.strict_sender ?? true;

      let expectedSender = payerWallet || null;
      let payerVerified = 0;

      if (payerAgent) {
        const row = stmtAgentGet.get(payerAgent);
        if (row && row.status === "verified" && row.wallet_address) {
          if (payerWallet && !sameAddress(payerWallet, row.wallet_address)) {
            return { success: false, error: "payer_wallet does not match verified agent wallet" };
          }
          expectedSender = normalizeAddress(row.wallet_address);
          payerVerified = 1;
        } else if (!payerWallet) {
          if (!allowUnverified) {
            return {
              success: false,
              error: "payer_agent is not verified. Run inv_begin_verification first or set allow_unverified_payer=true.",
            };
          }
          strictSender = false;
        }
      }

      if (strictSender && !expectedSender) {
        return {
          success: false,
          error: "strict_sender requires payer_wallet or verified payer_agent",
        };
      }

      const invoiceId = params.invoice_id ? String(params.invoice_id).trim() : buildInvoiceId();
      if (!invoiceId) return { success: false, error: "invoice_id is invalid" };
      if (stmtInvoiceGet.get(invoiceId)) {
        return { success: false, error: `invoice_id ${invoiceId} already exists` };
      }

      const comment = buildInvoiceComment(invoiceId, payerAgent);
      const now = new Date().toISOString();
      const expiresAt = params.expires_in_minutes
        ? new Date(Date.now() + Number(params.expires_in_minutes) * 60000).toISOString()
        : null;

      stmtInvoiceInsert.run(
        invoiceId,
        now,
        expiresAt,
        amountTon,
        amountNano,
        recipient,
        expectedSender,
        payerAgent,
        payerVerified,
        params.description ? String(params.description).trim() : null,
        comment,
        "pending",
        strictSender ? 1 : 0
      );

      const links = buildLinks(recipient, amountNano, comment);
      let identityLevel = "comment_only";
      if (expectedSender) identityLevel = payerVerified ? "wallet_verified" : "wallet";
      else if (!payerAgent && !strictSender) identityLevel = "none";

      return {
        success: true,
        data: {
          invoice_id: invoiceId,
          status: "pending",
          created_at: now,
          expires_at: expiresAt,
          amount_ton: amountTon,
          amount_nano: amountNano,
          recipient_wallet: recipient,
          payer_agent: payerAgent,
          payer_agent_verified: payerVerified === 1,
          expected_sender_wallet: expectedSender,
          comment,
          strict_sender: strictSender,
          identity_level: identityLevel,
          links,
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

const invCheck = {
  name: "inv_check",
  category: "data-bearing",
  description:
    "Verify an invoice by scanning cached TON transfers to the recipient wallet. Matches the invoice tag in the comment and (optionally) the expected sender wallet.",
  parameters: {
    type: "object",
    properties: {
      invoice_id: {
        type: "string",
        description: "Invoice id to verify",
      },
    },
    required: ["invoice_id"],
  },
  execute: async (params, context) => {
    try {
      const access = assertAccess(context, "inv_check");
      if (!access.ok) return { success: false, error: access.error };
      if (!context.db) throw new Error("Database not available in context");
      initDb(context.db);

      const rl = checkRateLimit(context.db, context.senderId, "inv_check", getRateLimitConfig(context, "inv_check"));
      if (!rl.allowed) return { success: false, error: `Rate limit exceeded. Retry in ${rl.retryAfterMs}ms.` };

      const invoiceId = String(params.invoice_id ?? "").trim();
      if (!invoiceId) return { success: false, error: "invoice_id is required" };

      const invoice = stmtInvoiceGet.get(invoiceId);
      if (!invoice) return { success: false, error: `invoice_id ${invoiceId} not found` };

      if (invoice.status === "paid") {
        return {
          success: true,
          data: {
            invoice_id: invoiceId,
            status: invoice.status,
            paid_at: invoice.paid_at,
            tx_event_id: invoice.tx_event_id,
            tx_sender_wallet: invoice.tx_sender_wallet,
            tx_amount_ton: invoice.tx_amount_ton,
          },
        };
      }

      if (invoice.expires_at && parseIso(invoice.expires_at) && Date.now() > parseIso(invoice.expires_at)) {
        stmtInvoiceUpdateStatus.run("expired", invoiceId);
        return {
          success: true,
          data: {
            invoice_id: invoiceId,
            status: "expired",
            expires_at: invoice.expires_at,
          },
        };
      }

      const strictSender = invoice.strict_sender === 1;
      if (strictSender && !invoice.expected_sender_wallet) {
        return { success: false, error: "invoice is missing expected_sender_wallet" };
      }

      const tag = `INV#${invoiceId}`;
      const amountNanoMin = BigInt(invoice.amount_nano);
      const startMs = parseIso(invoice.created_at) ?? 0;
      const endMs = parseIso(invoice.expires_at) ?? Date.now();

      const result = await findTransferWithSync(context.db, invoice.recipient_wallet, {
        tag,
        minAmountNano: amountNanoMin,
        expectedSender: invoice.expected_sender_wallet,
        strictSender,
        startMs,
        endMs,
      });

      stmtInvoiceUpdateLastCheck.run(new Date().toISOString(), invoiceId);

      if (!result.match) {
        const status = result.source === "throttled" ? "throttled" : "not_found";
        return {
          success: true,
          data: {
            invoice_id: invoiceId,
            status,
            strict_sender: strictSender,
            expected_sender_wallet: invoice.expected_sender_wallet ?? null,
            cache_source: result.source,
          },
        };
      }

      const paidAt = result.match.timestamp
        ? new Date(Number(result.match.timestamp) * 1000).toISOString()
        : new Date().toISOString();
      const paidAmountTon = formatTon(result.match.amount_nano);

      stmtInvoiceMarkPaid.run(
        paidAt,
        result.match.event_id,
        result.match.sender,
        result.match.amount_nano,
        paidAmountTon,
        invoiceId
      );

      const identityLevel = invoice.expected_sender_wallet
        ? invoice.payer_agent_verified === 1
          ? "wallet_verified"
          : "wallet"
        : "comment_only";

      return {
        success: true,
        data: {
          invoice_id: invoiceId,
          status: "paid",
          paid_at: paidAt,
          tx_event_id: result.match.event_id,
          tx_sender_wallet: result.match.sender,
          tx_amount_ton: paidAmountTon,
          identity_level: identityLevel,
          strict_sender: strictSender,
          cache_source: result.source,
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

const invReceipt = {
  name: "inv_receipt",
  category: "data-bearing",
  description:
    "Generate a receipt (check) for a paid invoice. Use after inv_check confirms payment.",
  parameters: {
    type: "object",
    properties: {
      invoice_id: {
        type: "string",
        description: "Invoice id to generate receipt for",
      },
    },
    required: ["invoice_id"],
  },
  execute: async (params, context) => {
    try {
      const access = assertAccess(context, "inv_receipt");
      if (!access.ok) return { success: false, error: access.error };
      if (!context.db) throw new Error("Database not available in context");
      initDb(context.db);

      const rl = checkRateLimit(context.db, context.senderId, "inv_receipt", getRateLimitConfig(context, "inv_receipt"));
      if (!rl.allowed) return { success: false, error: `Rate limit exceeded. Retry in ${rl.retryAfterMs}ms.` };

      const invoiceId = String(params.invoice_id ?? "").trim();
      if (!invoiceId) return { success: false, error: "invoice_id is required" };

      const invoice = stmtInvoiceGet.get(invoiceId);
      if (!invoice) return { success: false, error: `invoice_id ${invoiceId} not found` };
      if (invoice.status !== "paid") {
        return {
          success: false,
          error: `invoice_id ${invoiceId} is not paid (status: ${invoice.status})`,
        };
      }

      const identityLevel = invoice.expected_sender_wallet
        ? invoice.payer_agent_verified === 1
          ? "wallet_verified"
          : "wallet"
        : "comment_only";

      return {
        success: true,
        data: {
          invoice_id: invoiceId,
          status: invoice.status,
          created_at: invoice.created_at,
          paid_at: invoice.paid_at,
          amount_ton: invoice.amount_ton,
          recipient_wallet: invoice.recipient_wallet,
          payer_agent: invoice.payer_agent,
          payer_agent_verified: invoice.payer_agent_verified === 1,
          expected_sender_wallet: invoice.expected_sender_wallet,
          tx_event_id: invoice.tx_event_id,
          tx_sender_wallet: invoice.tx_sender_wallet,
          tx_amount_ton: invoice.tx_amount_ton,
          description: invoice.description,
          identity_level: identityLevel,
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

export const tools = [
  invBeginVerification,
  invConfirmVerification,
  invRegisterAgent,
  invCreate,
  invCheck,
  invReceipt,
];

export const __testing = {
  toNanoString,
  formatTon,
  sanitizeTag,
  commentTag,
  parseIso,
  eventTimeMs,
  extractTonTransfers,
  buildInvoiceComment,
  buildVerificationTag,
  createInMemoryRateLimiter: (windowMs, max) => {
    const store = new Map();
    return (key) => {
      const now = Date.now();
      const row = store.get(key);
      if (!row || now - row.window_start >= windowMs) {
        store.set(key, { window_start: now, count: 1 });
        return { allowed: true };
      }
      if (row.count >= max) {
        return { allowed: false, retryAfterMs: windowMs - (now - row.window_start) };
      }
      row.count += 1;
      store.set(key, row);
      return { allowed: true };
    };
  },
};
