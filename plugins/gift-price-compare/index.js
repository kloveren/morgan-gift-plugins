/**
 * Gift Price Compare plugin — cross-marketplace price comparison
 *
 * Queries MarketApp, Giftstat, GetGems, and Fragment for the same gift
 * collection/model and returns a unified comparison table with arbitrage
 * opportunities.
 */

const GIFTSTAT_API = "https://api.giftstat.app";
const MARKETAPP_API = "https://api.marketapp.ws/v1";
const GETGEMS_API = "https://api.getgems.io/graphql";
const FRAGMENT_URL = "https://fragment.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
        return address;
      }
    }
  }
  return null;
}

function getMarketAppToken(context) {
  if (context?.config?.marketapp_api_token) return context.config.marketapp_api_token;
  if (process.env.MARKETAPP_API_TOKEN) return process.env.MARKETAPP_API_TOKEN;
  return null;
}

function getGetGemsKey(context) {
  if (context?.config?.getgems_api_key) return context.config.getgems_api_key;
  if (process.env.GETGEMS_API_KEY) return process.env.GETGEMS_API_KEY;
  return null;
}

async function fetchWithTimeout(url, options = {}, ms = 12000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
}

async function fetchGiftstatFloors(collectionSlug) {
  try {
    const [floorRes, modelRes] = await Promise.all([
      fetchWithTimeout(`${GIFTSTAT_API}/current/collections/floor?marketplace=all&limit=300`),
      fetchWithTimeout(`${GIFTSTAT_API}/current/collections/models/floor?limit=5000`),
    ]);

    let collectionFloor = null;
    let marketplaceFloors = {};

    if (floorRes.ok) {
      const data = await floorRes.json();
      const slug = collectionSlug.toLowerCase().replace(/[\s''-]/g, "");
      for (const item of data.data || []) {
        const itemSlug = (item.slug || "").toLowerCase().replace(/[\s''-]/g, "");
        const itemName = (item.collection || "").toLowerCase().replace(/[\s''-]/g, "");
        if (itemSlug === slug || itemName === slug) {
          const mp = (item.marketplace || "unknown").toLowerCase();
          marketplaceFloors[mp] = item.floor_price;
          if (!collectionFloor || item.floor_price < collectionFloor) {
            collectionFloor = item.floor_price;
          }
        }
      }
    }

    const modelFloors = {};
    if (modelRes.ok) {
      const data = await modelRes.json();
      const slug = collectionSlug.toLowerCase().replace(/[\s''-]/g, "");
      for (const item of data.data || []) {
        const mSlug = (item.collection_slug || "").toLowerCase().replace(/[\s''-]/g, "");
        if (mSlug === slug && item.model && item.floor_price > 0) {
          modelFloors[item.model] = item.floor_price;
        }
      }
    }

    return { collectionFloor, marketplaceFloors, modelFloors, source: "giftstat" };
  } catch {
    return null;
  }
}

async function fetchMarketAppData(collectionAddress, model, context) {
  const token = getMarketAppToken(context);
  if (!token || !collectionAddress) return null;

  try {
    const query = { collection_address: collectionAddress, sort_by: "min_bid_asc" };
    if (model) query.model = model;

    const url = new URL(`${MARKETAPP_API}/gifts/onsale/`);
    for (const [k, v] of Object.entries(query)) {
      if (v) url.searchParams.set(k, String(v));
    }

    const res = await fetchWithTimeout(url, {
      headers: { Authorization: token, Accept: "application/json" },
    });

    if (!res.ok) return null;
    const data = await res.json();
    const items = (data.items || []).slice(0, 10);

    let floor = null;
    const listings = items.map((item) => {
      const price = item.min_bid
        ? Number(item.min_bid) / 1e9
        : item.status
        ? (() => { const st = Object.values(item.status)[0] || {}; return st.price_nano ? Number(st.price_nano) / 1e9 : null; })()
        : null;

      if (price && (!floor || price < floor)) floor = price;

      const rawAttrs = item.attributes || item.metadata?.attributes || [];
      const attrs = rawAttrs.reduce((acc, a) => {
        acc[a.trait_type] = a.value;
        return acc;
      }, {});

      return {
        name: item.name || item.metadata?.name || null,
        price: price ? +price.toFixed(2) : null,
        model: attrs.Model || attrs.model || null,
        backdrop: attrs.Backdrop || attrs.backdrop || null,
        symbol: attrs.Symbol || attrs.symbol || null,
        itemNumber: item.item_num ?? item.item_number ?? null,
      };
    });

    return { floor: floor ? +floor.toFixed(2) : null, listings, source: "marketapp" };
  } catch {
    return null;
  }
}

