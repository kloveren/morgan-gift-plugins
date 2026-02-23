/**
 * Whale Analytics plugin — track top gift holders, detect anomalies, store daily snapshots
 *
 * SDK plugin with isolated SQLite database for whale_snapshots persistence.
 *
 * Sources:
 * - GetGems API: collection history (on-chain sales)
 * - Giftstat API: floor prices, price history, collection data
 *
 * Three tools:
 * 1. whale_tracker — top holders, portfolios, activity patterns
 * 2. anomaly_detector — wash trading, price spikes, volume anomalies (heuristic)
 * 3. whale_snapshots — query historical snapshots + compute deltas between dates
 */

const GIFTSTAT_API = "https://api.giftstat.app";

const MARKETAPP_API = "https://api.marketapp.ws/v1";

async function toRawAddress(addr) {
  try {
    const { Address } = await import("@ton/core");
    return Address.parse(addr).toRawString();
  } catch {
    return addr;
  }
}

const COLLECTION_ALIASES = {
  "EQDLM65t0shS7gZAg0lMltGHYhsU94PzsMJHhYibmRV7kdUs": ["CandyCane", "Candy Cane", "Candy-Cane", "candycane"],
  "EQAoJw7BpOcBD3y9voMuEQ-qhS3K4gtM-6EePLxkzk8iSifX": ["SnoopDogg", "Snoop Dogg", "Snoop-Dogg", "snoopdog", "snoop"],
  "EQDz_VecErEBTLOTiR1tq0VS3lZuHHqhYmhZbthcrbFk7ztK": ["XmasStocking", "Xmas Stocking", "Xmas-Stocking", "xmasstocking"],
  "EQCwEFfUbbR-22fn3VgxUpBil7bwBQqEHm7wgQYbWY9c08YJ": ["BDayCandle", "B-Day Candle", "BDay Candle", "bdaycandle"],
  "EQBMcfMAZlMUr1W3X8kdEw3fJMUAaWH4-XcmE5R5RfFIY0E2": ["DeskCalendar", "Desk Calendar", "Desk-Calendar", "deskcalendar"],
  "EQCefrjhCD2_7HRIr2lmwt9ZaqeG_tdseBvADC66833kBS3y": ["HomemadeCake", "Homemade Cake", "Homemade-Cake", "homemadecake"],
  "EQBIj0uF-qIASqv6qIvcTif2wKSdt4WQc4mcoBywNp5GntuG": ["InstantRamen", "Instant Ramen", "Instant-Ramen", "instantramen"],
  "EQC6zjid8vJNEWqcXk10XjsdDLRKbcPZzbHusuEW6FokOWIm": ["LolPop", "Lol Pop", "Lol-Pop", "lolpop", "lollipop"],
  "EQBT9PbZBR6FGcZBSnwgo-DLpc0r7_X_8dlhG5UA6v9l9uJM": ["CookieHeart", "Cookie Heart", "Cookie-Heart", "cookieheart"],
  "EQCBK_JBASAA5XVz1D17Pn--kQaMWm0b9wReVtsEdRO4Tgy9": ["JesterHat", "Jester Hat", "Jester-Hat", "jesterhat"],
  "EQBG-g6ahkAUGWpefWbx-D_9sQ8oWbvy6puuq78U2c4NUDFS": ["PlushPepe", "Plush Pepe", "Plush-Pepe", "plushpepe"],
};

function resolveCollectionByAlias(nameOrSlug) {
  const query = (nameOrSlug || "").toLowerCase().replace(/[\s_-]/g, "");
  for (const [address, aliases] of Object.entries(COLLECTION_ALIASES)) {
    for (const alias of aliases) {
      if (alias.toLowerCase().replace(/[\s_-]/g, "") === query) {
        return { address, slug: aliases[0] };
      }
    }
  }
  return null;
}

export const manifest = {
  name: "whale-analytics",
  version: "1.4.0",
  sdkVersion: ">=1.0.0",
  description: "Whale tracking + anomaly detection + daily snapshots for gift markets",
  defaultConfig: {
    auto_snapshot: true,
    auto_snapshot_interval_hours: 24,
    auto_snapshot_top_n: 10,
    auto_snapshot_max_collections: 10,
  },
};

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whale_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT NOT NULL,
      collection TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      bought_count INTEGER NOT NULL DEFAULT 0,
      sold_count INTEGER NOT NULL DEFAULT 0,
      net_accumulation INTEGER NOT NULL DEFAULT 0,
      bought_volume_ton REAL NOT NULL DEFAULT 0,
      sold_volume_ton REAL NOT NULL DEFAULT 0,
      strategy TEXT,
      floor_ton REAL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(snapshot_date, collection, wallet_address)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_snapshots_date ON whale_snapshots(snapshot_date);
    CREATE INDEX IF NOT EXISTS idx_snapshots_collection ON whale_snapshots(collection);
    CREATE INDEX IF NOT EXISTS idx_snapshots_wallet ON whale_snapshots(wallet_address);
  `);
}

async function fetchWithTimeout(url, options = {}, ms = 15000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
}

async function giftstatFetch(path, params = {}) {
  const url = new URL(path, GIFTSTAT_API);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Giftstat ${res.status}`);
  return res.json();
}

