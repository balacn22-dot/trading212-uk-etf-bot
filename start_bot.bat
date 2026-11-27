@echo off
title Trading 212 UK ETF Bot
cd /d "%~dp0"
echo Starting Trading 212 UK GBP ETF Bot Dashboard...
start "" http://127.0.0.1:3212
node src/server.js
pause
