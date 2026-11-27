/**
 * Technical indicators, daily signal evaluation, and realistic UK GBP ETF portfolio backtester.
 */

export function calcSMA(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function calcEMA(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += values[i];
  ema /= period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

export function calcRSI(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const ema20 = calcEMA(closes, 20);
  const sma50 = calcSMA(closes, 50);
  const sma200 = calcSMA(closes, 200);
  const rsi14 = calcRSI(closes, 14);

  return candles.map((c, idx) => {
    const roc20 =
      idx >= 20 && closes[idx - 20] > 0
        ? ((c.close - closes[idx - 20]) / closes[idx - 20]) * 100
        : null;
    const dayChangePct =
      idx >= 1 && closes[idx - 1] > 0
        ? ((c.close - closes[idx - 1]) / closes[idx - 1]) * 100
        : 0;
    return {
      ...c,
      ema20: ema20[idx],
      sma50: sma50[idx],
      sma200: sma200[idx],
      rsi14: rsi14[idx],
      roc20,
      dayChangePct,
    };
  });
}

/**
 * Evaluate bar at index `idx` for BUY / SELL / HOLD signal & composite strength score (0-100).
 */
export function evaluateBarSignal(enrichedCandles, idx, position = null, riskParams = {}) {
  const stopLossPct = Number(riskParams.stopLossPct) || 3.5;
  const takeProfitPct = Number(riskParams.takeProfitPct) || 7.5;

  const bar = enrichedCandles[idx];
  const prev = idx > 0 ? enrichedCandles[idx - 1] : null;

  if (!bar || bar.sma50 == null || bar.ema20 == null || bar.rsi14 == null) {
    return {
      action: "HOLD",
      score: 0,
      reason: "Waiting for 50-day indicator history",
    };
  }

  const aboveSma50 = bar.close > bar.sma50;
  const aboveEma20 = bar.close > bar.ema20;
  const sma50Rising = prev?.sma50 != null ? bar.sma50 >= prev.sma50 * 0.9995 : aboveSma50;
  const rsi = bar.rsi14;
  const roc20 = bar.roc20 ?? 0;

  // 1. Check EXIT rules first if holding a position
  if (position && position.quantity > 0 && position.avgEntryPriceGbp > 0) {
    const pnlPct =
      ((bar.close - position.avgEntryPriceGbp) / position.avgEntryPriceGbp) * 100;

    if (pnlPct <= -stopLossPct) {
      return {
        action: "SELL",
        score: 95,
        pnlPct,
        reason: `Stop-Loss triggered (${pnlPct.toFixed(2)}% <= -${stopLossPct}%)`,
      };
    }

    if (pnlPct >= takeProfitPct) {
      return {
        action: "SELL",
        score: 90,
        pnlPct,
        reason: `Take-Profit target reached (+${pnlPct.toFixed(2)}% >= +${takeProfitPct}%)`,
      };
    }

    if (rsi >= 76 && pnlPct > 1.0) {
      return {
        action: "SELL",
        score: 82,
        pnlPct,
        reason: `Overbought RSI climax (RSI ${rsi.toFixed(1)} >= 76) - locking in +${pnlPct.toFixed(2)}%`,
      };
    }

    if (bar.close < bar.sma50 * 0.988) {
      return {
        action: "SELL",
        score: 80,
        pnlPct,
        reason: `Trend breakdown (>1.2% below 50-day SMA £${bar.sma50.toFixed(2)})`,
      };
    }

    return {
      action: "HOLD",
      score: 55,
      pnlPct,
      reason: `Holding uptrend position (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%, RSI ${rsi.toFixed(1)})`,
    };
  }

  // 2. Check ENTRY rules when flat
  // Setup A: Uptrend Pullback (price above rising 50-SMA, healthy RSI dip 33-55)
  const isPullbackSetup = aboveSma50 && sma50Rising && rsi >= 33 && rsi <= 55;

  // Setup B: Steady Momentum Trend (above 20-EMA & 50-SMA, positive 20d momentum, not overbought)
  const isMomentumSetup =
    aboveSma50 && aboveEma20 && roc20 >= 1.2 && rsi > 50 && rsi <= 66;

  if (isPullbackSetup || isMomentumSetup) {
    let score = 55;
    if (aboveEma20) score += 10;
    if (bar.sma200 != null && bar.close > bar.sma200) score += 12;
    if (roc20 > 0) score += Math.min(15, roc20 * 2);
    if (rsi >= 40 && rsi <= 55) score += 8; // Sweet-spot pullback bonus
    score = Math.min(99, Math.round(score));

    const reason = isPullbackSetup
      ? `Uptrend pullback buy: Price £${bar.close.toFixed(2)} > SMA50 (£${bar.sma50.toFixed(2)}) with value RSI ${rsi.toFixed(1)}`
      : `Momentum trend buy: Above EMA20 & SMA50, +${roc20.toFixed(1)}% 20d strength, RSI ${rsi.toFixed(1)}`;

    return {
      action: "BUY",
      score,
      reason,
    };
  }

  // Explain clearly why we stay on the sidelines
  let holdReason = `Neutral (RSI ${rsi.toFixed(1)})`;
  if (!aboveSma50) {
    holdReason = `Sidelines: Below 50-day SMA (£${bar.close.toFixed(2)} < £${bar.sma50.toFixed(2)})`;
  } else if (rsi > 66) {
    holdReason = `Sidelines: Waiting for pullback (RSI ${rsi.toFixed(1)} too stretched to chase)`;
  }

  return {
    action: "HOLD",
    score: aboveSma50 ? 40 : 15,
    reason: holdReason,
  };
}

/**
 * Multi-ETF realistic portfolio backtester in GBP (£).
 * Includes LSE ETF bid/ask spread slippage (~0.06% per side; 0% UK Stamp Duty & 0% FX fee).
 */
export function runPortfolioBacktest(universeData, options = {}) {
  const initialCapitalGbp = Math.max(100, Number(options.initialCapitalGbp) || 2000);
  const maxOpenPositions = Math.max(1, Number(options.maxOpenPositions) || 3);
  const maxPositionGbp =
    Number(options.maxPositionGbp) || Math.round(initialCapitalGbp / maxOpenPositions);
  const stopLossPct = Number(options.stopLossPct) || 3.5;
  const takeProfitPct = Number(options.takeProfitPct) || 7.5;
  const lookbackDays = Math.max(60, Number(options.lookbackDays) || 365);
  const spreadSlippageRate = 0.0006; // 0.06% realistic LSE ETF half-spread

  const enrichedMap = {};
  const allDatesSet = new Set();

  for (const [symbol, asset] of Object.entries(universeData)) {
    const enriched = computeIndicators(asset.candles || []);
    enrichedMap[symbol] = {
      symbol,
      name: asset.name,
      byDate: new Map(enriched.map((b, idx) => [b.date, { bar: b, idx, series: enriched }])),
    };
    for (const b of enriched) {
      if (b.sma50 != null) allDatesSet.add(b.date);
    }
  }

  const sortedDates = Array.from(allDatesSet).sort();
  const simDates = sortedDates.slice(-lookbackDays);

  if (simDates.length === 0) {
    return {
      initialCapitalGbp,
      finalEquityGbp: initialCapitalGbp,
      netProfitGbp: 0,
      totalReturnPct: 0,
      benchmarkReturnPct: 0,
      maxDrawdownPct: 0,
      winRatePct: 0,
      totalTrades: 0,
      equityCurve: [],
      trades: [],
    };
  }

  let cashGbp = initialCapitalGbp;
  const positions = new Map(); // symbol -> { quantity, avgEntryPriceGbp, entryDate }
  const closedTrades = [];
  const equityCurve = [];

  // Benchmark: Buy & Hold VUAG (or first available ETF)
  const benchAsset = enrichedMap.VUAG || Object.values(enrichedMap)[0];
  let benchStartPrice = null;

  let peakEquity = initialCapitalGbp;
  let maxDrawdownPct = 0;

  for (const date of simDates) {
    // 1. Evaluate exits on existing positions first
    for (const [symbol, pos] of Array.from(positions.entries())) {
      const entry = enrichedMap[symbol]?.byDate.get(date);
      if (!entry) continue;
      const sig = evaluateBarSignal(entry.series, entry.idx, pos, {
        stopLossPct,
        takeProfitPct,
      });

      if (sig.action === "SELL") {
        const fillPrice = entry.bar.close * (1 - spreadSlippageRate);
        const proceeds = pos.quantity * fillPrice;
        const costBasis = pos.quantity * pos.avgEntryPriceGbp;
        const profitGbp = proceeds - costBasis;
        const profitPct = (profitGbp / costBasis) * 100;

        cashGbp += proceeds;
        positions.delete(symbol);
        closedTrades.push({
          symbol,
          side: "SELL",
          entryDate: pos.entryDate,
          exitDate: date,
          entryPriceGbp: Number(pos.avgEntryPriceGbp.toFixed(3)),
          exitPriceGbp: Number(fillPrice.toFixed(3)),
          quantity: Number(pos.quantity.toFixed(4)),
          profitGbp: Number(profitGbp.toFixed(2)),
          profitPct: Number(profitPct.toFixed(2)),
          reason: sig.reason,
        });
      }
    }

    // 2. Evaluate new BUY candidates ranked by highest signal score
    if (positions.size < maxOpenPositions && cashGbp >= 15) {
      const candidates = [];
      for (const [symbol, assetObj] of Object.entries(enrichedMap)) {
        if (positions.has(symbol)) continue;
        const entry = assetObj.byDate.get(date);
        if (!entry) continue;
        const sig = evaluateBarSignal(entry.series, entry.idx, null, {
          stopLossPct,
          takeProfitPct,
        });
        if (sig.action === "BUY") {
          candidates.push({ symbol, bar: entry.bar, sig });
        }
      }

      candidates.sort((a, b) => b.sig.score - a.sig.score);

      for (const cand of candidates) {
        if (positions.size >= maxOpenPositions) break;
        // Dynamic sizing: scale with current equity or cap by maxPositionGbp
        const currentEquityEstimate =
          cashGbp +
          Array.from(positions.entries()).reduce((acc, [sym, p]) => {
            const latestBar = enrichedMap[sym]?.byDate.get(date)?.bar;
            return acc + p.quantity * (latestBar ? latestBar.close : p.avgEntryPriceGbp);
          }, 0);
        const slotBudget = Math.min(
          cashGbp * 0.98,
          Math.max(maxPositionGbp, currentEquityEstimate / maxOpenPositions)
        );
        if (slotBudget < 15) break;

        const fillPrice = cand.bar.close * (1 + spreadSlippageRate);
        const qty = Number((slotBudget / fillPrice).toFixed(4));
        if (qty <= 0) continue;

        const cost = qty * fillPrice;
        if (cost > cashGbp) continue;

        cashGbp -= cost;
        positions.set(cand.symbol, {
          quantity: qty,
          avgEntryPriceGbp: fillPrice,
          entryDate: date,
        });
      }
    }

    // 3. Mark-to-market portfolio equity
    let holdingsValueGbp = 0;
    for (const [symbol, pos] of positions.entries()) {
      const latestBar = enrichedMap[symbol]?.byDate.get(date)?.bar;
      const markPrice = latestBar ? latestBar.close : pos.avgEntryPriceGbp;
      holdingsValueGbp += pos.quantity * markPrice;
    }

    const totalEquityGbp = cashGbp + holdingsValueGbp;
    if (totalEquityGbp > peakEquity) peakEquity = totalEquityGbp;
    const ddPct = peakEquity > 0 ? ((peakEquity - totalEquityGbp) / peakEquity) * 100 : 0;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

    const benchBar = benchAsset?.byDate.get(date)?.bar;
    if (benchBar && benchStartPrice == null) {
      benchStartPrice = benchBar.close;
    }
    const benchmarkEquityGbp =
      benchBar && benchStartPrice
        ? (initialCapitalGbp * benchBar.close) / benchStartPrice
        : initialCapitalGbp;

    equityCurve.push({
      date,
      equityGbp: Number(totalEquityGbp.toFixed(2)),
      benchmarkGbp: Number(benchmarkEquityGbp.toFixed(2)),
      cashGbp: Number(cashGbp.toFixed(2)),
      openPositions: positions.size,
    });
  }

  const finalPoint = equityCurve[equityCurve.length - 1];
  const finalEquityGbp = finalPoint ? finalPoint.equityGbp : initialCapitalGbp;
  const finalBenchGbp = finalPoint ? finalPoint.benchmarkGbp : initialCapitalGbp;
  const netProfitGbp = finalEquityGbp - initialCapitalGbp;
  const totalReturnPct = (netProfitGbp / initialCapitalGbp) * 100;
  const benchmarkReturnPct = ((finalBenchGbp - initialCapitalGbp) / initialCapitalGbp) * 100;

  const wins = closedTrades.filter((t) => t.profitGbp > 0);
  const losses = closedTrades.filter((t) => t.profitGbp <= 0);
  const grossWin = wins.reduce((s, t) => s + t.profitGbp, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.profitGbp, 0));

  return {
    initialCapitalGbp,
    finalEquityGbp: Number(finalEquityGbp.toFixed(2)),
    netProfitGbp: Number(netProfitGbp.toFixed(2)),
    totalReturnPct: Number(totalReturnPct.toFixed(2)),
    benchmarkSymbol: benchAsset?.symbol || "VUAG",
    benchmarkReturnPct: Number(benchmarkReturnPct.toFixed(2)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    winRatePct:
      closedTrades.length > 0
        ? Number(((wins.length / closedTrades.length) * 100).toFixed(1))
        : 0,
    profitFactor:
      grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? 9.99 : 0,
    totalTrades: closedTrades.length,
    currentlyHeld: Array.from(positions.entries()).map(([symbol, p]) => ({
      symbol,
      quantity: Number(p.quantity.toFixed(4)),
      avgEntryPriceGbp: Number(p.avgEntryPriceGbp.toFixed(2)),
      entryDate: p.entryDate,
    })),
    equityCurve,
    trades: closedTrades.slice().reverse(),
  };
}