async function getgemsGiftHistory(types, limit, after, logger) {
  const apiKey = process.env.GETGEMS_API_KEY;
  if (!apiKey) {
    return { items: [], _blocked: true, _authError: true };
  }
  const params = new URLSearchParams();
  params.set("limit", String(limit || 100));
  if (after) params.set("after", after);
  if (types && types.length) {
    types.forEach((t) => params.append("types[]", t));
  }
  const url = `https://api.getgems.io/public-api/v1/nfts/history/gifts?${params}`;
  const headers = { Accept: "application/json", Authorization: apiKey };
  const res = await fetchWithTimeout(url, { headers });
  if (res.status === 403) {
    return { items: [], _blocked: true };
  }
  if (res.status === 401) {
    if (logger) logger(`GetGems 401: Authorization required but key present=${!!apiKey}`);
    return { items: [], _blocked: true, _authError: true };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GetGems ${res.status}: ${body.slice(0, 200)}`);
  }
  const raw = await res.json();
  const data = raw.response !== undefined ? raw.response : raw;
  const items = data.items || (Array.isArray(data) ? data : []);
  if (logger && !after) {
    logger(`GetGems gifts/history: ${items.length} items, cursor=${data.cursor || "none"}`);
  }
  return { items, cursor: data.cursor || null };
}

function fromNano(nano) {
  const n = typeof nano === "string" ? BigInt(nano) : BigInt(Math.round(Number(nano)));
  return Number(n) / 1e9;
}

async function getGiftCollections() {
  try {
    const data = await giftstatFetch("/current/collections", { limit: 300 });
    return (data.data || []).map((c) => ({
      ...c,
      address: c.blockchain_address || c.address || null,
      slug: c.collection_slug || c.slug || c.collection || null,
      name: c.collection || c.name || null,
      total_supply: c.total_amount || c.total_supply || 0,
    }));
  } catch {
    return [];
  }
}

async function getFloorPrices() {
  try {
    const data = await giftstatFetch("/current/collections/floor", {
      marketplace: "all",
      limit: 500,
    });
    const floors = {};
    for (const item of data.data || []) {
      const slug = (item.slug || "").toLowerCase();
      const floor = item.floor_price;
      if (slug && floor > 0) {
        if (!floors[slug] || floor < floors[slug]) {
          floors[slug] = floor;
        }
      }
    }
    return floors;
  } catch {
    return {};
  }
}

async function getCollectionSales(address, maxItems = 300, logger = null) {
  try {
    const rawAddr = await toRawAddress(address);
    const allItems = [];
    let cursor = undefined;
    const batchSize = 100;
    let blocked = false;
    let totalFetched = 0;
    const maxPages = 5;
    let pages = 0;
    while (allItems.length < maxItems && pages < maxPages) {
      pages++;
      const data = await getgemsGiftHistory(["sold"], batchSize, cursor, pages === 1 ? logger : null);
      if (data._blocked) {
        if (logger) logger(`GetGems: blocked (${data._authError ? "401 auth" : "403"}), skipping`);
        blocked = true;
        break;
      }
      const items = data.items || [];
      totalFetched += items.length;
      if (items.length === 0) break;
      for (const item of items) {
        const itemCollAddr = item.collectionAddress || item.collection?.address || null;
        if (!itemCollAddr) continue;
        let itemRaw;
        try { itemRaw = await toRawAddress(itemCollAddr); } catch { continue; }
        if (itemRaw !== rawAddr) continue;
        allItems.push({
          nft_name: item.name || null,
          nft_address: item.address,
          price_ton: item.typeData?.priceNano
            ? fromNano(item.typeData.priceNano)
            : item.typeData?.price || 0,
          buyer: item.typeData?.newOwner || null,
          seller: item.typeData?.oldOwner || null,
          time: item.time,
        });
      }
      cursor = data.cursor;
      if (!cursor || items.length < batchSize) break;
    }
    if (logger) {
      logger(`GetGems: ${address.slice(0, 12)}... fetched ${totalFetched} total events, ${allItems.length} matched collection (${pages} pages)`);
    }
    const result = allItems.slice(0, maxItems);
    result._blocked = blocked;
    return result;
  } catch (err) {
    if (logger) logger(`GetGems sales error: ${err.message}`);
    const result = [];
    result._blocked = false;
    return result;
  }
}

async function getMarketAppSales(collectionAddress, limit = 100, logger = null) {
  try {
    const token = process.env.MARKETAPP_API_TOKEN;
    if (!token) return [];

    const params = new URLSearchParams();
    if (collectionAddress) params.set("collection_address", collectionAddress);
    params.set("limit", String(Math.min(limit, 100)));

    const url = `${MARKETAPP_API}/gifts/history/?${params}`;
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: token },
    }, 30000);
    if (!res.ok) {
      if (logger) logger(`MarketApp API ${res.status} for ${collectionAddress || "all"} — URL: ${url}`);
      return [];
    }
    const data = await res.json();
    const items = data.items || data.data || data.results || [];

    if (logger && items.length > 0 && collectionAddress) {
      const types = [...new Set(items.map(ev => ev.event_type || ev.type || ev.action || "unknown"))];
      logger(`MarketApp ${collectionAddress.slice(0, 12)}...: event_types=[${types.join(",")}] (${items.length} events)`);
      if (items[0]) logger(`MarketApp sample: ${JSON.stringify(items[0]).slice(0, 500)}`);
    }

    return items
      .filter((ev) => {
        const td = ev.type_details || {};
        const price = td.price_nano ? fromNano(td.price_nano)
          : td.price ? Number(td.price)
          : ev.price ?? ev.price_ton ?? 0;
        return price > 0;
      })
      .map((ev) => {
        const td = ev.type_details || {};
        const price = td.price_nano ? fromNano(td.price_nano)
          : td.price ? Number(td.price)
          : ev.price ?? ev.price_ton ?? 0;
        let evTime = ev.ts || ev.timestamp || 0;
        if (!evTime && ev.date) evTime = Math.floor(new Date(ev.date).getTime() / 1000);
        if (evTime > 1e12) evTime = Math.floor(evTime / 1000);
        return {
          nft_address: ev.address || ev.nft_address || ev.nft || null,
          nft_name: ev.name || ev.collection_name || null,
          collection: ev.collection_name || null,
          price_ton: typeof price === "number" ? price : Number(price) || 0,
          buyer: td.dst || ev.buyer || ev.new_owner || null,
          seller: td.src || ev.seller || ev.old_owner || null,
          time: evTime,
          source: "marketapp",
        };
      });
  } catch (err) {
    if (logger) logger(`MarketApp fetch error: ${err.message}`);
    return [];
  }
}

async function getPriceHistory(marketplace = "portals", days = 14) {
  try {
    const data = await giftstatFetch("/history/collections/floor", {
      marketplace,
      scale: "day",
      days,
      limit: 500,
    });
    return data.data || [];
  } catch {
    return [];
  }
}

function deduplicateSales(sales) {
  const seen = new Set();
  return sales.filter((s) => {
    if (s.nft_address && s.buyer && s.time) {
      const key = `${s.nft_address}:${s.buyer}:${s.time}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  });
}

