/**
 * Chart plugin — generate price chart images via QuickChart.io
 *
 * Creates line charts from TonAPI price data and sends them
 * as photos to Telegram chats/channels.
 */

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";

const _require = createRequire(realpathSync(process.argv[1]));
const { Api } = _require("telegram");
const { CustomFile } = _require("telegram/client/uploads");

export const manifest = {
  name: "chart",
  version: "1.0.0",
};

const QUICKCHART_URL = "https://quickchart.io/chart";
const QUICKCHART_CREATE_URL = "https://quickchart.io/chart/create";

async function getChartShortUrl(chartConfig, width = 800, height = 400, bkg = "#0f172a") {
  try {
    const res = await fetch(QUICKCHART_CREATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chart: chartConfig,
        width: Number(width),
        height: Number(height),
        backgroundColor: bkg,
        format: "png",
        devicePixelRatio: 2,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`QuickChart POST ${res.status}`);
    const json = await res.json();
    if (!json.success || !json.url) throw new Error("QuickChart POST: no url in response");
    return json.url;
  } catch (err) {
    console.warn(`⚠️ QuickChart POST failed (${err.message}), falling back to GET URL`);
    const params = new URLSearchParams({
      c: JSON.stringify(chartConfig),
      w: String(width),
      h: String(height),
      bkg,
      f: "png",
    });
    const getUrl = `${QUICKCHART_URL}?${params.toString()}`;
    if (getUrl.length > 8000) {
      throw new Error(`Chart URL too long (${getUrl.length} chars) and POST API failed: ${err.message}`);
    }
    return getUrl;
  }
}

async function getChartShortUrlV3(chartConfig, width = 800, height = 400, bkg = "#0f172a") {
  try {
    const res = await fetch(QUICKCHART_CREATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chart: chartConfig,
        width: Number(width),
        height: Number(height),
        backgroundColor: bkg,
        format: "png",
        devicePixelRatio: 2,
        version: "3",
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`QuickChart POST ${res.status}`);
    const json = await res.json();
    if (!json.success || !json.url) throw new Error("QuickChart POST: no url in response");
    return json.url;
  } catch (err) {
    console.warn(`⚠️ QuickChart v3 POST failed (${err.message}), falling back to GET URL`);
    const params = new URLSearchParams({
      c: JSON.stringify(chartConfig),
      w: String(width),
      h: String(height),
      bkg,
      f: "png",
      version: "3",
    });
    const getUrl = `${QUICKCHART_URL}?${params.toString()}`;
    if (getUrl.length > 8000) {
      throw new Error(`Chart URL too long (${getUrl.length} chars) and POST API failed: ${err.message}`);
    }
    return getUrl;
  }
}

const PERIOD_CONFIG = {
  "1h": { seconds: 3600, points: 60 },
  "24h": { seconds: 86400, points: 96 },
  "7d": { seconds: 604800, points: 168 },
  "30d": { seconds: 2592000, points: 120 },
  "90d": { seconds: 7776000, points: 180 },
  "1y": { seconds: 31536000, points: 200 },
};

async function fetchPriceData(token, period, tonapiKey) {
  const config = PERIOD_CONFIG[period];
  if (!config) return null;

  const endDate = Math.floor(Date.now() / 1000);
  const startDate = endDate - config.seconds;
  const url = `https://tonapi.io/v2/rates/chart?token=${encodeURIComponent(token)}&currency=usd&start_date=${startDate}&end_date=${endDate}&points_count=${config.points}`;

  const headers = { Accept: "application/json" };
  if (tonapiKey) headers["Authorization"] = `Bearer ${tonapiKey}`;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;

  const data = await res.json();
  if (!Array.isArray(data.points) || data.points.length === 0) return null;

  return data.points
    .sort((a, b) => a[0] - b[0])
    .map(([ts, price]) => ({ timestamp: ts, price }));
}

async function buildChartUrl(points, label, period) {
  const labels = points.map((p) => {
    const d = new Date(p.timestamp * 1000);
    if (period === "1h" || period === "24h") {
      return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
    }
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  });

  const prices = points.map((p) => p.price);
  const startPrice = prices[0];
  const endPrice = prices[prices.length - 1];
  const isUp = endPrice >= startPrice;

  const skipN = Math.max(1, Math.floor(labels.length / 12));
  const sparseLabels = labels.map((l, i) => (i % skipN === 0 ? l : ""));

  const chartConfig = {
    type: "line",
    data: {
      labels: sparseLabels,
      datasets: [
        {
          label,
          data: prices,
          borderColor: isUp ? "#22c55e" : "#ef4444",
          backgroundColor: isUp ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
          borderWidth: 2.5,
          pointRadius: 0,
          fill: true,
          tension: 0.3,
        },
      ],
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: `${label} — ${period} (${isUp ? "+" : ""}${(((endPrice - startPrice) / startPrice) * 100).toFixed(2)}%)`,
          font: { size: 16, weight: "bold" },
          color: "#e2e8f0",
        },
        legend: { display: false },
      },
      scales: {
        x: {
          ticks: { color: "#94a3b8", maxRotation: 0, font: { size: 10 } },
          grid: { color: "rgba(148,163,184,0.15)" },
        },
        y: {
          ticks: {
            color: "#94a3b8",
            callback: (v) => "$" + (v >= 1 ? v.toFixed(2) : v.toFixed(4)),
          },
          grid: { color: "rgba(148,163,184,0.15)" },
        },
      },
      layout: { padding: { top: 5, right: 15, bottom: 5, left: 5 } },
    },
  };

  return getChartShortUrl(chartConfig, 800, 400, "#0f172a");
}

