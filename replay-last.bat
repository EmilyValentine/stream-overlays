@echo off
title Replay last stream (overlay testing)
cd /d "%~dp0"
if not exist sessions (
  echo No recorded sessions yet. Run start-live.bat during a stream first.
  pause
  exit /b 1
)
for /f "delims=" %%f in ('dir /b /o-d sessions\*.jsonl') do (
  set LAST=%%f
  goto found
)
:found
echo Replaying sessions\%LAST% at 5x speed. Open your overlays or http://localhost:3000/control to watch.
node live-bridge.mjs --replay sessions\%LAST% --speed 5
pause
