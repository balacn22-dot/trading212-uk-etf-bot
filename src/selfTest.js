import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.BOT_DATA_DIR = process.env.BOT_DATA_DIR || path.join(os.tmpdir(), "t212bot_test_data");
process.env.BOT_ENV_PATH = process.env.BOT_ENV_PATH || path.join(os.tmpdir(), "t212bot_test.env");

const { normalizePriceToGbp } = await import("./t212Client.js");
const { createAppServer } = await import("./server.js");

async function runTests() {
  console.log("1. Verifying UK LSE GBP vs GBX (pence) unit normalization...");
  assert.equal(normalizePriceToGbp(95.25, "GBP"), 95.25);
  assert.equal(normalizePriceToGbp(40550, "GBX"), 405.5);
  assert.equal(normalizePriceToGbp(812, "GBp"), 8.12);
  console.log("   PASS: GBP/GBX normalization exact.");

  console.log("2. Starting local HTTP server and probing API routes...");
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes("Trading 212 UK ETF Daily Bot"));
    console.log("   PASS: Dashboard HTML served (200 OK).");

    const statusRes = await fetch(`${base}/api/status`);
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.config.env, "demo");
    assert.equal(statusJson.signals.length, 5);
    console.log(
      `   PASS: /api/status returned ${statusJson.signals.length} UK ETF signals (Mode: ${statusJson.config.env}).`
    );

    const btRes = await fetch(`${base}/api/backtest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lookbackDays: 365, initialCapitalGbp: 2000 }),
    });
    assert.equal(btRes.status, 200);
    const btJson = await btRes.json();
    assert.equal(btJson.ok, true);
    assert.ok(btJson.report.equityCurve.length > 100);
    console.log(
      `   PASS: /api/backtest simulated ${btJson.report.equityCurve.length} trading days -> Final Equity: £${btJson.report.finalEquityGbp} (${btJson.report.totalReturnPct}%).`
    );

    const dryRes = await fetch(`${base}/api/run-cycle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    assert.equal(dryRes.status, 200);
    const dryJson = await dryRes.json();
    assert.equal(dryJson.ok, true);
    assert.equal(dryJson.result.dryRun, true);
    console.log(
      `   PASS: /api/run-cycle dry-run previewed ${dryJson.result.plannedOrders.length} order(s) safely.`
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log("\nALL TESTS PASSED!");
}

runTests().catch((err) => {
  console.error("SELF-TEST FAILED:", err);
  process.exit(1);
});