function analyzeWhales(recentSales, allSales, collectionSlug, collectionAddress, floors, topN) {
  const buyerStats = {};
  const sellerStats = {};

  for (const sale of recentSales) {
    if (sale.buyer) {
      if (!buyerStats[sale.buyer]) buyerStats[sale.buyer] = { count: 0, total_ton: 0, collections: {}, names: [] };
      buyerStats[sale.buyer].count++;
      buyerStats[sale.buyer].total_ton += sale.price_ton || 0;
      const col = sale.collection || collectionSlug || "unknown";
      buyerStats[sale.buyer].collections[col] = (buyerStats[sale.buyer].collections[col] || 0) + 1;
      if (sale.nft_name && buyerStats[sale.buyer].names.length < 5) {
        buyerStats[sale.buyer].names.push(sale.nft_name);
      }
    }
    if (sale.seller) {
      if (!sellerStats[sale.seller]) sellerStats[sale.seller] = { count: 0, total_ton: 0 };
      sellerStats[sale.seller].count++;
      sellerStats[sale.seller].total_ton += sale.price_ton || 0;
    }
  }

  const topBuyers = Object.entries(buyerStats)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, topN)
    .map(([address, stats]) => {
      const sellCount = sellerStats[address]?.count || 0;
      const sellVolume = sellerStats[address]?.total_ton || 0;

      const totalTrades = stats.count + sellCount;
      let strategy = "unknown";
      if (totalTrades < 3) {
        strategy = "insufficient_data";
      } else if (stats.count > sellCount * 3) {
        strategy = "accumulating";
      } else if (sellCount > stats.count * 2) {
        strategy = "distributing";
      } else if (Math.abs(stats.count - sellCount) < stats.count * 0.3) {
        strategy = "trading";
      } else {
        strategy = "mixed";
      }

      const topCollections = Object.entries(stats.collections)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([col, count]) => ({
          collection: col,
          bought: count,
          floor_ton: floors[col.toLowerCase()] || null,
        }));

      return {
        wallet_address: address,
        bought_count: stats.count,
        bought_volume_ton: +stats.total_ton.toFixed(2),
        sold_count: sellCount,
        sold_volume_ton: +sellVolume.toFixed(2),
        net_accumulation: stats.count - sellCount,
        strategy,
        top_collections: topCollections,
        sample_nfts: stats.names,
      };
    });

  const totalVolume = recentSales.reduce((sum, s) => sum + (s.price_ton || 0), 0);
  const avgPrice = recentSales.length > 0 ? totalVolume / recentSales.length : 0;
  const isSampled = allSales.length >= 300 || (!collectionAddress && allSales.length >= 500);

  return { topBuyers, buyerStats, sellerStats, totalVolume, avgPrice, isSampled };
}

function saveSnapshot(db, sdk, collectionSlug, topBuyers, floors) {
  if (!db) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const floor = floors[(collectionSlug || "").toLowerCase()] || null;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO whale_snapshots
      (snapshot_date, collection, wallet_address, bought_count, sold_count,
       net_accumulation, bought_volume_ton, sold_volume_ton, strategy, floor_ton)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((whales) => {
    let count = 0;
    for (const w of whales) {
      stmt.run(
        today,
        collectionSlug || "multi",
        w.wallet_address,
        w.bought_count,
        w.sold_count,
        w.net_accumulation,
        w.bought_volume_ton,
        w.sold_volume_ton,
        w.strategy,
        floor
      );
      count++;
    }
    return count;
  });

  try {
    const saved = insertMany(topBuyers);
    sdk.log.info(`Saved ${saved} whale snapshots for ${collectionSlug || "multi"} (${today})`);
    return saved;
  } catch (err) {
    sdk.log.error(`Failed to save snapshots: ${err.message}`);
    return 0;
  }
}

