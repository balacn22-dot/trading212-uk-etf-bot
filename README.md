# Trading 212 UK GBP ETF Daily Bot & Dashboard

A local, privacy-first automated daily trading bot and backtesting dashboard tailored for **UK Trading 212** accounts (**Practice/Demo**, **Invest**, and tax-free **Stocks & Shares ISA**).

## Why This Setup Is Designed for UK Safety
- **Zero Leverage:** Trades real London Stock Exchange (LSE) ETFs—never CFDs or margin.
- **0% UK Stamp Duty & 0% FX Fee:** Trades GBP/GBX-listed ETFs (`VUAG`, `EQQQ`, `VWRP`, `SGLN`, `ISF`), avoiding the 0.5% UK Stamp Duty charged on individual LSE company shares and the 0.15% FX fee on USD stocks.
- **GBP / GBX Pence Protection:** Automatically normalizes LSE pence (`GBX`) vs pounds (`GBP`) quotes so position sizing is always accurate in `£`.
- **Hard Risk Guardrails:**
  - Defaults to **Practice / Demo Mode** (`demo.trading212.com`).
  - Per-ETF maximum `£` cap, max open ETF positions, automatic stop-loss (`-3.5%`), take-profit (`+7.5%`), LSE trading-hours guard (`Mon–Fri 08:05–16:25 UK`), and a daily max-loss circuit breaker.
  - Scheduled daily check defaults to **14:45 UK time** (15 minutes after US market open while LSE is active, when UK ETF spreads are tightest).
- **100% Local Credentials:** Your Trading 212 `API Key` and `API Secret` stay strictly in `D:\APPS\Trading212Bot\.env` on your own machine—never share your login password.

## Quick Start (Windows Local Dashboard)
1. Double-click **`start_bot.bat`** (or run `node src/server.js` inside `D:\APPS\Trading212Bot`).
2. Your browser will open **`http://127.0.0.1:3212`**.
3. Open your **Trading 212** app → switch to **Practice Mode** → go to **Menu (☰) → Settings → API (Beta) → Generate API key**.
4. Paste your **API Key** and **API Secret** into the Dashboard Settings panel and click **Save Settings** → **Test T212 Connection**.
5. Run the **Strategy Backtester**, click **Preview Orders (Dry Run)**, and keep it in **Practice / Demo Mode** for 2–4 weeks before considering Live mode.

---

## Run in the Cloud 24/7 With Your PC OFF (Free GitHub Actions)
This repository includes [`.github/workflows/daily-trade.yml`](.github/workflows/daily-trade.yml) and [`src/cloudRun.js`](src/cloudRun.js), which run automatically on GitHub's cloud servers **Monday–Friday at 09:10, 12:30, and 14:45 UTC**—even when your PC is completely shut down.

### 1. Create a Private GitHub Repository & Push
1. Go to [https://github.com/new](https://github.com/new), name it `trading212-uk-etf-bot`, select **Private**, and click **Create repository** (leave "Add a README" unticked).
2. In PowerShell inside `D:\APPS\Trading212Bot`, run (replacing `<YOUR_USERNAME>`):
   ```powershell
   git remote add origin https://github.com/<YOUR_USERNAME>/trading212-uk-etf-bot.git
   git push -u origin main
   ```

### 2. Add Your Encrypted GitHub Secrets
In your GitHub repository, go to **Settings → Secrets and variables → Actions → New repository secret** and add:
- `T212_API_KEY` — Your Trading 212 API Key
- `T212_API_SECRET` — Your Trading 212 API Secret Key
- `T212_ENV` — `demo` (for Practice Mode) or `live` (when ready for Real Money / ISA)

*(Optional secrets: `MAX_POSITION_GBP`, `MAX_OPEN_POSITIONS`, `STOP_LOSS_PCT`, `TAKE_PROFIT_PCT`, `MAX_DAILY_LOSS_GBP`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.)*

### 3. Test With 1 Click on GitHub
Go to the **Actions** tab in your GitHub repo → click **Trading 212 Daily UK ETF Bot** → click **Run workflow** (`dry_run: true`) to see a formatted live account & UK ETF signal table right inside your GitHub summary!
