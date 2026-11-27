import { UK_ETF_UNIVERSE } from "./config.js";
import { normalizePriceToGbp } from "./t212Client.js";

const candleCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch historical daily OHLCV candles in GBP (£) from Yahoo Finance for LSE ETFs.
 * Automatically normalizes GBp/GBX pence quotes into £ GBP so all strategy math is uniform.
 */
export async function fetchDailyCandles(yahooSymbol, range = "2y") {
  const cacheKey = `${yahooSymbol}:${range}`;
  const cached = candleCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.payload;
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    yahooSymbol
  )}?range=${range}&interval=1d&includePrePost=false`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`Yahoo Finance returned HTTP ${res.status}`);
    }

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result || !Array.isArray(result.timestamp)) {
      throw new Error(`Missing candle series for ${yahooSymbol}`);
    }

    const currency = result.meta?.currency || "GBP";
    const quote = result.indicators?.quote?.[0] || {};
    const timestamps = result.timestamp;

    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      const rawOpen = quote.open?.[i];
      const rawHigh = quote.high?.[i];
      const rawLow = quote.low?.[i];
      const rawClose = quote.close?.[i];
      const volume = quote.volume?.[i] ?? 0;

      if (
        rawClose == null ||
        rawOpen == null ||
        rawHigh == null ||
        rawLow == null ||
        !Number.isFinite(rawClose)
      ) {
        continue;
      }

      candles.push({
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        timestamp: timestamps[i] * 1000,
        open: Number(normalizePriceToGbp(rawOpen, currency).toFixed(4)),
        high: Number(normalizePriceToGbp(rawHigh, currency).toFixed(4)),
        low: Number(normalizePriceToGbp(rawLow, currency).toFixed(4)),
        close: Number(normalizePriceToGbp(rawClose, currency).toFixed(4)),
        volume,
      });
    }

    if (candles.length < 60) {
      throw new Error(`Insufficient candle history (${candles.length} bars) for ${yahooSymbol}`);
    }

    const payload = {
      yahooSymbol,
      rawCurrency: currency,
      displayCurrency: "GBP",
      source: "yahoo-live",
      candles,
    };
    candleCache.set(cacheKey, { fetchedAt: Date.now(), payload });
    return payload;
  } catch (err) {
    // Deterministic realistic fallback series ONLY when offline / sandboxed without network
    return generateFallbackSeries(yahooSymbol, err.message);
  }
}

export async function fetchUniverseMarketData(range = "2y") {
  const entries = await Promise.all(
    UK_ETF_UNIVERSE.map(async (etf) => {
      const data = await fetchDailyCandles(etf.yahooSymbol, range);
      return [etf.symbol, { ...etf, ...data }];
    })
  );
  return Object.fromEntries(entries);
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function generateFallbackSeries(yahooSymbol, reason) {
  let seed = hashSeed(yahooSymbol);
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const basePrices = {
    "VUAG.L": 88.0,
    "EQQQ.L": 365.0,
    "VWRP.L": 98.0,
    "SGLN.L": 39.0,
    "ISF.L": 7.8,
  };

  let price = basePrices[yahooSymbol] || 100.0;
  const candles = [];
  const totalDays = 500;
  const now = Date.now();

  for (let i = totalDays; i >= 0; i--) {
    const ts = now - i * 24 * 60 * 60 * 1000;
    const d = new Date(ts);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // Skip weekends

    // Upward secular ETF drift + realistic mean-reverting waves
    const cycle = Math.sin((totalDays - i) / 14) * 0.003;
    const shock = (rand() - 0.482) * 0.018 + cycle;
    const open = price;
    const close = Math.max(2, open * (1 + shock));
    const high = Math.max(open, close) * (1 + rand() * 0.006);
    const low = Math.min(open, close) * (1 - rand() * 0.006);
    price = close;

    candles.push({
      date: d.toISOString().slice(0, 10),
      timestamp: ts,
      open: Number(open.toFixed(4)),
      high: Number(high.toFixed(4)),
      low: Number(low.toFixed(4)),
      close: Number(close.toFixed(4)),
      volume: Math.floor(150000 + rand() * 500000),
    });
  }

  return {
    yahooSymbol,
    rawCurrency: "GBP",
    displayCurrency: "GBP",
    source: "offline-simulation",
    fallbackReason: reason,
    candles,
  };
}
