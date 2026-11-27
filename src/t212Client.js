import fs from "node:fs";
import { Buffer } from "node:buffer";
import {
  getConfig,
   ensureDirectories,
  INSTRUMENTS_CACHE_PATH,
  UK_ETF_UNIVERSE,
} from "./config.js";

let lastRequestTime = 0;
let requestMutex = Promise.resolve();
const MIN_REQUEST_GAP_MS = 1150; // Respect Trading 212 API rate limits strictly in sequence

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizePriceToGbp(rawPrice, currencyCode) {
  const num = Number(rawPrice) || 0;
  const code = String(currencyCode || "GBP").trim();
  // LSE quotes many ETFs (like EQQQ, ISF, SGLN) in GBX / GBp (pence = 1/100 GBP)
  if (code === "GBX" || code === "GBp") {
    return num / 100;
  }
  return num;
}

export class Trading212Client {
  constructor(customConfig = null) {
    this.config = customConfig || getConfig();
  }

  refreshConfig() {
    this.config = getConfig();
  }

  hasCredentials() {
    return Boolean(this.config.apiKey);
  }

  buildAuthHeader() {
    const { apiKey, apiSecret } = this.config;
    if (!apiKey) {
      throw new Error(
        "Trading 212 API Key is not configured yet. Add your key in Dashboard Settings."
      );
    }
    if (apiSecret) {
      const encoded = Buffer.from(`${apiKey}:${apiSecret}`, "utf-8").toString("base64");
      return `Basic ${encoded}`;
    }
    // Fallback for legacy single-token keys if secret was omitted
    return apiKey;
  }

  async request(endpoint, { method = "GET", body = undefined } = {}) {
    const run = async () => {
      this.refreshConfig();
      const now = Date.now();
      const elapsed = now - lastRequestTime;
      if (elapsed < MIN_REQUEST_GAP_MS) {
        await sleep(MIN_REQUEST_GAP_MS - elapsed);
      }
      lastRequestTime = Date.now();

      const url = `${this.config.baseUrl}${endpoint}`;
      const headers = {
        Authorization: this.buildAuthHeader(),
        Accept: "application/json",
      };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429) {
        const resetHeader = res.headers.get("x-ratelimit-reset");
        const waitSec = resetHeader
          ? Math.max(2, Math.min(30, Number(resetHeader) - Math.floor(Date.now() / 1000) + 1))
          : 5;
        await sleep(waitSec * 1000);
        lastRequestTime = Date.now();
        const retry = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        return this.parseResponse(retry, endpoint);
      }

      return this.parseResponse(res, endpoint);
    };

    const next = requestMutex.then(run, run);
    requestMutex = next.catch(() => {});
    return next;
  }

  async parseResponse(res, endpoint) {
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      if (res.status === 401) {
        const currentEnv = this.config.env.toUpperCase();
        const otherEnv = currentEnv === "DEMO" ? "LIVE" : "DEMO";
        throw new Error(
          `401 Unauthorized in ${currentEnv} mode. (Tip: Trading 212 ${otherEnv} API keys only work when Environment is set to ${otherEnv}, and Practice keys only work in DEMO mode.)`
        );
      }
      const detail =
        (data && (data.errorMessage || data.message || data.code || JSON.stringify(data))) ||
        `HTTP ${res.status}`;
      throw new Error(`Trading 212 API error (${res.status}) on ${endpoint}: ${detail}`);
    }
    return data;
  }

  async getAccountCash() {
    return this.request("/equity/account/cash");
  }

  async getAccountInfo() {
    return this.request("/equity/account/info");
  }

  async getPortfolio() {
    return this.request("/equity/portfolio");
  }

  async getPendingOrders() {
    return this.request("/equity/orders");
  }

  async getInstruments({ forceRefresh = false } = {}) {
    ensureDirectories();
    const envTag = this.config.env;

    if (!forceRefresh && fs.existsSync(INSTRUMENTS_CACHE_PATH)) {
      try {
        const cached = JSON.parse(fs.readFileSync(INSTRUMENTS_CACHE_PATH, "utf-8"));
        const ageMs = Date.now() - (cached.timestamp || 0);
        if (
          cached.env === envTag &&
          Array.isArray(cached.instruments) &&
          ageMs < 24 * 60 * 60 * 1000
        ) {
          return cached.instruments;
        }
      } catch {
        // Ignore corrupt cache and refetch
      }
    }

    const instruments = await this.request("/equity/metadata/instruments");
    if (Array.isArray(instruments)) {
      fs.writeFileSync(
        INSTRUMENTS_CACHE_PATH,
        JSON.stringify({ env: envTag, timestamp: Date.now(), instruments }),
        "utf-8"
      );
    }
    return instruments || [];
  }

  async resolveUkEtfTickers() {
    let instruments = [];
    if (this.hasCredentials()) {
      try {
        instruments = await this.getInstruments();
      } catch {
        instruments = [];
      }
    }

    const map = {};
    for (const etf of UK_ETF_UNIVERSE) {
      const candidates = instruments.filter(
        (inst) =>
          String(inst.shortName || "").toUpperCase() === etf.symbol.toUpperCase()
      );
      // Prefer London Stock Exchange listings denominated in GBP or GBX
      const ukMatch =
        candidates.find(
          (c) =>
            (c.currencyCode === "GBP" || c.currencyCode === "GBX") &&
            String(c.ticker || "").includes("l_EQ")
        ) ||
        candidates.find((c) => c.currencyCode === "GBP" || c.currencyCode === "GBX") ||
        candidates[0];

      map[etf.symbol] = ukMatch
        ? {
            symbol: etf.symbol,
            ticker: ukMatch.ticker,
            currencyCode: ukMatch.currencyCode || "GBP",
            minTradeQuantity: Number(ukMatch.minTradeQuantity) || 0.01,
            name: ukMatch.name || etf.name,
            verified: true,
          }
        : {
            symbol: etf.symbol,
            ticker: etf.fallbackT212Ticker,
            currencyCode: "GBP",
            minTradeQuantity: 0.01,
            name: etf.name,
            verified: false,
          };
    }
    return map;
  }

  /**
   * Place a Trading 212 Market Order.
   * Positive quantity = BUY, negative quantity = SELL.
   */
  async placeMarketOrder({ ticker, quantity }) {
    const numQty = Number(quantity);
    if (!ticker || !Number.isFinite(numQty) || Math.abs(numQty) < 0.0001) {
      throw new Error(`Invalid market order parameters: ticker=${ticker}, quantity=${quantity}`);
    }

    return this.request("/equity/orders/market", {
      method: "POST",
      body: {
        ticker,
        quantity: numQty,
      },
    });
  }
}
