@echo off
title Live bridge (keep open while streaming)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org then run this again.
  pause
  exit /b 1
)
if not exist node_modules\playwright-core (
  echo Installing dependencies, this only happens once...
  call npm install --no-fund --no-audit
)
if not exist config.json (
  set /p TTUSER=Your TikTok username, without @: 
  call node live-bridge.mjs %%TTUSER%%
) else (
  node live-bridge.mjs
)
pause