export const tools = (sdk) => {
  const db = sdk.db;

  const whaleTracker = {
    name: "whale_tracker",
    category: "data-bearing",
    description:
      "Track top gift holders (whales) for a specific collection or across all collections. " +
      "USE THIS for whale/transaction/wallet questions — NOT for price/floor/collection questions (use Giftstat tools for those). " +
      "Data sources: MarketApp (primary) + GetGems on-chain (secondary) + Giftstat floor prices (for valuation only). " +
      "Returns: top holders with gift counts, buy/sell volumes, strategy classification (accumulating/distributing/trading). " +
      "Note: sampled from recent sales (up to 300 per collection per source) — not exhaustive ownership data. " +
      "Automatically saves snapshot to database for delta tracking. " +
      "For complex whale analysis: use chart_dashboard (NOT chart_generate) — create 2-3 charts with return_url_only=true, then compose into dashboard. " +
      "IMPORTANT: Always write analysis text FIRST (in Russian for DM/channel), then send chart. Text before chart, never chart-only.",

    parameters: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: "Collection slug or name to analyze (e.g. 'PlushPepe', 'HeartLocket'). If omitted, analyzes across multiple top collections.",
        },
        collection_address: {
          type: "string",
          description: "On-chain collection address. If provided, used directly for GetGems API calls.",
        },
        period_days: {
          type: "integer",
          description: "Period to analyze in days (default: 14). Max 30.",
        },
        top_n: {
          type: "integer",
          description: "Number of top whales to return (default: 10)",
        },
        save_snapshot: {
          type: "boolean",
          description: "Save results as daily snapshot for delta tracking (default: true)",
        },
      },
    },

    execute: async (params, context) => {
      try {
        const periodDays = Math.min(params.period_days || 14, 30);
        const topN = params.top_n || 10;
        const cutoffTime = Math.floor(Date.now() / 1000) - periodDays * 86400;

        sdk.log.info(`whale_tracker: collection=${params.collection || "multi"}, period=${periodDays}d`);

        let collectionAddress = params.collection_address;
        let collectionSlug = params.collection || null;

        const floors = await getFloorPrices();

        let allSales = [];
        let getgemsBlocked = false;
        const skipGems = shouldSkipGetgems();

        const hasMarketApp = !!process.env.MARKETAPP_API_TOKEN;
        const sources = skipGems ? [] : ["getgems"];
        if (hasMarketApp) sources.push("marketapp");

        const log = (...a) => sdk.log.info(...a);
        if (skipGems) sdk.log.info(`whale_tracker: GetGems skipped (empty streak: ${_getgemsState.emptyStreak}), using MarketApp-only`);

        if (collectionAddress) {
          const [gemsSales, maSales] = await Promise.all([
            skipGems ? Object.assign([], { _blocked: false }) : getCollectionSales(collectionAddress, 300, log),
            hasMarketApp ? getMarketAppSales(collectionAddress, 100, log) : [],
          ]);
          if (gemsSales._blocked) getgemsBlocked = true;
          allSales = deduplicateSales([
            ...gemsSales.map((s) => ({ ...s, source: "getgems" })),
            ...maSales,
          ]);
        } else if (collectionSlug) {
          const collections = await getGiftCollections();
          const match = collections.find(
            (c) =>
              (c.slug || "").toLowerCase() === collectionSlug.toLowerCase() ||
              (c.name || "").toLowerCase() === collectionSlug.toLowerCase()
          );
          if (match && match.address) {
            collectionAddress = match.address;
            sdk.log.info(`whale_tracker: resolved ${collectionSlug} → ${collectionAddress} (giftstat)`);
          } else {
            const aliasMatch = resolveCollectionByAlias(collectionSlug);
            if (aliasMatch) {
              collectionAddress = aliasMatch.address;
              sdk.log.info(`whale_tracker: resolved ${collectionSlug} → ${collectionAddress} (alias: ${aliasMatch.slug})`);
            } else {
              sdk.log.info(`whale_tracker: collection "${collectionSlug}" not found in Giftstat (${collections.length}) or aliases`);
            }
          }
          if (collectionAddress) {
            const [gemsSales, maSales] = await Promise.all([
              skipGems ? Object.assign([], { _blocked: false }) : getCollectionSales(collectionAddress, 300, log),
              hasMarketApp ? getMarketAppSales(collectionAddress, 100, log) : [],
            ]);
            if (gemsSales._blocked) getgemsBlocked = true;
            allSales = deduplicateSales([
              ...gemsSales.map((s) => ({ ...s, source: "getgems" })),
              ...maSales,
            ]);
          }
        }

        if (!collectionAddress) {
          const collections = await getGiftCollections();
          const topCollections = collections
            .filter((c) => c.address && c.total_supply > 100)
            .sort((a, b) => (b.total_supply || 0) - (a.total_supply || 0))
            .slice(0, 20);

          sdk.log.info(`whale_tracker: multi-collection mode, scanning ${Math.min(topCollections.length, 10)} collections`);

          const salesPromises = topCollections.slice(0, 10).map(async (col) => {
            const [gemsSales, maSales] = await Promise.all([
              skipGems ? Object.assign([], { _blocked: false }) : getCollectionSales(col.address, 100, log),
              hasMarketApp ? getMarketAppSales(col.address, 50, log) : [],
            ]);
            if (gemsSales._blocked) getgemsBlocked = true;
            return deduplicateSales([
              ...gemsSales.map((s) => ({ ...s, source: "getgems", collection: col.slug || col.name })),
              ...maSales.map((s) => ({ ...s, collection: col.slug || col.name })),
            ]);
          });

          const results = await Promise.all(salesPromises);
          allSales = results.flat();
        }

        sdk.log.info(`whale_tracker: ${allSales.length} total sales fetched (sources: ${sources.join(",")}), filtering to last ${periodDays}d`);

        const recentSales = allSales.filter((s) => s.time >= cutoffTime);

        const analysis = analyzeWhales(
          recentSales, allSales, collectionSlug, collectionAddress, floors, topN
        );
        const { topBuyers, buyerStats, sellerStats, totalVolume, avgPrice, isSampled } = analysis;

        let snapshotsSaved = 0;
        if (params.save_snapshot !== false && db) {
          snapshotsSaved = saveSnapshot(db, sdk, collectionSlug, topBuyers, floors);
        }

        if (recentSales.length === 0) {
          let noDataReason;
          if (allSales.length === 0 && getgemsBlocked && !hasMarketApp) {
            noDataReason = "GetGems API blocked (403) and MarketApp token not configured. No data sources available.";
          } else if (allSales.length === 0 && getgemsBlocked) {
            noDataReason = "GetGems API blocked (403). MarketApp returned no sales for these collections.";
          } else if (allSales.length === 0) {
            noDataReason = "No sales data found from any source for these collections.";
          } else {
            noDataReason = `Found ${allSales.length} total sales but none within the last ${periodDays} days.`;
          }
          return {
            success: true,
            data: {
              period_days: periodDays,
              collection: collectionSlug || "multi-collection",
              sources,
              total_sales_analyzed: 0,
              total_sales_fetched: allSales.length,
              top_whales: [],
              getgems_blocked: getgemsBlocked,
              no_data_reason: noDataReason,
            },
            summary: `Нет данных о whale-активности за последние ${periodDays} дней. Используй anomaly_detector и gift_floor_prices для альтернативного анализа рынка.`,
          };
        }

        return {
          success: true,
          data: {
            period_days: periodDays,
            collection: collectionSlug || "multi-collection",
            sources,
            total_sales_analyzed: recentSales.length,
            total_sales_fetched: allSales.length,
            sampled: isSampled,
            coverage_note: isSampled
              ? "Data sampled from recent sales — some activity may be missing"
              : "All available sales in period analyzed",
            total_volume_ton: +totalVolume.toFixed(2),
            avg_price_ton: +avgPrice.toFixed(2),
            unique_buyers: Object.keys(buyerStats).length,
            unique_sellers: Object.keys(sellerStats).length,
            top_whales: topBuyers,
            getgems_blocked: getgemsBlocked,
            snapshot_saved: snapshotsSaved > 0,
            snapshots_count: snapshotsSaved,
          },
          summary: topBuyers.length > 0
            ? `Топ-кит: ${topBuyers[0].wallet_address.slice(0, 8)}...${topBuyers[0].wallet_address.slice(-4)} — ${topBuyers[0].bought_count} покупок, ${topBuyers[0].bought_volume_ton} TON, стратегия: ${topBuyers[0].strategy}. Всего ${recentSales.length} сделок за ${periodDays}д.`
            : `Нет whale-активности за ${periodDays} дней.`,
        };
      } catch (err) {
        sdk.log.error(`whale_tracker error: ${err.message}`);
        return { success: false, error: String(err.message || err).slice(0, 500) };
      }
    },
  };

  const anomalyDetector = {
    name: "anomaly_detector",
    category: "data-bearing",
    description:
      "Detect price and volume anomalies in gift markets (heuristic analysis). Analyzes daily floor price and volume data " +
      "to find wash trading, price manipulation, and unusual spikes. " +
      "Classification: volume spike + price spike + revert next day = wash trading (heuristic); " +
      "volume spike + price holds = organic demand; single trade >> avg = whale buy. " +
      "Data from Giftstat price history. " +
      "Use with chart_dashboard for complex analysis (combine with floor charts and whale data). " +
      "IMPORTANT: Always write analysis in Russian for DM/channel. Text analysis FIRST, then chart.",

    parameters: {
      type: "object",
      properties: {
        period_days: {
          type: "integer",
          description: "Analysis period in days (default: 14, max: 30)",
        },
        sensitivity: {
          type: "number",
          description: "Anomaly threshold in standard deviations (default: 2.5). Lower = more sensitive.",
        },
        collections: {
          type: "array",
          items: { type: "string" },
          description: "Filter to specific collection slugs. If omitted, analyzes all available collections.",
        },
        marketplace: {
          type: "string",
          enum: ["portals", "tonnel", "getgems"],
          description: "Marketplace for price history (default: portals)",
        },
      },
    },

    execute: async (params, context) => {
      try {
        const periodDays = Math.min(params.period_days || 14, 30);
        const sensitivity = params.sensitivity || 2.5;
        const marketplace = params.marketplace || "portals";

        sdk.log.info(`anomaly_detector: period=${periodDays}d, sensitivity=${sensitivity}, marketplace=${marketplace}`);

        const priceHistory = await getPriceHistory(marketplace, periodDays);

        if (!priceHistory || priceHistory.length === 0) {
          return { success: false, error: "No price history data available from Giftstat" };
        }

        const collectionData = {};
        for (const entry of priceHistory) {
          const slug = (entry.slug || entry.collection || "").toLowerCase();
          if (!slug) continue;
          if (params.collections && params.collections.length > 0) {
            if (!params.collections.some((c) => c.toLowerCase() === slug)) continue;
          }
          if (!collectionData[slug]) collectionData[slug] = [];
          collectionData[slug].push({
            date: entry.date || entry.timestamp,
            floor: entry.floor_price || entry.floor || 0,
            volume: entry.volume || entry.total_volume || 0,
            trades: entry.trades || entry.total_trades || 0,
            avg_price: entry.avg_price || 0,
          });
        }

        const anomalies = [];
        const collectionSummaries = {};

        for (const [slug, dataPoints] of Object.entries(collectionData)) {
          if (dataPoints.length < 3) continue;

          const sorted = dataPoints.sort((a, b) => new Date(a.date) - new Date(b.date));

          const floors = sorted.map((d) => d.floor).filter((f) => f > 0);
          const volumes = sorted.map((d) => d.volume).filter((v) => v > 0);
          const trades = sorted.map((d) => d.trades).filter((t) => t > 0);

          const floorMean = floors.length > 0 ? floors.reduce((a, b) => a + b, 0) / floors.length : 0;
          const floorStd = floors.length > 1
            ? Math.sqrt(floors.reduce((sum, v) => sum + (v - floorMean) ** 2, 0) / (floors.length - 1))
            : 0;

          const volumeMean = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
          const volumeStd = volumes.length > 1
            ? Math.sqrt(volumes.reduce((sum, v) => sum + (v - volumeMean) ** 2, 0) / (volumes.length - 1))
            : 0;

          const tradesMean = trades.length > 0 ? trades.reduce((a, b) => a + b, 0) / trades.length : 0;

          collectionSummaries[slug] = {
            data_points: sorted.length,
            floor_mean: +floorMean.toFixed(2),
            floor_std: +floorStd.toFixed(2),
            volume_mean: +volumeMean.toFixed(2),
            trades_mean: +tradesMean.toFixed(0),
          };

          for (let i = 0; i < sorted.length; i++) {
            const day = sorted[i];
            const prevDay = i > 0 ? sorted[i - 1] : null;
            const nextDay = i < sorted.length - 1 ? sorted[i + 1] : null;

            const floorDeviation = floorStd > 0 ? (day.floor - floorMean) / floorStd : 0;
            const volumeDeviation = volumeStd > 0 ? (day.volume - volumeMean) / volumeStd : 0;

            const isFloorSpike = Math.abs(floorDeviation) > sensitivity;
            const isVolumeSpike = volumeDeviation > sensitivity;

            if (!isFloorSpike && !isVolumeSpike) continue;

            const floorRevertedNextDay =
              nextDay && prevDay && day.floor > 0 && prevDay.floor > 0
                ? Math.abs(nextDay.floor - prevDay.floor) / prevDay.floor < 0.15
                : false;

            const priceMultiplier =
              prevDay && prevDay.floor > 0 && day.floor > 0
                ? day.floor / prevDay.floor
                : 1;

            let classification = "unknown";
            let severity = "low";

            if (isVolumeSpike && isFloorSpike && floorRevertedNextDay) {
              classification = "wash_trading";
              severity = "high";
            } else if (isVolumeSpike && isFloorSpike && !floorRevertedNextDay) {
              classification = "organic_demand";
              severity = "medium";
            } else if (isVolumeSpike && !isFloorSpike) {
              classification = "volume_spike";
              severity = "medium";
            } else if (isFloorSpike && floorDeviation > 0) {
              classification = "price_pump";
              severity = priceMultiplier > 3 ? "high" : "medium";
            } else if (isFloorSpike && floorDeviation < 0) {
              classification = "price_dump";
              severity = priceMultiplier < 0.5 ? "high" : "medium";
            }

            anomalies.push({
              collection: slug,
              date: day.date,
              classification,
              severity,
              floor_price: +day.floor.toFixed(2),
              floor_deviation: +floorDeviation.toFixed(1),
              volume: +day.volume.toFixed(2),
              volume_deviation: +volumeDeviation.toFixed(1),
              trades: day.trades,
              price_multiplier: +priceMultiplier.toFixed(1),
              reverted_next_day: floorRevertedNextDay,
              avg_price: day.avg_price > 0 ? +day.avg_price.toFixed(2) : null,
            });
          }
        }

        anomalies.sort((a, b) => {
          const severityOrder = { high: 0, medium: 1, low: 2 };
          return (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3);
        });

        const washTradingCount = anomalies.filter((a) => a.classification === "wash_trading").length;
        const pricePumpCount = anomalies.filter((a) => a.classification === "price_pump").length;
        const highSeverityCount = anomalies.filter((a) => a.severity === "high").length;

        return {
          success: true,
          data: {
            period_days: periodDays,
            marketplace,
            sensitivity,
            collections_analyzed: Object.keys(collectionData).length,
            total_anomalies: anomalies.length,
            wash_trading_events: washTradingCount,
            price_pump_events: pricePumpCount,
            high_severity: highSeverityCount,
            anomalies: anomalies.slice(0, 20),
            collection_baselines: collectionSummaries,
          },
          summary: anomalies.length > 0
            ? `Found ${anomalies.length} anomalies: ${washTradingCount} wash trading, ${pricePumpCount} price pumps, ${highSeverityCount} high severity`
            : "No anomalies detected in this period",
        };
      } catch (err) {
        sdk.log.error(`anomaly_detector error: ${err.message}`);
        return { success: false, error: String(err.message || err).slice(0, 500) };
      }
    },
  };

  const whaleSnapshots = {
    name: "whale_snapshots",
    category: "data-bearing",
    description:
      "Query stored whale snapshots and compute deltas between dates. " +
      "Shows how whale holdings changed over time — who accumulated, who dumped, new entrants. " +
      "Snapshots are automatically saved by whale_tracker. " +
      "Use 'compare' mode with two dates to see portfolio changes (delta tracking). " +
      "Use with chart_generate to visualize trends (multi_line: whale holdings over time).",

    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["latest", "history", "compare"],
          description: "Query mode: 'latest' = most recent snapshot, 'history' = all snapshots for a wallet, 'compare' = delta between two dates",
        },
        collection: {
          type: "string",
          description: "Filter by collection slug",
        },
        wallet_address: {
          type: "string",
          description: "Filter by specific wallet (for history mode)",
        },
        date_from: {
          type: "string",
          description: "Start date for compare mode (YYYY-MM-DD)",
        },
        date_to: {
          type: "string",
          description: "End date for compare mode (YYYY-MM-DD). Defaults to today.",
        },
        limit: {
          type: "integer",
          description: "Max results to return (default: 20)",
        },
      },
    },

    execute: async (params, context) => {
      if (!db) {
        return { success: false, error: "Database not available — plugin needs migrate() support" };
      }

      try {
        const mode = params.mode || "latest";
        const limit = params.limit || 20;

        if (mode === "latest") {
          const dateRow = db.prepare(
            "SELECT MAX(snapshot_date) as latest FROM whale_snapshots" +
            (params.collection ? " WHERE collection = ?" : "")
          ).get(...(params.collection ? [params.collection] : []));

          if (!dateRow?.latest) {
            return { success: true, data: { snapshots: [], note: "No snapshots yet. Run whale_tracker first to collect data." } };
          }

          let query = "SELECT * FROM whale_snapshots WHERE snapshot_date = ?";
          const queryParams = [dateRow.latest];
          if (params.collection) {
            query += " AND collection = ?";
            queryParams.push(params.collection);
          }
          query += " ORDER BY net_accumulation DESC LIMIT ?";
          queryParams.push(limit);

          const rows = db.prepare(query).all(...queryParams);

          return {
            success: true,
            data: {
              snapshot_date: dateRow.latest,
              count: rows.length,
              snapshots: rows.map((r) => ({
                wallet: r.wallet_address,
                collection: r.collection,
                bought: r.bought_count,
                sold: r.sold_count,
                net: r.net_accumulation,
                bought_ton: r.bought_volume_ton,
                sold_ton: r.sold_volume_ton,
                strategy: r.strategy,
                floor_ton: r.floor_ton,
              })),
            },
          };
        }

        if (mode === "history") {
          if (!params.wallet_address && !params.collection) {
            return { success: false, error: "history mode requires wallet_address or collection" };
          }

          let query = "SELECT * FROM whale_snapshots WHERE 1=1";
          const queryParams = [];
          if (params.wallet_address) {
            query += " AND wallet_address = ?";
            queryParams.push(params.wallet_address);
          }
          if (params.collection) {
            query += " AND collection = ?";
            queryParams.push(params.collection);
          }
          query += " ORDER BY snapshot_date DESC LIMIT ?";
          queryParams.push(limit);

          const rows = db.prepare(query).all(...queryParams);

          return {
            success: true,
            data: {
              count: rows.length,
              history: rows.map((r) => ({
                date: r.snapshot_date,
                wallet: r.wallet_address,
                collection: r.collection,
                bought: r.bought_count,
                sold: r.sold_count,
                net: r.net_accumulation,
                strategy: r.strategy,
                floor_ton: r.floor_ton,
              })),
            },
          };
        }

        if (mode === "compare") {
          if (!params.date_from) {
            return { success: false, error: "compare mode requires date_from (YYYY-MM-DD)" };
          }

          const dateTo = params.date_to || new Date().toISOString().slice(0, 10);
          const dateFrom = params.date_from;

          let whereClause = "";
          const baseParams = [];
          if (params.collection) {
            whereClause = " AND collection = ?";
            baseParams.push(params.collection);
          }

          const fromRows = db.prepare(
            `SELECT * FROM whale_snapshots WHERE snapshot_date = ?${whereClause}`
          ).all(dateFrom, ...baseParams);

          const toRows = db.prepare(
            `SELECT * FROM whale_snapshots WHERE snapshot_date = ?${whereClause}`
          ).all(dateTo, ...baseParams);

          const fromMap = {};
          for (const r of fromRows) {
            fromMap[`${r.collection}:${r.wallet_address}`] = r;
          }

          const toMap = {};
          for (const r of toRows) {
            toMap[`${r.collection}:${r.wallet_address}`] = r;
          }

          const allKeys = new Set([...Object.keys(fromMap), ...Object.keys(toMap)]);
          const deltas = [];

          for (const key of allKeys) {
            const from = fromMap[key];
            const to = toMap[key];
            const [collection, wallet] = key.split(":");

            deltas.push({
              wallet,
              collection,
              from_date: dateFrom,
              to_date: dateTo,
              bought_delta: (to?.bought_count || 0) - (from?.bought_count || 0),
              sold_delta: (to?.sold_count || 0) - (from?.sold_count || 0),
              net_delta: (to?.net_accumulation || 0) - (from?.net_accumulation || 0),
              volume_delta_ton: +((to?.bought_volume_ton || 0) - (from?.bought_volume_ton || 0)).toFixed(2),
              strategy_from: from?.strategy || "new_entrant",
              strategy_to: to?.strategy || "exited",
              floor_from: from?.floor_ton || null,
              floor_to: to?.floor_ton || null,
              is_new: !from,
              has_exited: !to,
            });
          }

          deltas.sort((a, b) => Math.abs(b.net_delta) - Math.abs(a.net_delta));

          const accumulators = deltas.filter((d) => d.net_delta > 0);
          const distributors = deltas.filter((d) => d.net_delta < 0);
          const newEntrants = deltas.filter((d) => d.is_new);

          return {
            success: true,
            data: {
              date_from: dateFrom,
              date_to: dateTo,
              total_wallets: deltas.length,
              accumulators: accumulators.length,
              distributors: distributors.length,
              new_entrants: newEntrants.length,
              deltas: deltas.slice(0, limit),
            },
            summary: `${dateFrom} → ${dateTo}: ${accumulators.length} accumulating, ${distributors.length} distributing, ${newEntrants.length} new entrants`,
          };
        }

        return { success: false, error: `Unknown mode: ${mode}. Use latest, history, or compare.` };
      } catch (err) {
        sdk.log.error(`whale_snapshots error: ${err.message}`);
        return { success: false, error: String(err.message || err).slice(0, 500) };
      }
    },
  };

  const dataSources = {
    name: "data_sources",
    category: "data-bearing",
    description:
      "Check current health and status of all whale-analytics data sources (GetGems, MarketApp, Giftstat). " +
      "Shows: API status, GetGems empty streak counter, whether GetGems is being skipped, last status transition, " +
      "and time since last check. Use this to diagnose data issues or verify source availability. " +
      "If GetGems shows 'skipped' — system automatically switched to MarketApp-only mode after consecutive empty responses.",

    parameters: {
      type: "object",
      properties: {
        recheck: {
          type: "boolean",
          description: "Force a fresh health check of all sources right now (default: false — returns cached state)",
        },
      },
    },

    execute: async (params) => {
      try {
        if (params.recheck) {
          const log = (...a) => sdk.log.info(...a);
          const results = await testDataSources(log);
          return {
            success: true,
            fresh: true,
            sources: results,
            getgems_state: {
              status: _getgemsState.status,
              empty_streak: _getgemsState.emptyStreak,
              skipped_in_snapshots: _getgemsState.skipUntilRecheck,
              last_checked: _getgemsState.lastChecked ? new Date(_getgemsState.lastChecked).toISOString() : null,
              last_ok: _getgemsState.lastOkTime ? new Date(_getgemsState.lastOkTime).toISOString() : null,
              last_transition: _getgemsState.lastTransition,
              recheck_interval_hours: GETGEMS_RECHECK_INTERVAL_MS / 3600000,
              skip_threshold: GETGEMS_SKIP_AFTER_STREAK,
            },
          };
        }

        const elapsed = _getgemsState.lastChecked ? Math.round((Date.now() - _getgemsState.lastChecked) / 60000) : null;

        return {
          success: true,
          fresh: false,
          getgems_state: {
            status: _getgemsState.status,
            empty_streak: _getgemsState.emptyStreak,
            skipped_in_snapshots: _getgemsState.skipUntilRecheck,
            last_checked: _getgemsState.lastChecked ? new Date(_getgemsState.lastChecked).toISOString() : null,
            last_checked_minutes_ago: elapsed,
            last_ok: _getgemsState.lastOkTime ? new Date(_getgemsState.lastOkTime).toISOString() : null,
            last_transition: _getgemsState.lastTransition,
            recheck_interval_hours: GETGEMS_RECHECK_INTERVAL_MS / 3600000,
            skip_threshold: GETGEMS_SKIP_AFTER_STREAK,
          },
          hint: "Use recheck=true to run a fresh health check of all sources",
        };
      } catch (err) {
        sdk.log.error(`data_sources error: ${err.message}`);
        return { success: false, error: err.message };
      }
    },
  };

  return [whaleTracker, anomalyDetector, whaleSnapshots, dataSources];
};

