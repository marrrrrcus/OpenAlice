@echo off
setlocal EnableExtensions
title OKX Snapshot Writer

REM ==================================================================
REM  OKX market-snapshot writer (Open Alice, self-contained)
REM  Runs the writer IN THIS WINDOW (not detached) so it reliably stays
REM  alive as long as the window is open. Writes data\market-snapshot.json
REM  every 5 minutes. Keep this window open; close it to stop the writer.
REM ==================================================================

cd /d "%~dp0"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

echo ==================================================
echo  OKX Snapshot Writer  (Open Alice)
echo  Output: data\market-snapshot.json  (every 5 min)
echo  Log:    logs\okx_snapshot.log
echo.
echo  Keep this window open. Close it to stop the writer.
echo ==================================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] python not found on PATH.
  pause
  exit /b 1
)

python "%~dp0services\okx_snapshot_writer.py"

echo.
echo [writer stopped] exit code %ERRORLEVEL%
echo If this was unexpected, check logs\okx_snapshot.log for the reason.
pause
