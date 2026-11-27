import fs from "node:fs";
import {
  getConfig,
  ensureDirectories,
  STATE_PATH,
  UK_ETF_UNIVERSE,
} from "./config.js";
import { Trading212Client, normalizePriceToGbp } from "./t212Client.js";
import { fetchUniverseMarketData } from "./marketData.js";
import { computeIndicators, evaluateBarSignal, runPortfolioBacktest } from "./strategy.js";

/**
 * Check London Stock Exchange (LSE) regular trading session in Europe/London timezone.
 * LSE trades Mon-Fri 08:00 - 16:30 UK time. We avoid the first 5 mins & last 5 mins auction spread.
 */
export function getUkMarketStatus(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((p) => [p.type, p.value])
  );
  const weekday = parts.weekday; // Mon, Tue, Wed, Thu, Fri, Sat, Sun
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;

  const isWeekday = !["Sat", "Sun"].includes(weekday);
  const minutesSinceMidnight = hour * 60 + minute;
  const openMinutes = 8 * 60 + 5; // 08:05 UK
  const closeMinutes = 16 * 60 + 25; // 16:25 UK
  const isOpen =
    isWeekday && minutesSinceMidnight >= openMinutes && minutesSinceMidnight <= closeMinutes;

  return {
    isOpen,
    isWeekday,
    ukDate: dateStr,
    ukTime: timeStr,
    weekday,
    statusLabel: isOpen
      ? `LSE Open (${timeStr} UK)`
      : `LSE Closed (${weekday} ${timeStr} UK — trades Mon–Fri 08:05–16:25)`,
  };
}

export class BotEngine {
  constructor() {
    ensureDirectories();
    this.client = new Trading212Client();
    this.state = this.loadState();
    this.schedulerTimer = null;
    this.isRunningCycle = false;
  }

  loadState() {
    if (fs.existsSync(STATE_PATH)) {
      try {
        return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
      } catch {
        // Reinitialize on corrupt state
      }
    }
    return {
      lastAutoRunDate: null,
      lastCycleAt: null,
      dailyRealizedPnlGbp: 0,
      dailyPnlDate: null,
      circuitBreakerTripped: false,
      activityLog: [
        {
          timestamp: new Date().toISOString(),
          level: "INFO",
          message:
            "Trading 212 UK ETF Bot initialized in safe Practice/Demo mode. Add your API Key in Settings to connect.",
        },
      ],
      executionHistory: [],
    };
  }

  saveState() {
    ensureDirectories();
    // Keep logs bounded
    this.state.activityLog = (this.state.activityLog || []).slice(0, 120);
    this.state.executionHistory = (this.state.executionHistory || []).slice(0, 100);
    fs.writeFileSync(STATE_PATH, JSON.stringify(this.state, null, 2), "utf-8");
  }

  log(level, message, details = null) {
    this.state.activityLog.unshift({
      timestamp: new Date().toISOString(),
      level,
      message,
      details,
    });
    this.saveState();
  }

  startScheduler() {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    // Check every 45 seconds whether it's time for today's scheduled UK trade check
    this.schedulerTimer = setInterval(() => {
      this.checkScheduledRun().catch((err) => {
        this.log("ERROR", `Scheduled check error: ${err.message}`);
      });
    }, 45 * 1000);
    this.schedulerTimer.unref?.();
  }

  async checkScheduledRun() {
    const cfg = getConfig();
    if (!cfg.autoTradeEnabled || !cfg.apiKey) return;

    const uk = getUkMarketStatus();
    if (!uk.isOpen) return;
    if (this.state.lastAutoRunDate === uk.ukDate) return;

    const [targetH, targetM] = cfg.dailyRunTimeUk.split(":").map(Number);
    const [nowH, nowM] = uk.ukTime.split(":").map(Number);
    const nowMins = nowH * 60 + nowM;
    const targetMins = (targetH || 14) * 60 + (targetM || 45);

    // Trigger within a 20-minute window after DAILY_RUN_TIME_UK
    if (nowMins >= targetMins && nowMins <= targetMins + 20) {
      this.state.lastAutoRunDate = uk.ukDate;
      this.saveState();
      this.log("INFO", `Executing scheduled daily UK trade cycle (${uk.ukTime} UK)...`);
      await this.runTradeCycle({ dryRun: false, allowClosedMarketDemo: false });
    }
  }