const marketChart = {
  name: "market_chart",
  category: "data-bearing",
  description:
    "Generate a price chart image for TON or any jetton and send it as a photo to the current chat/channel. " +
    "Uses QuickChart.io to render a professional chart from TonAPI price data.",

  parameters: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description: 'Token: "ton" for TON, or a jetton master contract address. Defaults to "ton".',
      },
      period: {
        type: "string",
        enum: ["1h", "24h", "7d", "30d", "90d", "1y"],
        description: 'Chart time period. Defaults to "7d".',
      },
      caption: {
        type: "string",
        description: "Optional caption text to display under the chart image.",
      },
      chat_id: {
        type: "string",
        description: "Target chat/channel to send the chart to. Defaults to the current chat. Use @channelname for channels.",
      },
      return_url_only: {
        type: "boolean",
        description: "If true, return chart URL without sending to chat. Use with telegram_send_album to combine multiple charts in one post.",
      },
    },
  },

  execute: async (params, context) => {
    try {
      const token = params.token || "ton";
      const period = params.period || "7d";
      const chatId = params.chat_id || context.chatId;
      const tonapiKey = process.env.TELETON_TONAPI_KEY || context.config?.tonapi_key;

      const points = await fetchPriceData(token, period, tonapiKey);
      if (!points || points.length === 0) {
        return { success: false, error: `No price data for token "${token}" over ${period}` };
      }

      const startPrice = points[0].price;
      const endPrice = points[points.length - 1].price;
      const changePct = ((endPrice - startPrice) / startPrice * 100).toFixed(2);
      const tokenLabel = token === "ton" ? "TON/USD" : token.slice(0, 12) + "...";

      const chartUrl = await buildChartUrl(points, tokenLabel, period);

      if (params.return_url_only) {
        return {
          success: true,
          data: {
            chart_url: chartUrl,
            token: tokenLabel,
            period,
            start_price: startPrice,
            end_price: endPrice,
            change_percent: parseFloat(changePct),
            points_count: points.length,
          },
        };
      }

      const client = context.bridge.getClient().getClient();
      let peer;
      try {
        peer = await client.getInputEntity(chatId);
      } catch {
        return { success: false, error: `Cannot resolve chat: ${chatId}` };
      }

      const caption = params.caption || `${tokenLabel} — $${endPrice.toFixed(4)} (${changePct >= 0 ? "+" : ""}${changePct}%) over ${period}`;

      const imgBuf = await downloadChartImage(chartUrl);
      await client.sendFile(peer, {
        file: imgBuf,
        caption,
        parseMode: "md",
        forceDocument: false,
      });

      return {
        success: true,
        data: {
          token: tokenLabel,
          period,
          start_price: startPrice,
          end_price: endPrice,
          change_percent: parseFloat(changePct),
          points_count: points.length,
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

const GIFTSTAT_API = "https://api.giftstat.app";

const COLLECTION_COLORS = [
  "#FF6B6B", "#00FF88", "#00D4FF", "#FFD700", "#FF00FF",
  "#FF8C00", "#00FFFF", "#FF4081", "#76FF03", "#E040FB",
];

async function fetchGiftFloorHistory(collections, days, marketplace) {
  const url = new URL("/history/collections/floor", GIFTSTAT_API);
  url.searchParams.set("marketplace", marketplace);
  url.searchParams.set("scale", "day");
  url.searchParams.set("days", String(days));
  url.searchParams.set("limit", "10000");

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Giftstat API error: ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.data) || json.data.length === 0) return null;

  const slugSet = collections
    ? new Set(collections.map((c) => c.toLowerCase().replace(/[\s''-]/g, "")))
    : null;

  const byCollection = {};
  for (const item of json.data) {
    const slug = item.slug || item.collection_slug || "";
    const name = item.collection || slug;
    if (!name || name === "undefined" || name === "null") continue;
    const key = slug.toLowerCase().replace(/[\s''-]/g, "");
    if (!key) continue;
    if (slugSet && !slugSet.has(key)) continue;
    if (!byCollection[key]) byCollection[key] = { name, slug, points: [] };
    byCollection[key].points.push({
      date: item.dt,
      price: item.floor_price || 0,
    });
  }

  for (const col of Object.values(byCollection)) {
    col.points.sort((a, b) => a.date.localeCompare(b.date));
  }

  return byCollection;
}

async function fetchTopCollections(marketplace, limit) {
  const url = new URL("/current/collections/floor", GIFTSTAT_API);
  url.searchParams.set("marketplace", marketplace);
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return [];
  const json = await res.json();
  if (!Array.isArray(json.data)) return [];

  return json.data
    .filter((c) => c.floor_price >= 10)
    .sort((a, b) => b.floor_price - a.floor_price)
    .slice(0, 8)
    .map((c) => c.slug || c.collection);
}

async function buildGiftChartUrl(byCollection, days) {
  const entries = Object.values(byCollection)
    .filter((e) => e.name && e.name !== "undefined" && e.points && e.points.length > 0)
    .slice(0, 8);
  if (entries.length === 0) return null;

  const allPrices = entries.flatMap((e) => e.points.map((p) => p.price)).filter((p) => p > 0);
  const minPrice = allPrices.length > 0 ? Math.min(...allPrices) : 1;
  const maxPrice = allPrices.length > 0 ? Math.max(...allPrices) : 1;
  const priceRange = maxPrice / (minPrice || 1);
  const useLogScale = priceRange > 10;

  const allDates = [...new Set(entries.flatMap((e) => e.points.map((p) => p.date)))].sort();
  const skipN = Math.max(1, Math.floor(allDates.length / 10));
  const sparseLabels = allDates.map((d, i) => {
    if (i % skipN === 0) {
      const dt = new Date(d + "T00:00:00Z");
      return dt.toLocaleDateString("ru-RU", { month: "short", day: "numeric", timeZone: "UTC" });
    }
    return "";
  });

  const datasets = entries.map((entry, idx) => {
    const dateMap = {};
    for (const p of entry.points) dateMap[p.date] = Math.round(p.price * 10) / 10;
    const data = allDates.map((d) => {
      const v = dateMap[d] ?? null;
      if (useLogScale && v !== null && v <= 0) return null;
      return v;
    });
    return {
      label: String(entry.name || "Unknown").slice(0, 18),
      data,
      borderColor: COLLECTION_COLORS[idx % COLLECTION_COLORS.length],
      borderWidth: 3,
      pointRadius: 4,
      pointBorderWidth: 2,
      fill: false,
      tension: 0.3,
      spanGaps: true,
    };
  });

  const daysRu = days <= 7 ? `${days} дн` : `${days} дней`;
  const scaleNote = useLogScale ? " (лог. шкала)" : "";
  const yAxisConfig = useLogScale
    ? {
        type: "logarithmic",
        title: { display: true, text: "TON (лог.)", color: "#cbd5e1", font: { size: 13 } },
        ticks: {
          color: "#cbd5e1",
          font: { size: 12 },
          callback: (v) => {
            if (v >= 1000) return Math.round(v).toLocaleString();
            if (v >= 100) return Math.round(v);
            if (v >= 1) return v.toFixed(1);
            return v.toFixed(2);
          },
        },
        grid: { color: "rgba(148,163,184,0.15)" },
      }
    : {
        title: { display: true, text: "TON", color: "#cbd5e1", font: { size: 13 } },
        ticks: {
          color: "#cbd5e1",
          font: { size: 12 },
          callback: (v) => v >= 1000 ? Math.round(v).toLocaleString() : v >= 100 ? Math.round(v) : v.toFixed(1),
        },
        grid: { color: "rgba(148,163,184,0.15)" },
      };

  const chartConfig = {
    type: "line",
    data: { labels: sparseLabels, datasets },
    options: {
      plugins: {
        title: {
          display: true,
          text: `Флоры подарков — ${daysRu}${scaleNote}`,
          font: { size: 18, weight: "bold" },
          color: "#e2e8f0",
        },
        legend: {
          display: true,
          position: "bottom",
          labels: { color: "#f1f5f9", boxWidth: 14, padding: 12, font: { size: 13 } },
        },
      },
      scales: {
        x: {
          ticks: { color: "#cbd5e1", maxRotation: 0, font: { size: 12 } },
          grid: { color: "rgba(148,163,184,0.15)" },
        },
        y: yAxisConfig,
      },
      layout: { padding: { top: 5, right: 15, bottom: 5, left: 5 } },
    },
  };

  return getChartShortUrl(chartConfig, 1000, 500, "#0f172a");
}

async function buildFloorChartWithVolume(byCollection, days) {
  const entries = Object.values(byCollection)
    .filter((e) => e.name && e.name !== "undefined" && e.points && e.points.length > 0)
    .slice(0, 8);
  if (entries.length === 0) return null;

  const allDates = [...new Set(entries.flatMap((e) => e.points.map((p) => p.date)))].sort();
  const skipN = Math.max(1, Math.floor(allDates.length / 10));
  const sparseLabels = allDates.map((d, i) => {
    if (i % skipN === 0) {
      const dt = new Date(d + "T00:00:00Z");
      return dt.toLocaleDateString("ru-RU", { month: "short", day: "numeric", timeZone: "UTC" });
    }
    return "";
  });

  const priceDatasets = entries.map((entry, idx) => {
    const dateMap = {};
    for (const p of entry.points) dateMap[p.date] = Math.round(p.price * 10) / 10;
    const data = allDates.map((d) => dateMap[d] ?? null);
    return {
      label: String(entry.name || "Unknown").slice(0, 18),
      data,
      borderColor: COLLECTION_COLORS[idx % COLLECTION_COLORS.length],
      borderWidth: 3,
      pointRadius: 3,
      fill: false,
      tension: 0.3,
      spanGaps: true,
      yAxisID: "y",
      type: "line",
    };
  });

  const volumePerDate = allDates.map((d) => {
    let count = 0;
    for (const entry of entries) {
      if (entry.points.some((p) => p.date === d)) count++;
    }
    return count;
  });

  const volumeDataset = {
    label: "Активность",
    data: volumePerDate,
    backgroundColor: "rgba(99, 102, 241, 0.3)",
    borderColor: "rgba(99, 102, 241, 0.6)",
    borderWidth: 1,
    yAxisID: "volume",
    type: "bar",
    order: 10,
  };

  const daysRu = days <= 7 ? `${days} дн` : `${days} дней`;
  const chartConfig = {
    type: "bar",
    data: { labels: sparseLabels, datasets: [...priceDatasets, volumeDataset] },
    options: {
      plugins: {
        title: { display: true, text: `Флоры подарков + объём — ${daysRu}`, font: { size: 18, weight: "bold" }, color: "#e2e8f0" },
        legend: { display: true, position: "bottom", labels: { color: "#f1f5f9", boxWidth: 14, padding: 12, font: { size: 13 } } },
      },
      scales: {
        x: { ticks: { color: "#cbd5e1", maxRotation: 0, font: { size: 12 } }, grid: { color: "rgba(148,163,184,0.15)" } },
        y: {
          position: "left",
          title: { display: true, text: "TON", color: "#cbd5e1", font: { size: 13 } },
          ticks: { color: "#cbd5e1", font: { size: 12 }, callback: (v) => v >= 1000 ? Math.round(v).toLocaleString() : v >= 100 ? Math.round(v) : v.toFixed(1) },
          grid: { color: "rgba(148,163,184,0.15)" },
        },
        volume: {
          position: "right",
          title: { display: true, text: "Активность", color: "#6366f1", font: { size: 11 } },
          ticks: { color: "#6366f1", font: { size: 10 }, stepSize: 1 },
          grid: { display: false },
          beginAtZero: true,
        },
      },
      layout: { padding: { top: 5, right: 15, bottom: 5, left: 5 } },
    },
  };

  return getChartShortUrl(chartConfig, 1000, 550, "#0f172a");
}

const giftFloorChart = {
  name: "gift_floor_chart",
  category: "data-bearing",
  description:
    "Generate a gift collection floor price chart image and send it to a chat/channel. " +
    "Shows floor price trends over time for top collections using Giftstat data. " +
    "Perfect for channel posts with visual market analysis.",

  parameters: {
    type: "object",
    properties: {
      collections: {
        type: "string",
        description:
          'Comma-separated collection slugs to chart (e.g. "PlushPepe,DurovsCap,HeartLocket"). ' +
          "If omitted, auto-selects top collections by floor price.",
      },
      days: {
        type: "integer",
        description: "Number of days of history (default: 7). Supported: 3, 7, 14, 30.",
      },
      marketplace: {
        type: "string",
        enum: ["portals", "tonnel", "getgems"],
        description: "Marketplace for price data (default: portals).",
      },
      caption: {
        type: "string",
        description: "Optional caption for the chart image.",
      },
      chat_id: {
        type: "string",
        description: "Target chat/channel (e.g. @morganlegacy). Defaults to current chat.",
      },
      return_url_only: {
        type: "boolean",
        description: "If true, return chart URL without sending to chat. Use with telegram_send_album to combine multiple charts in one post.",
      },
      showVolume: {
        type: "boolean",
        description: "Show trading volume bars below price chart. Uses Giftstat history data. Default: false.",
      },
    },
  },

  execute: async (params, context) => {
    try {
      const days = params.days || 7;
      const marketplace = params.marketplace || "portals";
      const chatId = params.chat_id || context.chatId;

      let collectionSlugs = null;
      if (params.collections) {
        collectionSlugs = params.collections.split(",").map((s) => s.trim()).filter(Boolean);
      }

      if (!collectionSlugs || collectionSlugs.length === 0) {
        collectionSlugs = await fetchTopCollections(marketplace, 50);
        if (collectionSlugs.length === 0) {
          return { success: false, error: "No collections found with floor >= 10 TON" };
        }
      }

      const byCollection = await fetchGiftFloorHistory(collectionSlugs, days, marketplace);
      if (!byCollection || Object.keys(byCollection).length === 0) {
        return { success: false, error: "No price history data found for specified collections" };
      }

      if (params.showVolume) {
        const chartUrl = await buildFloorChartWithVolume(byCollection, days);
        if (!chartUrl) return { success: false, error: "Failed to build chart with volume" };

        const collectionNames = Object.values(byCollection).map((c) => c.name);
        const summaryParts = [];
        for (const col of Object.values(byCollection)) {
          if (!col.name || col.name === "undefined") continue;
          if (col.points.length >= 2) {
            const first = col.points[0].price;
            const last = col.points[col.points.length - 1].price;
            const lastRounded = last >= 100 ? Math.round(last) : Math.round(last * 10) / 10;
            if (first > 0) {
              const pct = ((last - first) / first * 100).toFixed(1);
              summaryParts.push(`${col.name}: ${lastRounded} TON (${pct >= 0 ? "+" : ""}${pct}%)`);
            } else {
              summaryParts.push(`${col.name}: ${lastRounded} TON`);
            }
          }
        }

        if (params.return_url_only) {
          return { success: true, data: { chart_url: chartUrl, collections: collectionNames, days, marketplace, summary: summaryParts, volume: true } };
        }

        const client = context.bridge.getClient().getClient();
        let peer;
        try { peer = await client.getInputEntity(chatId); }
        catch { return { success: false, error: `Cannot resolve chat: ${chatId}` }; }

        const caption = params.caption || `📊 Флоры + объём — ${days}д (${marketplace})\n${summaryParts.join(" | ")}`;
        const imgBuf = await downloadChartImage(chartUrl);
        await client.sendFile(peer, { file: imgBuf, caption: caption.slice(0, 1024), parseMode: "md", forceDocument: false });

        return { success: true, data: { collections: collectionNames, days, marketplace, summary: summaryParts, volume: true } };
      }

      const chartUrl = await buildGiftChartUrl(byCollection, days);
      if (!chartUrl) {
        return { success: false, error: "Failed to build chart" };
      }

      const collectionNames = Object.values(byCollection).map((c) => c.name);
      const summaryParts = [];
      for (const col of Object.values(byCollection)) {
        if (!col.name || col.name === "undefined") continue;
        if (col.points.length >= 2) {
          const first = col.points[0].price;
          const last = col.points[col.points.length - 1].price;
          const lastRounded = last >= 100 ? Math.round(last) : Math.round(last * 10) / 10;
          if (first > 0) {
            const pct = ((last - first) / first * 100).toFixed(1);
            summaryParts.push(`${col.name}: ${lastRounded} TON (${pct >= 0 ? "+" : ""}${pct}%)`);
          } else {
            summaryParts.push(`${col.name}: ${lastRounded} TON`);
          }
        }
      }

      if (params.return_url_only) {
        return {
          success: true,
          data: {
            chart_url: chartUrl,
            collections: collectionNames,
            days,
            marketplace,
            summary: summaryParts,
          },
        };
      }

      const client = context.bridge.getClient().getClient();
      let peer;
      try {
        peer = await client.getInputEntity(chatId);
      } catch {
        return { success: false, error: `Cannot resolve chat: ${chatId}` };
      }

      const caption = params.caption || `Gift Floor Prices — ${days}d (${marketplace})\n${summaryParts.join(" | ")}`;

      const imgBuf = await downloadChartImage(chartUrl);
      await client.sendFile(peer, {
        file: imgBuf,
        caption: caption.slice(0, 1024),
        parseMode: "md",
        forceDocument: false,
      });

      return {
        success: true,
        data: {
          collections: collectionNames,
          days,
          marketplace,
          summary: summaryParts,
          points_per_collection: Object.fromEntries(
            Object.entries(byCollection).map(([k, v]) => [v.name, v.points.length])
          ),
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

async function fetchAllCollections(marketplace) {
  const url = new URL("/current/collections/floor", GIFTSTAT_API);
  url.searchParams.set("marketplace", marketplace);
  url.searchParams.set("limit", "200");

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return [];
  const json = await res.json();
  if (!Array.isArray(json.data)) return [];
  return json.data;
}

async function buildTopMoversChartUrl(gainers, losers, periodLabel) {
  const items = [...gainers.reverse(), ...losers]
    .filter((i) => i.name && i.name !== "undefined" && i.name !== "null");
  const labels = items.map((i) => String(i.name || "Unknown").slice(0, 20));
  const data = items.map((i) => Math.round((i.change || 0) * 10) / 10);
  const colors = items.map((i) => ((i.change || 0) >= 0 ? "#22c55e" : "#ef4444"));

  const periodRu = periodLabel === "24h" ? "24ч" : periodLabel === "7 days" ? "7 дней" : "30 дней";
  const chartConfig = {
    type: "horizontalBar",
    data: {
      labels,
      datasets: [
        {
          label: `Изменение (%)`,
          data,
          backgroundColor: colors,
          borderColor: colors,
          borderWidth: 1,
        },
      ],
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: `ТОП Муверы — ${periodRu}`,
          font: { size: 18, weight: "bold" },
          color: "#e2e8f0",
        },
        legend: { display: false },
        datalabels: {
          display: true,
          anchor: "end",
          align: (ctx) => (ctx.dataset.data[ctx.dataIndex] >= 0 ? "right" : "left"),
          color: "#e2e8f0",
          font: { size: 11, weight: "bold" },
          formatter: (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + "%",
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#94a3b8",
            font: { size: 11 },
            callback: (v) => (v >= 0 ? "+" : "") + Math.round(v) + "%",
          },
          grid: { color: "rgba(148,163,184,0.15)" },
        },
        y: {
          ticks: { color: "#e2e8f0", font: { size: 12 } },
          grid: { display: false },
        },
      },
      layout: { padding: { top: 5, right: 65, bottom: 5, left: 5 } },
    },
  };

  const totalBars = items.length;
  const chartHeight = Math.max(400, totalBars * 34 + 80);

  return getChartShortUrl(chartConfig, 900, chartHeight, "#0f172a");
}

const giftTopMovers = {
  name: "gift_top_movers",
  category: "data-bearing",
  description:
    "Generate a horizontal bar chart showing TOP gift collections by price change (gainers and losers). " +
    "Compares current floor price vs previous period (1d, 7d, or 30d). " +
    "Great for channel posts — shows which collections grew the most and which dropped.",

  parameters: {
    type: "object",
    properties: {
      period: {
        type: "string",
        enum: ["1d", "7d", "30d"],
        description: "Comparison period: 1d (vs yesterday), 7d (vs last week), 30d (vs last month). Default: 7d.",
      },
      top_count: {
        type: "integer",
        description: "Number of top gainers and top losers to show (default: 10, max: 15).",
      },
      min_floor: {
        type: "number",
        description: "Minimum floor price in TON to include (default: 5). Filters out cheap/noisy collections.",
      },
      marketplace: {
        type: "string",
        enum: ["portals", "tonnel", "getgems"],
        description: "Marketplace for price data (default: portals).",
      },
      caption: {
        type: "string",
        description: "Optional caption for the chart image.",
      },
      chat_id: {
        type: "string",
        description: "Target chat/channel (e.g. @morganlegacy). Defaults to current chat.",
      },
      return_url_only: {
        type: "boolean",
        description: "If true, return chart URL without sending to chat. Use with telegram_send_album to combine multiple charts.",
      },
    },
  },

  execute: async (params, context) => {
    try {
      const period = params.period || "7d";
      const topCount = Math.min(params.top_count || 10, 15);
      const minFloor = params.min_floor ?? 5;
      const marketplace = params.marketplace || "portals";
      const chatId = params.chat_id || context.chatId;

      const allCollections = await fetchAllCollections(marketplace);
      if (allCollections.length === 0) {
        return { success: false, error: "No collections data available" };
      }

      const prevField = {
        "1d": "floor_price_prev1day",
        "7d": "floor_price_prev7day",
        "30d": "floor_price_prev30day",
      }[period];

      const withChange = allCollections
        .filter((c) => c.floor_price >= minFloor && c[prevField] > 0 && (c.collection || c.slug))
        .map((c) => ({
          name: c.collection || c.slug || "Unknown",
          slug: c.slug || "",
          floor: Math.round(c.floor_price * 10) / 10,
          prev: c[prevField],
          change: ((c.floor_price - c[prevField]) / c[prevField]) * 100,
        }));

      withChange.sort((a, b) => b.change - a.change);

      const gainers = withChange.slice(0, topCount);
      const losers = withChange.slice(-topCount).reverse();

      const periodLabel = period === "1d" ? "24h" : period === "7d" ? "7 days" : "30 days";
      const chartUrl = await buildTopMoversChartUrl(gainers, losers, periodLabel);

      if (params.return_url_only) {
        return {
          success: true,
          data: {
            chart_url: chartUrl,
            period: periodLabel,
            gainers: gainers.map((g) => ({ name: g.name, floor: g.floor, change: +g.change.toFixed(1) })),
            losers: losers.map((l) => ({ name: l.name, floor: l.floor, change: +l.change.toFixed(1) })),
          },
        };
      }

      const client = context.bridge.getClient().getClient();
      let peer;
      try {
        peer = await client.getInputEntity(chatId);
      } catch {
        return { success: false, error: `Cannot resolve chat: ${chatId}` };
      }

      const caption = params.caption ||
        `TOP Movers — ${periodLabel} (${marketplace})\n` +
        gainers.slice(0, 3).map((g) => `${g.name}: +${g.change.toFixed(1)}%`).join(" | ") +
        " | " +
        losers.slice(0, 3).map((l) => `${l.name}: ${l.change.toFixed(1)}%`).join(" | ");

      const imgBuf = await downloadChartImage(chartUrl);
      await client.sendFile(peer, {
        file: imgBuf,
        caption: caption.slice(0, 1024),
        parseMode: "md",
        forceDocument: false,
      });

      return {
        success: true,
        data: {
          period: periodLabel,
          marketplace,
          gainers: gainers.map((g) => ({ name: g.name, floor: g.floor, change: +g.change.toFixed(1) })),
          losers: losers.map((l) => ({ name: l.name, floor: l.floor, change: +l.change.toFixed(1) })),
        },
      };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

const DARK_COLORS = [
  "#f59e0b", "#3b82f6", "#22c55e", "#ef4444", "#a855f7",
  "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16",
  "#06b6d4", "#e11d48", "#8b5cf6", "#d97706", "#059669",
];

async function buildPieChartUrl(labels, values, title, options = {}) {
  const colors = options.colors || DARK_COLORS.slice(0, labels.length);
  const chartType = options.doughnut ? "doughnut" : "pie";

  const chartConfig = {
    type: chartType,
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderColor: "#0f172a",
        borderWidth: 2,
      }],
    },
    options: {
      plugins: {
        title: {
          display: !!title,
          text: title || "",
          font: { size: 16, weight: "bold" },
          color: "#e2e8f0",
        },
        legend: {
          display: true,
          position: "right",
          labels: {
            color: "#e2e8f0",
            boxWidth: 14,
            padding: 10,
            font: { size: 11 },
            generateLabels: undefined,
          },
        },
        datalabels: {
          display: true,
          color: "#ffffff",
          font: { size: 11, weight: "bold" },
          formatter: (value, ctx) => {
            const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
            const pct = ((value / total) * 100).toFixed(1);
            return pct > 3 ? pct + "%" : "";
          },
        },
      },
    },
  };

  return getChartShortUrl(chartConfig, options.width || 700, options.height || 400, "#0f172a");
}

const pieChart = {
  name: "chart_pie",
  category: "data-bearing",
  description:
    "Generate a pie or doughnut chart image and send to chat/channel. " +
    "Use for: volume breakdowns (organic vs wash), portfolio distribution, market share, transaction type splits. " +
    "Dark theme, professional colors. " +
    "RULE: When creating 2+ charts, ALWAYS use return_url_only=true and combine via chart_dashboard. Never send multiple charts separately.",

  parameters: {
    type: "object",
    properties: {
      labels: {
        type: "array",
        items: { type: "string" },
        description: 'Slice labels, e.g. ["Organic", "Gray zone", "Wash trading"]',
      },
      values: {
        type: "array",
        items: { type: "number" },
        description: "Numeric values for each slice, e.g. [1.8, 3.6, 7.3]",
      },
      title: {
        type: "string",
        description: 'Chart title, e.g. "MRKT — Volume Breakdown"',
      },
      doughnut: {
        type: "boolean",
        description: "If true, render as doughnut (hollow center) instead of solid pie. Default: false.",
      },
      colors: {
        type: "array",
        items: { type: "string" },
        description: 'Custom hex colors for slices, e.g. ["#22c55e", "#f59e0b", "#ef4444"]. Auto-assigned if omitted.',
      },
      caption: {
        type: "string",
        description: "Optional caption text under the chart image.",
      },
      chat_id: {
        type: "string",
        description: "Target chat/channel. Defaults to current chat.",
      },
      return_url_only: {
        type: "boolean",
        description: "If true, return chart URL without sending. Use for album/dashboard composition.",
      },
    },
    required: ["labels", "values"],
  },

  execute: async (params, context) => {
    try {
      const { labels, values, title, doughnut, colors } = params;
      const chatId = params.chat_id || context.chatId;

      if (!labels || !values || labels.length !== values.length) {
        return { success: false, error: "labels and values arrays must have equal length" };
      }

      const chartUrl = await buildPieChartUrl(labels, values, title, { doughnut, colors });

      if (params.return_url_only) {
        return { success: true, data: { chart_url: chartUrl, labels, values, title } };
      }

      const client = context.bridge.getClient().getClient();
      let peer;
      try { peer = await client.getInputEntity(chatId); }
      catch { return { success: false, error: `Cannot resolve chat: ${chatId}` }; }

      const caption = params.caption || title || "Chart";
      const imgBuf = await downloadChartImage(chartUrl);
      await client.sendFile(peer, { file: imgBuf, caption, parseMode: "md", forceDocument: false });

      return { success: true, data: { labels, values, title } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

async function buildBarChartUrl(labels, datasets, title, options = {}) {
  const chartDatasets = datasets.map((ds, idx) => ({
    label: ds.label || `Series ${idx + 1}`,
    data: ds.data,
    backgroundColor: ds.color || DARK_COLORS[idx % DARK_COLORS.length],
    borderColor: ds.borderColor || ds.color || DARK_COLORS[idx % DARK_COLORS.length],
    borderWidth: 1,
    borderRadius: 3,
    barPercentage: datasets.length > 1 ? 0.8 : 0.6,
    categoryPercentage: datasets.length > 1 ? 0.8 : 0.7,
  }));

  const chartConfig = {
    type: options.stacked ? "bar" : "bar",
    data: { labels, datasets: chartDatasets },
    options: {
      plugins: {
        title: {
          display: !!title,
          text: title || "",
          font: { size: 16, weight: "bold" },
          color: "#e2e8f0",
        },
        legend: {
          display: datasets.length > 1,
          position: "top",
          labels: { color: "#94a3b8", boxWidth: 12, padding: 8, font: { size: 10 } },
        },
        datalabels: {
          display: options.show_values !== false,
          anchor: "end",
          align: "top",
          color: "#e2e8f0",
          font: { size: 10, weight: "bold" },
          formatter: (v) => {
            if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
            if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
            return String(v);
          },
        },
      },
      scales: {
        x: {
          stacked: !!options.stacked,
          ticks: { color: "#94a3b8", maxRotation: 45, font: { size: 10 } },
          grid: { color: "rgba(148,163,184,0.1)" },
        },
        y: {
          stacked: !!options.stacked,
          ticks: {
            color: "#94a3b8",
            callback: (v) => {
              if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
              if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
              return v;
            },
          },
          grid: { color: "rgba(148,163,184,0.15)" },
          title: options.y_label ? { display: true, text: options.y_label, color: "#94a3b8", font: { size: 11 } } : undefined,
        },
      },
      layout: { padding: { top: 10, right: 15, bottom: 5, left: 5 } },
    },
  };

  const barCount = labels.length * datasets.length;
  const chartWidth = Math.max(600, Math.min(1000, barCount * 50 + 200));

  return getChartShortUrl(chartConfig, options.width || chartWidth, options.height || 450, "#0f172a");
}

const barChart = {
  name: "chart_bar",
  category: "data-bearing",
  description:
    "Generate a vertical bar chart image and send to chat/channel. " +
    "Use for: daily trading volumes, collection comparisons, before/after data, category breakdowns. " +
    "Supports grouped bars (multiple datasets) and stacked bars. Dark theme, professional colors. " +
    "RULE: When creating 2+ charts, ALWAYS use return_url_only=true and combine via chart_dashboard. Never send multiple charts separately.",

  parameters: {
    type: "object",
    properties: {
      labels: {
        type: "array",
        items: { type: "string" },
        description: 'X-axis labels, e.g. ["Jun 1", "Jun 2", "Jun 3"] or ["MRKT", "Tonnel", "Fragment"]',
      },
      datasets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: 'Series name, e.g. "Declared volume"' },
            data: { type: "array", items: { type: "number" }, description: "Numeric values" },
            color: { type: "string", description: 'Hex color, e.g. "#22c55e"' },
          },
          required: ["data"],
        },
        description: "One or more data series. Use multiple for grouped/stacked bars.",
      },
      title: {
        type: "string",
        description: 'Chart title, e.g. "Daily Trading Volume (Feb 2026)"',
      },
      stacked: {
        type: "boolean",
        description: "Stack bars on top of each other (instead of side-by-side). Default: false.",
      },
      y_label: {
        type: "string",
        description: 'Y-axis label, e.g. "Volume (TON)" or "Count"',
      },
      caption: {
        type: "string",
        description: "Optional caption text under the chart image.",
      },
      chat_id: {
        type: "string",
        description: "Target chat/channel. Defaults to current chat.",
      },
      return_url_only: {
        type: "boolean",
        description: "If true, return chart URL without sending. Use for album/dashboard composition.",
      },
    },
    required: ["labels", "datasets"],
  },

  execute: async (params, context) => {
    try {
      const { labels, datasets, title, stacked, y_label } = params;
      const chatId = params.chat_id || context.chatId;

      if (!labels || !datasets || datasets.length === 0) {
        return { success: false, error: "labels and datasets are required" };
      }

      const chartUrl = await buildBarChartUrl(labels, datasets, title, { stacked, y_label });

      if (params.return_url_only) {
        return { success: true, data: { chart_url: chartUrl, labels, title } };
      }

      const client = context.bridge.getClient().getClient();
      let peer;
      try { peer = await client.getInputEntity(chatId); }
      catch { return { success: false, error: `Cannot resolve chat: ${chatId}` }; }

      const caption = params.caption || title || "Chart";
      const imgBuf = await downloadChartImage(chartUrl);
      await client.sendFile(peer, { file: imgBuf, caption, parseMode: "md", forceDocument: false });

      return { success: true, data: { labels, title } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

async function downloadChartImage(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading chart`);
    const buf = Buffer.from(await res.arrayBuffer());
    return new CustomFile("chart.png", buf.length, "", buf);
  } finally {
    clearTimeout(timer);
  }
}

async function downloadImage(url, timeoutMs = 15000) {
  console.log(`📥 downloadImage: ${url.length} chars, url=${url.substring(0, 120)}${url.length > 120 ? "..." : ""}`);

  if (url.includes("quickchart.io/chart?") && url.length > 2000) {
    console.log(`📥 Long GET URL detected (${url.length} chars), re-creating via POST...`);
    try {
      const parsed = new URL(url);
      const chartConfig = parsed.searchParams.get("c");
      const width = Number(parsed.searchParams.get("w")) || 800;
      const height = Number(parsed.searchParams.get("h")) || 400;
      const bkg = parsed.searchParams.get("bkg") || "#0f172a";
      const version = parsed.searchParams.get("version");

      if (chartConfig) {
        const body = {
          chart: JSON.parse(chartConfig),
          width, height, backgroundColor: bkg,
          format: "png", devicePixelRatio: 2,
        };
        if (version) body.version = version;

        const postRes = await fetch(QUICKCHART_CREATE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
        if (postRes.ok) {
          const json = await postRes.json();
          if (json.success && json.url) {
            console.log(`📥 Re-created short URL: ${json.url}`);
            url = json.url;
          }
        }
      }
    } catch (repostErr) {
      console.warn(`⚠️ Failed to re-POST long URL: ${repostErr.message}`);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} (url=${url.substring(0, 200)}, body=${body.substring(0, 200)})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 10 * 1024 * 1024) throw new Error("Image too large (>10MB)");
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

async function composeDashboard(chartUrls, options = {}) {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    throw new Error("sharp library not available for dashboard composition");
  }

  const DARK_BG = { r: 15, g: 23, b: 42, alpha: 255 };
  const PADDING = 20;
  const GAP = 16;
  const DASHBOARD_WIDTH = options.width || 1200;
  const HALF_WIDTH = Math.floor((DASHBOARD_WIDTH - PADDING * 2 - GAP) / 2);

  const buffers = await Promise.all(chartUrls.map((url) => downloadImage(url)));
  const images = await Promise.all(buffers.map(async (buf) => {
    const meta = await sharp(buf).metadata();
    return { buf, width: meta.width || 800, height: meta.height || 400 };
  }));

  const layout = options.layout || "auto";
  const rows = [];

  if (layout === "auto") {
    let i = 0;
    while (i < images.length) {
      const img = images[i];
      const aspect = img.width / img.height;

      if (aspect > 1.8 || images.length - i === 1 || (images.length <= 2)) {
        rows.push({ type: "full", indices: [i] });
        i++;
      } else if (i + 1 < images.length) {
        rows.push({ type: "half", indices: [i, i + 1] });
        i += 2;
      } else {
        rows.push({ type: "full", indices: [i] });
        i++;
      }
    }
  } else if (layout === "grid") {
    for (let i = 0; i < images.length; i += 2) {
      if (i + 1 < images.length) {
        rows.push({ type: "half", indices: [i, i + 1] });
      } else {
        rows.push({ type: "full", indices: [i] });
      }
    }
  } else {
    for (let i = 0; i < images.length; i++) {
      rows.push({ type: "full", indices: [i] });
    }
  }

  const composites = [];
  let currentY = PADDING;
  const contentWidth = DASHBOARD_WIDTH - PADDING * 2;

  for (const row of rows) {
    if (row.type === "full") {
      const img = images[row.indices[0]];
      const scale = contentWidth / img.width;
      const scaledHeight = Math.round(img.height * scale);

      const resized = await sharp(img.buf).resize(contentWidth, scaledHeight, { fit: "fill" }).toBuffer();
      composites.push({ input: resized, left: PADDING, top: currentY });
      currentY += scaledHeight + GAP;
    } else {
      let maxH = 0;
      for (const idx of row.indices) {
        const img = images[idx];
        const scale = HALF_WIDTH / img.width;
        const scaledHeight = Math.round(img.height * scale);
        if (scaledHeight > maxH) maxH = scaledHeight;
      }

      for (let j = 0; j < row.indices.length; j++) {
        const img = images[row.indices[j]];
        const scale = HALF_WIDTH / img.width;
        const scaledHeight = Math.round(img.height * scale);

        const resized = await sharp(img.buf).resize(HALF_WIDTH, scaledHeight, { fit: "fill" }).toBuffer();
        const left = PADDING + j * (HALF_WIDTH + GAP);
        composites.push({ input: resized, left, top: currentY });
      }
      currentY += maxH + GAP;
    }
  }

  const totalHeight = currentY - GAP + PADDING;

  const dashboard = await sharp({
    create: {
      width: DASHBOARD_WIDTH,
      height: totalHeight,
      channels: 4,
      background: DARK_BG,
    },
  })
    .composite(composites)
    .png({ quality: 90 })
    .toBuffer();

  return dashboard;
}

const dashboardTool = {
  name: "chart_dashboard",
  category: "data-bearing",
  description:
    "IMPORTANT: ALWAYS use this tool to combine 2+ charts into ONE image before sending. " +
    "NEVER send charts separately via multiple telegram_send_photo — always compose a dashboard first. " +
    "Compose multiple chart images into a single dashboard image with dark background and grid layout. " +
    "First generate charts using chart_pie, chart_bar, gift_floor_chart, gift_top_movers, market_chart with return_url_only=true, " +
    "then pass their chart_url values here. The result is a single tall image with all charts arranged professionally — " +
    "like a Bloomberg terminal dashboard. Send via telegram_send_photo. " +
    "Layout modes: 'auto' (smart 1-2 column), 'grid' (force 2 columns), 'stack' (all full-width). " +
    "Dashboard modes: 'trading' (candlestick+volume+heatmap), 'whale' (whale_activity+dominance), 'distribution' (histogram+floor+turnover).",

  parameters: {
    type: "object",
    properties: {
      chart_urls: {
        type: "array",
        items: { type: "string" },
        description: "Array of chart image URLs from other chart tools (use return_url_only=true). 2-6 charts recommended.",
      },
      mode: {
        type: "string",
        enum: ["default", "trading", "whale", "distribution"],
        description: "Dashboard preset mode. 'default' = bar+line+pie, 'trading' = candlestick+volume+heatmap, 'whale' = whale_activity+dominance, 'distribution' = histogram+floor+turnover. Only affects the description hint for LLM — chart_urls still required.",
      },
      layout: {
        type: "string",
        enum: ["auto", "grid", "stack"],
        description: "Layout mode: 'auto' (smart arrangement), 'grid' (force 2-column grid), 'stack' (all full-width). Default: auto.",
      },
      width: {
        type: "integer",
        description: "Dashboard width in pixels (default: 1200). Use 900 for mobile-friendly.",
      },
      caption: {
        type: "string",
        description: "Caption for when sending directly to chat.",
      },
      chat_id: {
        type: "string",
        description: "Target chat/channel. If set, sends the dashboard image directly.",
      },
      return_file_path: {
        type: "boolean",
        description: "If true, save to temp file and return the file path instead of sending. Use to pass to telegram_send_album.",
      },
    },
    required: ["chart_urls"],
  },

  execute: async (params, context) => {
    try {
      const { chart_urls, layout, width, caption } = params;

      if (!chart_urls || chart_urls.length === 0) {
        return { success: false, error: "No chart_urls provided" };
      }
      if (chart_urls.length > 8) {
        return { success: false, error: "Maximum 8 charts per dashboard" };
      }

      console.log(`🎨 Composing dashboard: ${chart_urls.length} charts, layout=${layout || "auto"}`);

      const dashboardBuffer = await composeDashboard(chart_urls, { layout, width });

      const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const teletoneHome = process.env.TELETON_HOME || join(homedir(), ".teleton");
      const tmpDir = join(teletoneHome, "workspace", "temp");
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
      const filePath = join(tmpDir, `dashboard_${Date.now()}.png`);
      writeFileSync(filePath, dashboardBuffer);

      console.log(`📊 Dashboard saved: ${filePath} (${(dashboardBuffer.length / 1024).toFixed(0)} KB)`);

      if (params.return_file_path || !params.chat_id) {
        return {
          success: true,
          data: {
            file_path: filePath,
            size_kb: Math.round(dashboardBuffer.length / 1024),
            charts_count: chart_urls.length,
            layout: layout || "auto",
          },
        };
      }

      const client = context.bridge.getClient().getClient();
      let peer;
      try { peer = await client.getInputEntity(params.chat_id); }
      catch { return { success: false, error: `Cannot resolve chat: ${params.chat_id}` }; }

      await client.sendFile(peer, {
        file: filePath,
        caption: caption || "",
        parseMode: "md",
        forceDocument: false,
      });

      return {
        success: true,
        data: {
          file_path: filePath,
          size_kb: Math.round(dashboardBuffer.length / 1024),
          charts_count: chart_urls.length,
          sent_to: params.chat_id,
        },
      };
    } catch (err) {
      console.error("Dashboard composition error:", err);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

const CHART_COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#06b6d4", "#f97316", "#ec4899", "#14b8a6", "#a855f7",
  "#eab308", "#22c55e", "#e11d48", "#0ea5e9", "#d946ef",
];

const chartGenerate = {
  name: "chart_generate",
  category: "data-bearing",
  description:
    "Universal chart generator — create any chart from raw data arrays. " +
    "Types: line, multi_line, bar, horizontal_bar, pie, doughnut. " +
    "Pass your own labels and datasets with data arrays. " +
    "Supports annotations (text markers on data points), custom colors, axis labels. " +
    "Use this when you have computed data (whale portfolios, volume analysis, anomaly detection) " +
    "and need a professional chart. Returns chart_url (use with chart_dashboard) or sends directly. " +
    "Dark theme by default (#0D1117 background). " +
    "RULE: When creating 2+ charts, ALWAYS use return_url_only=true and combine via chart_dashboard. Never send multiple charts separately.",

  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["line", "multi_line", "bar", "horizontal_bar", "pie", "doughnut"],
        description: "Chart type. multi_line = multiple line series on same axes.",
      },
      title: {
        type: "string",
        description: "Chart title (displayed at top, white text).",
      },
      subtitle: {
        type: "string",
        description: "Optional subtitle below title (smaller, gray text).",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "X-axis labels (categories, dates, names). Required.",
      },
      datasets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Series name for legend" },
            data: { type: "array", items: { type: "number" }, description: "Data values array (same length as labels)" },
            color: { type: "string", description: "Optional color hex (e.g. #FF6B35). Auto-assigned if omitted." },
          },
          required: ["label", "data"],
        },
        description: "One or more data series. Each has label, data array, optional color.",
      },
      x_label: { type: "string", description: "X-axis label (e.g. 'Date', 'Collection')" },
      y_label: { type: "string", description: "Y-axis label (e.g. 'Volume (K TON)', 'Price (TON)')" },
      annotations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "Data point index to annotate" },
            text: { type: "string", description: "Annotation text (e.g. 'x16', 'wash?', 'PEAK')" },
          },
          required: ["index", "text"],
        },
        description: "Optional text annotations on specific data points.",
      },
      stacked: { type: "boolean", description: "Stack bars/areas (default: false)" },
      width: { type: "integer", description: "Chart width in px (default: 900)" },
      height: { type: "integer", description: "Chart height in px (default: 500)" },
      values: {
        type: "array",
        items: { type: "number" },
        description: "Fallback: simple data values array (converted to single dataset). Use 'datasets' for multi-series.",
      },
      colors: {
        type: "array",
        items: { type: "string" },
        description: "Fallback: colors for values array. Use 'datasets' with color field for multi-series.",
      },
      chat_id: { type: "string", description: "Send chart directly to this chat/channel" },
      caption: { type: "string", description: "Caption when sending to chat" },
      return_url_only: { type: "boolean", description: "Return URL without sending (for dashboard composition)" },
    },
    required: ["type", "title", "labels"],
  },

  execute: async (params, context) => {
    try {
      const { type, title, subtitle, labels, x_label, y_label, annotations, stacked } = params;

      if (!labels || labels.length === 0) return { success: false, error: "labels array is required" };

      let datasets = params.datasets;
      if ((!datasets || datasets.length === 0) && params.values) {
        datasets = [{
          label: title || "Data",
          data: params.values,
          color: params.colors && params.colors.length === 1 ? params.colors[0] : undefined,
        }];
      }
      if (!datasets || datasets.length === 0) return { success: false, error: "datasets array is required (or pass values array as fallback)" };

      const isHorizontal = type === "horizontal_bar";
      const isPie = type === "pie" || type === "doughnut";
      const isLine = type === "line" || type === "multi_line";
      const chartType = isPie ? type : isHorizontal ? "horizontalBar" : isLine ? "line" : "bar";

      const chartDatasets = datasets.map((ds, i) => {
        const color = ds.color || CHART_COLORS[i % CHART_COLORS.length];
        const base = {
          label: ds.label,
          data: ds.data,
        };

        if (isPie) {
          return {
            ...base,
            backgroundColor: ds.data.map((_, j) => datasets.length === 1 ? (CHART_COLORS[j % CHART_COLORS.length]) : color),
            borderColor: "#0D1117",
            borderWidth: 2,
          };
        }

        if (isLine) {
          return {
            ...base,
            borderColor: color,
            backgroundColor: color + "20",
            fill: false,
            tension: 0.3,
            pointRadius: 4,
            pointBackgroundColor: color,
            borderWidth: 2,
          };
        }

        return {
          ...base,
          backgroundColor: datasets.length === 1
            ? ds.data.map((_, j) => CHART_COLORS[j % CHART_COLORS.length])
            : color,
          borderColor: "#0D1117",
          borderWidth: 1,
        };
      });

      const chartConfig = {
        type: chartType,
        data: { labels, datasets: chartDatasets },
        options: {
          legend: {
            display: datasets.length > 1 || isPie,
            labels: { fontColor: "#e2e8f0", fontSize: 12, padding: 15 },
            position: isPie ? "right" : "top",
          },
          title: {
            display: true,
            text: subtitle ? [title, subtitle] : title,
            fontColor: "#f1f5f9",
            fontSize: 16,
            padding: 10,
          },
        },
      };

      if (!isPie) {
        const scaleColor = "#94a3b8";
        const gridColor = "#1e293b";

        chartConfig.options.scales = {
          [isHorizontal ? "xAxes" : "yAxes"]: [{
            ticks: { fontColor: scaleColor, beginAtZero: true },
            gridLines: { color: gridColor },
            ...(y_label ? { scaleLabel: { display: true, labelString: y_label, fontColor: "#cbd5e1" } } : {}),
            ...(stacked ? { stacked: true } : {}),
          }],
          [isHorizontal ? "yAxes" : "xAxes"]: [{
            ticks: { fontColor: scaleColor },
            gridLines: { color: gridColor },
            ...(x_label ? { scaleLabel: { display: true, labelString: x_label, fontColor: "#cbd5e1" } } : {}),
            ...(stacked ? { stacked: true } : {}),
          }],
        };
      }

      if (annotations && annotations.length > 0 && !isPie) {
        chartConfig.options.plugins = chartConfig.options.plugins || {};
        chartConfig.options.plugins.datalabels = {
          display: (ctx) => {
            const idx = ctx.dataIndex;
            return annotations.some((a) => a.index === idx);
          },
          color: "#FFD700",
          anchor: "end",
          align: "top",
          font: { weight: "bold", size: 12 },
          formatter: (value, ctx) => {
            const ann = annotations.find((a) => a.index === ctx.dataIndex);
            return ann ? ann.text : "";
          },
        };
      }

      if (isPie) {
        chartConfig.options.plugins = chartConfig.options.plugins || {};
        chartConfig.options.plugins.datalabels = {
          color: "#f1f5f9",
          font: { size: 11, weight: "bold" },
          formatter: (value, ctx) => {
            const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
            const pct = ((value / total) * 100).toFixed(0);
            if (+pct < 3) return "";
            return `${ctx.chart.data.labels[ctx.dataIndex]}\n${pct}%`;
          },
        };
      }

      const chartWidth = params.width || 900;
      const chartHeight = params.height || 500;

      const chartUrl = await getChartShortUrl(chartConfig, chartWidth, chartHeight, "#0D1117");

      console.log(`📊 chart_generate: ${type} "${title}" (${datasets.length} series, ${labels.length} points)`);

      if (params.return_url_only) {
        return { success: true, data: { chart_url: chartUrl, type, title } };
      }

      if (!params.chat_id) {
        return { success: true, data: { chart_url: chartUrl, type, title, note: "Use chart_dashboard or telegram_send_photo to send" } };
      }

      const client = context.bridge.getClient().getClient();
      let peer;
      try { peer = await client.getInputEntity(params.chat_id); }
      catch { return { success: false, error: `Cannot resolve chat: ${params.chat_id}` }; }

      const sendCaption = params.caption || title;
      const imgBuf = await downloadChartImage(chartUrl);
      await client.sendFile(peer, { file: imgBuf, caption: sendCaption, parseMode: "md", forceDocument: false });

      return { success: true, data: { chart_url: chartUrl, type, title, sent_to: params.chat_id } };
    } catch (err) {
      console.error("chart_generate error:", err);
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Heatmap chart — collection performance grid
// ---------------------------------------------------------------------------

async function buildHeatmapUrl(collections, title) {
  const labels = collections.map((c) => String(c.name || "?").slice(0, 16));
  const periods = ["1д", "7д", "30д"];
  const data = [];

  for (let row = 0; row < collections.length; row++) {
    const c = collections[row];
    for (let col = 0; col < 3; col++) {
      const val = [c.change_1d, c.change_7d, c.change_30d][col] ?? 0;
      data.push({ x: periods[col], y: labels[row], v: Math.round(val * 10) / 10 });
    }
  }

  const chartConfig = {
    type: "matrix",
    data: {
      datasets: [{
        label: "Изменение %",
        data,
        backgroundColor: (ctx) => {
          const v = ctx.dataset.data[ctx.dataIndex]?.v ?? 0;
          if (v > 30) return "#15803d";
          if (v > 10) return "#22c55e";
          if (v > 0) return "#4ade80";
          if (v > -10) return "#fbbf24";
          if (v > -30) return "#ef4444";
          return "#991b1b";
        },
        borderColor: "#0f172a",
        borderWidth: 2,
        width: (ctx) => {
          const a = ctx.chart.chartArea;
          return a ? (a.right - a.left) / 3 - 4 : 80;
        },
        height: (ctx) => {
          const a = ctx.chart.chartArea;
          return a ? (a.bottom - a.top) / labels.length - 4 : 30;
        },
      }],
    },
    options: {
      plugins: {
        title: { display: true, text: title, font: { size: 18, weight: "bold" }, color: "#e2e8f0" },
        legend: { display: false },
        datalabels: {
          display: true,
          color: "#ffffff",
          font: { size: 11, weight: "bold" },
          formatter: (v) => (v.v >= 0 ? "+" : "") + v.v.toFixed(1) + "%",
        },
      },
      scales: {
        x: { type: "category", labels: periods, ticks: { color: "#cbd5e1", font: { size: 13 } }, grid: { display: false } },
        y: { type: "category", labels, offset: true, ticks: { color: "#cbd5e1", font: { size: 11 } }, grid: { display: false } },
      },
    },
  };

  const chartHeight = Math.max(400, labels.length * 38 + 100);
  return getChartShortUrl(chartConfig, 700, chartHeight, "#0f172a");
}

const giftHeatmap = {
  name: "gift_heatmap",
  category: "data-bearing",
  description:
    "Generate a heatmap showing gift collection price changes across 1d/7d/30d periods. " +
    "Green = growth, yellow = flat, red = decline. Intensity shows magnitude. " +
    "Great visual overview of entire gift market health. Uses Giftstat data.",

  parameters: {
    type: "object",
    properties: {
      min_floor: {
        type: "number",
        description: "Minimum floor price in TON to include (default: 5).",
      },
      max_collections: {
        type: "integer",
        description: "Max collections to show (default: 15, max: 25).",
      },
      marketplace: {
        type: "string",
        enum: ["portals", "tonnel", "getgems"],
        description: "Marketplace for price data (default: portals).",
      },
      caption: { type: "string", description: "Optional caption." },
      chat_id: { type: "string", description: "Target chat/channel." },
      return_url_only: { type: "boolean", description: "Return URL only for dashboard composition." },
    },
  },

  execute: async (params, context) => {
    try {
      const minFloor = params.min_floor ?? 5;
      const maxCollections = Math.min(params.max_collections || 15, 25);
      const marketplace = params.marketplace || "portals";
      const chatId = params.chat_id || context.chatId;

      const allCollections = await fetchAllCollections(marketplace);
      if (allCollections.length === 0) return { success: false, error: "No collections data" };

      const items = allCollections
        .filter((c) => c.floor_price >= minFloor && (c.collection || c.slug))
        .map((c) => ({
          name: c.collection || c.slug,
          floor: c.floor_price,
          change_1d: c.floor_price_prev1day > 0 ? ((c.floor_price - c.floor_price_prev1day) / c.floor_price_prev1day) * 100 : 0,
          change_7d: c.floor_price_prev7day > 0 ? ((c.floor_price - c.floor_price_prev7day) / c.floor_price_prev7day) * 100 : 0,
          change_30d: c.floor_price_prev30day > 0 ? ((c.floor_price - c.floor_price_prev30day) / c.floor_price_prev30day) * 100 : 0,
        }))
        .sort((a, b) => b.floor - a.floor)
        .slice(0, maxCollections);

      if (items.length === 0) return { success: false, error: "No collections match criteria" };

      const chartUrl = await buildHeatmapUrl(items, `Тепловая карта подарков — ${marketplace}`);

      if (params.return_url_only) {
        return { success: true, data: { chart_url: chartUrl, collections: items.length, marketplace } };
      }

      const client = context.bridge.getClient().getClient();
      let peer;
      try { peer = await client.getInputEntity(chatId); }
      catch { return { success: false, error: `Cannot resolve chat: ${chatId}` }; }

      const caption = params.caption || `🔥 Тепловая карта подарков (${marketplace})`;
      const imgBuf = await downloadChartImage(chartUrl);
      await client.sendFile(peer, { file: imgBuf, caption, parseMode: "md", forceDocument: false });

      return { success: true, data: { collections: items.length, marketplace } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Market dominance chart — pie/doughnut of market share
// ---------------------------------------------------------------------------

const giftDominance = {
  name: "gift_dominance",
  category: "data-bearing",
  description:
    "Generate a market dominance chart (doughnut) showing each gift collection's share of the total market. " +
    "Market share calculated by floor_price × supply (market cap proxy). " +
    "Similar to BTC dominance in crypto. Uses Giftstat data.",

  parameters: {
    type: "object",
    properties: {
      top_count: {
        type: "integer",
        description: "Number of top collections to show (default: 10, rest grouped as 'Остальные').",
      },
      metric: {
        type: "string",
        enum: ["floor"],
        description: "Metric for dominance: 'floor' = market cap proxy (floor × supply). Default: floor.",
      },
      marketplace: {
        type: "string",
        enum: ["portals", "tonnel", "getgems"],
        description: "Marketplace for price data (default: portals).",
      },
      caption: { type: "string", description: "Optional caption." },
      chat_id: { type: "string", description: "Target chat/channel." },
      return_url_only: { type: "boolean", description: "Return URL only for dashboard composition." },
    },
  },

  execute: async (params, context) => {
    try {
      const topCount = params.top_count || 10;
      const marketplace = params.marketplace || "portals";
      const chatId = params.chat_id || context.chatId;

      const allCollections = await fetchAllCollections(marketplace);
      if (allCollections.length === 0) return { success: false, error: "No collections data" };

      const sorted = allCollections
        .filter((c) => c.floor_price > 0 && (c.collection || c.slug))
        .map((c) => ({
          name: c.collection || c.slug,
          value: c.floor_price * (c.total_supply || c.supply || 1),
        }))
        .sort((a, b) => b.value - a.value);

      if (sorted.length === 0) return { success: false, error: "No collections with valid floor price data" };

      const top = sorted.slice(0, topCount);
      const othersValue = sorted.slice(topCount).reduce((sum, c) => sum + c.value, 0);
      if (othersValue > 0) top.push({ name: "Остальные", value: othersValue });

      const total = top.reduce((s, c) => s + c.value, 0);
      if (total === 0) return { success: false, error: "All collections have zero market cap" };

      const labels = top.map((c) => c.name);
      const values = top.map((c) => Math.round(c.value));

      const title = `Доминация рынка подарков — ${marketplace}`;
      const chartUrl = await buildPieChartUrl(labels, values, title, { doughnut: true, width: 800, height: 500 });

      const breakdown = top.map((c) => ({
        name: c.name,
        share: Math.round((c.value / total) * 1000) / 10,
      }));

      if (params.return_url_only) {
        return { success: true, data: { chart_url: chartUrl, breakdown, marketplace } };
      }

      const client = context.bridge.getClient().getClient();
      let peer;
      try { peer = await client.getInputEntity(chatId); }
      catch { return { success: false, error: `Cannot resolve chat: ${chatId}` }; }

      const caption = params.caption || `📊 ${title}`;
      const imgBuf = await downloadChartImage(chartUrl);
      await client.sendFile(peer, { file: imgBuf, caption, parseMode: "md", forceDocument: false });

      return { success: true, data: { breakdown, marketplace } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Distribution histogram — price distribution
// ---------------------------------------------------------------------------

const giftDistribution = {
  name: "gift_distribution",
  category: "data-bearing",
  description:
    "Generate a price distribution histogram for gift collections. " +
    "Shows how many collections fall into each price bucket (0-10, 10-50, 50-100, 100-500, 500-1000, 1000+ TON). " +
    "Useful for understanding market structure and identifying price clusters.",

  parameters: {
    type: "object",
    properties: {
      marketplace: {
        type: "string",
        enum: ["portals", "tonnel", "getgems"],
        description: "Marketplace for price data (default: portals).",
      },
      caption: { type: "string", description: "Optional caption." },
      chat_id: { type: "string", description: "Target chat/channel." },
      return_url_only: { type: "boolean", description: "Return URL only for dashboard composition." },
    },
  },

  execute: async (params, context) => {
    try {
      const marketplace = params.marketplace || "portals";
      const chatId = params.chat_id || context.chatId;

      const allCollections = await fetchAllCollections(marketplace);
      if (allCollections.length === 0) return { success: false, error: "No collections data" };

      const buckets = [
        { label: "0–10 TON", min: 0, max: 10, count: 0, collections: [] },
        { label: "10–50 TON", min: 10, max: 50, count: 0, collections: [] },
        { label: "50–100 TON", min: 50, max: 100, count: 0, collections: [] },
        { label: "100–500 TON", min: 100, max: 500, count: 0, collections: [] },
        { label: "500–1K TON", min: 500, max: 1000, count: 0, collections: [] },
        { label: "1K+ TON", min: 1000, max: Infinity, count: 0, collections: [] },
      ];

      for (const c of allCollections) {
        if (!c.floor_price || c.floor_price <= 0) continue;
        for (const b of buckets) {
          if (c.floor_price >= b.min && c.floor_price < b.max) {
            b.count++;
            b.collections.push(c.collection || c.slug);
            break;
          }
        }
      }

      const labels = buckets.map((b) => b.label);
      const values = buckets.map((b) => b.count);
      const colors = ["#22c55e", "#4ade80", "#fbbf24", "#f59e0b", "#ef4444", "#991b1b"];

      const title = `Распределение цен подарков — ${marketplace}`;
      const chartUrl = await buildBarChartUrl(
        labels,
        [{ label: "Коллекций", data: values, color: undefined }],
        title,
        { y_label: "Количество", show_values: true }
      );

      const bucketData = buckets.map((b) => ({ range: b.label, count: b.count, examples: b.collections.slice(0, 3) }));

      if (params.return_url_only) {
        return { success: true, data: { chart_url: chartUrl, buckets: bucketData, marketplace } };
      }

      const client = context.bridge.getClient().getClient();
      let peer;
      try { peer = await client.getInputEntity(chatId); }
      catch { return { success: false, error: `Cannot resolve chat: ${chatId}` }; }

      const caption = params.caption || `📊 ${title}`;
      const imgBuf = await downloadChartImage(chartUrl);
      await client.sendFile(peer, { file: imgBuf, caption, parseMode: "md", forceDocument: false });

      return { success: true, data: { buckets: bucketData, marketplace } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Volatility index — collection volatility comparison
// ---------------------------------------------------------------------------

const giftVolatility = {
  name: "gift_volatility",
  category: "data-bearing",
  description:
    "Generate a volatility index chart comparing price stability of gift collections over 7 or 30 days. " +
    "Higher volatility = more risky but potentially more profitable. " +
    "Calculated as standard deviation of daily floor price changes. Horizontal bar chart sorted by volatility.",

  parameters: {
    type: "object",
    properties: {
      days: {
        type: "integer",
        description: "Period for volatility calculation: 7 or 30 days (default: 7).",
      },
      min_floor: {
        type: "number",
        description: "Minimum floor price to include (default: 10 TON).",
      },
      top_count: {
        type: "integer",
        description: "Number of most volatile collections to show (default: 12).",
      },
      marketplace: {
        type: "string",
        enum: ["portals", "tonnel", "getgems"],
        description: "Marketplace (default: portals).",
      },
      caption: { type: "string" },
      chat_id: { type: "string" },
      return_url_only: { type: "boolean" },
    },
  },

  execute: async (params, context) => {
    try {
      const days = params.days || 7;
      const minFloor = params.min_floor ?? 10;
      const topCount = params.top_count || 12;
      const marketplace = params.marketplace || "portals";
      const chatId = params.chat_id || context.chatId;

      const topSlugs = await fetchTopCollections(marketplace, 100);
      if (topSlugs.length === 0) return { success: false, error: "No collections" };

      const byCollection = await fetchGiftFloorHistory(null, days, marketplace);
      if (!byCollection) return { success: false, error: "No history data" };

      const volatilities = [];
      for (const [key, col] of Object.entries(byCollection)) {
        if (!col.name || col.name === "undefined" || col.points.length < 3) continue;
        const lastPrice = col.points[col.points.length - 1].price;
        if (lastPrice < minFloor) continue;

        const returns = [];
        for (let i = 1; i < col.points.length; i++) {
          const prev = col.points[i - 1].price;
          if (prev > 0) returns.push(((col.points[i].price - prev) / prev) * 100);
        }
        if (returns.length < 2) continue;

        const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
        const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
        const stddev = Math.sqrt(variance);

        volatilities.push({ name: col.name, volatility: Math.round(stddev * 10) / 10, floor: lastPrice });
      }

      volatilities.sort((a, b) => b.volatility - a.volatility);
      const top = volatilities.slice(0, topCount);

      if (top.length === 0) return { success: false, error: "Not enough data for volatility" };

      const labels = top.map((t) => t.name.slice(0, 18));
      const data = top.map((t) => t.volatility);
      const colors = top.map((t) => t.volatility > 15 ? "#ef4444" : t.volatility > 8 ? "#f59e0b" : "#22c55e");

      const daysRu = days <= 7 ? `${days} дн` : `${days} дней`;
      const chartConfig = {
        type: "horizontalBar",
        data: {
          labels,
          datasets: [{
            label: "Волатильность (%)",
            data,
            backgroundColor: colors,
            borderColor: colors,
            borderWidth: 1,
          }],
        },
        options: {
          plugins: {
            title: { display: true, text: `Индекс волатильности — ${daysRu}`, font: { size: 18, weight: "bold" }, color: "#e2e8f0" },
            legend: { display: false },
            datalabels: {
              display: true,
              anchor: "end",
              align: "right",
              color: "#e2e8f0",
              font: { size: 11, weight: "bold" },
              formatter: (v) => v.toFixed(1) + "%",
            },
          },
          scales: {
            x: { ticks: { color: "#94a3b8", font: { size: 11 } }, grid: { color: "rgba(148,163,184,0.15)" } },
            y: { ticks: { color: "#e2e8f0", font: { size: 12 } }, grid: { display: false } },
          },
          layout: { padding: { top: 5, right: 60, bottom: 5, left: 5 } },
        },
      };

      const chartHeight = Math.max(400, top.length * 34 + 80);
      const chartUrl = await getChartShortUrl(chartConfig, 900, chartHeight, "#0f172a");

      if (params.return_url_only) {
        return { success: true, data: { chart_url: chartUrl, items: top, period: daysRu } };
      }

      const client = context.bridge.getClient().getClient();
      let peer;
      try { peer = await client.getInputEntity(chatId); }
      catch { return { success: false, error: `Cannot resolve chat: ${chatId}` }; }

      const caption = params.caption || `📈 Индекс волатильности подарков — ${daysRu}`;
      const imgBuf = await downloadChartImage(chartUrl);
      await client.sendFile(peer, { file: imgBuf, caption, parseMode: "md", forceDocument: false });

      return { success: true, data: { items: top, period: daysRu } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

// ---------------------------------------------------------------------------
// Turnover rate chart — how fast gifts are being resold
// ---------------------------------------------------------------------------

const giftTurnover = {
  name: "gift_turnover",
  category: "data-bearing",
  description:
    "Generate a turnover rate comparison chart for gift collections. " +
    "Turnover = (7d change in floor price) / avg floor, showing price momentum. " +
    "Higher turnover suggests more active trading and potential price discovery. " +
    "Horizontal bar chart, sorted by turnover speed.",

  parameters: {
    type: "object",
    properties: {
      min_floor: { type: "number", description: "Minimum floor price (default: 5 TON)." },
      top_count: { type: "integer", description: "Number of collections (default: 12)." },
      marketplace: { type: "string", enum: ["portals", "tonnel", "getgems"] },
      caption: { type: "string" },
      chat_id: { type: "string" },
      return_url_only: { type: "boolean" },
    },
  },

  execute: async (params, context) => {
    try {
      const minFloor = params.min_floor ?? 5;
      const topCount = params.top_count || 12;
      const marketplace = params.marketplace || "portals";
      const chatId = params.chat_id || context.chatId;

      const allCollections = await fetchAllCollections(marketplace);
      const items = allCollections
        .filter((c) => c.floor_price >= minFloor && c.floor_price_prev7day > 0 && (c.collection || c.slug))
        .map((c) => {
          const avg = (c.floor_price + c.floor_price_prev7day) / 2;
          const turnover = Math.abs(c.floor_price - c.floor_price_prev7day) / avg * 100;
          return {
            name: c.collection || c.slug,
            turnover: Math.round(turnover * 10) / 10,
            floor: c.floor_price,
            direction: c.floor_price >= c.floor_price_prev7day ? "up" : "down",
          };
        })
        .sort((a, b) => b.turnover - a.turnover)
        .slice(0, topCount);

      if (items.length === 0) return { success: false, error: "Not enough data" };

      const labels = items.map((t) => t.name.slice(0, 18));
      const data = items.map((t) => t.turnover);
      const colors = items.map((t) => t.direction === "up" ? "#22c55e" : "#ef4444");

      const chartConfig = {
        type: "horizontalBar",
        data: {
          labels,
          datasets: [{
            label: "Оборот (%)",
            data,
            backgroundColor: colors,
            borderColor: colors,
            borderWidth: 1,
          }],
        },
        options: {
          plugins: {
            title: { display: true, text: "Скорость изменения цен — 7д", font: { size: 18, weight: "bold" }, color: "#e2e8f0" },
            legend: { display: false },
            datalabels: {
              display: true,
              anchor: "end",
              align: "right",
              color: "#e2e8f0",
              font: { size: 11, weight: "bold" },
              formatter: (v) => v.toFixed(1) + "%",
            },
          },
          scales: {
            x: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,0.15)" } },
            y: { ticks: { color: "#e2e8f0", font: { size: 12 } }, grid: { display: false } },
          },
          layout: { padding: { top: 5, right: 60, bottom: 5, left: 5 } },
        },
      };

      const chartHeight = Math.max(400, items.length * 34 + 80);
      const chartUrl = await getChartShortUrl(chartConfig, 900, chartHeight, "#0f172a");

      if (params.return_url_only) {
        return { success: true, data: { chart_url: chartUrl, items } };
      }

      const client = context.bridge.getClient().getClient();
      let peer;
      try { peer = await client.getInputEntity(chatId); }
      catch { return { success: false, error: `Cannot resolve chat: ${chatId}` }; }

      const caption = params.caption || "📊 Скорость изменения цен подарков — 7д";
      const imgBuf = await downloadChartImage(chartUrl);
      await client.sendFile(peer, { file: imgBuf, caption, parseMode: "md", forceDocument: false });

      return { success: true, data: { items } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

const chartWhaleActivity = {
  name: "chart_whale_activity",
  category: "data-bearing",
  description:
    "Generate a whale activity timeline chart. Shows large purchases/sales over time as a bubble/scatter chart. " +
    "First call whale_snapshots to get data, then pass the processed data here. " +
    "X-axis: dates, Y-axis: volume in TON, bubble size: number of active whales. Dark theme. " +
    "RULE: When creating 2+ charts, ALWAYS use return_url_only=true and combine via chart_dashboard.",

  parameters: {
    type: "object",
    properties: {
      dates: {
        type: "array",
        items: { type: "string" },
        description: 'Date labels, e.g. ["Feb 10", "Feb 11", "Feb 12"]',
      },
      buy_volumes: {
        type: "array",
        items: { type: "number" },
        description: "Total buy volume in TON per date",
      },
      sell_volumes: {
        type: "array",
        items: { type: "number" },
        description: "Total sell volume in TON per date",
      },
      whale_counts: {
        type: "array",
        items: { type: "number" },
        description: "Number of active whales per date",
      },
      title: {
        type: "string",
        description: 'Chart title, e.g. "Whale Activity — CookieHeart 14д"',
      },
      caption: { type: "string", description: "Optional caption." },
      chat_id: { type: "string", description: "Target chat/channel." },
      return_url_only: { type: "boolean", description: "Return URL only for dashboard composition." },
    },
    required: ["dates", "buy_volumes", "sell_volumes"],
  },

  execute: async (params, context) => {
    try {
      const { dates, buy_volumes, sell_volumes, whale_counts } = params;
      const chatId = params.chat_id || context.chatId;

      if (!dates || !buy_volumes || dates.length !== buy_volumes.length) {
        return { success: false, error: "dates and buy_volumes must have equal length" };
      }

      const datasets = [
        {
          label: "Покупки (TON)",
          data: buy_volumes,
          backgroundColor: "rgba(34, 197, 94, 0.7)",
          borderColor: "#22c55e",
          borderWidth: 2,
          borderRadius: 3,
          order: 2,
        },
        {
          label: "Продажи (TON)",
          data: sell_volumes.map((v) => -Math.abs(v)),
          backgroundColor: "rgba(239, 68, 68, 0.7)",
          borderColor: "#ef4444",
          borderWidth: 2,
          borderRadius: 3,
          order: 2,
        },
      ];

      if (whale_counts && whale_counts.length === dates.length) {
        datasets.push({
          label: "Китов активно",
          data: whale_counts,
          type: "line",
          borderColor: "#a855f7",
          backgroundColor: "rgba(168, 85, 247, 0.1)",
          borderWidth: 2,
          pointRadius: 4,
          fill: false,
          yAxisID: "whales",
          order: 1,
        });
      }

      const title = params.title || "Активность китов";
      const hasWhaleAxis = whale_counts && whale_counts.length === dates.length;

      const chartConfig = {
        type: "bar",
        data: { labels: dates, datasets },
        options: {
          plugins: {
            title: { display: true, text: title, font: { size: 18, weight: "bold" }, color: "#e2e8f0" },
            legend: { display: true, position: "bottom", labels: { color: "#f1f5f9", boxWidth: 14, padding: 12, font: { size: 12 } } },
          },
          scales: {
            x: {
              ticks: { color: "#cbd5e1", maxRotation: 45, font: { size: 11 } },
              grid: { color: "rgba(148,163,184,0.15)" },
            },
            y: {
              title: { display: true, text: "Объём (TON)", color: "#cbd5e1", font: { size: 12 } },
              ticks: {
                color: "#cbd5e1",
                callback: (v) => {
                  const abs = Math.abs(v);
                  if (abs >= 1000) return (v < 0 ? "-" : "") + (abs / 1000).toFixed(1) + "K";
                  return Math.round(v);
                },
              },
              grid: { color: "rgba(148,163,184,0.15)" },
            },
            ...(hasWhaleAxis ? {
              whales: {
                position: "right",
                title: { display: true, text: "Китов", color: "#a855f7", font: { size: 11 } },
                ticks: { color: "#a855f7", font: { size: 10 }, stepSize: 1 },
                grid: { display: false },
                beginAtZero: true,
              },
            } : {}),
          },
          layout: { padding: { top: 5, right: 15, bottom: 5, left: 5 } },
        },
      };

      const chartUrl = await getChartShortUrl(chartConfig, 1000, 500, "#0f172a");

      if (params.return_url_only) {
        return { success: true, data: { chart_url: chartUrl, title } };
      }

      const client = context.bridge.getClient().getClient();
      let peer;
      try { peer = await client.getInputEntity(chatId); }
      catch { return { success: false, error: `Cannot resolve chat: ${chatId}` }; }

      const caption = params.caption || `🐋 ${title}`;
      const imgBuf = await downloadChartImage(chartUrl);
      await client.sendFile(peer, { file: imgBuf, caption, parseMode: "md", forceDocument: false });

      return { success: true, data: { title } };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

const chartListingDistribution = {
  name: "chart_listing_distribution",
  category: "data-bearing",
  description:
    "Generate a price distribution histogram for active listings within a single gift collection. " +
    "Shows how many NFTs are listed at each price range — useful for finding fair floor price vs outliers. " +
    "Data from MarketApp onsale listings. First call marketapp_gifts_onsale to get listings, then pass prices here. " +
    "RULE: When creating 2+ charts, ALWAYS use return_url_only=true and combine via chart_dashboard.",

  parameters: {
    type: "object",
    properties: {
      prices: {
        type: "array",
        items: { type: "number" },
        description: "Array of listing prices in TON from marketapp_gifts_onsale",
      },
      collection_name: {
        type: "string",
        description: "Collection name for chart title",
      },
      bin_size: {
        type: "number",
        description: "Price bin width in TON (default: auto-calculated based on range)",
      },
      caption: { type: "string", description: "Optional caption." },
      chat_id: { type: "string", description: "Target chat/channel." },
      return_url_only: { type: "boolean", description: "Return URL only for dashboard composition." },
    },
    required: ["prices", "collection_name"],
  },

  execute: async (params, context) => {
    try {
      const { prices, collection_name } = params;
      const chatId = params.chat_id || context.chatId;

      if (!prices || prices.length === 0) {
        return { success: false, error: "No prices provided" };
      }

      const sorted = [...prices].sort((a, b) => a - b);
      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      const range = max - min;

      let binSize = params.bin_size;
      if (!binSize) {
        if (range <= 10) binSize = 1;
        else if (range <= 50) binSize = 5;
        else if (range <= 200) binSize = 10;
        else if (range <= 1000) binSize = 50;
        else binSize = 100;
      }

      const bins = [];
      let start = Math.floor(min / binSize) * binSize;
      while (start <= max) {
        const end = start + binSize;
        const count = sorted.filter((p) => p >= start && p < end).length;
        bins.push({ label: `${Math.round(start)}–${Math.round(end)}`, count, start, end });
        start = end;
      }

      const labels = bins.map((b) => b.label);
      const values = bins.map((b) => b.count);

      const median = sorted[Math.floor(sorted.length / 2)];
      const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;

      const colors = bins.map((b) => {
        if (median >= b.start && median < b.end) return "#22c55e";
        return "#3b82f6";
      });

      const title = `Распределение цен листингов — ${collection_name}`;
      const chartConfig = {
        type: "bar",
        data: {
          labels,
          datasets: [{
            label: "Листингов",
            data: values,
            backgroundColor: colors,
            borderColor: colors.map((c) => c === "#22c55e" ? "#16a34a" : "#2563eb"),
            borderWidth: 1,
            borderRadius: 3,
          }],
        },
        options: {
          plugins: {
            title: { display: true, text: title, font: { size: 16, weight: "bold" }, color: "#e2e8f0" },
            legend: { display: false },
            datalabels: {
              display: true,
              anchor: "end",
              align: "top",
              color: "#e2e8f0",
              font: { size: 11, weight: "bold" },
              formatter: (v) => v > 0 ? v : "",
            },
          },
          scales: {
            x: {
              title: { display: true, text: "Цена (TON)", color: "#94a3b8", font: { size: 11 } },
              ticks: { color: "#94a3b8", maxRotation: 45, font: { size: 10 } },
              grid: { color: "rgba(148,163,184,0.1)" },
            },
            y: {
              title: { display: true, text: "Количество", color: "#94a3b8", font: { size: 11 } },
              ticks: { color: "#94a3b8", stepSize: 1 },
              grid: { color: "rgba(148,163,184,0.15)" },
              beginAtZero: true,
            },
          },
          layout: { padding: { top: 10, right: 15, bottom: 5, left: 5 } },
        },
      };

      const chartUrl = await getChartShortUrl(chartConfig, 900, 450, "#0f172a");

      const stats = {
        total_listings: prices.length,
        min_price: Math.round(min * 10) / 10,
        max_price: Math.round(max * 10) / 10,
        median_price: Math.round(median * 10) / 10,
        mean_price: Math.round(mean * 10) / 10,
        bins: bins.filter((b) => b.count > 0).map((b) => ({ range: b.label + " TON", count: b.count })),
      };

      if (params.return_url_only) {
        return { success: true, data: { chart_url: chartUrl, ...stats } };
      }

      const client = context.bridge.getClient().getClient();
      let peer;
      try { peer = await client.getInputEntity(chatId); }
      catch { return { success: false, error: `Cannot resolve chat: ${chatId}` }; }

      const caption = params.caption || `📊 ${title}\nМедиана: ${stats.median_price} TON | Листингов: ${stats.total_listings}`;
      const imgBuf = await downloadChartImage(chartUrl);
      await client.sendFile(peer, { file: imgBuf, caption: caption.slice(0, 1024), parseMode: "md", forceDocument: false });

      return { success: true, data: stats };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

const chartCandlestick = {
  name: "chart_candlestick",
  category: "data-bearing",
  description:
    "Generate a candlestick (OHLC) chart for gift collection price history. " +
    "First call marketapp_gift_history with limit=100 to get sales data, then group by day and compute open/high/low/close, then pass here. " +
    "Best for liquid collections: CookieHeart, InstantRamen, LolPop, JesterHat, HomemadeCake. " +
    "Low-liquidity collections may not have enough data for meaningful candles. " +
    "RULE: When creating 2+ charts, ALWAYS use return_url_only=true and combine via chart_dashboard.",

  parameters: {
    type: "object",
    properties: {
      candles: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date: { type: "string", description: "Date label, e.g. '14 фев'" },
            open: { type: "number" },
            high: { type: "number" },
            low: { type: "number" },
            close: { type: "number" },
          },
          required: ["date", "open", "high", "low", "close"],
        },
        description: "Array of OHLC candle objects, one per period (day/6h)",
      },
      volumes: {
        type: "array",
        items: { type: "number" },
        description: "Optional volume (number of trades) per candle period. Same length as candles.",
      },
      collection_name: {
        type: "string",
        description: "Collection name for chart title",
      },
      caption: { type: "string", description: "Optional caption." },
      chat_id: { type: "string", description: "Target chat/channel." },
      return_url_only: { type: "boolean", description: "Return URL only for dashboard composition." },
    },
    required: ["candles", "collection_name"],
  },

  execute: async (params, context) => {
    try {
      const { candles, collection_name, volumes } = params;
      const chatId = params.chat_id || context.chatId;

      if (!candles || candles.length === 0) {
        return { success: false, error: "No candle data provided" };
      }

      const ohlcData = candles.map((c) => ({
        x: c.date,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
      }));

      const datasets = [{
        label: `${collection_name} (TON)`,
        data: ohlcData,
        color: {
          up: "#22c55e",
          down: "#ef4444",
          unchanged: "#94a3b8",
        },
        borderColor: {
          up: "#22c55e",
          down: "#ef4444",
          unchanged: "#94a3b8",
        },
      }];

      const scales = {
        x: {
          type: "category",
          labels: candles.map((c) => c.date),
          ticks: { color: "#cbd5e1", font: { size: 11 } },
          grid: { color: "rgba(148,163,184,0.15)" },
        },
        y: {
          title: { display: true, text: "TON", color: "#cbd5e1", font: { size: 12 } },
          ticks: {
            color: "#cbd5e1",
            callback: (v) => v >= 1000 ? Math.round(v).toLocaleString() : v >= 100 ? Math.round(v) : v.toFixed(1),
          },
          grid: { color: "rgba(148,163,184,0.15)" },
        },
      };

      if (volumes && volumes.length === candles.length) {
        datasets.push({
          label: "Объём",
          data: volumes,
          type: "bar",
          backgroundColor: "rgba(99, 102, 241, 0.3)",
          borderColor: "rgba(99, 102, 241, 0.5)",
          borderWidth: 1,
          yAxisID: "volume",
          order: 10,
        });
        scales.volume = {
          position: "right",
          title: { display: true, text: "Сделок", color: "#6366f1", font: { size: 11 } },
          ticks: { color: "#6366f1", font: { size: 10 }, stepSize: 1 },
          grid: { display: false },
          beginAtZero: true,
        };
      }

      const title = `Свечной график — ${collection_name}`;
      const chartConfig = {
        type: "candlestick",
        data: { datasets },
        options: {
          plugins: {
            title: { display: true, text: title, font: { size: 18, weight: "bold" }, color: "#e2e8f0" },
            legend: { display: volumes && volumes.length > 0, position: "bottom", labels: { color: "#f1f5f9", font: { size: 12 } } },
          },
          scales,
          layout: { padding: { top: 5, right: 15, bottom: 5, left: 5 } },
        },
      };

      const chartUrl = await getChartShortUrlV3(chartConfig, 1000, 500, "#0f172a");

      const lastCandle = candles[candles.length - 1];
      const firstCandle = candles[0];
      const changePct = firstCandle.open > 0 ? ((lastCandle.close - firstCandle.open) / firstCandle.open * 100).toFixed(1) : "0";

      const stats = {
        collection: collection_name,
        candles_count: candles.length,
        period_open: firstCandle.open,
        period_close: lastCandle.close,
        period_high: Math.max(...candles.map((c) => c.high)),
        period_low: Math.min(...candles.map((c) => c.low)),
        change_pct: parseFloat(changePct),
      };

      if (params.return_url_only) {
        return { success: true, data: { chart_url: chartUrl, ...stats } };
      }

      const client = context.bridge.getClient().getClient();
      let peer;
      try { peer = await client.getInputEntity(chatId); }
      catch { return { success: false, error: `Cannot resolve chat: ${chatId}` }; }

      const caption = params.caption || `🕯 ${title}\nOpen: ${stats.period_open} → Close: ${stats.period_close} TON (${changePct >= 0 ? "+" : ""}${changePct}%)`;
      const imgBuf = await downloadChartImage(chartUrl);
      await client.sendFile(peer, { file: imgBuf, caption: caption.slice(0, 1024), parseMode: "md", forceDocument: false });

      return { success: true, data: stats };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 500) };
    }
  },
};

export const tools = [
  marketChart, giftFloorChart, giftTopMovers, pieChart, barChart, dashboardTool, chartGenerate,
  giftHeatmap, giftDominance, giftDistribution, giftVolatility, giftTurnover,
  chartWhaleActivity, chartListingDistribution, chartCandlestick,
];
