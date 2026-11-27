const el = (id) => document.getElementById(id);

let currentStatus = null;

function fmtGbp(val) {
  const num = Number(val) || 0;
  const sign = num < 0 ? "-" : "";
  return `${sign}£${Math.abs(num).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtSignedPct(val) {
  const num = Number(val) || 0;
  return `${num >= 0 ? "+" : ""}${num.toFixed(2)}%`;
}

function showBanner(msg, isError = false) {
  const banner = el("alertBanner");
  banner.textContent = msg;
  banner.style.borderColor = isError ? "#ef4444" : "#3b82f6";
  banner.classList.remove("hidden");
  setTimeout(() => {
    banner.classList.add("hidden");
  }, 8000);
}

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function renderStatus(data) {
  currentStatus = data;
  const { config, ukMarket, account, signals, state } = data;

  // Header Pills
  const modeBadge = el("modeBadge");
  if (config.env === "live") {
    modeBadge.textContent = "LIVE REAL MONEY (ISA / INVEST)";
    modeBadge.className = "pill pill-live";
  } else {
    modeBadge.textContent = "PRACTICE / DEMO MODE";
    modeBadge.className = "pill pill-demo";
  }

  const marketBadge = el("marketBadge");
  marketBadge.textContent = ukMarket.statusLabel;
  marketBadge.className = ukMarket.isOpen ? "pill pill-open" : "pill pill-neutral";

  const autoBadge = el("autoBadge");
  autoBadge.textContent = config.autoTradeEnabled
    ? `Auto-Trade: ON (${config.dailyRunTimeUk} UK)`
    : "Auto-Trade: OFF";
  autoBadge.className = config.autoTradeEnabled ? "pill pill-open" : "pill pill-neutral";

  // KPI Cards
  if (account.connected && account.cash) {
    el("kpiConnection").textContent =
      config.env === "live" ? "Connected (LIVE)" : "Connected (Demo)";
    el("kpiConnection").className = "kpi-value pos-text";
    el("kpiEnvDetail").textContent = `Key ${config.maskedApiKey} · Verified`;
    el("kpiFreeCash").textContent = fmtGbp(account.cash.freeGbp);
    el("kpiTotalCash").textContent = `Total Equity: ${fmtGbp(account.cash.totalGbp)}`;

    const ppl = account.cash.pplGbp;
    el("kpiPpl").textContent = `${ppl >= 0 ? "+" : ""}${fmtGbp(ppl)}`;
    el("kpiPpl").className = `kpi-value ${ppl >= 0 ? "pos-text" : "neg-text"}`;
    el("kpiPositionsCount").textContent = `${account.portfolio.length} Open ETF Position(s)`;
  } else {
    el("kpiConnection").textContent = config.hasApiKey ? "Auth Error" : "Demo Ready (No Key)";
    el("kpiConnection").className = "kpi-value";
    el("kpiEnvDetail").textContent =
      account.error || "Signals & Backtester active · Add T212 key below";
    el("kpiFreeCash").textContent = "—";
    el("kpiTotalCash").textContent = "Connect Trading 212 API to view balance";
    el("kpiPpl").textContent = "—";
    el("kpiPpl").className = "kpi-value";
    el("kpiPositionsCount").textContent = "0 Open ETF Positions";
  }

  el("kpiRiskMain").textContent = `£${config.maxPositionGbp} / ETF`;
  el(
    "kpiRiskSub"
  ).textContent = `-${config.stopLossPct}% Stop · +${config.takeProfitPct}% Target · £${config.maxDailyLossGbp} Daily Cap`;

  // Populate Settings Form
  el("envSelect").value = config.env;
  el("keyMaskHint").textContent = config.hasApiKey ? `(Saved: ${config.maskedApiKey})` : "(Not set)";
  el("maxPositionInput").value = config.maxPositionGbp;
  el("maxOpenInput").value = config.maxOpenPositions;
  el("dailyLossInput").value = config.maxDailyLossGbp;
  el("stopLossInput").value = config.stopLossPct;
  el("takeProfitInput").value = config.takeProfitPct;
  el("runTimeInput").value = config.dailyRunTimeUk;
  el("autoTradeCheckbox").checked = config.autoTradeEnabled;

  // Render Signals Table
  const tbody = el("signalsTableBody");
  tbody.innerHTML = signals
    .map((s) => {
      const badgeClass =
        s.action === "BUY" ? "badge-buy" : s.action === "SELL" ? "badge-sell" : "badge-hold";
      const dayCls = s.dayChangePct >= 0 ? "pos-text" : "neg-text";
      return `
        <tr>
          <td><strong>${s.symbol}</strong></td>
          <td>
            <div>${s.name}</div>
            <span class="muted"><code>${s.t212Ticker}</code> · ${
        s.dataSource === "yahoo-live" ? "Live LSE Data" : "Offline Sim"
      }</span>
          </td>
          <td><strong>${fmtGbp(s.priceGbp)}</strong></td>
          <td class="${dayCls}">${fmtSignedPct(s.dayChangePct)}</td>
          <td>£${s.ema20Gbp ?? "—"} / £${s.sma50Gbp ?? "—"}</td>
          <td>${s.rsi14 ?? "—"}</td>
          <td><span class="badge ${badgeClass}">${s.action}</span></td>
          <td>
            <div class="score-bar"><div class="score-fill" style="width:${s.score}%"></div></div>
            <span>${s.score}</span>
          </td>
          <td>${s.reason}</td>
        </tr>
      `;
    })
    .join("");

  // Render Portfolio Table
  const portBody = el("portfolioBody");
  const positions = account.portfolio || [];
  if (positions.length === 0) {
    portBody.innerHTML = `<tr><td colspan="6" class="muted center">No open positions in this Trading 212 account</td></tr>`;
  } else {
    portBody.innerHTML = positions
      .map((p) => {
        const cls = p.pplGbp >= 0 ? "pos-text" : "neg-text";
        return `
          <tr>
            <td><strong>${p.symbol}</strong> <span class="muted">(${p.ticker})</span></td>
            <td>${p.quantity}</td>
            <td>${fmtGbp(p.avgEntryPriceGbp)}</td>
            <td>${fmtGbp(p.currentPriceGbp)}</td>
            <td>${fmtGbp(p.marketValueGbp)}</td>
            <td class="${cls}">${p.pplGbp >= 0 ? "+" : ""}${fmtGbp(p.pplGbp)} (${fmtSignedPct(
          p.pnlPct
        )})</td>
          </tr>
        `;
      })
      .join("");
  }

  // Render Activity Log
  const logBox = el("activityLogBox");
  const logs = state.activityLog || [];
  logBox.innerHTML = logs
    .map((item) => {
      const time = new Date(item.timestamp).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      return `
        <div class="log-item log-${item.level}">
          <span class="muted">[${time}]</span> <strong>${item.level}:</strong> ${item.message}
        </div>
      `;
    })
    .join("");
}

function drawEquityChart(curve) {
  const canvas = el("equityCanvas");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(400, rect.width || 660);
  const height = 220;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, width, height);
  if (!curve || curve.length < 2) return;

  const pad = { top: 16, right: 16, bottom: 26, left: 58 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const allVals = curve.flatMap((p) => [p.equityGbp, p.benchmarkGbp]);
  const minVal = Math.min(...allVals) * 0.985;
  const maxVal = Math.max(...allVals) * 1.015;
  const span = Math.max(1, maxVal - minVal);

  const xAt = (i) => pad.left + (i / (curve.length - 1)) * plotW;
  const yAt = (v) => pad.top + plotH - ((v - minVal) / span) * plotH;

  // Grid lines
  ctx.strokeStyle = "rgba(147, 163, 194, 0.14)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#93a3c2";
  ctx.font = "11px sans-serif";
  for (let g = 0; g <= 3; g++) {
    const val = minVal + (span * g) / 3;
    const y = yAt(val);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(`£${Math.round(val)}`, 6, y + 4);
  }

  // Benchmark line (dashed slate)
  ctx.beginPath();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "#64748b";
  ctx.lineWidth = 1.6;
  curve.forEach((pt, idx) => {
    const x = xAt(idx);
    const y = yAt(pt.benchmarkGbp);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);

  // Bot Equity line (emerald)
  ctx.beginPath();
  ctx.strokeStyle = "#10b981";
  ctx.lineWidth = 2.4;
  curve.forEach((pt, idx) => {
    const x = xAt(idx);
    const y = yAt(pt.equityGbp);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Start & end dates
  ctx.fillStyle = "#93a3c2";
  ctx.fillText(curve[0].date, pad.left, height - 6);
  ctx.fillText(curve[curve.length - 1].date, width - pad.right - 68, height - 6);
}

async function runBacktest() {
  const btn = el("runBacktestBtn");
  btn.disabled = true;
  btn.textContent = "Simulating...";
  try {
    const lookbackDays = Number(el("btDaysSelect").value) || 365;
    const initialCapitalGbp = Number(el("btCapitalInput").value) || 2000;
    const { report } = await apiFetch("/api/backtest", {
      method: "POST",
      body: JSON.stringify({ lookbackDays, initialCapitalGbp }),
    });

    el("btFinalEquity").textContent = fmtGbp(report.finalEquityGbp);
    el("btReturn").textContent = `${fmtSignedPct(report.totalReturnPct)} (${fmtGbp(
      report.netProfitGbp
    )})`;
    el("btReturn").className = report.totalReturnPct >= 0 ? "pos-text" : "neg-text";
    el("btBench").textContent = fmtSignedPct(report.benchmarkReturnPct);
    el("btDrawdown").textContent = `-${report.maxDrawdownPct.toFixed(2)}%`;
    el("btWinRate").textContent = `${report.winRatePct}% (${report.totalTrades} trades)`;
    el("btTradeCount").textContent = String(report.trades.length);

    drawEquityChart(report.equityCurve);

    const tbody = el("btTradesBody");
    if (report.trades.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted center">No closed trades in period</td></tr>`;
    } else {
      tbody.innerHTML = report.trades
        .map((t) => {
          const cls = t.profitGbp >= 0 ? "pos-text" : "neg-text";
          return `
            <tr>
              <td><strong>${t.symbol}</strong></td>
              <td>${t.entryDate} → ${t.exitDate}</td>
              <td>£${t.entryPriceGbp} → £${t.exitPriceGbp}</td>
              <td class="${cls}">${t.profitGbp >= 0 ? "+" : ""}${fmtGbp(t.profitGbp)} (${fmtSignedPct(
            t.profitPct
          )})</td>
              <td>${t.reason}</td>
            </tr>
          `;
        })
        .join("");
    }
  } catch (err) {
    showBanner(`Backtest error: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Run Backtest";
  }
}

async function loadAll() {
  try {
    const data = await apiFetch("/api/status");
    renderStatus(data);
  } catch (err) {
    showBanner(`Failed to load status: ${err.message}`, true);
  }
}

// Event Listeners
el("refreshBtn").addEventListener("click", loadAll);
el("runBacktestBtn").addEventListener("click", runBacktest);

el("settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nextEnv = el("envSelect").value;
  if (nextEnv === "live" && currentStatus?.config?.env !== "live") {
    const ok = window.confirm(
      "WARNING: You are switching from Practice/Demo Mode to LIVE Real-Money Mode (Trading 212 Invest / Stocks ISA).\n\nHave you tested in Practice Mode first and verified your £ risk limits?"
    );
    if (!ok) {
      el("envSelect").value = "demo";
      return;
    }
  }

  try {
    await apiFetch("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        env: nextEnv,
        apiKey: el("apiKeyInput").value,
        apiSecret: el("apiSecretInput").value,
        maxPositionGbp: Number(el("maxPositionInput").value),
        maxOpenPositions: Number(el("maxOpenInput").value),
        maxDailyLossGbp: Number(el("dailyLossInput").value),
        stopLossPct: Number(el("stopLossInput").value),
        takeProfitPct: Number(el("takeProfitInput").value),
        dailyRunTimeUk: el("runTimeInput").value,
        autoTradeEnabled: el("autoTradeCheckbox").checked,
      }),
    });
    el("apiKeyInput").value = "";
    el("apiSecretInput").value = "";
    showBanner("Settings saved locally to .env!");
    await loadAll();
  } catch (err) {
    showBanner(`Could not save settings: ${err.message}`, true);
  }
});

el("testConnBtn").addEventListener("click", async () => {
  try {
    const acc = await apiFetch("/api/test-connection", { method: "POST" });
    if (acc.connected) {
      showBanner(
        `Connected to Trading 212 (${acc.env.toUpperCase()})! Free Cash: ${fmtGbp(
          acc.cash.freeGbp
        )}`
      );
    } else {
      showBanner(`Connection failed: ${acc.error || acc.message}`, true);
    }
    await loadAll();
  } catch (err) {
    showBanner(`Connection error: ${err.message}`, true);
  }
});

el("dryRunBtn").addEventListener("click", async () => {
  try {
    const { result } = await apiFetch("/api/run-cycle", {
      method: "POST",
      body: JSON.stringify({ dryRun: true }),
    });
    const box = el("cyclePreviewBox");
    box.classList.remove("hidden");
    if (result.plannedOrders.length === 0) {
      box.innerHTML = `<strong>Dry-Run Preview:</strong> No BUY or SELL orders triggered right now. Strategy recommends holding current cash/positions safely.`;
    } else {
      const items = result.plannedOrders
        .map(
          (o) =>
            `<li><strong>${o.side}</strong> ${Math.abs(o.quantity)} shares of <strong>${
              o.symbol
            }</strong> (<code>${o.ticker}</code>, ~${fmtGbp(o.estimatedValueGbp)}) — <em>${
              o.reason
            }</em></li>`
        )
        .join("");
      box.innerHTML = `<strong>Dry-Run Order Preview (NOT sent to broker):</strong><ul style="margin:6px 0 0 18px">${items}</ul>`;
    }
    await loadAll();
  } catch (err) {
    showBanner(`Dry-run failed: ${err.message}`, true);
  }
});

el("executeCycleBtn").addEventListener("click", async () => {
  const modeLabel =
    currentStatus?.config?.env === "live" ? "LIVE REAL MONEY" : "PRACTICE / DEMO";
  const ukOpen = currentStatus?.ukMarket?.isOpen;
  let allowClosedMarketDemo = false;

  if (!ukOpen && currentStatus?.config?.env === "demo") {
    allowClosedMarketDemo = window.confirm(
      `London Stock Exchange is currently closed (${currentStatus.ukMarket.ukTime} UK).\n\nSince you are in PRACTICE/DEMO mode, would you like to queue a Demo test order anyway? (Cancel to abort)`
    );
    if (!allowClosedMarketDemo) return;
  } else {
    const confirmed = window.confirm(
      `Execute today's strategy orders now in ${modeLabel} mode?`
    );
    if (!confirmed) return;
  }

  try {
    const { result } = await apiFetch("/api/run-cycle", {
      method: "POST",
      body: JSON.stringify({ dryRun: false, allowClosedMarketDemo }),
    });
    const box = el("cyclePreviewBox");
    box.classList.remove("hidden");
    box.innerHTML = `<strong>Execution Complete:</strong> ${result.executedOrders.length} order(s) processed. Check the Activity Audit Log below for order IDs.`;
    await loadAll();
  } catch (err) {
    showBanner(err.message, true);
    await loadAll();
  }
});

// Initial page boot
loadAll().then(runBacktest);
