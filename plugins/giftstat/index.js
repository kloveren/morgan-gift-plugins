/**
 * Giftstat plugin -- Telegram gift ANALYTICS from giftstat.app
 *
 * IMPORTANT: Giftstat is an ANALYTICS and DATA AGGREGATION tool, NOT a marketplace.
 * You CANNOT buy or sell gifts on Giftstat. It only provides market data and statistics.
 * Actual marketplaces where you can buy/sell gifts: Fragment, GetGems, MarketApp, Tonnel, swap.coffee (Thermos).
 *
 * Provides real-time and historical data on Telegram gift collections,
 * floor prices, model variants, backdrops, symbols, and TON exchange rates.
 * All data comes from the public Giftstat API (no auth required).
 */

export const manifest = {
  id: "giftstat",
  name: "giftstat",
  version: "2.0.0",
  description: "Telegram gift market analytics from giftstat.app — collections, floor prices, models, stats, history. v2 API: floor index with Bollinger bands, per-collection daily floors with marketplace breakdown",
  author: "Kloveren (t.me/morganlegacy)",
};

const API_BASE = "https://api.giftstat.app";
const API_V2_BASE = "https://apiv2.giftstat.app";

// Shared fetch helper. Builds the URL, attaches query params, and returns
// parsed JSON. Throws on non-2xx responses so callers can catch uniformly.
async function giftstatFetch(path, params = {}, base = API_BASE) {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`Giftstat API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Pagination schema fragment -- reused by most tools
// ---------------------------------------------------------------------------

const paginationProps = {
  limit: {
    type: "integer",
    description: "Maximum number of results to return",
  },
  offset: {
    type: "integer",
    description: "Number of results to skip (for pagination)",
  },
};

// ---------------------------------------------------------------------------
// Factory for simple paginated endpoints (limit + offset only)
// ---------------------------------------------------------------------------

function makePaginatedTool(name, description, path, sdk) {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: { ...paginationProps },
    },
    execute: async (params) => {
      try {
        const result = await giftstatFetch(path, {
          limit: params.limit,
          offset: params.offset,
        });
        return { success: true, data: result };
      } catch (err) {
        sdk.log.error(`${name}:`, err.message);
        return { success: false, error: err.message };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Export -- SDK wrapper
// ---------------------------------------------------------------------------

export const tools = (sdk) => {

// ---------------------------------------------------------------------------
// Tool 1: gift_collections
// Lists all gift collections with supply, pricing, and mint data.
// ---------------------------------------------------------------------------

const giftCollections = {
  name: "gift_collections",
  category: "data-bearing",
  description:
    "PRIMARY SOURCE for gift collection data. List all Telegram gift collections with supply, pricing, and mint data from Giftstat ANALYTICS (read-only data, NOT a marketplace — you cannot buy here). Use FIRST for any question about collections, supply, pricing, models, rarity. Prefer over MarketApp/GetGems for general collection info.",

  parameters: {
    type: "object",
    properties: {
      fields: {
        type: "string",
        description: "Comma-separated list of fields to return (filters the response)",
      },
      ...paginationProps,
    },
  },

  execute: async (params) => {
    try {
      const result = await giftstatFetch("/current/collections", {
        fields: params.fields,
        limit: params.limit,
        offset: params.offset,
      });
      return { success: true, data: result };
    } catch (err) {
      sdk.log.error("gift_collections:", err.message);
      return { success: false, error: err.message };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 2: gift_floor_prices
// Floor prices per marketplace. Has an extra marketplace param.
// ---------------------------------------------------------------------------

const giftFloorPrices = {
  name: "gift_floor_prices",
  category: "data-bearing",
  description:
    "PRIMARY SOURCE for floor prices. Get current floor prices for gift collections AGGREGATED BY Giftstat from all marketplaces. Use FIRST for any price/floor question — faster and more complete than querying individual marketplaces. The 'marketplace' parameter selects which marketplace's floor prices to show (portals, tonnel, fragment, getgems). Giftstat is NOT a marketplace — to buy gifts, use actual marketplaces directly.",

  parameters: {
    type: "object",
    properties: {
      marketplace: {
        type: "string",
        enum: ["portals", "tonnel", "fragment", "getgems"],
        description: "Marketplace to query (default: portals)",
      },
      ...paginationProps,
    },
  },

  execute: async (params) => {
    try {
      const result = await giftstatFetch("/current/collections/floor", {
        marketplace: params.marketplace ?? "portals",
        limit: params.limit,
        offset: params.offset,
      });
      return { success: true, data: result };
    } catch (err) {
      sdk.log.error("gift_floor_prices:", err.message);
      return { success: false, error: err.message };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 3: gift_models
// Model variants with rarity levels.
// ---------------------------------------------------------------------------

const giftModels = makePaginatedTool(
  "gift_models",
  "PRIMARY SOURCE for gift models and rarity. List gift model variants with their rarity levels. Use FIRST for any question about models, variants, rarity within a collection.",
  "/current/collections/models",
  sdk,
);

// ---------------------------------------------------------------------------
// Tool 4: gift_model_stats
// Per-model statistics: count, total amount, rarity, market share.
// ---------------------------------------------------------------------------

const giftModelStats = makePaginatedTool(
  "gift_model_stats",
  "PRIMARY SOURCE for model statistics. Get statistics per gift model: count, total amount, rarity, and market share percentage. Use FIRST for model analysis.",
  "/current/collections/models/stat",
  sdk,
);

// ---------------------------------------------------------------------------
// Tool 5: gift_model_floor
// Floor price for each model variant.
// ---------------------------------------------------------------------------

const giftModelFloor = makePaginatedTool(
  "gift_model_floor",
  "PRIMARY SOURCE for model floor prices. Get the current floor price for each gift model variant. Use FIRST for per-model pricing.",
  "/current/collections/models/floor",
  sdk,
);

// ---------------------------------------------------------------------------
// Tool 6: gift_backdrops
// Background variants with rarity data.
// ---------------------------------------------------------------------------

const giftBackdrops = makePaginatedTool(
  "gift_backdrops",
  "List available gift background variants with rarity data.",
  "/current/collections/backdrops",
  sdk,
);

// ---------------------------------------------------------------------------
// Tool 7: gift_symbols
// Symbol/pattern variants with rarity data.
// ---------------------------------------------------------------------------

const giftSymbols = makePaginatedTool(
  "gift_symbols",
  "List available gift symbol/pattern variants with rarity data.",
  "/current/collections/symbols",
  sdk,
);

// ---------------------------------------------------------------------------
// Tool 8: gift_thematics
// Thematic gift categories. No params at all.
// ---------------------------------------------------------------------------

const giftThematics = {
  name: "gift_thematics",
  category: "data-bearing",
  description: "List all thematic gift categories.",

  parameters: {
    type: "object",
    properties: {},
  },

  execute: async () => {
    try {
      const result = await giftstatFetch("/current/thematics");
      return { success: true, data: result };
    } catch (err) {
      sdk.log.error("gift_thematics:", err.message);
      return { success: false, error: err.message };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 9: gift_thematic_lines
// Lines grouped by thematic category. Paginated.
// ---------------------------------------------------------------------------

const giftThematicLines = makePaginatedTool(
  "gift_thematic_lines",
  "List curated gift lines grouped by thematic category.",
  "/current/thematics/lines",
  sdk,
);

// ---------------------------------------------------------------------------
// Tool 10: gift_ton_rate
// Current TON/USDT exchange rate. No params.
// ---------------------------------------------------------------------------

const giftTonRate = {
  name: "gift_ton_rate",
  category: "data-bearing",
  description: "Get the current TON to USDT exchange rate.",

  parameters: {
    type: "object",
    properties: {},
  },

  execute: async () => {
    try {
      const result = await giftstatFetch("/current/ton-rate");
      return { success: true, data: result };
    } catch (err) {
      sdk.log.error("gift_ton_rate:", err.message);
      return { success: false, error: err.message };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 11: gift_price_history
// Historical floor prices. Extra params: marketplace, scale, days.
// ---------------------------------------------------------------------------

const giftPriceHistory = {
  name: "gift_price_history",
  category: "data-bearing",
  description:
    "PRIMARY SOURCE for price trends and history. Get historical floor price data for gift collections. Use FIRST for any question about price trends, history, charts. Supports different time scales and date ranges.",

  parameters: {
    type: "object",
    properties: {
      marketplace: {
        type: "string",
        enum: ["portals", "tonnel", "getgems"],
        description: "Marketplace to query (default: portals)",
      },
      scale: {
        type: "string",
        enum: ["day", "hour"],
        description: "Time granularity for data points (default: day)",
      },
      days: {
        type: "integer",
        description: "Number of days of history to return",
      },
      ...paginationProps,
    },
  },

  execute: async (params) => {
    try {
      const result = await giftstatFetch("/history/collections/floor", {
        marketplace: params.marketplace ?? "portals",
        scale: params.scale ?? "day",
        days: params.days,
        limit: params.limit,
        offset: params.offset,
      });
      return { success: true, data: result };
    } catch (err) {
      sdk.log.error("gift_price_history:", err.message);
      return { success: false, error: err.message };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 12: gift_index_floor_history (v2 API)
// Market-wide gift floor index time series with Bollinger-like bands.
// ---------------------------------------------------------------------------

const giftIndexFloorHistory = {
  name: "gift_index_floor_history",
  category: "data-bearing",
  description:
    "PRIMARY SOURCE for MARKET-WIDE gift index. Returns the Gift Market Floor Index time series — an aggregate price indicator across ALL gift collections. Includes upper/lower threshold bands (similar to Bollinger bands). Data from Nov 2025, ~30min intervals. Use for: market overview charts, evening/morning posts, overall market health assessment, trend analysis. Much more useful than individual collection floors for big-picture analysis.",

  parameters: {
    type: "object",
    properties: {
      days: {
        type: "integer",
        description: "Number of recent days to return (e.g. 7 for weekly, 30 for monthly). Returns all data if omitted.",
      },
    },
  },

  execute: async (params) => {
    try {
      const result = await giftstatFetch("/history/index/floor", {}, API_V2_BASE);
      let data = Array.isArray(result) ? result : (result.data || []);

      if (params.days && data.length > 0) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - params.days);
        const cutoffTs = cutoff.getTime();
        data = data.filter((d) => {
          const dateVal = d.dt || d.datetime || d.date || d.timestamp;
          if (!dateVal) return true;
          const ts = typeof dateVal === "number" ? dateVal * 1000 : new Date(dateVal).getTime();
          return ts >= cutoffTs;
        });
      }

      if (data.length > 500) {
        const step = Math.ceil(data.length / 500);
        data = data.filter((_, i) => i % step === 0);
      }

      const sample = data[0] || {};
      const fields = Object.keys(sample).join(", ");

      return {
        success: true,
        total_points: data.length,
        fields,
        data,
        hint: "Common fields: price (floor index value), upper_threshhold/lower_threshhold (band limits), dt (datetime). Use for chart_floor with band overlay or market overview posts.",
      };
    } catch (err) {
      sdk.log.error("gift_index_floor_history:", err.message);
      return { success: false, error: err.message };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 13: gift_collection_floor_history (v2 API)
// Per-collection daily floor history with marketplace breakdown.
// ---------------------------------------------------------------------------

const giftCollectionFloorHistory = {
  name: "gift_collection_floor_history",
  category: "data-bearing",
  description:
    "PRIMARY SOURCE for per-collection floor price history with MARKETPLACE BREAKDOWN (portals, tonnel, mrkt/marketapp floors separately). Daily data. Use for: comparing marketplace prices, arbitrage detection, collection-specific trend charts. More detailed than gift_price_history (v1) which returns aggregated floors only.",

  parameters: {
    type: "object",
    properties: {
      collection: {
        type: "string",
        description: "Filter by collection name or slug (e.g. 'SnoopDogg', 'PlushPepe'). Case-sensitive slug preferred. Returns all collections if omitted.",
      },
      days: {
        type: "integer",
        description: "Number of recent days to return (e.g. 7, 30, 90). Returns all data if omitted.",
      },
      ...paginationProps,
    },
  },

  execute: async (params) => {
    try {
      const allData = [];
      let offset = 0;
      const pageSize = params.limit || 1000;
      const maxPages = 10;

      for (let page = 0; page < maxPages; page++) {
        const result = await giftstatFetch("/history/collections/floor", {
          limit: pageSize,
          offset,
        }, API_V2_BASE);

        const chunk = Array.isArray(result) ? result : (result.data || []);
        if (chunk.length === 0) break;
        allData.push(...chunk);
        if (chunk.length < pageSize) break;
        offset += chunk.length;
      }

      let data = allData;

      if (params.collection && data.length > 0) {
        const q = params.collection.toLowerCase();
        data = data.filter((d) => {
          const name = (d.collection || d.name || "").toLowerCase();
          const slug = (d.slug || d.id || "").toLowerCase();
          return name.includes(q) || slug.includes(q);
        });
      }

      if (params.days && data.length > 0) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - params.days);
        const cutoffTs = cutoff.getTime();
        data = data.filter((d) => {
          const dateVal = d.dt || d.datetime || d.date || d.timestamp;
          if (!dateVal) return true;
          const ts = typeof dateVal === "number" ? dateVal * 1000 : new Date(dateVal).getTime();
          return ts >= cutoffTs;
        });
      }

      const sample = data[0] || {};
      const fields = Object.keys(sample).join(", ");

      return {
        success: true,
        total_records: data.length,
        fields,
        data,
        hint: "Look at 'fields' for actual column names. Typically includes: collection/name, dt/date, floor_price, tonnel_floor_price, portals_floor_price, mrkt_floor_price. Use for marketplace comparison and arbitrage detection.",
      };
    } catch (err) {
      sdk.log.error("gift_collection_floor_history:", err.message);
      return { success: false, error: err.message };
    }
  },
};

// ---------------------------------------------------------------------------
// Return tools array
// ---------------------------------------------------------------------------

return [
  giftCollections,
  giftFloorPrices,
  giftModels,
  giftModelStats,
  giftModelFloor,
  giftBackdrops,
  giftSymbols,
  giftThematics,
  giftThematicLines,
  giftTonRate,
  giftPriceHistory,
  giftIndexFloorHistory,
  giftCollectionFloorHistory,
];

}; // end tools(sdk)
