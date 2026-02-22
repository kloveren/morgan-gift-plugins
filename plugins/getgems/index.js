/**
 * Getgems plugin -- NFT marketplace on TON
 *
 * Browse collections, view NFTs, check traits/offers/history,
 * and buy or list NFTs on the Getgems marketplace.
 * Trading tools sign transactions from the agent wallet at ~/.teleton/wallet.json.
 */

import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// CJS dependencies (resolve from teleton runtime)
// ---------------------------------------------------------------------------

const _require = createRequire(realpathSync(process.argv[1]));

const { Address, SendMode, Cell } = _require("@ton/core");
const { WalletContractV5R1, TonClient, internal } = _require("@ton/ton");
const { mnemonicToPrivateKey } = _require("@ton/crypto");

export const manifest = {
  name: "getgems",
  version: "1.0.0",
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://api.getgems.io/public-api/v1/";
const _TELETON_DIR = process.env.TELETON_HOME || join(homedir(), ".teleton");
const WALLET_FILE = join(_TELETON_DIR, "wallet.json");

function toRawAddr(addr) {
  try {
    return Address.parse(addr).toRawString();
  } catch {
    return addr;
  }
}

// ---------------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------------

function getApiKey(context) {
  const key = context?.config?.getgems_api_key;
  if (key) return key;
  if (process.env.GETGEMS_API_KEY) return process.env.GETGEMS_API_KEY;
  try {
    return readFileSync(join(_TELETON_DIR, "getgems.key"), "utf-8").trim();
  } catch {}
  throw new Error(
    "Getgems API key not found. Set getgems_api_key in ~/.teleton/config.yaml, GETGEMS_API_KEY env var, or create ~/.teleton/getgems.key"
  );
}

// ---------------------------------------------------------------------------
// Rate limiter + cache (400 req / 5 min = ~1.3 req/s, we cap at 1 req/s)
// ---------------------------------------------------------------------------

const _cache = new Map();
const CACHE_TTL_MS = 60_000;
const CACHE_TTL_LONG_MS = 120_000;
const LONG_CACHE_PATHS = ["collections/top", "gifts/collections", "gifts/collections/top", "collection/stats/", "collection/basic-info/"];

function getCacheTtl(path) {
  for (const p of LONG_CACHE_PATHS) {
    if (path.includes(p)) return CACHE_TTL_LONG_MS;
  }
  return CACHE_TTL_MS;
}

function cacheKey(method, path, paramsOrBody) {
  return `${method}:${path}:${JSON.stringify(paramsOrBody)}`;
}

function getFromCache(key) {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return undefined;
  }
  return entry.data;
}

function setCache(key, data, ttlMs) {
  _cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  if (_cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of _cache) {
      if (now > v.expiresAt) _cache.delete(k);
    }
  }
}

let _lastRequestTime = 0;
const MIN_INTERVAL_MS = 800;
let _requestCount5m = 0;
let _windowStart = Date.now();
const MAX_REQUESTS_5M = 350;

