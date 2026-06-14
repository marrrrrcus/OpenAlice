@echo off
setlocal EnableExtensions

set "APP_DIR=%~dp0.."
cd /d "%APP_DIR%" || (
  echo [ERROR] Cannot enter OpenAlice directory: %APP_DIR%
  pause
  exit /b 1
)

title OpenAlice OKX Snapshot Writer
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

echo ==================================================
echo  OpenAlice OKX Snapshot Writer
echo ==================================================
echo Directory: %CD%
echo Script:    %CD%\services\okx_snapshot_writer.py
echo.
echo Keep this window open. Closing it stops market-snapshot updates.
echo.

python "%CD%\services\okx_snapshot_writer.py"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo [ERROR] OKX snapshot writer exited with code %EXIT_CODE%.
echo Check logs\okx_snapshot.log for details.
pause
exit /b %EXIT_CODE%