let _schedulerTimer = null;
let _initialTimeout = null;
let _schedulerRunning = false;
let _schedulerStarted = false;

const _getgemsState = {
  status: "unknown",
  emptyStreak: 0,
  lastChecked: 0,
  lastTransition: null,
  lastOkTime: 0,
  skipUntilRecheck: false,
};
const GETGEMS_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const GETGEMS_SKIP_AFTER_STREAK = 3;

async function runAutoSnapshot(db, log, topN, maxCollections) {
  if (_schedulerRunning) return;
  _schedulerRunning = true;

  try {
    log("Auto-snapshot: starting daily snapshot run...");

    const collections = await getGiftCollections();
    const topCollections = collections
      .filter((c) => c.address && c.total_supply > 100)
      .sort((a, b) => (b.total_supply || 0) - (a.total_supply || 0))
      .slice(0, maxCollections);

    if (topCollections.length === 0) {
      log("Auto-snapshot: no collections found, skipping");
      return;
    }

    const floors = await getFloorPrices();
    const hasMarketApp = !!process.env.MARKETAPP_API_TOKEN;
    let totalSaved = 0;
    let processed = 0;

    const skipGems = shouldSkipGetgems();
    if (skipGems) {
      log(`Auto-snapshot: GetGems skipped (empty streak: ${_getgemsState.emptyStreak}, recheck in ${Math.round((GETGEMS_RECHECK_INTERVAL_MS - (Date.now() - _getgemsState.lastChecked)) / 60000)}min)`);
    }
    if (hasMarketApp) log(`Auto-snapshot: MarketApp token found, mode=${skipGems ? "MarketApp-only" : "multi-source"}`);

    let gemsHadData = false;
    let gemsCheckedThisRun = false;

    for (const col of topCollections) {
      try {
        const colName = col.slug || col.name || "unknown";
        const [gemsSales, maSales] = await Promise.all([
          skipGems ? Object.assign([], { _blocked: false, _skipped: true }) : getCollectionSales(col.address, 200, log),
          hasMarketApp ? getMarketAppSales(col.address, 100, log) : [],
        ]);
        if (!gemsSales._skipped) {
          gemsCheckedThisRun = true;
          if (gemsSales.length > 0 && !gemsSales._blocked) gemsHadData = true;
        }
        const gemsStatus = gemsSales._skipped ? "skipped" : gemsSales._blocked ? "blocked" : gemsSales.length === 0 ? "empty" : `${gemsSales.length}`;
        log(`Auto-snapshot ${colName}: GetGems=${gemsStatus} sales, MarketApp=${maSales.length} sales`);
        const allSales = deduplicateSales([
          ...gemsSales.map((s) => ({ ...s, source: "getgems" })),
          ...maSales,
        ]);
        if (allSales.length === 0) {
          log(`Auto-snapshot ${colName}: 0 total sales after dedup, skipping`);
          continue;
        }

        const cutoff = Math.floor(Date.now() / 1000) - 14 * 86400;
        const recentSales = allSales.filter((s) => s.time >= cutoff);
        log(`Auto-snapshot ${colName}: ${allSales.length} total, ${recentSales.length} recent (14d), cutoff=${cutoff}, sample_time=${allSales[0]?.time || 0}`);
        if (recentSales.length < 3) {
          log(`Auto-snapshot ${colName}: only ${recentSales.length} recent sales (<3), skipping`);
          continue;
        }

        const slug = col.slug || col.name || "unknown";
        const analysis = analyzeWhales(recentSales, allSales, slug, col.address, floors, topN);
        const sdkMock = { log: { info: (...a) => log(...a), error: (...a) => log(...a) } };
        const saved = saveSnapshot(db, sdkMock, slug, analysis.topBuyers, floors);
        totalSaved += saved;
        processed++;

        await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        log(`Auto-snapshot: error for ${col.slug || col.name}: ${err.message}`);
      }
    }

    if (gemsCheckedThisRun) {
      updateGetgemsState(gemsHadData ? "ok" : "empty_data", log);
      log(`Auto-snapshot: GetGems state updated → ${_getgemsState.status} (streak: ${_getgemsState.emptyStreak})`);
    }

    log(`Auto-snapshot: completed — ${totalSaved} snapshots saved across ${processed}/${topCollections.length} collections`);
  } catch (err) {
    log(`Auto-snapshot: run failed — ${err.message}`);
  } finally {
    _schedulerRunning = false;
  }
}

