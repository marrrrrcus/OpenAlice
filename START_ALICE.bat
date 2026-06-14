@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM ==================================================================
REM  OpenAlice one-click launcher
REM  Starts: UTA + Alice + Vite (via pnpm dev) and the self-contained
REM  OKX market-snapshot writer (services\okx_snapshot_writer.py).
REM  Everything runs from this folder - no dependency on any other
REM  project. The snapshot writer reads OKX creds from .env and writes
REM  data\market-snapshot.json.
REM ==================================================================

set "APP_DIR=%~dp0"
set "NO_PAUSE="
if /i "%~1"=="--no-pause" set "NO_PAUSE=1"

cd /d "%APP_DIR%" || (
  echo [ERROR] Cannot enter OpenAlice directory: %APP_DIR%
  pause
  exit /b 1
)

echo.
echo ==================================================
echo  OpenAlice startup
echo ==================================================
for /f "delims=" %%B in ('git branch --show-current 2^>nul') do set "BRANCH=%%B"
if not defined BRANCH set "BRANCH=unknown"
echo Directory: %CD%
echo Branch: %BRANCH%
echo.

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm not found on PATH.
  call :maybe_pause
  exit /b 1
)

if not exist "package.json" (
  echo [ERROR] package.json not found. This script must live in the OpenAlice root directory.
  call :maybe_pause
  exit /b 1
)

REM --- OKX market-snapshot writer (self-contained) ---------------------------
REM The writer is independent of Alice, so ensure it FIRST before the
REM "Alice already running -> just open the browser" early-exit below, so a
REM dead writer always gets restarted regardless of Alice's state. Ensure
REM semantics: leave a healthy writer alone, start one only if none is running
REM (no needless bounce). It reads .env and writes data\market-snapshot.json;
REM PYTHONUTF8 avoids the Windows cp1252 console crash.
echo [1/4] Ensuring OKX snapshot writer is running...
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%scripts\start-okx-snapshot-writer.ps1"
if errorlevel 1 (
  echo [ERROR] Failed to start OKX snapshot writer.
  call :maybe_pause
  exit /b 1
)
echo.

echo [2/4] Checking dev ports...
REM "Already running" requires ALL FOUR ports up. Checking for ANY port was a
REM bug: UTA (47333) stays listening even when the Alice backend (47331)
REM crashes, so a partial/broken stack would be misread as "already running"
REM and never get restarted.  exit 10 = all healthy, 11 = partial, 0 = none.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ports = 47331,47332,47333,5173; $up = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | Select-Object -ExpandProperty LocalPort -Unique); if ($up.Count -eq $ports.Count) { exit 10 } elseif ($up.Count -gt 0) { Write-Host ('       up: ' + ($up -join ', ') + '  |  down: ' + (($ports | Where-Object { $up -notcontains $_ }) -join ', ')); exit 11 }"
set "PORT_STATUS=%ERRORLEVEL%"
if "%PORT_STATUS%"=="10" goto :already_running
if "%PORT_STATUS%"=="11" goto :partial_running
if errorlevel 1 (
  echo [WARN] Could not verify ports. Continuing startup...
)

echo.
echo [3/4] Building workspace packages (needed on first run)...
call :build_package "@traderalice/ibkr" "packages\ibkr\dist\index.js"
if errorlevel 1 exit /b 1
call :verify_ibkr_exports
if errorlevel 1 exit /b 1
call :build_package "@traderalice/uta-protocol" "packages\uta-protocol\dist\index.js"
if errorlevel 1 exit /b 1
echo Done.
echo.

echo [4/4] Starting Alice (UTA + Alice + Vite)...
echo       Port 47331 - Alice
echo       Port 47332 - MCP
echo       Port 47333 - UTA
echo       Port 5173  - UI
echo.

pnpm dev
set "EXIT_CODE=%ERRORLEVEL%"

endlocal
exit /b %EXIT_CODE%

:already_running
echo.
echo [INFO] Alice already appears to be running (all ports healthy).
echo        UI:      http://localhost:5173/
echo        Backend: http://127.0.0.1:47331/
echo        UTA:     http://127.0.0.1:47333/
echo.
echo [INFO] Opening the Alice UI in your browser...
start "" "http://localhost:5173/"
call :maybe_pause
exit /b 0

:partial_running
echo.
echo [WARN] Alice is in a PARTIAL / unhealthy state - some ports are up, some are down.
echo        This usually means the backend crashed while UTA/UI stayed alive.
echo        Close EVERY Alice window (the pnpm dev terminal + any leftover
echo        UTA/writer windows), then run this file again for a clean start.
call :maybe_pause
exit /b 1

:build_package
set "PKG=%~1"
set "DIST_FILE=%~2"

if exist "%DIST_FILE%" (
  echo   [OK] %PKG% already built
  exit /b 0
)

echo   [build] %PKG%
pnpm --filter %PKG% exec tsc
if errorlevel 1 (
  echo [ERROR] Failed to build %PKG%.
  call :maybe_pause
  exit /b 1
)

if not exist "%DIST_FILE%" (
  echo [ERROR] %PKG% build completed but %DIST_FILE% is still missing.
  call :maybe_pause
  exit /b 1
)
exit /b 0

:verify_ibkr_exports
node --input-type=module -e "import('@traderalice/ibkr').then(m=>process.exit(typeof m.coerceSecType==='function'?0:2)).catch(()=>process.exit(2))" >nul 2>nul
if errorlevel 1 (
  echo   [build] @traderalice/ibkr stale dist detected; rebuilding
  pnpm --filter @traderalice/ibkr exec tsc
  if errorlevel 1 (
    echo [ERROR] Failed to rebuild @traderalice/ibkr.
    call :maybe_pause
    exit /b 1
  )
  node --input-type=module -e "import('@traderalice/ibkr').then(m=>process.exit(typeof m.coerceSecType==='function'?0:2)).catch(()=>process.exit(2))" >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] @traderalice/ibkr built, but coerceSecType is still unavailable.
    call :maybe_pause
    exit /b 1
  )
)
echo   [OK] @traderalice/ibkr exports verified
exit /b 0

:maybe_pause
if not defined NO_PAUSE pause
exit /b 0
