import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, "..");
export const DATA_DIR = process.env.BOT_DATA_DIR
  ? path.resolve(process.env.BOT_DATA_DIR)
  : path.join(ROOT_DIR, "data");
export const ENV_PATH = process.env.BOT_ENV_PATH
  ? path.resolve(process.env.BOT_ENV_PATH)
  : path.join(ROOT_DIR, ".env");
export const STATE_PATH = path.join(DATA_DIR, "bot_state.json");
export const INSTRUMENTS_CACHE_PATH = path.join(DATA_DIR, "instruments_cache.json");

// Curated UK LSE ETFs: 0% UK Stamp Duty, 0% FX fee in GBP, ISA & Invest eligible
export const UK_ETF_UNIVERSE = [
  {
    symbol: "VUAG",
    yahooSymbol: "VUAG.L",
    name: "Vanguard S&P 500 UCITS ETF (Acc)",
    category: "US Large-Cap Core (GBP)",
    fallbackT212Ticker: "VUAGl_EQ",
  },
  {
    symbol: "EQQQ",
    yahooSymbol: "EQQQ.L",
    name: "Invesco EQQQ Nasdaq-100 UCITS ETF",
    category: "US Tech Growth (GBP/GBX)",
    fallbackT212Ticker: "EQQQl_EQ",
  },
  {
    symbol: "VWRP",
    yahooSymbol: "VWRP.L",
    name: "Vanguard FTSE All-World UCITS ETF (Acc)",
    category: "Global Equities (GBP)",
    fallbackT212Ticker: "VWRPl_EQ",
  },
  {
    symbol: "SGLN",
    yahooSymbol: "SGLN.L",
    name: "iShares Physical Gold ETC",
    category: "Safe-Haven Gold Hedge (GBX)",
    fallbackT212Ticker: "SGLNl_EQ",
  },
  {
    symbol: "ISF",
    yahooSymbol: "ISF.L",
    name: "iShares Core FTSE 100 UCITS ETF",
    category: "UK Blue-Chip Equities (GBX)",
    fallbackT212Ticker: "ISFl_EQ",
  },
];

export function ensureDirectories() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function parseEnvFile() {
  const result = {};
  if (!fs.existsSync(ENV_PATH)) {
    return result;
  }
  const content = fs.readFileSync(ENV_PATH, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

export function getConfig() {
  const fileEnv = parseEnvFile();
  const get = (key, fallback) =>
    fileEnv[key] !== undefined && fileEnv[key] !== ""
      ? fileEnv[key]
      : process.env[key] !== undefined && process.env[key] !== ""
        ? process.env[key]
        : fallback;

  const envMode = String(get("T212_ENV", "demo")).toLowerCase() === "live" ? "live" : "demo";

  return {
    env: envMode,
    baseUrl:
      envMode === "live"
        ? "https://live.trading212.com/api/v0"
        : "https://demo.trading212.com/api/v0",
    apiKey: String(get("T212_API_KEY", "")).trim(),
    apiSecret: String(get("T212_API_SECRET", "")).trim(),
    port: Number(get("PORT", 3212)) || 3212,
    autoTradeEnabled: String(get("AUTO_TRADE_ENABLED", "false")).toLowerCase() === "true",
    // 14:45 UK time = 15 mins after US open while LSE is open, giving tightest ETF spreads
    dailyRunTimeUk: String(get("DAILY_RUN_TIME_UK", "14:45")),
    maxPositionGbp: Math.max(10, Number(get("MAX_POSITION_GBP", 200)) || 200),
    maxOpenPositions: Math.max(1, Math.min(10, Number(get("MAX_OPEN_POSITIONS", 3)) || 3)),
    stopLossPct: Math.max(0.5, Number(get("STOP_LOSS_PCT", 3.5)) || 3.5),
    takeProfitPct: Math.max(1.0, Number(get("TAKE_PROFIT_PCT", 7.5)) || 7.5),
    maxDailyLossGbp: Math.max(5, Number(get("MAX_DAILY_LOSS_GBP", 30)) || 30),
  };
}

export function updateEnvSettings(updates) {
  const existing = parseEnvFile();
  const merged = {
    T212_ENV: existing.T212_ENV ?? "demo",
    T212_API_KEY: existing.T212_API_KEY ?? "",
    T212_API_SECRET: existing.T212_API_SECRET ?? "",
    PORT: existing.PORT ?? "3212",
    AUTO_TRADE_ENABLED: existing.AUTO_TRADE_ENABLED ?? "false",
    DAILY_RUN_TIME_UK: existing.DAILY_RUN_TIME_UK ?? "14:45",
    MAX_POSITION_GBP: existing.MAX_POSITION_GBP ?? "200",
    MAX_OPEN_POSITIONS: existing.MAX_OPEN_POSITIONS ?? "3",
    STOP_LOSS_PCT: existing.STOP_LOSS_PCT ?? "3.5",
    TAKE_PROFIT_PCT: existing.TAKE_PROFIT_PCT ?? "7.5",
    MAX_DAILY_LOSS_GBP: existing.MAX_DAILY_LOSS_GBP ?? "30",
    ...updates,
  };

  const lines = [
    "# Trading 212 UK ETF Bot Local Configuration",
    "# Stored strictly on your own PC - never shared externally",
    `T212_ENV=${merged.T212_ENV}`,
    `T212_API_KEY=${merged.T212_API_KEY}`,
    `T212_API_SECRET=${merged.T212_API_SECRET}`,
    `PORT=${merged.PORT}`,
    `AUTO_TRADE_ENABLED=${merged.AUTO_TRADE_ENABLED}`,
    `DAILY_RUN_TIME_UK=${merged.DAILY_RUN_TIME_UK}`,
    `MAX_POSITION_GBP=${merged.MAX_POSITION_GBP}`,
    `MAX_OPEN_POSITIONS=${merged.MAX_OPEN_POSITIONS}`,
    `STOP_LOSS_PCT=${merged.STOP_LOSS_PCT}`,
    `TAKE_PROFIT_PCT=${merged.TAKE_PROFIT_PCT}`,
    `MAX_DAILY_LOSS_GBP=${merged.MAX_DAILY_LOSS_GBP}`,
    "",
  ];
  fs.writeFileSync(ENV_PATH, lines.join("\n"), "utf-8");
  return getConfig();
}