function updateGetgemsState(newStatus, log) {
  const prev = _getgemsState.status;
  _getgemsState.lastChecked = Date.now();

  if (newStatus === "ok") {
    if (prev !== "ok" && prev !== "unknown") {
      log(`⚡ GetGems RECOVERED: ${prev} → ok (was empty for ${_getgemsState.emptyStreak} checks)`);
      _getgemsState.lastTransition = { from: prev, to: "ok", at: new Date().toISOString() };
    }
    _getgemsState.emptyStreak = 0;
    _getgemsState.lastOkTime = Date.now();
    _getgemsState.skipUntilRecheck = false;
  } else if (newStatus === "empty_data") {
    _getgemsState.emptyStreak++;
    if (prev === "ok") {
      log(`⚠ GetGems DEGRADED: ok → empty_data (streak: ${_getgemsState.emptyStreak})`);
      _getgemsState.lastTransition = { from: "ok", to: "empty_data", at: new Date().toISOString() };
    }
    if (_getgemsState.emptyStreak >= GETGEMS_SKIP_AFTER_STREAK && !_getgemsState.skipUntilRecheck) {
      log(`GetGems: ${_getgemsState.emptyStreak} consecutive empty responses — switching to MarketApp-only mode. Will recheck in ${GETGEMS_RECHECK_INTERVAL_MS / 3600000}h`);
      _getgemsState.skipUntilRecheck = true;
    }
  } else {
    if (prev === "ok") {
      log(`⚠ GetGems ERROR: ok → ${newStatus}`);
      _getgemsState.lastTransition = { from: "ok", to: newStatus, at: new Date().toISOString() };
    }
    _getgemsState.emptyStreak++;
    if (_getgemsState.emptyStreak >= GETGEMS_SKIP_AFTER_STREAK) {
      _getgemsState.skipUntilRecheck = true;
    }
  }

  _getgemsState.status = newStatus;
}