async function fetchMarketAppCollections(context) {
  const token = getMarketAppToken(context);
  if (!token) return [];

  try {
    const res = await fetchWithTimeout(`${MARKETAPP_API}/collections/gifts/`, {
      headers: { Authorization: token, Accept: "application/json" },
    });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

async function fetchGetGemsFloor(collectionAddress, model, context) {
  const key = getGetGemsKey(context);
  if (!collectionAddress) return null;

  try {
    const headers = { "Content-Type": "application/json" };
    if (key) headers["X-Api-Key"] = key;

    const safeModel = model ? model.replace(/["\\\n\r]/g, "") : null;
    const attrFilter = safeModel
      ? `, attributes: [{traitType: "Model", value: "${safeModel}"}]`
      : "";

    const query = `query {
      nftCollectionByAddress(address: "${collectionAddress.replace(/["\\\n\r]/g, "")}") {
        name
        approximateItemsCount
        floorPrice
        nftItems(first: 5, filter: { saleType: ON_SALE${attrFilter} }, sort: PRICE_ASC) {
          items {
            name
            address
            sale { fullPrice }
            attributes { traitType value }
          }
        }
      }
    }`;

    const res = await fetchWithTimeout(GETGEMS_API, {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const col = data?.data?.nftCollectionByAddress;
    if (!col) return null;

    const floorNano = col.floorPrice ? Number(col.floorPrice) / 1e9 : null;
    const listings = (col.nftItems?.items || []).map((item) => {
      const attrs = (item.attributes || []).reduce((acc, a) => {
        acc[a.traitType] = a.value;
        return acc;
      }, {});
      const price = item.sale?.fullPrice ? Number(item.sale.fullPrice) / 1e9 : null;
      return {
        name: item.name,
        price: price ? +price.toFixed(2) : null,
        model: attrs.Model || null,
        backdrop: attrs.Backdrop || null,
        address: item.address,
      };
    });

    return { floor: floorNano ? +floorNano.toFixed(2) : null, listings, source: "getgems" };
  } catch {
    return null;
  }
}

async function fetchFragmentData(collectionSlug) {
  try {
    const homeRes = await fetchWithTimeout(FRAGMENT_URL + "/", {
      headers: { "User-Agent": UA },
    });
    const rawCookies = homeRes.headers.getSetCookie?.() ?? [];
    let ssid = null;
    for (const c of (Array.isArray(rawCookies) ? rawCookies : [rawCookies])) {
      const m = String(c).match(/stel_ssid=([^;]+)/);
      if (m) { ssid = m[1]; break; }
    }
    if (!ssid) {
      const fallback = homeRes.headers.get("set-cookie") ?? "";
      ssid = fallback.match(/stel_ssid=([^;]+)/)?.[1] ?? null;
    }
    const html = await homeRes.text();
    const hash = html.match(/apiUrl['"]\s*:\s*['"][^'"]*hash=([a-f0-9]+)/)?.[1]
      ?? html.match(/hash=([a-f0-9]{10,})/)?.[1];
    if (!ssid || !hash) return null;

    const normalized = collectionSlug.toLowerCase().replace(/[\s'_-]/g, "");
    const collectionsRes = await fetchWithTimeout(FRAGMENT_URL + "/gifts", {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Cookie: `stel_ssid=${ssid}`,
        "User-Agent": UA,
      },
    });
    if (!collectionsRes.ok) return null;
    const colData = await collectionsRes.json();
    const colHtml = colData.h ?? "";

    let fragmentSlug = null;
    const colItems = colHtml.split(/js-choose-collection-item/);
    for (const item of colItems) {
      const slug = item.match(/data-value="([^"]+)"/)?.[1];
      if (!slug) continue;
      const name = item.match(/tm-main-filters-name">([^<]+)/)?.[1]?.trim();
      const checkSlug = slug.toLowerCase().replace(/[\s'_-]/g, "");
      const checkName = (name || "").toLowerCase().replace(/[\s'_-]/g, "");
      if (checkSlug === normalized || checkName === normalized ||
          checkSlug.includes(normalized) || normalized.includes(checkSlug) ||
          checkName.includes(normalized) || normalized.includes(checkName)) {
        fragmentSlug = slug;
        break;
      }
    }

    if (!fragmentSlug) return null;

    const body = new URLSearchParams({
      method: "searchAuctions",
      type: "gifts",
      query: "",
      sort: "price_asc",
      filter: "sale",
      view: "list",
      collection: fragmentSlug,
    });

    const searchRes = await fetchWithTimeout(
      `${FRAGMENT_URL}/api?hash=${hash}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Cookie: `stel_ssid=${ssid}`,
          "User-Agent": UA,
        },
        body,
      }
    );

    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    if (!searchData.ok) return null;

    const sHtml = searchData.html ?? "";
    const rows = [];
    const trParts = sHtml.split(/<tr[\s>]/);
    for (const tr of trParts) {
      const href = tr.match(/href="\/gift\/([^"?]+)/);
      if (!href) continue;
      const name = tr.match(/table-cell-value tm-value">([^<]+)/)?.[1]?.trim();
      const attrs = tr.match(/table-cell-desc tm-nowrap">([^<]+)/)?.[1]?.trim();
      const priceStr = tr.match(/icon-before icon-ton">([^<]+)/)?.[1]?.trim();
      const price = priceStr ? parseFloat(priceStr.replace(/,/g, "")) : null;
      if (name && price && !isNaN(price)) {
        rows.push({
          name,
          url: `https://fragment.com/gift/${href[1]}`,
          attributes: attrs ?? null,
          price: +price.toFixed(2),
        });
      }
    }

    let floor = null;
    const listings = rows.slice(0, 10).map((r) => {
      if (r.price && (!floor || r.price < floor)) floor = r.price;
      return r;
    });

    return {
      floor: floor ? +floor.toFixed(2) : null,
      listings,
      totalListings: rows.length,
      source: "fragment",
    };
  } catch {
    return null;
  }
}

function findCollectionAddress(collections, slug) {
  if (!slug) return null;
  const normalized = slug.toLowerCase().replace(/[\s'-]/g, "");
  for (const c of collections) {
    const name = (c.name || "").toLowerCase().replace(/[\s'-]/g, "");
    if (name === normalized || name.includes(normalized) || normalized.includes(name)) {
      return c.address;
    }
  }
  return null;
}

export const manifest = {
  id: "gift-price-compare",
  name: "gift-price-compare",
  version: "1.1.0",
  description: "Cross-marketplace gift price comparison. On-chain: MarketApp (marketapp.ws), GetGems, Fragment. Off-chain: Portals, Tonnel, MRKT. Giftstat is a DATA AGGREGATOR (not a marketplace) that collects floor prices from off-chain markets.",
  author: "Kloveren (t.me/morganlegacy)",
};

const tools = [
  {
    name: "gift_price_compare",
    category: "data-bearing",
    description:
      "Compare gift prices across marketplaces. On-chain: MarketApp (marketapp.ws), GetGems, Fragment. Off-chain (Telegram Mini Apps): Portals, Tonnel, MRKT. Giftstat is NOT a marketplace — it is a data aggregator that collects floor prices from off-chain markets. MarketApp ≠ MRKT (MarketApp = on-chain at marketapp.ws, MRKT = off-chain Telegram Mini App with 8% commission). Results show actual marketplace names. Provide a collection name/slug and optionally a model name.",
    parameters: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description:
            "Collection name or slug (e.g. 'Precious Peach', 'SnoopDogg', 'Jelly Bunny', 'Sakura Flower')",
        },
        model: {
          type: "string",
          description: "Optional model name to filter (e.g. 'Doggfather', 'Impeached', 'Sunset')",
        },
        collection_address: {
          type: "string",
          description:
            "Optional on-chain collection address. If not provided, will attempt to resolve from collection name via MarketApp.",
        },
      },
      required: ["collection"],
    },
    execute: async (params, context) => {
      try {
        const collectionSlug = params.collection;
        const model = params.model || null;
        let collectionAddress = params.collection_address || null;

        const maCollections = await fetchMarketAppCollections(context);

        if (!collectionAddress && maCollections.length > 0) {
          collectionAddress = findCollectionAddress(maCollections, collectionSlug);
        }

        if (!collectionAddress) {
          collectionAddress = resolveCollectionByAlias(collectionSlug);
        }

        const [giftstatData, marketappData, getgemsData, fragmentData] = await Promise.all([
          fetchGiftstatFloors(collectionSlug),
          fetchMarketAppData(collectionAddress, model, context),
          fetchGetGemsFloor(collectionAddress, model, context),
          fetchFragmentData(collectionSlug),
        ]);

        const comparison = {
          collection: collectionSlug,
          model: model || "all",
          collectionAddress,
          marketplaces: {},
          cheapestListings: [],
          arbitrage: null,
        };

        if (giftstatData) {
          for (const [mp, floor] of Object.entries(giftstatData.marketplaceFloors)) {
            const mpName = mp === "unknown" ? "other" : mp;
            comparison.marketplaces[mpName] = {
              floor: +floor.toFixed(2),
              source: "giftstat_aggregator",
              note: `Floor from ${mpName} marketplace (via Giftstat aggregator)`,
            };
          }
          if (model && giftstatData.modelFloors[model]) {
            comparison.marketplaces.model_floor = {
              floor: +giftstatData.modelFloors[model].toFixed(2),
              source: "giftstat_aggregator",
              note: `Model "${model}" floor across all marketplaces (via Giftstat aggregator)`,
            };
          }
        }

        if (marketappData) {
          comparison.marketplaces.marketapp = {
            floor: marketappData.floor,
            source: "marketapp",
            listingsCount: marketappData.listings.length,
          };
          for (const l of marketappData.listings) {
            comparison.cheapestListings.push({ ...l, marketplace: "marketapp" });
          }
        }

        if (getgemsData) {
          comparison.marketplaces.getgems = {
            floor: getgemsData.floor,
            source: "getgems",
            listingsCount: getgemsData.listings.length,
            note: model ? "Floor is collection-wide (GetGems does not expose model-specific floor)" : undefined,
          };
          for (const l of getgemsData.listings) {
            comparison.cheapestListings.push({ ...l, marketplace: "getgems" });
          }
        }

        if (fragmentData) {
          const hasAggregatedFragment = comparison.marketplaces.fragment != null;
          if (hasAggregatedFragment && fragmentData.floor) {
            comparison.marketplaces.fragment.floor_live = fragmentData.floor;
            comparison.marketplaces.fragment.listingsCount = fragmentData.totalListings;
            comparison.marketplaces.fragment.note = "Fragment marketplace (aggregated + live data)";
            comparison.marketplaces.fragment.floor = Math.min(
              comparison.marketplaces.fragment.floor,
              fragmentData.floor
            );
          } else {
            comparison.marketplaces.fragment = {
              floor: fragmentData.floor,
              source: "fragment",
              listingsCount: fragmentData.totalListings,
            };
          }
          for (const l of fragmentData.listings) {
            comparison.cheapestListings.push({ ...l, marketplace: "fragment" });
          }
        }

        comparison.cheapestListings.sort((a, b) => (a.price || Infinity) - (b.price || Infinity));
        comparison.cheapestListings = comparison.cheapestListings.slice(0, 15);

        const floors = Object.entries(comparison.marketplaces)
          .filter(([, v]) => v.floor > 0)
          .map(([mp, v]) => ({ marketplace: mp, floor: v.floor }))
          .sort((a, b) => a.floor - b.floor);

        if (floors.length >= 2) {
          const cheapest = floors[0];
          const mostExpensive = floors[floors.length - 1];
          const spread = mostExpensive.floor - cheapest.floor;
          const spreadPct = ((spread / cheapest.floor) * 100).toFixed(1);

          if (spread > 0) {
            comparison.arbitrage = {
              buyAt: cheapest.marketplace,
              buyPrice: cheapest.floor,
              sellAt: mostExpensive.marketplace,
              sellPrice: mostExpensive.floor,
              spread: +spread.toFixed(2),
              spreadPercent: +spreadPct,
              note:
                +spreadPct > 5
                  ? `Potential ${spreadPct}% arbitrage opportunity!`
                  : `Spread is only ${spreadPct}% — likely not worth after fees`,
            };
          }
        }

        const summary = floors.map((f) => `${f.marketplace}: ${f.floor} TON`).join(" | ");

        return {
          success: true,
          summary: summary || "No price data available",
          comparison,
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },
];

export { tools };
