@echo off
title LIVE Fest rank probe
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org then run this again.
  pause
  exit /b 1
)
if not exist node_modules\tiktok-live-connector (
  echo Installing dependencies, this only happens once...
  call npm install --no-fund --no-audit
)
set /p TTUSER=Your TikTok username (without @):
node rank-probe.mjs %TTUSER% 15
pause
