import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, updateEnvSettings } from "./config.js";
import { BotEngine, getUkMarketStatus } from "./botEngine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const engine = new BotEngine();
engine.startScheduler();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 256 * 1024) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON request body"));
      }
    });
    req.on("error", reject);
  });
}

function sanitizeConfig(cfg) {
  return {
    env: cfg.env,
    hasApiKey: Boolean(cfg.apiKey),
    hasApiSecret: Boolean(cfg.apiSecret),
    maskedApiKey: cfg.apiKey
      ? `${cfg.apiKey.slice(0, 4)}••••${cfg.apiKey.slice(-4)}`
      : "",
    port: cfg.port,
    autoTradeEnabled: cfg.autoTradeEnabled,
    dailyRunTimeUk: cfg.dailyRunTimeUk,
    maxPositionGbp: cfg.maxPositionGbp,
    maxOpenPositions: cfg.maxOpenPositions,
    stopLossPct: cfg.stopLossPct,
    takeProfitPct: cfg.takeProfitPct,
    maxDailyLossGbp: cfg.maxDailyLossGbp,
  };
}

export function createAppServer() {
  return http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, "http://127.0.0.1");
      const pathname = parsedUrl.pathname;

      if (pathname === "/api/status" && req.method === "GET") {
        const cfg = getConfig();
        const ukMarket = getUkMarketStatus();
        const account = await engine.getAccountSnapshot();
        const { signals } = await engine.generateDailySignals(account.portfolio || []);

        return sendJson(res, 200, {
          config: sanitizeConfig(cfg),
          ukMarket,
          account,
          signals,
          state: {
            lastAutoRunDate: engine.state.lastAutoRunDate,
            lastCycleAt: engine.state.lastCycleAt,
            circuitBreakerTripped: engine.state.circuitBreakerTripped,
            activityLog: (engine.state.activityLog || []).slice(0, 40),
            executionHistory: (engine.state.executionHistory || []).slice(0, 30),
          },
        });
      }

      if (pathname === "/api/settings" && req.method === "POST") {
        const body = await readJsonBody(req);
        const updates = {};

        if (body.env === "demo" || body.env === "live") {
          updates.T212_ENV = body.env;
        }
        if (typeof body.apiKey === "string" && body.apiKey.trim() !== "") {
          updates.T212_API_KEY = body.apiKey.trim();
        }
        if (typeof body.apiSecret === "string" && body.apiSecret.trim() !== "") {
          updates.T212_API_SECRET = body.apiSecret.trim();
        }
        if (body.clearCredentials === true) {
          updates.T212_API_KEY = "";
          updates.T212_API_SECRET = "";
        }
        if (typeof body.autoTradeEnabled === "boolean") {
          updates.AUTO_TRADE_ENABLED = String(body.autoTradeEnabled);
        }
        if (typeof body.dailyRunTimeUk === "string" && /^\d{2}:\d{2}$/.test(body.dailyRunTimeUk)) {
          updates.DAILY_RUN_TIME_UK = body.dailyRunTimeUk;
        }
        if (body.maxPositionGbp !== undefined) {
          updates.MAX_POSITION_GBP = String(Math.max(10, Number(body.maxPositionGbp) || 200));
        }
        if (body.maxOpenPositions !== undefined) {
          updates.MAX_OPEN_POSITIONS = String(
            Math.max(1, Math.min(10, Number(body.maxOpenPositions) || 3))
          );
        }
        if (body.stopLossPct !== undefined) {
          updates.STOP_LOSS_PCT = String(Math.max(0.5, Number(body.stopLossPct) || 3.5));
        }
        if (body.takeProfitPct !== undefined) {
          updates.TAKE_PROFIT_PCT = String(Math.max(1.0, Number(body.takeProfitPct) || 7.5));
        }
        if (body.maxDailyLossGbp !== undefined) {
          updates.MAX_DAILY_LOSS_GBP = String(Math.max(5, Number(body.maxDailyLossGbp) || 30));
        }

        const updatedCfg = updateEnvSettings(updates);
        engine.log(
          "INFO",
          `Settings updated (Mode: ${updatedCfg.env.toUpperCase()}, Auto-Trade: ${
            updatedCfg.autoTradeEnabled ? "ON" : "OFF"
          }, Max/ETF: £${updatedCfg.maxPositionGbp}).`
        );

        const account = await engine.getAccountSnapshot();
        return sendJson(res, 200, {
          ok: true,
          config: sanitizeConfig(updatedCfg),
          account,
        });
      }

      if (pathname === "/api/test-connection" && req.method === "POST") {
        const account = await engine.getAccountSnapshot();
        if (account.connected) {
          engine.log(
            "SUCCESS",
            `Connected to Trading 212 (${account.env.toUpperCase()}) — Free Cash: £${account.cash.freeGbp.toFixed(
              2
            )}, Open Positions: ${account.portfolio.length}`
          );
        } else {
          engine.log("WARN", `Connection check failed: ${account.error || account.message}`);
        }
        return sendJson(res, 200, account);
      }

      if (pathname === "/api/run-cycle" && req.method === "POST") {
        const body = await readJsonBody(req);
        const dryRun = body.dryRun !== false;
        const allowClosedMarketDemo = Boolean(body.allowClosedMarketDemo);
        const result = await engine.runTradeCycle({ dryRun, allowClosedMarketDemo });
        return sendJson(res, 200, { ok: true, result });
      }

      if (pathname === "/api/backtest" && req.method === "POST") {
        const body = await readJsonBody(req);
        const report = await engine.runBacktestReport({
          initialCapitalGbp: body.initialCapitalGbp,
          lookbackDays: body.lookbackDays,
          maxPositionGbp: body.maxPositionGbp,
          maxOpenPositions: body.maxOpenPositions,
          stopLossPct: body.stopLossPct,
          takeProfitPct: body.takeProfitPct,
        });
        return sendJson(res, 200, { ok: true, report });
      }

      // Serve static files from /public
      const relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const safePath = path.normalize(path.join(PUBLIC_DIR, relPath));
      if (!safePath.startsWith(PUBLIC_DIR) || !fs.existsSync(safePath)) {
        return sendJson(res, 404, { error: "Not found" });
      }

      const ext = path.extname(safePath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      });
      fs.createReadStream(safePath).pipe(res);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  });
}

// Start server when invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const cfg = getConfig();
  const server = createAppServer();
  // Bind exclusively to 127.0.0.1 so only this computer can access the dashboard
  server.listen(cfg.port, "127.0.0.1", () => {
    console.log("");
    console.log("==========================================================");
    console.log("  Trading 212 UK GBP ETF Bot & Dashboard Running Locally");
    console.log(`  Dashboard URL : http://127.0.0.1:${cfg.port}`);
    console.log(`  Current Mode  : ${cfg.env.toUpperCase()} (${cfg.env === "demo" ? "Safe Practice Money" : "LIVE Real Money"})`);
    console.log("==========================================================");
    console.log("");
  });
}