  async getAccountSnapshot() {
    const cfg = getConfig();
    this.client.refreshConfig();

    if (!cfg.apiKey) {
      return {
        connected: false,
        env: cfg.env,
        message: "API Key not set yet",
        cash: null,
        portfolio: [],
      };
    }

    try {
      const [cash, portfolio, pendingOrders, tickerMap] = await Promise.all([
        this.client.getAccountCash(),
        this.client.getPortfolio(),
        this.client.getPendingOrders().catch(() => []),
        this.client.resolveUkEtfTickers(),
      ]);

      const reverseTickerMap = {};
      for (const item of Object.values(tickerMap)) {
        reverseTickerMap[item.ticker] = item;
      }

      const normalizedPortfolio = (portfolio || []).map((pos) => {
        const meta = reverseTickerMap[pos.ticker];
        const currency = meta?.currencyCode || (pos.ticker.includes("l_EQ") ? "GBP" : "GBP");
        const avgPriceGbp = normalizePriceToGbp(pos.averagePrice, currency);
        const curPriceGbp = normalizePriceToGbp(pos.currentPrice, currency);
        const valueGbp = Number(pos.quantity) * curPriceGbp;
        return {
          ticker: pos.ticker,
          symbol: meta?.symbol || pos.ticker.replace(/l?_EQ$/, ""),
          name: meta?.name || pos.ticker,
          quantity: Number(pos.quantity),
          avgEntryPriceGbp: Number(avgPriceGbp.toFixed(3)),
          currentPriceGbp: Number(curPriceGbp.toFixed(3)),
          marketValueGbp: Number(valueGbp.toFixed(2)),
          pplGbp: Number((Number(pos.ppl) || 0).toFixed(2)),
          pnlPct:
            avgPriceGbp > 0
              ? Number((((curPriceGbp - avgPriceGbp) / avgPriceGbp) * 100).toFixed(2))
              : 0,
        };
      });

      return {
        connected: true,
        env: cfg.env,
        cash: {
          freeGbp: Number((Number(cash?.free) || 0).toFixed(2)),
          totalGbp: Number((Number(cash?.total) || 0).toFixed(2)),
          investedGbp: Number((Number(cash?.invested) || 0).toFixed(2)),
          pplGbp: Number((Number(cash?.ppl) || 0).toFixed(2)),
        },
        portfolio: normalizedPortfolio,
        pendingOrders: Array.isArray(pendingOrders) ? pendingOrders : [],
        tickerMap,
      };
    } catch (err) {
      return {
        connected: false,
        env: cfg.env,
        error: err.message,
        cash: null,
        portfolio: [],
      };
    }
  }