function shouldSkipGetgems() {
  if (!_getgemsState.skipUntilRecheck) return false;
  const elapsed = Date.now() - _getgemsState.lastChecked;
  if (elapsed >= GETGEMS_RECHECK_INTERVAL_MS) {
    _getgemsState.skipUntilRecheck = false;
    return false;
  }
  return true;
}

async function testDataSources(log) {
  const results = { getgems: "unknown", marketapp: "unknown", giftstat: "unknown" };

  try {
    const gemsKey = process.env.GETGEMS_API_KEY;
    if (!gemsKey) {
      results.getgems = "no_api_key";
      log(`GetGems health: no API key configured`);
    } else {
      const params = new URLSearchParams();
      params.set("limit", "5");
      params.append("types[]", "sold");
      const res = await fetch(
        `https://api.getgems.io/public-api/v1/nfts/history/gifts?${params}`,
        { headers: { Accept: "application/json", Authorization: gemsKey }, signal: AbortSignal.timeout(10000) }
      );
      if (res.ok) {
        const raw = await res.json();
        const data = raw.response !== undefined ? raw.response : raw;
        const items = data.items || (Array.isArray(data) ? data : []);
        if (items.length > 0) {
          results.getgems = "ok";
          log(`GetGems health: OK (${items.length} gift sale events)`);
        } else {
          log(`GetGems health: HTTP 200 but 0 items from nfts/history/gifts endpoint`);
          results.getgems = "empty_data";
        }
      } else {
        const body = await res.text().catch(() => "");
        log(`GetGems health check ${res.status}: ${body.substring(0, 300)}`);
        results.getgems = `error_${res.status}`;
      }
    }
  } catch (err) {
    results.getgems = `error: ${err.message}`;
  }

  updateGetgemsState(results.getgems, log);

  try {
    const token = process.env.MARKETAPP_API_TOKEN;
    if (!token) {
      results.marketapp = "no_token";
    } else {
      const params = new URLSearchParams({ limit: "1" });
      const res = await fetch(`${MARKETAPP_API}/gifts/history/?${params}`, {
        headers: { Authorization: token },
        signal: AbortSignal.timeout(10000),
      });
      results.marketapp = res.ok ? "ok" : `error_${res.status}`;
    }
  } catch (err) {
    results.marketapp = `error: ${err.message}`;
  }

  try {
    const res = await fetch("https://api.giftstat.app/current/collections/floor?marketplace=portals&limit=1", {
      signal: AbortSignal.timeout(10000),
    });
    results.giftstat = res.ok ? "ok" : `error_${res.status}`;
  } catch (err) {
    results.giftstat = `error: ${err.message}`;
  }

  const skipInfo = _getgemsState.skipUntilRecheck ? " [SKIPPED in snapshots]" : "";
  log(`Data source health: GetGems=${results.getgems}${skipInfo} (streak:${_getgemsState.emptyStreak}), MarketApp=${results.marketapp}, Giftstat=${results.giftstat}`);
  return results;
}

