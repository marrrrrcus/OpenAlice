$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$writerPath = Join-Path $repoRoot "services\okx_snapshot_writer.py"
$runnerPath = Join-Path $repoRoot "scripts\run-okx-snapshot-writer.bat"

if (-not (Test-Path -LiteralPath $writerPath)) {
  Write-Host "[ERROR] OKX snapshot writer not found: $writerPath"
  exit 1
}
if (-not (Test-Path -LiteralPath $runnerPath)) {
  Write-Host "[ERROR] OKX snapshot writer runner not found: $runnerPath"
  exit 1
}

$target = [System.IO.Path]::GetFullPath($writerPath).Replace("/", "\").ToLowerInvariant()
$processes = @(
  Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*okx_snapshot_writer*" -or $_.CommandLine -like "*run-okx-snapshot-writer*" }
)

$openAliceProcesses = @()
foreach ($process in $processes) {
  $commandLine = [string]$process.CommandLine
  $normalized = $commandLine.Replace("/", "\").ToLowerInvariant()
  if ($process.Name -like "python*" -and $normalized -like ("*" + $target + "*")) {
    $openAliceProcesses += $process
    continue
  }

  Write-Host "[INFO] Stopping stale/non-OpenAlice snapshot writer process pid=$($process.ProcessId)"
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

if ($openAliceProcesses.Count -gt 0) {
  Write-Host "[OK] OpenAlice OKX snapshot writer already running."
  exit 0
}

Write-Host "[INFO] Starting OpenAlice OKX snapshot writer in a dedicated terminal..."
Start-Process `
  -FilePath $runnerPath `
  -WorkingDirectory $repoRoot `
  -WindowStyle Minimized `
  | Out-Null

Start-Sleep -Seconds 8
$started = @(
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -like "python*" -and
      ([string]$_.CommandLine).Replace("/", "\").ToLowerInvariant() -like ("*" + $target + "*")
    }
)

if ($started.Count -lt 1) {
  Write-Host "[ERROR] OKX snapshot writer did not stay running. Check logs\okx_snapshot.log."
  exit 1
}
if ($started.Count -gt 1) {
  foreach ($extra in $started | Select-Object -Skip 1) {
    Write-Host "[INFO] Stopping duplicate OpenAlice snapshot writer pid=$($extra.ProcessId)"
    Stop-Process -Id $extra.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "[OK] OpenAlice OKX snapshot writer running pid=$($started[0].ProcessId)."
exit 0