  async generateDailySignals(existingPortfolio = []) {
    const cfg = getConfig();
    const universeData = await fetchUniverseMarketData("2y");
    const tickerMap = await this.client.resolveUkEtfTickers();

    const posBySymbol = new Map();
    for (const p of existingPortfolio) {
      posBySymbol.set(p.symbol, p);
    }

    const signals = [];
    for (const etf of UK_ETF_UNIVERSE) {
      const asset = universeData[etf.symbol];
      const enriched = computeIndicators(asset?.candles || []);
      const lastIdx = enriched.length - 1;
      const latest = enriched[lastIdx];
      const heldPos = posBySymbol.get(etf.symbol) || null;

      const evalResult = evaluateBarSignal(enriched, lastIdx, heldPos, {
        stopLossPct: cfg.stopLossPct,
        takeProfitPct: cfg.takeProfitPct,
      });

      const resolved = tickerMap[etf.symbol];
      signals.push({
        symbol: etf.symbol,
        name: etf.name,
        category: etf.category,
        t212Ticker: resolved?.ticker || etf.fallbackT212Ticker,
        tickerVerified: Boolean(resolved?.verified),
        minTradeQuantity: resolved?.minTradeQuantity || 0.01,
        dataSource: asset.source,
        date: latest?.date || null,
        priceGbp: latest ? Number(latest.close.toFixed(2)) : 0,
        dayChangePct: latest ? Number(latest.dayChangePct.toFixed(2)) : 0,
        ema20Gbp: latest?.ema20 ? Number(latest.ema20.toFixed(2)) : null,
        sma50Gbp: latest?.sma50 ? Number(latest.sma50.toFixed(2)) : null,
        sma200Gbp: latest?.sma200 ? Number(latest.sma200.toFixed(2)) : null,
        rsi14: latest?.rsi14 ? Number(latest.rsi14.toFixed(1)) : null,
        roc20Pct: latest?.roc20 != null ? Number(latest.roc20.toFixed(2)) : null,
        action: evalResult.action,
        score: evalResult.score,
        reason: evalResult.reason,
        heldQuantity: heldPos ? heldPos.quantity : 0,
        heldPnlGbp: heldPos ? heldPos.pplGbp : 0,
      });
    }

    signals.sort((a, b) => b.score - a.score);
    return { signals, universeData };
  }