export async function start(ctx) {
  if (_schedulerStarted) return;

  const config = ctx.pluginConfig || {};
  if (config.auto_snapshot === false) {
    ctx.log("Auto-snapshot disabled via config");
    return;
  }

  if (!ctx.db) {
    ctx.log("Auto-snapshot: no database available, skipping scheduler");
    return;
  }

  _schedulerStarted = true;

  testDataSources(ctx.log).catch((err) => ctx.log(`Data source test error: ${err.message}`));

  const intervalHours = config.auto_snapshot_interval_hours || 24;
  const topN = config.auto_snapshot_top_n || 10;
  const maxCollections = config.auto_snapshot_max_collections || 10;
  const intervalMs = intervalHours * 60 * 60 * 1000;

  ctx.log(`Auto-snapshot scheduler: every ${intervalHours}h, top ${topN} whales, ${maxCollections} collections`);

  const initialDelay = 60 * 1000;
  _initialTimeout = setTimeout(() => {
    _initialTimeout = null;
    runAutoSnapshot(ctx.db, ctx.log, topN, maxCollections);

    _schedulerTimer = setInterval(() => {
      runAutoSnapshot(ctx.db, ctx.log, topN, maxCollections);
    }, intervalMs);
  }, initialDelay);
}

export async function stop() {
  if (_initialTimeout) {
    clearTimeout(_initialTimeout);
    _initialTimeout = null;
  }
  if (_schedulerTimer) {
    clearInterval(_schedulerTimer);
    _schedulerTimer = null;
  }
  _schedulerRunning = false;
  _schedulerStarted = false;
}
