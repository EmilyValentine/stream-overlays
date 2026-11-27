@echo off
title LIVE Fest rank probe
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org then run this again.
  pause
  exit /b 1
)
if not exist tiktool-key.txt (
  echo You need a free TikTool API key first.
  echo 1. Sign up at https://tik.tools and copy your API key
  echo 2. Paste it below. It is saved to tiktool-key.txt in this folder and never uploaded to GitHub.
  set /p TTKEY=API key:
  call echo %%TTKEY%%> tiktool-key.txt
)
set /p TTUSER=Your TikTok username (without @):
node rank-probe.mjs %TTUSER% 15
pause