  /**
   * Execute one complete daily analysis + optional order placement cycle.
   * `dryRun: true` previews the exact orders without sending them to Trading 212.
   */
  async runTradeCycle({ dryRun = true, allowClosedMarketDemo = false } = {}) {
    if (this.isRunningCycle) {
      throw new Error("A trade cycle is already in progress.");
    }
    this.isRunningCycle = true;

    try {
      const cfg = getConfig();
      const uk = getUkMarketStatus();

      // Reset daily loss tracker on a new UK date
      if (this.state.dailyPnlDate !== uk.ukDate) {
        this.state.dailyPnlDate = uk.ukDate;
        this.state.dailyRealizedPnlGbp = 0;
        this.state.circuitBreakerTripped = false;
      }

      const account = await this.getAccountSnapshot();
      const { signals } = await this.generateDailySignals(account.portfolio || []);

      const plannedOrders = [];
      const executedOrders = [];

      // Check Daily Loss Circuit Breaker
      const currentPortfolioPpl = account.cash?.pplGbp ?? 0;
      if (
        this.state.dailyRealizedPnlGbp <= -cfg.maxDailyLossGbp ||
        this.state.circuitBreakerTripped
      ) {
        this.state.circuitBreakerTripped = true;
        const msg = `Daily Loss Circuit Breaker active (limit -£${cfg.maxDailyLossGbp}). New BUY orders blocked today.`;
        this.log("WARN", msg);
        return {
          dryRun,
          ukMarket: uk,
          circuitBreakerTripped: true,
          message: msg,
          plannedOrders: [],
          executedOrders: [],
          signals,
        };
      }

      let freeCashGbp = account.connected ? account.cash.freeGbp : cfg.maxPositionGbp * 2;
      let openCount = (account.portfolio || []).length;
      const pendingTickers = new Set(
        (account.pendingOrders || []).map((o) => o.ticker).filter(Boolean)
      );

      // 1. Process SELL signals first to protect capital and free up cash
      for (const sig of signals.filter((s) => s.action === "SELL" && s.heldQuantity > 0)) {
        if (pendingTickers.has(sig.t212Ticker)) continue;
        const sellOrder = {
          side: "SELL",
          symbol: sig.symbol,
          ticker: sig.t212Ticker,
          quantity: -Number(sig.heldQuantity.toFixed(4)),
          estimatedValueGbp: Number((sig.heldQuantity * sig.priceGbp).toFixed(2)),
          reason: sig.reason,
        };
        plannedOrders.push(sellOrder);
      }

      // 2. Process BUY signals ranked by highest composite score
      for (const sig of signals.filter((s) => s.action === "BUY" && s.heldQuantity === 0)) {
        if (openCount >= cfg.maxOpenPositions) break;
        if (pendingTickers.has(sig.t212Ticker)) continue;
        const allocationGbp = Math.min(cfg.maxPositionGbp, freeCashGbp * 0.96);
        if (allocationGbp < 10 || sig.priceGbp <= 0) continue;

        const rawQty = allocationGbp / sig.priceGbp;
        const qty = Number(rawQty.toFixed(4));
        if (qty < sig.minTradeQuantity) continue;

        plannedOrders.push({
          side: "BUY",
          symbol: sig.symbol,
          ticker: sig.t212Ticker,
          quantity: qty,
          estimatedValueGbp: Number((qty * sig.priceGbp).toFixed(2)),
          reason: sig.reason,
        });
        freeCashGbp -= qty * sig.priceGbp;
        openCount += 1;
      }

      this.state.lastCycleAt = new Date().toISOString();

      if (dryRun) {
        this.log(
          "INFO",
          `Dry-run scan finished: ${plannedOrders.length} order(s) proposed (${signals.filter((s) => s.action === "BUY").length} BUY, ${signals.filter((s) => s.action === "SELL").length} SELL signals).`
        );
        this.saveState();
        return {
          dryRun: true,
          ukMarket: uk,
          accountConnected: account.connected,
          currentPortfolioPpl,
          plannedOrders,
          executedOrders: [],
          signals,
        };
      }

      // Real API execution checks
      if (!account.connected) {
        throw new Error(
          account.error ||
            "Cannot execute orders: Trading 212 API is not connected. Check your API Key & Secret in Settings."
        );
      }

      const marketAllowed = uk.isOpen || (cfg.env === "demo" && allowClosedMarketDemo);
      if (!marketAllowed) {
        throw new Error(
          `${uk.statusLabel}. For your protection, live LSE market orders are blocked while London Stock Exchange is closed so you don't get filled at wide opening auction spreads.`
        );
      }

      for (const order of plannedOrders) {
        try {
          const apiResp = await this.client.placeMarketOrder({
            ticker: order.ticker,
            quantity: order.quantity,
          });
          const record = {
            ...order,
            env: cfg.env,
            status: "SUBMITTED",
            orderId: apiResp?.id || null,
            timestamp: new Date().toISOString(),
          };
          executedOrders.push(record);
          this.state.executionHistory.unshift(record);
          this.log(
            "SUCCESS",
            `[${cfg.env.toUpperCase()}] Submitted ${order.side} ${Math.abs(order.quantity)} ${order.symbol} (~£${order.estimatedValueGbp}) — ${order.reason}`
          );
        } catch (orderErr) {
          const failRecord = {
            ...order,
            env: cfg.env,
            status: "FAILED",
            error: orderErr.message,
            timestamp: new Date().toISOString(),
          };
          executedOrders.push(failRecord);
          this.state.executionHistory.unshift(failRecord);
          this.log(
            "ERROR",
            `Order failed for ${order.symbol} (${order.ticker}): ${orderErr.message}`
          );
        }
      }

      if (plannedOrders.length === 0) {
        this.log(
          "INFO",
          `[${cfg.env.toUpperCase()}] Daily check complete — no action needed today. Existing holdings and cash remain safe.`
        );
      }

      this.saveState();
      return {
        dryRun: false,
        ukMarket: uk,
        plannedOrders,
        executedOrders,
        signals,
      };
    } finally {
      this.isRunningCycle = false;
    }
  }

  async runBacktestReport(params = {}) {
    const cfg = getConfig();
    const universeData = await fetchUniverseMarketData("2y");
    return runPortfolioBacktest(universeData, {
      initialCapitalGbp: params.initialCapitalGbp ?? 2000,
      maxOpenPositions: params.maxOpenPositions ?? cfg.maxOpenPositions,
      maxPositionGbp: params.maxPositionGbp ?? cfg.maxPositionGbp,
      stopLossPct: params.stopLossPct ?? cfg.stopLossPct,
      takeProfitPct: params.takeProfitPct ?? cfg.takeProfitPct,
      lookbackDays: params.lookbackDays ?? 365,
    });
  }
}
