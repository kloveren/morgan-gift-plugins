# Morgan Gift Plugins

Custom [Teleton](https://github.com/TONresistor/teleton-agent) plugins for the **Telegram Gifts market on TON**. These plugins power [@morgan_agent](https://t.me/morgan_agent) — a Telegram-native AI agent that provides real-time analytics, cross-marketplace trading, and whale intelligence for the TON Gift NFT ecosystem.

## Overview

The Telegram Gift market has grown into a multi-million dollar NFT economy on TON, with gifts trading across 6+ marketplaces (GetGems, MarketApp, Fragment, Portals, Tonnel, MRKT). These plugins give Teleton agents the tools to analyze, visualize, and trade in this market — directly from Telegram.

**Total: 10,200+ lines of production code, 50+ tools, 6 marketplace integrations.**

## What's New (March 2026)

- **geckoterminal** — new plugin: trending pools, OHLCV candles, batch token prices (10 tools)
- **dyor** — new plugin: trust scores, holder analysis, DEX transactions, trending jettons (11 tools)
- **invoices** — new plugin: TON payment invoices with on-chain verification and receipt generation (6 tools)
- **gift-price-compare** — upgraded to 6 marketplaces (added Portals, Tonnel, MRKT)
- **whale-analytics** — upgraded to multi-source (GetGems + MarketApp + Giftstat), daily SQLite snapshots with delta comparison
- **chart** — added dashboard compositor (multi-chart in single image)
- **Total: 9 plugins, 50+ tools** (was 6 plugins, ~30 tools in February)

## Plugins

### `whale-analytics`
**Whale tracking, anomaly detection & snapshot engine**

Tracks the biggest holders across gift collections, detects suspicious market activity (wash trading, pump & dump), and maintains daily snapshots for delta analysis.

- `whale_tracker` — Portfolio analysis of top holders: accumulation patterns, buy/sell volumes, strategy classification (Diamond Hands / Flipper / Accumulator)
- `anomaly_detector` — Statistical z-score analysis for price pumps, volume spikes, and heuristic wash-trade detection
- `whale_snapshots` — Historical snapshot storage with delta comparison: who accumulated, who dumped, new entrants

Multi-source data: GetGems API + MarketApp API + Giftstat price history. SQLite-backed for persistence.

---

### `chart`
**Professional chart generation engine**

Renders publication-quality charts directly in Telegram chats using QuickChart.io and sharp image composition.

- `market_chart` — TON/jetton price charts (line, candlestick)
- `gift_floor_chart` — Floor price charts for gift collections with trend lines
- `gift_top_movers` — Horizontal bar charts: top gainers & losers by price change
- `chart_pie` — Market dominance, portfolio distribution, volume breakdowns
- `chart_bar` — Daily volumes, category comparisons, grouped/stacked bars
- `chart_dashboard` — Multi-chart compositor: combine any charts into a single dashboard image
- `chart_generate` — Universal chart tool: feed raw data arrays, get any chart type

Dark theme, auto-sizing, markdown captions, direct-to-chat delivery.

---

### `giftstat`
**Telegram Gift market analytics via Giftstat API**

The primary data source for gift collection information. Wraps both Giftstat API v1 and v2.

- `gift_collections` — All collections with supply, pricing, mint data, and metadata
- `gift_collection_floor` — Floor prices with marketplace breakdown (Portals, Tonnel, GetGems, Fragment)
- `gift_models` / `gift_model_floor` — Model-level data (rarity tiers within collections)
- `gift_floor_index` — Market-wide floor index with **Bollinger Bands** for technical analysis
- `gift_price_history` — Historical floor prices per collection, hourly or daily
- `gift_backdrops` / `gift_symbols` / `gift_thematics` — NFT attribute data
- `gift_ton_rate` — Current TON/USD exchange rate

No API key required. Public data aggregation from all major marketplaces.

---

### `gift-price-compare`
**Cross-marketplace arbitrage scanner**

Queries 6 marketplaces simultaneously and finds price discrepancies for the same gift collection.

- `gift_price_compare` — Side-by-side floor price comparison across:
  - **On-chain:** GetGems, MarketApp, Fragment
  - **Off-chain:** Portals, Tonnel, MRKT
  - **Data aggregator:** Giftstat (floor consolidation)
- Calculates spread percentage and flags arbitrage opportunities
- Model-level breakdown when available
- Smart collection name resolution with alias mapping

---

### `marketapp`
**MarketApp.ws marketplace integration**

Full trading capabilities on MarketApp — browse, buy, sell, and manage NFT gifts.

- `marketapp_collections` — Browse collections with floor price, volume, listing stats
- `marketapp_gifts_onsale` — Filter gifts on sale by collection, model, symbol, backdrop, price range
- `marketapp_gift_history` — Recent sales history
- `marketapp_nft_info` — Detailed NFT info by on-chain address
- `marketapp_collection_attributes` — Attribute breakdown (models, backdrops, symbols)
- `marketapp_buy_nft` — Execute buy transactions (on-chain, signed from agent wallet)
- `marketapp_list_nft` — List NFTs for sale at a specified TON price
- `marketapp_change_price` / `marketapp_cancel_sale` — Manage active listings

Requires `MARKETAPP_API_TOKEN`. Trading tools sign transactions from the agent's TON wallet.

---

### `getgems`
**GetGems marketplace integration**

Full-featured integration with GetGems — the largest NFT marketplace on TON.

- `getgems_collection_info` — Collection stats (floor, volume, holders, items)
- `getgems_collection_items` / `getgems_items_onsale` — Browse and filter NFTs
- `getgems_nft_info` — Detailed NFT metadata and sale status
- `getgems_nft_history` — Transaction history for specific NFTs
- `getgems_owner_nfts` — All NFTs owned by a wallet address
- `getgems_user_trading` — User trading statistics (bought/sold, volume, P&L)
- `getgems_gift_collections` — Telegram Gift collections listing
- `getgems_buy_nft` — Buy NFTs listed for sale (on-chain transaction)
- `getgems_list_nft` — List NFTs for fixed-price sale
- `getgems_cancel_sale` — Cancel active listings

GraphQL-based. Requires `GETGEMS_API_KEY` for extended access.

---

### `dyor`
**TON token analytics from DYOR.io**

Comprehensive token research: search, trust scores, pricing, holder data, DEX activity, and market pools.

- `dyor_search` — Search TON jettons by name or symbol
- `dyor_details` — Full jetton details by contract address
- `dyor_trust_score` — DYOR.io trust score (0-100) with safety breakdown
- `dyor_price` — Current price in TON, USD, and optional currency
- `dyor_price_chart` — Price chart data points over time
- `dyor_metrics` — Consolidated metrics (price, holders, liquidity, FDMC, mcap)
- `dyor_stats` — Percent change statistics by time period
- `dyor_holders` — Holder count and holder history ticks
- `dyor_transactions` — Recent DEX transactions for a jetton
- `dyor_markets` — DEX pool/market data for a jetton
- `dyor_trending` — Trending TON jettons by chosen metric

No API key required. 11 tools covering the full token research workflow.

---

### `geckoterminal`
**TON DEX pool and token data from GeckoTerminal**

Real-time DEX analytics: trending pools, new listings, OHLCV candles, trade history, and batch token prices.

- `gecko_trending_pools` — Trending pools on TON by activity
- `gecko_new_pools` — Newly created pools (last 48h)
- `gecko_top_pools` — Top pools by liquidity and volume
- `gecko_search_pools` — Search pools by token name, symbol, or address
- `gecko_pool_info` — Detailed pool info (price, volume, liquidity, 24h changes)
- `gecko_pool_trades` — Recent trades for a specific pool
- `gecko_pool_ohlcv` — OHLCV candlestick data for charting
- `gecko_token_info` — Full token data (price, volume, FDV, supply)
- `gecko_token_pools` — All pools trading a specific token
- `gecko_token_prices` — Batch price lookup for up to 30 tokens

No API key required. 10 tools for DEX data and market movers.

---

### `invoices`
**Secure TON payment invoices with on-chain verification**

Complete payment infrastructure: wallet ownership verification, invoice generation with deep links, cached on-chain event indexing, and receipt generation.

- `inv_begin_verification` — Create wallet ownership verification challenge
- `inv_confirm_verification` — Confirm wallet ownership by on-chain proof
- `inv_register_agent` — Alias for `inv_begin_verification`
- `inv_create` — Create a TON invoice with deep links for Tonkeeper, Tonhub, and MyTonWallet
- `inv_check` — Verify invoice payment on-chain via cached event indexer
- `inv_receipt` — Generate a receipt for a paid invoice

Cached event indexer reduces TonAPI calls. Used by the Stars broker and deal system for secure payment flows.

---

## Additional Features (Live on @morgan_agent)

Beyond these open-source plugins, Morgan includes proprietary features:

- **Stars Broker** — Buy Telegram Stars for TON via Split.tg API. Public invoice flow: any user pays TON, Morgan delivers Stars with 5% commission
- **Deal System** — P2P gift trading with escrow, auto-verification, and Telegram Bot API companion bot
- **Proactive Engagement** — Keyword-based responses in group chats for trading discussions

---

## Installation

1. Clone or copy the desired plugin folders into your Teleton agent's `plugins/` directory:

```bash
git clone https://github.com/kloveren/morgan-gift-plugins.git
cp -r morgan-gift-plugins/plugins/giftstat ~/.teleton/plugins/
cp -r morgan-gift-plugins/plugins/chart ~/.teleton/plugins/
# ... copy whichever plugins you need
```

2. Set required environment variables:

```bash
# For MarketApp trading
export MARKETAPP_API_TOKEN="your_token_here"

# For GetGems extended access
export GETGEMS_API_KEY="your_key_here"
```

3. Restart your Teleton agent. Plugins are auto-discovered from the `plugins/` directory.

> **Note:** `giftstat`, `chart`, `gift-price-compare`, `dyor`, `geckoterminal`, and `invoices` work without any API keys — they use public APIs.

## Architecture

Each plugin follows the Teleton plugin standard:

```
plugin-name/
├── index.js        # Plugin entry point, exports tools array
├── manifest.json   # Metadata: name, version, tools, permissions, tags
└── README.md       # Documentation (optional)
```

Plugins export a `tools` function that receives the SDK context and returns an array of tool definitions. Each tool has:
- `name` — unique identifier
- `description` — used by the AI agent to decide when to invoke the tool
- `parameters` — JSON Schema for input validation
- `execute(params, context)` — async handler that returns `{ success, data }` or `{ success, error }`

## Live Demo

Try these plugins in action: [@morgan_agent](https://t.me/morgan_agent)

Example commands:
- "Show me the top gift collections by floor price"
- "Compare Plush Pepe prices across marketplaces"
- "Track whales in the Candy Cane collection"
- "Generate a market dominance chart"
- "Find arbitrage opportunities in gifts"
- "DYOR on STON token"
- "Show trending DEX pools on TON"
- "Create an invoice for 2 TON"

## Tech Stack

- **Runtime:** Node.js (ESM)
- **Blockchain:** TON (The Open Network)
- **APIs:** Giftstat, GetGems GraphQL, MarketApp REST, Fragment, DYOR.io, GeckoTerminal, QuickChart.io, TonAPI
- **On-chain:** @ton/core, @ton/ton, @ton/crypto for transaction signing
- **Visualization:** QuickChart.io + sharp for image composition

## License

MIT — see [LICENSE](./LICENSE)

## Changelog

**v1.1.0** (March 2026) — Added `geckoterminal`, `dyor`, `invoices` plugins. Upgraded `whale-analytics` to multi-source with SQLite delta snapshots. `gift-price-compare` now covers 6 marketplaces. `chart` gains dashboard compositor.

**v1.0.0** (February 2026) — Initial release: `whale-analytics`, `chart`, `giftstat`, `gift-price-compare`, `marketapp`, `getgems`.

## Links

- [Teleton Agent Framework](https://github.com/TONresistor/teleton-agent)
- [Teleton Plugins Directory](https://github.com/TONresistor/teleton-plugins)
- [Giftstat API](https://api.giftstat.app)
- [Morgan Agent (Live)](https://t.me/morgan_agent)
- [Morgan Legacy Channel](https://t.me/morganlegacy)