async function throttle() {
  const now = Date.now();
  if (now - _windowStart > 300_000) {
    _requestCount5m = 0;
    _windowStart = now;
  }
  if (_requestCount5m >= MAX_REQUESTS_5M) {
    const waitMs = 300_000 - (now - _windowStart) + 1000;
    console.warn(`[getgems] Rate limit window almost full (${_requestCount5m}/${MAX_REQUESTS_5M}), waiting ${Math.round(waitMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, waitMs));
    _requestCount5m = 0;
    _windowStart = Date.now();
  }
  const elapsed = now - _lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
  _lastRequestTime = Date.now();
  _requestCount5m++;
}

// ---------------------------------------------------------------------------
// Shared API helper
// ---------------------------------------------------------------------------

async function gemsApi(path, context, params = {}, _retries = 3) {
  const ck = cacheKey("GET", path, params);
  const cached = getFromCache(ck);
  if (cached !== undefined) return cached;

  await throttle();

  const apiKey = getApiKey(context);
  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      if (Array.isArray(v)) {
        v.forEach((item) => url.searchParams.append(k, item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  const res = await fetch(url, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429 && _retries > 0) {
    const retryAfter = Math.min(Number(res.headers.get("retry-after") || 5), 30);
    const delay = retryAfter * 1000 + Math.random() * 1000;
    console.warn(`[getgems] 429 rate limited, waiting ${Math.round(delay / 1000)}s (retries left: ${_retries - 1})`);
    await new Promise((r) => setTimeout(r, delay));
    return gemsApi(path, context, params, _retries - 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Getgems API ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  const result = json.response !== undefined ? json.response : json;
  setCache(ck, result, getCacheTtl(path));
  return result;
}

async function gemsPost(path, context, body = {}, _retries = 3) {
  await throttle();

  const apiKey = getApiKey(context);
  const url = new URL(path, API_BASE);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429 && _retries > 0) {
    const retryAfter = Math.min(Number(res.headers.get("retry-after") || 5), 30);
    const delay = retryAfter * 1000 + Math.random() * 1000;
    console.warn(`[getgems] 429 rate limited on POST, waiting ${Math.round(delay / 1000)}s`);
    await new Promise((r) => setTimeout(r, delay));
    return gemsPost(path, context, body, _retries - 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Getgems API ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.response !== undefined ? json.response : json;
}

// ---------------------------------------------------------------------------
// Price conversion
// ---------------------------------------------------------------------------

function fromNano(nano) {
  if (!nano) return null;
  return Number(nano) / 1e9;
}

// ---------------------------------------------------------------------------
// Wallet helper
// ---------------------------------------------------------------------------

async function getWalletAndClient() {
  let walletData;
  try {
    walletData = JSON.parse(readFileSync(WALLET_FILE, "utf-8"));
  } catch {
    throw new Error("Agent wallet not found at " + WALLET_FILE);
  }
  if (!walletData.mnemonic || !Array.isArray(walletData.mnemonic)) {
    throw new Error("Invalid wallet file: missing mnemonic array");
  }

  const keyPair = await mnemonicToPrivateKey(walletData.mnemonic);
  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });

  let endpoint;
  try {
    const { getHttpEndpoint } = _require("@orbs-network/ton-access");
    endpoint = await getHttpEndpoint({ network: "mainnet" });
  } catch {
    endpoint = "https://toncenter.com/api/v2/jsonRPC";
  }

  const client = new TonClient({ endpoint });
  const contract = client.open(wallet);
  return { wallet, keyPair, client, contract };
}

async function sendGetgemsTransaction(txResponse) {
  const { wallet, keyPair, contract } = await getWalletAndClient();
  const seqno = await contract.getSeqno();

  const messages = txResponse.list.map((item) => {
    const msg = {
      to: Address.parse(item.to),
      value: BigInt(item.amount),
      bounce: true,
    };
    if (item.payload) {
      msg.body = Cell.fromBoc(Buffer.from(item.payload, "base64"))[0];
    }
    if (item.stateInit) {
      msg.init = Cell.fromBoc(Buffer.from(item.stateInit, "base64"))[0];
    }
    return internal(msg);
  });

  await contract.sendTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    messages,
  });

  return { wallet_address: wallet.address.toString(), seqno };
}

// ---------------------------------------------------------------------------
// Tool 1: getgems_top_collections
// ---------------------------------------------------------------------------

const topCollections = {
  name: "getgems_top_collections",
  category: "data-bearing",
  description:
    "SECONDARY for collection browsing (use gift_collections from Giftstat FIRST for gift data). Get top NFT collections on Getgems ranked by trading volume. Includes Anonymous Telegram Numbers, Telegram Usernames, Telegram Gift NFTs, and other NFT collections. Filter by time period (day/week/month/all).",

  parameters: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["day", "week", "month", "all"],
        description: "Time period for volume ranking (default: day)",
      },
      limit: {
        type: "integer",
        description: "Number of results (1-100, default: 10)",
        minimum: 1,
        maximum: 100,
      },
    },
  },

  execute: async (params, context) => {
    try {
      const kind = params.kind ?? "day";
      const limit = params.limit ?? 10;
      const data = await gemsApi("collections/top", context, { kind, limit });
      const rawItems = Array.isArray(data) ? data : (data.items ?? []);

      const items = rawItems.map((item) => ({
        rank: item.place,
        name: item.collection?.name ?? null,
        address: item.collection?.address ?? null,
        volume_ton: fromNano(item.value),
        floor_price_ton: fromNano(item.floorPrice),
        change_percent: item.diffPercent ?? null,
      }));

      return { success: true, data: { collections: items, count: items.length, period: kind } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 2: getgems_collection_info
// ---------------------------------------------------------------------------

const collectionInfo = {
  name: "getgems_collection_info",
  category: "data-bearing",
  description:
    "SECONDARY for collection info (use gift_collections from Giftstat FIRST for gift pricing/supply). Get detailed info about an NFT collection on Getgems including social links, royalty, floor price, and description.",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Collection contract address",
      },
    },
    required: ["address"],
  },

  execute: async (params, context) => {
    try {
      const data = await gemsApi(
        `collection/basic-info/${toRawAddr(params.address)}`,
        context
      );
      return { success: true, data };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 3: getgems_collection_stats
// ---------------------------------------------------------------------------

const collectionStats = {
  name: "getgems_collection_stats",
  category: "data-bearing",
  description:
    "SECONDARY for collection stats (use gift_collections/gift_floor_prices from Giftstat FIRST). Get collection statistics: floor price, total volume sold, item count, and number of unique holders.",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Collection contract address",
      },
    },
    required: ["address"],
  },

  execute: async (params, context) => {
    try {
      const data = await gemsApi(
        `collection/stats/${toRawAddr(params.address)}`,
        context
      );
      return {
        success: true,
        data: {
          floor_price_ton: fromNano(data.floorPriceNano ?? data.floorPrice),
          items_count: data.itemsCount ?? null,
          total_volume_ton: fromNano(data.totalVolumeSoldNano ?? data.totalVolumeSold),
          holders: data.holders ?? null,
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 4: getgems_collection_attributes
// ---------------------------------------------------------------------------

const collectionAttributes = {
  name: "getgems_collection_attributes",
  category: "data-bearing",
  description:
    "SECONDARY for trait/rarity data (use gift_models/gift_model_stats from Giftstat FIRST for gift model data). Get all traits and rarity data for a collection, including floor price per trait value.",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Collection contract address",
      },
    },
    required: ["address"],
  },

  execute: async (params, context) => {
    try {
      const data = await gemsApi(
        `collection/attributes/${toRawAddr(params.address)}`,
        context
      );

      const rawAttrs = Array.isArray(data) ? data : (data.attributes ?? data.items ?? []);
      const attributes = rawAttrs.map((attr) => ({
        trait_type: attr.traitType,
        values: (attr.values ?? []).map((v) => ({
          value: v.value,
          count: v.count,
          min_price_ton: fromNano(v.minPriceNano ?? v.minPrice),
        })),
      }));

      return { success: true, data: { attributes, count: attributes.length } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 5: getgems_collection_history
// ---------------------------------------------------------------------------

const collectionHistory = {
  name: "getgems_collection_history",
  category: "data-bearing",
  description:
    "SECONDARY for transaction history (use marketapp_gifts_history as PRIMARY for gift sale transactions). Get activity history for a collection: sales, transfers, mints, listings, auctions, burns. Returns NFT names, addresses, prices, buyers/sellers for each event. For general price data use Giftstat. Supports filtering by event type and cursor pagination.",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Collection contract address",
      },
      types: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "mint",
            "transfer",
            "sold",
            "cancelSale",
            "putUpForSale",
            "putUpForAuction",
            "cancelAuction",
            "burn",
          ],
        },
        description: "Filter by event types (e.g. [\"sold\", \"transfer\"])",
      },
      limit: {
        type: "integer",
        description: "Number of results (1-100, default: 20)",
        minimum: 1,
        maximum: 100,
      },
      after: {
        type: "string",
        description: "Cursor for pagination (from previous response)",
      },
    },
    required: ["address"],
  },

  execute: async (params, context) => {
    try {
      const queryParams = {
        limit: params.limit ?? 20,
        after: params.after,
      };
      if (Array.isArray(params.types) && params.types.length > 0) {
        queryParams.types = params.types;
      }
      const data = await gemsApi(
        `collection/history/${toRawAddr(params.address)}`,
        context,
        queryParams
      );
      const items = (data.items ?? []).map((item) => {
        const e = {
          nft_name: item.name ?? null,
          nft_address: item.address,
          type: item.typeData?.type ?? "unknown",
          time: item.time,
        };
        if (item.typeData?.priceNano) e.price_ton = fromNano(item.typeData.priceNano);
        else if (item.typeData?.price) e.price_ton = item.typeData.price;
        if (item.typeData?.currency) e.currency = item.typeData.currency;
        if (item.typeData?.newOwner) e.new_owner = item.typeData.newOwner;
        if (item.typeData?.oldOwner) e.old_owner = item.typeData.oldOwner;
        if (item.typeData?.owner) e.owner = item.typeData.owner;
        return e;
      });
      return { success: true, data: { items, cursor: data.cursor ?? null, count: items.length } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 6: getgems_nft_info
// ---------------------------------------------------------------------------

const nftInfo = {
  name: "getgems_nft_info",
  category: "data-bearing",
  description:
    "Get full details for a specific NFT by its contract address: owner, sale status, price, attributes, image, and collection. Shows if the NFT is listed for sale or at auction. Tip: if you only have a name (like a phone number), use getgems_find_nft to search, or get the NFT address from Fragment/TONAPI first.",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "NFT item contract address",
      },
    },
    required: ["address"],
  },

  execute: async (params, context) => {
    try {
      const data = await gemsApi(
        `nft/${encodeURIComponent(params.address)}`,
        context
      );

      const result = {
        address: data.address,
        name: data.name ?? null,
        description: data.description ?? null,
        collection_address: data.collectionAddress ?? null,
        owner: data.actualOwnerAddress ?? data.ownerAddress ?? null,
        image: data.image ?? null,
        attributes: data.attributes ?? [],
        warning: data.warning ?? null,
      };

      if (data.sale) {
        if (data.sale.fullPrice) {
          result.sale = {
            type: "fixed_price",
            price_ton: fromNano(data.sale.fullPrice),
            currency: data.sale.currency ?? "TON",
            marketplace: data.sale.marketplace ?? null,
            sale_address: data.sale.saleAddress ?? null,
            version: data.sale.version ?? null,
          };
        } else if (data.sale.maxBid !== undefined || data.sale.currentBid !== undefined) {
          result.sale = {
            type: "auction",
            current_bid_ton: fromNano(data.sale.currentBid),
            min_bid_ton: fromNano(data.sale.minBid),
            max_bid_ton: fromNano(data.sale.maxBid),
            bids_count: data.sale.bidsCount ?? 0,
            end_time: data.sale.endTime ?? null,
          };
        } else {
          result.sale = data.sale;
        }
      } else {
        result.sale = null;
      }

      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 7: getgems_nft_history
// ---------------------------------------------------------------------------

const nftHistory = {
  name: "getgems_nft_history",
  category: "data-bearing",
  description:
    "Get trade and transfer history for a specific NFT. Supports filtering by event type and cursor pagination.",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "NFT item contract address",
      },
      types: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "mint",
            "transfer",
            "sold",
            "cancelSale",
            "putUpForSale",
            "putUpForAuction",
            "cancelAuction",
            "burn",
          ],
        },
        description: "Filter by event types",
      },
      limit: {
        type: "integer",
        description: "Number of results (1-100, default: 20)",
        minimum: 1,
        maximum: 100,
      },
      after: {
        type: "string",
        description: "Cursor for pagination",
      },
    },
    required: ["address"],
  },

  execute: async (params, context) => {
    try {
      const queryParams = {
        limit: params.limit ?? 20,
        after: params.after,
      };
      if (Array.isArray(params.types) && params.types.length > 0) {
        queryParams.types = params.types;
      }
      const data = await gemsApi(
        `nft/history/${encodeURIComponent(params.address)}`,
        context,
        queryParams
      );
      return { success: true, data };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 8: getgems_nfts_on_sale
// ---------------------------------------------------------------------------

const nftsOnSale = {
  name: "getgems_nfts_on_sale",
  category: "data-bearing",
  description:
    "Get NFTs currently listed for sale in a collection. Returns sale price, owner, name, and NFT details with cursor pagination. Works for all collections: Anonymous Telegram Numbers, Usernames, Gifts, etc. Use getgems_find_nft to search for a specific NFT by name/number.",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Collection contract address",
      },
      limit: {
        type: "integer",
        description: "Number of results (1-100, default: 20)",
        minimum: 1,
        maximum: 100,
      },
      after: {
        type: "string",
        description: "Cursor for pagination",
      },
    },
    required: ["address"],
  },

  execute: async (params, context) => {
    try {
      const data = await gemsApi(
        `nfts/on-sale/${encodeURIComponent(params.address)}`,
        context,
        { limit: params.limit ?? 20, after: params.after }
      );
      return { success: true, data };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 9: getgems_nft_offers
// ---------------------------------------------------------------------------

const nftOffers = {
  name: "getgems_nft_offers",
  category: "data-bearing",
  description:
    "Get active buy offers on a specific NFT, including offer price, royalty fees, and expiration time.",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "NFT item contract address",
      },
      limit: {
        type: "integer",
        description: "Number of results (1-100, default: 20)",
        minimum: 1,
        maximum: 100,
      },
    },
    required: ["address"],
  },

  execute: async (params, context) => {
    try {
      const data = await gemsApi(
        `offers/nft/${encodeURIComponent(params.address)}`,
        context,
        { limit: params.limit ?? 20 }
      );

      const rawOffers = Array.isArray(data) ? data : (data.items ?? []);
      const offers = rawOffers.map((o) => ({
        offer_address: o.offerAddress ?? null,
        price_ton: fromNano(o.fullPrice),
        profit_ton: fromNano(o.profitPrice),
        royalty_ton: fromNano(o.royaltyPrice),
        fee_ton: fromNano(o.feePrice),
        currency: o.currency ?? "TON",
        expires_at: o.finishAt ?? null,
        is_collection_offer: o.isCollectionOffer ?? false,
        nft_address: o.nftAddress ?? null,
        collection_address: o.collectionAddress ?? null,
      }));

      return { success: true, data: { offers, count: offers.length } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 10: getgems_owner_nfts
// ---------------------------------------------------------------------------

const ownerNfts = {
  name: "getgems_owner_nfts",
  category: "data-bearing",
  description:
    "Get all NFTs owned by a wallet address on Getgems. Returns NFT details with cursor pagination.",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Owner wallet address",
      },
      limit: {
        type: "integer",
        description: "Number of results (1-100, default: 20)",
        minimum: 1,
        maximum: 100,
      },
      after: {
        type: "string",
        description: "Cursor for pagination",
      },
    },
    required: ["address"],
  },

  execute: async (params, context) => {
    try {
      const data = await gemsApi(
        `nfts/owner/${encodeURIComponent(params.address)}`,
        context,
        { limit: params.limit ?? 20, after: params.after }
      );
      return { success: true, data };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 11: getgems_user_trading
// ---------------------------------------------------------------------------

const userTrading = {
  name: "getgems_user_trading",
  category: "data-bearing",
  description:
    "Get trading statistics for a user: number of trades, total volume, and current balance on Getgems.",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "User wallet address",
      },
    },
    required: ["address"],
  },

  execute: async (params, context) => {
    try {
      const data = await gemsApi(
        `user-trading-info/${encodeURIComponent(params.address)}`,
        context
      );
      return {
        success: true,
        data: {
          trading_count: data.tradingCount ?? null,
          trading_volume_ton: fromNano(data.tradingVolume),
          balance_ton: fromNano(data.balance),
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 12: getgems_gift_collections
// ---------------------------------------------------------------------------

const giftCollections = {
  name: "getgems_gift_collections",
  category: "data-bearing",
  description:
    "List Telegram Gift NFT collections on Getgems. Returns collection details with cursor pagination.",

  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        description: "Number of results (1-100, default: 20)",
        minimum: 1,
        maximum: 100,
      },
      after: {
        type: "string",
        description: "Cursor for pagination",
      },
    },
  },

  execute: async (params, context) => {
    try {
      const data = await gemsApi("gifts/collections", context, {
        limit: params.limit ?? 20,
        after: params.after,
      });
      return { success: true, data };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 13: getgems_buy_nft
// ---------------------------------------------------------------------------

const buyNft = {
  name: "getgems_buy_nft",
  category: "action",
  description:
    "Buy an NFT listed for fixed-price sale on Getgems. Signs and sends the purchase transaction from the agent wallet. The NFT must currently be listed for sale.",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "NFT item contract address to buy",
      },
    },
    required: ["address"],
  },

  execute: async (params, context) => {
    const steps = [];
    try {
      // Step 1: Get NFT info and sale version
      const nft = await gemsApi(
        `nft/${encodeURIComponent(params.address)}`,
        context
      );
      steps.push("fetched NFT info");

      if (!nft.sale || !nft.sale.fullPrice) {
        throw new Error("NFT is not listed for fixed-price sale");
      }

      const version = nft.sale.version;
      if (!version) {
        throw new Error("Sale version not found on NFT sale object");
      }

      const priceTon = fromNano(nft.sale.fullPrice);
      steps.push(`sale price: ${priceTon} TON, version: ${version}`);

      // Step 2: Get buy transaction from Getgems
      const tx = await gemsPost(
        `nfts/buy-fix-price/${encodeURIComponent(params.address)}`,
        context,
        { version }
      );
      steps.push(`got transaction: ${tx.list?.length ?? 0} messages`);

      if (!tx.list || tx.list.length === 0) {
        throw new Error("Getgems returned empty transaction list");
      }

      // Step 3: Sign and send
      const result = await sendGetgemsTransaction(tx);
      steps.push("transaction sent");

      return {
        success: true,
        data: {
          nft_address: params.address,
          nft_name: nft.name ?? null,
          price_ton: priceTon,
          wallet_address: result.wallet_address,
          seqno: result.seqno,
          messages_sent: tx.list.length,
          steps,
          message: "Buy transaction sent. Allow ~30 seconds for on-chain confirmation.",
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500), steps };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 14: getgems_list_nft
// ---------------------------------------------------------------------------

const listNft = {
  name: "getgems_list_nft",
  category: "action",
  description:
    "List an NFT for fixed-price sale on Getgems. Sets the sale price and signs the listing transaction from the agent wallet. The agent must own the NFT.",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "NFT item contract address to list",
      },
      price: {
        type: "string",
        description: "Sale price in TON (e.g. \"5.5\" for 5.5 TON)",
      },
      currency: {
        type: "string",
        description: "Currency for the listing (default: TON)",
      },
    },
    required: ["address", "price"],
  },

  execute: async (params, context) => {
    const steps = [];
    try {
      const priceTon = Number(params.price);
      if (isNaN(priceTon) || priceTon <= 0) {
        throw new Error("price must be a positive number in TON");
      }

      // Get wallet address for ownerAddress field
      const { wallet } = await getWalletAndClient();
      const ownerAddress = wallet.address.toString();
      steps.push("resolved wallet: " + ownerAddress);

      // Convert to nanoTON string
      const fullPrice = BigInt(Math.round(priceTon * 1e9)).toString();
      steps.push(`price: ${params.price} TON = ${fullPrice} nanoTON`);

      // POST to put-on-sale
      const tx = await gemsPost(
        `nfts/put-on-sale-fix-price/${encodeURIComponent(params.address)}`,
        context,
        {
          ownerAddress,
          fullPrice,
          currency: params.currency ?? "TON",
        }
      );
      steps.push(`got transaction: ${tx.list?.length ?? 0} messages`);

      if (!tx.list || tx.list.length === 0) {
        throw new Error("Getgems returned empty transaction list");
      }

      // Sign and send
      const result = await sendGetgemsTransaction(tx);
      steps.push("transaction sent");

      return {
        success: true,
        data: {
          nft_address: params.address,
          price_ton: params.price,
          currency: params.currency ?? "TON",
          wallet_address: result.wallet_address,
          seqno: result.seqno,
          messages_sent: tx.list.length,
          steps,
          message: "Listing transaction sent. Allow ~30 seconds for on-chain confirmation.",
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500), steps };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 15: getgems_collection_nfts
// ---------------------------------------------------------------------------

const collectionNfts = {
  name: "getgems_collection_nfts",
  category: "data-bearing",
  description:
    "List ALL NFTs in a collection (not just on-sale). Returns NFT addresses, names, owners, and sale status. Useful for browsing Anonymous Telegram Numbers, Usernames, Gifts, and other collections. For searching by name use getgems_find_nft.",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description:
          "Collection contract address. Known: Anonymous Numbers = EQAOQdwdw8kGftJCSFgOErM1mBjYPe4DBPq8-AhF6vr9si5N, Usernames = EQCA14o1-VWhS2efqoh_9M1b_A9DtKTuoqfmkn83AbJzwnPi",
      },
      limit: {
        type: "integer",
        description: "Number of results (1-100, default: 20)",
        minimum: 1,
        maximum: 100,
      },
      after: {
        type: "string",
        description: "Cursor for pagination",
      },
    },
    required: ["address"],
  },

  execute: async (params, context) => {
    try {
      const data = await gemsApi(
        `nfts/collection/${toRawAddr(params.address)}`,
        context,
        { limit: params.limit ?? 20, after: params.after }
      );
      const rawItems = Array.isArray(data) ? data : (data.items ?? []);

      const items = rawItems.map((item) => {
        const entry = {
          address: item.address,
          name: item.name ?? null,
          owner: item.actualOwnerAddress ?? item.ownerAddress ?? null,
          has_sale: !!item.sale,
        };
        if (item.sale) {
          if (item.sale.fullPrice) {
            entry.sale_type = "fixed_price";
            entry.price_ton = fromNano(item.sale.fullPrice);
          } else if (item.sale.minBid !== undefined) {
            entry.sale_type = "auction";
            entry.min_bid_ton = fromNano(item.sale.minBid);
            entry.last_bid_ton = item.sale.lastBidAmount ? fromNano(item.sale.lastBidAmount) : null;
          }
        }
        return entry;
      });

      return {
        success: true,
        data: { items, count: items.length, cursor: data.cursor ?? null },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 16: getgems_find_nft
// ---------------------------------------------------------------------------

const findNft = {
  name: "getgems_find_nft",
  category: "data-bearing",
  description:
    "Search for a specific NFT by name within a Getgems collection. Scans recent collection history events and current on-sale listings to find NFTs matching the query. Best for small/medium collections. For high-volume collections (100K+ items like Anonymous Numbers), only finds NFTs with very recent activity. If not found, use fragment_nft to get the NFT address, then getgems_nft_info for Getgems details. Also returns collection floor price for context.",

  parameters: {
    type: "object",
    properties: {
      collection_address: {
        type: "string",
        description:
          "Collection contract address. Known collections: Anonymous Telegram Numbers = EQAOQdwdw8kGftJCSFgOErM1mBjYPe4DBPq8-AhF6vr9si5N, Telegram Usernames = EQCA14o1-VWhS2efqoh_9M1b_A9DtKTuoqfmkn83AbJzwnPi",
      },
      query: {
        type: "string",
        description:
          "Name or number to search for (case-insensitive substring match). Examples: '8888321' for phone number +888 8 321, 'durov' for @durov username",
      },
      max_pages: {
        type: "integer",
        description:
          "Maximum history pages to scan (1-10, default 5). Each page = 100 events. More pages = slower but deeper search.",
        minimum: 1,
        maximum: 10,
      },
    },
    required: ["collection_address", "query"],
  },

  execute: async (params, context) => {
    try {
      const query = params.query.toLowerCase().replace(/[\s\-\+]/g, "");
      const maxPages = params.max_pages ?? 5;
      const matches = new Map();

      let collectionStats = null;
      try {
        const stats = await gemsApi(
          `collection/stats/${toRawAddr(params.collection_address)}`,
          context
        );
        collectionStats = {
          floor_price_ton: fromNano(stats.floorPriceNano ?? stats.floorPrice),
          items_count: stats.itemsCount ?? null,
          total_volume_ton: fromNano(stats.totalVolumeSoldNano ?? stats.totalVolumeSold),
        };
      } catch {}

      const addMatch = (name, address, event) => {
        if (!matches.has(address)) {
          matches.set(address, { name, address, events: [] });
        }
        matches.get(address).events.push(event);
      };

      const nameMatches = (name) => {
        if (!name) return false;
        const normalized = name.toLowerCase().replace(/[\s\-\+]/g, "");
        return normalized.includes(query);
      };

      let cursor = undefined;
      let pagesScanned = 0;

      for (let page = 0; page < maxPages; page++) {
        const data = await gemsApi(
          `collection/history/${toRawAddr(params.collection_address)}`,
          context,
          {
            limit: 100,
            after: cursor,
            types: ["sold", "transfer", "putUpForSale", "putUpForAuction", "cancelSale"],
          }
        );
        const items = data.items ?? [];
        pagesScanned++;

        for (const item of items) {
          if (nameMatches(item.name)) {
            const event = {
              type: item.typeData?.type ?? "unknown",
              time: item.time,
              price_ton: item.typeData?.priceNano
                ? fromNano(item.typeData.priceNano)
                : (item.typeData?.price ?? null),
            };
            if (item.typeData?.newOwner) event.new_owner = item.typeData.newOwner;
            if (item.typeData?.oldOwner) event.old_owner = item.typeData.oldOwner;
            if (item.typeData?.owner) event.owner = item.typeData.owner;
            if (item.typeData?.currency) event.currency = item.typeData.currency;
            addMatch(item.name, item.address, event);
          }
        }

        if (!data.cursor || items.length < 100) break;
        cursor = data.cursor;
      }

      let onSaleMatch = null;
      try {
        let saleCursor = undefined;
        for (let p = 0; p < 3; p++) {
          const saleData = await gemsApi(
            `nfts/on-sale/${toRawAddr(params.collection_address)}`,
            context,
            { limit: 100, after: saleCursor }
          );
          const saleItems = saleData.items ?? [];

          for (const item of saleItems) {
            if (nameMatches(item.name)) {
              onSaleMatch = {
                address: item.address,
                name: item.name,
                owner: item.actualOwnerAddress ?? item.ownerAddress,
                sale_type: item.sale?.type ?? null,
                price_ton: item.sale?.fullPrice
                  ? fromNano(item.sale.fullPrice)
                  : item.sale?.lastBidAmount
                    ? fromNano(item.sale.lastBidAmount)
                    : null,
                min_bid_ton: item.sale?.minBid ? fromNano(item.sale.minBid) : null,
              };
              break;
            }
          }

          if (onSaleMatch || !saleData.cursor || saleItems.length < 100) break;
          saleCursor = saleData.cursor;
        }
      } catch {}

      const results = Array.from(matches.values());

      if (results.length === 0 && !onSaleMatch) {
        return {
          success: true,
          data: {
            found: false,
            query: params.query,
            pages_scanned: pagesScanned,
            collection_stats: collectionStats,
            message:
              "No NFT found matching this query in recent history or current listings. The NFT may exist but hasn't had recent activity on Getgems. High-volume collections (100K+ items) have too many events to scan fully.",
            hint:
              "Try: 1) Use fragment_nft or fragment_item to find the NFT address, then getgems_nft_info to check it on Getgems. 2) Use getgems_collection_stats and getgems_recent_sales to verify price claims against floor price.",
          },
        };
      }

      return {
        success: true,
        data: {
          found: true,
          query: params.query,
          pages_scanned: pagesScanned,
          collection_stats: collectionStats,
          history_matches: results,
          on_sale: onSaleMatch,
          hint: results.length > 0
            ? "Use getgems_nft_info with the NFT address for full details."
            : null,
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 16: getgems_recent_sales
// ---------------------------------------------------------------------------

const recentSales = {
  name: "getgems_recent_sales",
  category: "data-bearing",
  description:
    "SECONDARY for recent sales (use marketapp_gifts_history as PRIMARY for gift sale history). Get recent NFT sales from a collection on Getgems with formatted prices and names. Use as fallback when MarketApp is unavailable. Works for all collections including Anonymous Telegram Numbers and Telegram Usernames.",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description:
          "Collection contract address. Known: Anonymous Numbers = EQAOQdwdw8kGftJCSFgOErM1mBjYPe4DBPq8-AhF6vr9si5N, Usernames = EQCA14o1-VWhS2efqoh_9M1b_A9DtKTuoqfmkn83AbJzwnPi",
      },
      limit: {
        type: "integer",
        description: "Number of sales to return (1-100, default: 20)",
        minimum: 1,
        maximum: 100,
      },
      after: {
        type: "string",
        description: "Cursor for pagination",
      },
    },
    required: ["address"],
  },

  execute: async (params, context) => {
    try {
      const data = await gemsApi(
        `collection/history/${toRawAddr(params.address)}`,
        context,
        { limit: params.limit ?? 20, after: params.after, types: ["sold"] }
      );

      const items = (data.items ?? []).map((item) => ({
        nft_name: item.name ?? null,
        nft_address: item.address,
        price_ton: item.typeData?.priceNano
          ? fromNano(item.typeData.priceNano)
          : (item.typeData?.price ?? null),
        currency: item.typeData?.currency ?? "TON",
        buyer: item.typeData?.newOwner ?? null,
        seller: item.typeData?.oldOwner ?? null,
        time: item.time,
      }));

      return {
        success: true,
        data: {
          sales: items,
          count: items.length,
          cursor: data.cursor ?? null,
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 18: getgems_top_gift_collections
// ---------------------------------------------------------------------------

const topGiftCollections = {
  name: "getgems_top_gift_collections",
  category: "data-bearing",
  description:
    "SECONDARY for gift collection rankings (use gift_collections/gift_floor_prices from Giftstat FIRST). Get top Telegram Gift NFT collections on Getgems ranked by volume/floor price. Returns gift-specific collection data including floor prices, volumes, and holder counts.",

  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        description: "Number of results (1-100, default: 20)",
        minimum: 1,
        maximum: 100,
      },
      after: {
        type: "string",
        description: "Cursor for pagination",
      },
    },
  },

  execute: async (params, context) => {
    try {
      const data = await gemsApi("gifts/collections/top", context, {
        limit: params.limit ?? 20,
        after: params.after,
      });
      const rawItems = Array.isArray(data) ? data : (data.items ?? []);
      const items = rawItems.map((item) => ({
        name: item.collection?.name ?? item.name ?? null,
        address: item.collection?.address ?? item.address ?? null,
        floor_price_ton: fromNano(item.floorPrice ?? item.collection?.floorPrice),
        volume_ton: fromNano(item.value ?? item.volume),
        holders: item.holders ?? item.collection?.holders ?? null,
        items_count: item.itemsCount ?? item.collection?.itemsCount ?? null,
        change_percent: item.diffPercent ?? null,
      }));
      return { success: true, data: { collections: items, count: items.length, cursor: data.cursor ?? null } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 19: getgems_gift_history
// ---------------------------------------------------------------------------

const giftHistory = {
  name: "getgems_gift_history",
  category: "data-bearing",
  description:
    "SECONDARY for cross-collection gift activity (use marketapp_gifts_history as PRIMARY for gift sale transactions). " +
    "Get recent activity history across ALL Telegram Gift NFT collections on Getgems: sales, transfers, listings, cancellations. " +
    "Unlike getgems_collection_history (which requires a specific collection address), this endpoint shows gift events across all collections. " +
    "Use as fallback for whale tracking when MarketApp is unavailable.",

  parameters: {
    type: "object",
    properties: {
      types: {
        type: "array",
        items: {
          type: "string",
          enum: ["mint", "transfer", "sold", "cancelSale", "putUpForSale", "putUpForAuction", "cancelAuction", "burn"],
        },
        description: 'Filter by event types (e.g. ["sold", "transfer"]). Default: all types.',
      },
      limit: {
        type: "integer",
        description: "Number of results (1-100, default: 30)",
        minimum: 1,
        maximum: 100,
      },
      after: {
        type: "string",
        description: "Cursor for pagination (from previous response)",
      },
    },
  },

  execute: async (params, context) => {
    try {
      const queryParams = {
        limit: params.limit ?? 30,
        after: params.after,
      };
      if (Array.isArray(params.types) && params.types.length > 0) {
        queryParams.types = params.types;
      }
      const data = await gemsApi("nfts/history/gifts", context, queryParams);
      const rawItems = Array.isArray(data) ? data : (data.items ?? []);

      const items = rawItems.map((item) => {
        const e = {
          nft_name: item.name ?? null,
          nft_address: item.address ?? null,
          collection_name: item.collectionName ?? item.collection?.name ?? null,
          collection_address: item.collectionAddress ?? item.collection?.address ?? null,
          type: item.typeData?.type ?? item.type ?? "unknown",
          time: item.time ?? null,
        };
        if (item.typeData?.priceNano) e.price_ton = fromNano(item.typeData.priceNano);
        else if (item.typeData?.price) e.price_ton = item.typeData.price;
        if (item.typeData?.currency) e.currency = item.typeData.currency;
        if (item.typeData?.newOwner) e.new_owner = item.typeData.newOwner;
        if (item.typeData?.oldOwner) e.old_owner = item.typeData.oldOwner;
        if (item.typeData?.owner) e.owner = item.typeData.owner;
        return e;
      });

      return { success: true, data: { items, count: items.length, cursor: data.cursor ?? null } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 20: getgems_offchain_gifts_on_sale
// ---------------------------------------------------------------------------

const offchainGiftsOnSale = {
  name: "getgems_offchain_gifts_on_sale",
  category: "data-bearing",
  description:
    "Get Telegram Gifts currently listed for off-chain sale on Getgems. " +
    "Off-chain gifts haven't been minted to NFT yet — they exist in Telegram's system and are traded via Getgems marketplace. " +
    "Returns gift names, prices, sellers, and collection info. Useful for price discovery, finding deals below floor, and monitoring gift supply.",

  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        description: "Number of results (1-100, default: 30)",
        minimum: 1,
        maximum: 100,
      },
      after: {
        type: "string",
        description: "Cursor for pagination",
      },
    },
  },

  execute: async (params, context) => {
    try {
      const data = await gemsApi("nfts/offchain/on-sale/gifts", context, {
        limit: params.limit ?? 30,
        after: params.after,
      });
      const rawItems = Array.isArray(data) ? data : (data.items ?? []);

      const items = rawItems.map((item) => {
        const e = {
          name: item.name ?? null,
          address: item.address ?? null,
          collection_name: item.collectionName ?? item.collection?.name ?? null,
          collection_address: item.collectionAddress ?? item.collection?.address ?? null,
          owner: item.actualOwnerAddress ?? item.ownerAddress ?? null,
          image: item.image ?? null,
        };
        if (item.sale) {
          if (item.sale.fullPrice) {
            e.price_ton = fromNano(item.sale.fullPrice);
            e.sale_type = "fixed_price";
          } else if (item.sale.minBid !== undefined) {
            e.sale_type = "auction";
            e.min_bid_ton = fromNano(item.sale.minBid);
            e.last_bid_ton = item.sale.lastBidAmount ? fromNano(item.sale.lastBidAmount) : null;
          }
          e.currency = item.sale.currency ?? "TON";
        }
        return e;
      });

      return { success: true, data: { items, count: items.length, cursor: data.cursor ?? null } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 21: getgems_collection_top_owners
// ---------------------------------------------------------------------------

const collectionTopOwners = {
  name: "getgems_collection_top_owners",
  category: "data-bearing",
  description:
    "SECONDARY for whale/holder data (use whale_tracker for comprehensive whale analysis with MarketApp+GetGems combined). " +
    "Get top holders/owners of an NFT collection on Getgems, ranked by number of items owned. " +
    "Useful for holder concentration metrics and identifying major collectors.",

  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Collection contract address",
      },
      limit: {
        type: "integer",
        description: "Number of top owners (1-100, default: 20)",
        minimum: 1,
        maximum: 100,
      },
    },
    required: ["address"],
  },

  execute: async (params, context) => {
    try {
      const data = await gemsApi(
        `collection/top-owners/${toRawAddr(params.address)}`,
        context,
        { limit: params.limit ?? 20 }
      );
      const rawItems = Array.isArray(data) ? data : (data.items ?? []);
      const owners = rawItems.map((item) => ({
        address: item.ownerAddress ?? item.address ?? null,
        count: item.count ?? item.nftsCount ?? null,
      }));
      return { success: true, data: { owners, count: owners.length } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const tools = [
  topCollections,
  collectionInfo,
  collectionStats,
  collectionAttributes,
  collectionHistory,
  nftInfo,
  nftHistory,
  nftsOnSale,
  nftOffers,
  ownerNfts,
  userTrading,
  giftCollections,
  buyNft,
  listNft,
  collectionNfts,
  findNft,
  recentSales,
  topGiftCollections,
  giftHistory,
  offchainGiftsOnSale,
  collectionTopOwners,
];
