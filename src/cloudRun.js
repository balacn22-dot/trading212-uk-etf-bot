import fs from "node:fs";
import { getConfig } from "./config.js";
import { BotEngine, getUkMarketStatus } from "./botEngine.js";

/**
 * Stateless Cloud Runner for GitHub Actions.
 * Reads credentials & risk settings from GitHub Secrets (environment variables),
 * checks Trading 212 account & UK LSE ETF signals, executes trades when LSE is open,
 * writes a rich Markdown report to GitHub Actions Step Summary, and optionally sends Telegram alerts.
 */
async function sendTelegramNotification(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.warn("Telegram notification skipped:", err.message);
  }
}

function writeGitHubSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, `${markdown}\n`, "utf-8");
  }
}

async function main() {
  const cfg = getConfig();
  const uk = getUkMarketStatus();
  const forceDryRun =
    String(process.env.DRY_RUN || "false").toLowerCase() === "true" || !uk.isOpen;

  console.log("==========================================================");
  console.log(`  Trading 212 UK ETF Cloud Runner (${cfg.env.toUpperCase()} MODE)`);
  console.log(`  UK Market Status : ${uk.statusLabel}`);
  console.log(`  Execution Mode   : ${forceDryRun ? "DRY-RUN PREVIEW" : "LIVE ORDER EXECUTION"}`);
  console.log("==========================================================");

  if (!cfg.apiKey) {
    throw new Error(
      "Missing T212_API_KEY! Add T212_API_KEY and T212_API_SECRET in your GitHub repo -> Settings -> Secrets and variables -> Actions."
    );
  }

  const engine = new BotEngine();
  const account = await engine.getAccountSnapshot();

  if (!account.connected) {
    throw new Error(`Trading 212 connection failed: ${account.error || account.message}`);
  }

  console.log(
    `Connected (${cfg.env.toUpperCase()}) | Free Cash: £${account.cash.freeGbp.toFixed(
      2
    )} | Total Equity: £${account.cash.totalGbp.toFixed(2)} | Open Positions: ${
      account.portfolio.length
    }`
  );

  const cycle = await engine.runTradeCycle({
    dryRun: forceDryRun,
    allowClosedMarketDemo: false,
  });

  // Print signal table to console logs
  console.log("\nToday's UK GBP ETF Signals:");
  for (const s of cycle.signals) {
    console.log(
      `  - ${s.symbol.padEnd(5)} | £${s.priceGbp.toFixed(2).padStart(7)} | RSI ${String(
        s.rsi14
      ).padStart(4)} | ${s.action.padEnd(4)} (Score ${String(s.score).padStart(2)}) | ${s.reason}`
    );
  }

  const ordersList = forceDryRun ? cycle.plannedOrders : cycle.executedOrders;
  if (ordersList.length === 0) {
    console.log("\nResult: No BUY or SELL orders triggered on this check.");
  } else {
    console.log(`\nOrders (${forceDryRun ? "Previewed" : "Processed"}):`);
    for (const o of ordersList) {
      console.log(
        `  * ${o.side} ${Math.abs(o.quantity)} ${o.symbol} (${o.ticker}) ~£${
          o.estimatedValueGbp
        } [${o.status || "PREVIEW"}] — ${o.reason}`
      );
    }
  }

  // Build rich Markdown Summary for GitHub Actions UI
  const summaryLines = [
    `## Trading 212 UK ETF Bot — ${cfg.env.toUpperCase()} Check`,
    `- **UK Time:** \`${uk.ukDate} ${uk.ukTime}\` (${uk.statusLabel})`,
    `- **Run Type:** \`${
      forceDryRun
        ? uk.isOpen
          ? "Manual Dry-Run Preview"
          : "Market Closed — Safe Preview Only"
        : "Active Automated Execution"
    }\``,
    `- **Account Balance:** Free Cash **£${account.cash.freeGbp.toFixed(
      2
    )}** · Total Equity **£${account.cash.totalGbp.toFixed(
      2
    )}** · Open P&L **£${account.cash.pplGbp.toFixed(2)}**`,
    "",
    "### UK GBP ETF Signals",
    "| ETF | Price (£) | 1D % | RSI(14) | Signal | Score | Reasoning |",
    "| :--- | :---: | :---: | :---: | :---: | :---: | :--- |",
    ...cycle.signals.map(
      (s) =>
        `| **${s.symbol}** (\`${s.t212Ticker}\`) | £${s.priceGbp.toFixed(2)} | ${
          s.dayChangePct >= 0 ? "+" : ""
        }${s.dayChangePct.toFixed(2)}% | ${s.rsi14} | **${s.action}** | ${s.score} | ${s.reason} |`
    ),
    "",
  ];

  if (ordersList.length > 0) {
    summaryLines.push(`### Orders ${forceDryRun ? "Previewed (Dry Run)" : "Executed"}`);
    for (const o of ordersList) {
      summaryLines.push(
        `- **${o.side}** \`${Math.abs(o.quantity)}\` **${o.symbol}** (~£${
          o.estimatedValueGbp
        }) — ${o.reason} ${o.status ? `*(${o.status})*` : ""}`
      );
    }
  } else {
    summaryLines.push("### Orders\n- None triggered on this check — holding cash/positions safely.");
  }

  writeGitHubSummary(summaryLines.join("\n"));

  // Send Telegram message if configured and orders occurred (or on afternoon summary)
  if (ordersList.length > 0 || process.env.TELEGRAM_ALWAYS_NOTIFY === "true") {
    const tgLines = [
      `*Trading 212 Bot (${cfg.env.toUpperCase()})*`,
      `Cash: £${account.cash.freeGbp.toFixed(2)} | Equity: £${account.cash.totalGbp.toFixed(2)}`,
      ordersList.length > 0
        ? ordersList
            .map(
              (o) =>
                `• *${o.side}* ${Math.abs(o.quantity)} ${o.symbol} (~£${o.estimatedValueGbp}) [${
                  o.status || "DRY-RUN"
                }]`
            )
            .join("\n")
        : "No trades triggered — holding safely.",
    ];
    await sendTelegramNotification(tgLines.join("\n"));
  }
}

main().catch((err) => {
  console.error("CLOUD RUN ERROR:", err.message);
  writeGitHubSummary(`## Trading 212 Bot Error\n\`\`\`\n${err.message}\n\`\`\``);
  process.exit(1);
});
