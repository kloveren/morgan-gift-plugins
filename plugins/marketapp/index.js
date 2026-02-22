/**
 * MarketApp plugin — gift marketplace on TON (marketapp.ws)
 *
 * Browse collections, gifts on sale, sales history, NFT info,
 * collection attributes, AND buy/sell/cancel NFTs.
 * Requires MARKETAPP_API_TOKEN. Trading tools sign transactions
 * from the agent wallet at ~/.teleton/wallet.json.
 */

import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const _require = createRequire(realpathSync(process.argv[1]));
const { Address, SendMode, Cell } = _require("@ton/core");
const { WalletContractV5R1, TonClient, internal } = _require("@ton/ton");
const { mnemonicToPrivateKey } = _require("@ton/crypto");

const API_BASE = "https://api.marketapp.ws/v1";
const _TELETON_DIR = process.env.TELETON_HOME || join(homedir(), ".teleton");
const WALLET_FILE = join(_TELETON_DIR, "wallet.json");

function getToken(context) {
  if (context?.config?.marketapp_api_token) return context.config.marketapp_api_token;
  if (process.env.MARKETAPP_API_TOKEN) return process.env.MARKETAPP_API_TOKEN;
  return null;
}

async function marketFetch(path, params = {}, context = null) {
  const token = getToken(context);
  if (!token) throw new Error("MARKETAPP_API_TOKEN not configured");

  const url = new URL(path, API_BASE + "/");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url, {
    headers: {
      Authorization: token,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MarketApp API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function marketPost(path, body = {}, context = null) {
  const token = getToken(context);
  if (!token) throw new Error("MARKETAPP_API_TOKEN not configured");

  const url = new URL(path, API_BASE + "/");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MarketApp API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

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

async function sendMarketappTransaction(txResponse) {
  const { wallet, keyPair, contract } = await getWalletAndClient();
  const seqno = await contract.getSeqno();

  const txData = txResponse.transaction || txResponse;
  const messages = txData.messages.map((item) => {
    const msg = {
      to: Address.parse(item.address),
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

function formatTon(nanoStr) {
  if (!nanoStr) return null;
  const n = Number(nanoStr);
  if (isNaN(n)) return nanoStr;
  return (n / 1e9).toFixed(2);
}

function formatCollection(c) {
  const s = c.extra_data || {};
  return {
    name: c.name,
    address: c.address,
    items: s.items ?? null,
    floor: formatTon(s.floor),
    rentFloor: formatTon(s.rent_floor),
    volume7d: formatTon(s.volume7d),
    volume30d: formatTon(s.volume30d),
    owners: s.owners ?? null,
    onSaleAll: s.on_sale_all ?? null,
    onSaleOnchain: s.on_sale_onchain ?? null,
  };
}

function formatNftItem(item) {
  const attrs = (item.metadata?.attributes || []).reduce((acc, a) => {
    acc[a.trait_type] = a.value;
    return acc;
  }, {});

  const status = item.status || {};
  const statusType = Object.keys(status)[0] || "unknown";
  const statusData = status[statusType] || {};

  return {
    address: item.address,
    collection: item.collection_address,
    name: item.metadata?.name || null,
    image: item.metadata?.image || null,
    itemNumber: item.item_number ?? null,
    model: attrs.Model || attrs.model || null,
    backdrop: attrs.Backdrop || attrs.backdrop || null,
    symbol: attrs.Symbol || attrs.symbol || null,
    status: statusType,
    price: statusData.price_nano
      ? formatTon(statusData.price_nano)
      : statusData.price
      ? formatTon(statusData.price)
      : null,
    currency: statusData.currency || null,
    marketplace: statusData.market_name || "marketapp",
  };
}

export const manifest = {
  id: "marketapp",
  name: "marketapp",
  version: "1.1.0",
  description: "MarketApp.ws gift marketplace on TON",
  author: "Kloveren (t.me/morganlegacy)",
};

const tools = [
  {
    name: "marketapp_collections",
    category: "data-bearing",
    description:
      "List gift collections on MarketApp with floor price, 7d/30d volume, owners, and listing counts. Returns all available gift collections.",
    parameters: { type: "object", properties: {} },
    execute: async (_params, context) => {
      try {
        const data = await marketFetch("collections/gifts/", {}, context);
        const collections = (Array.isArray(data) ? data : [])
          .map(formatCollection)
          .sort((a, b) => (parseFloat(b.volume7d) || 0) - (parseFloat(a.volume7d) || 0));
        return {
          success: true,
          count: collections.length,
          collections,
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  {
    name: "marketapp_gifts_onsale",
    category: "data-bearing",
    description:
      "Get gifts currently on sale on MarketApp. Filter by collection address, model, symbol, backdrop, price range. Sort by price or recency. Returns up to 100 items per page with cursor pagination.",
    parameters: {
      type: "object",
      properties: {
        collection_address: {
          type: "string",
          description: "Collection address to filter by (use marketapp_collections to find addresses)",
        },
        model: { type: "string", description: "Filter by model name" },
        symbol: { type: "string", description: "Filter by symbol name" },
        backdrop: { type: "string", description: "Filter by backdrop name" },
        min_price: { type: "number", description: "Minimum price in TON" },
        max_price: { type: "number", description: "Maximum price in TON" },
        sort_by: {
          type: "string",
          description: "Sort order: min_bid_asc (cheapest first, default), min_bid_desc (most expensive first), recently_touch (most recent)",
        },
        limit: { type: "number", description: "Number of results (1-100, default 20)" },
        cursor: { type: "string", description: "Pagination cursor from previous response" },
      },
    },
    execute: async (params, context) => {
      try {
        const query = {};
        if (params.collection_address) query.collection_address = params.collection_address;
        if (params.model) query.model = params.model;
        if (params.symbol) query.symbol = params.symbol;
        if (params.backdrop) query.backdrop = params.backdrop;
        if (params.min_price) query.min_price = params.min_price;
        if (params.max_price) query.max_price = params.max_price;
        if (params.sort_by) query.sort_by = params.sort_by;
        if (params.cursor) query.cursor = params.cursor;

        const data = await marketFetch("gifts/onsale/", query, context);
        const items = (data.items || []).slice(0, params.limit || 20).map(formatNftItem);

        return {
          success: true,
          count: items.length,
          cursor: data.cursor || null,
          items,
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  {
    name: "marketapp_gift_history",
    category: "data-bearing",
    description:
      "Get recent gift sales history on MarketApp. Filter by collection address. Shows buyer, seller, price, currency, and marketplace for each sale.",
    parameters: {
      type: "object",
      properties: {
        collection_address: { type: "string", description: "Filter by collection address" },
        limit: { type: "number", description: "Number of results (1-100, default 20)" },
        cursor: { type: "string", description: "Pagination cursor" },
      },
    },
    execute: async (params, context) => {
      try {
        const query = {};
        if (params.collection_address) query.collection_address = params.collection_address;
        if (params.limit) query.limit = Math.min(params.limit, 100);
        if (params.cursor) query.cursor = params.cursor;

        const data = await marketFetch("gifts/history/", query, context);
        const events = (data.items || []).map((ev) => {
          const details = ev.details || {};
          return {
            nftAddress: ev.nft_address,
            eventType: ev.event_type,
            seller: details.src || null,
            buyer: details.dst || null,
            price: formatTon(details.price_nano),
            currency: details.currency || null,
            marketplace: details.market_name || null,
          };
        });

        return {
          success: true,
          count: events.length,
          cursor: data.cursor || null,
          events,
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  {
    name: "marketapp_nft_info",
    category: "data-bearing",
    description:
      "Get detailed info for a specific NFT by its on-chain address. Returns attributes (model, backdrop, symbol), sale status, price, and metadata.",
    parameters: {
      type: "object",
      properties: {
        nft_address: {
          type: "string",
          description: "On-chain NFT address (e.g. EQ...)",
        },
      },
      required: ["nft_address"],
    },
    execute: async (params, context) => {
      try {
        const data = await marketFetch(`nfts/${params.nft_address}/`, {}, context);
        const item = data.item || data;
        return { success: true, nft: formatNftItem(item) };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  {
    name: "marketapp_collection_attributes",
    category: "data-bearing",
    description:
      "Get the full attribute breakdown for a gift collection on MarketApp. Shows all models, backdrops, symbols with their counts and floor prices.",
    parameters: {
      type: "object",
      properties: {
        collection_address: {
          type: "string",
          description: "Collection on-chain address",
        },
      },
      required: ["collection_address"],
    },
    execute: async (params, context) => {
      try {
        const data = await marketFetch(
          `collections/${params.collection_address}/attributes/`,
          {},
          context
        );
        const attributes = (data.attributes || []).map((attr) => ({
          traitType: attr.trait_type,
          values: (attr.values || []).map((v) => ({
            value: v.value,
            count: v.count ?? null,
            floor: v.floor ? formatTon(v.floor) : null,
          })),
        }));

        return { success: true, attributes };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  {
    name: "marketapp_buy_nft",
    category: "action",
    description:
      "Buy an NFT listed for sale on MarketApp. Signs and sends the purchase transaction from the agent wallet. The NFT must be currently listed for sale on MarketApp (on-chain). Use marketapp_gifts_onsale to find NFTs and their addresses.",
    parameters: {
      type: "object",
      properties: {
        nft_address: {
          type: "string",
          description: "On-chain NFT address to buy (e.g. EQ...)",
        },
        price: {
          type: "number",
          description: "Listed price in TON (must match the current listing price)",
        },
      },
      required: ["nft_address", "price"],
    },
    execute: async (params, context) => {
      const steps = [];
      try {
        steps.push("requesting buy transaction from MarketApp API");
        const txResponse = await marketPost(
          "nfts/buy/",
          {
            data: [
              {
                nft_address: params.nft_address,
                price: params.price,
                currency: "TON",
              },
            ],
          },
          context
        );
        steps.push(`got transaction: ${txResponse.transaction?.messages?.length ?? 0} messages`);

        if (!txResponse.transaction?.messages?.length) {
          throw new Error("MarketApp returned empty transaction");
        }

        const result = await sendMarketappTransaction(txResponse);
        steps.push("transaction sent");

        return {
          success: true,
          data: {
            nft_address: params.nft_address,
            price_ton: params.price,
            wallet_address: result.wallet_address,
            seqno: result.seqno,
            messages_sent: txResponse.transaction.messages.length,
            steps,
            message: "Buy transaction sent. Allow ~30 seconds for on-chain confirmation.",
          },
        };
      } catch (err) {
        return { success: false, error: String(err.message || err).slice(0, 500), steps };
      }
    },
  },

  {
    name: "marketapp_list_nft",
    category: "action",
    description:
      "List an NFT for sale on MarketApp. Sets the sale price and signs the listing transaction from the agent wallet. The agent must own the NFT on-chain.",
    parameters: {
      type: "object",
      properties: {
        nft_address: {
          type: "string",
          description: "On-chain NFT address to list (e.g. EQ...)",
        },
        price: {
          type: "number",
          description: "Sale price in TON (e.g. 5.5 for 5.5 TON)",
        },
      },
      required: ["nft_address", "price"],
    },
    execute: async (params, context) => {
      const steps = [];
      try {
        if (params.price <= 0) throw new Error("Price must be positive");

        const { wallet } = await getWalletAndClient();
        const ownerAddress = wallet.address.toString();
        steps.push("resolved wallet: " + ownerAddress);

        const txResponse = await marketPost(
          "nfts/sale/",
          {
            owner_address: ownerAddress,
            data: [
              {
                nft_address: params.nft_address,
                price: params.price,
                currency: "TON",
              },
            ],
          },
          context
        );
        steps.push(`got transaction: ${txResponse.transaction?.messages?.length ?? 0} messages`);

        if (!txResponse.transaction?.messages?.length) {
          throw new Error("MarketApp returned empty transaction");
        }

        const result = await sendMarketappTransaction(txResponse);
        steps.push("transaction sent");

        return {
          success: true,
          data: {
            nft_address: params.nft_address,
            price_ton: params.price,
            wallet_address: result.wallet_address,
            seqno: result.seqno,
            messages_sent: txResponse.transaction.messages.length,
            steps,
            message: "Listing transaction sent. Allow ~30 seconds for on-chain confirmation.",
          },
        };
      } catch (err) {
        return { success: false, error: String(err.message || err).slice(0, 500), steps };
      }
    },
  },

  {
    name: "marketapp_change_price",
    category: "action",
    description:
      "Change the sale price of an NFT already listed on MarketApp. The agent must own the NFT.",
    parameters: {
      type: "object",
      properties: {
        nft_address: {
          type: "string",
          description: "On-chain NFT address",
        },
        price: {
          type: "number",
          description: "New sale price in TON",
        },
      },
      required: ["nft_address", "price"],
    },
    execute: async (params, context) => {
      try {
        if (params.price <= 0) throw new Error("Price must be positive");

        const { wallet } = await getWalletAndClient();
        const ownerAddress = wallet.address.toString();

        const txResponse = await marketPost(
          "nfts/change_price/",
          {
            owner_address: ownerAddress,
            data: [
              {
                nft_address: params.nft_address,
                price: params.price,
                currency: "TON",
              },
            ],
          },
          context
        );

        if (!txResponse.transaction?.messages?.length) {
          throw new Error("MarketApp returned empty transaction");
        }

        const result = await sendMarketappTransaction(txResponse);

        return {
          success: true,
          data: {
            nft_address: params.nft_address,
            new_price_ton: params.price,
            wallet_address: result.wallet_address,
            seqno: result.seqno,
            message: "Price change transaction sent. Allow ~30 seconds for on-chain confirmation.",
          },
        };
      } catch (err) {
        return { success: false, error: String(err.message || err).slice(0, 500) };
      }
    },
  },

  {
    name: "marketapp_cancel_sale",
    category: "action",
    description:
      "Cancel the sale of an NFT on MarketApp, removing it from the marketplace. The agent must own the NFT.",
    parameters: {
      type: "object",
      properties: {
        nft_address: {
          type: "string",
          description: "On-chain NFT address to delist",
        },
      },
      required: ["nft_address"],
    },
    execute: async (params, context) => {
      try {
        const { wallet } = await getWalletAndClient();
        const ownerAddress = wallet.address.toString();

        const txResponse = await marketPost(
          "nfts/cancel_sale/",
          {
            owner_address: ownerAddress,
            nft_addresses: [params.nft_address],
          },
          context
        );

        if (!txResponse.transaction?.messages?.length) {
          throw new Error("MarketApp returned empty transaction");
        }

        const result = await sendMarketappTransaction(txResponse);

        return {
          success: true,
          data: {
            nft_address: params.nft_address,
            wallet_address: result.wallet_address,
            seqno: result.seqno,
            message: "Cancel sale transaction sent. Allow ~30 seconds for on-chain confirmation.",
          },
        };
      } catch (err) {
        return { success: false, error: String(err.message || err).slice(0, 500) };
      }
    },
  },
];

export { tools };
