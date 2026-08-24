param(
  [int]$ControlPort = 0
)

$ErrorActionPreference = "SilentlyContinue"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RuntimeDir = Join-Path $ProjectRoot ".devpilot-runtime"
$RuntimePath = Join-Path $RuntimeDir "runtime.json"
$InfoPath = Join-Path $ProjectRoot "DevPilot-connection.txt"

$runtime = $null
if (Test-Path $RuntimePath) {
  try { $runtime = Get-Content -Raw -Encoding UTF8 $RuntimePath | ConvertFrom-Json } catch {}
}

$effectiveControlPort = if ($ControlPort -gt 0) {
  $ControlPort
} elseif ($runtime -and $runtime.controlPort) {
  [int]$runtime.controlPort
} else {
  7680
}

$mcpPort = if ($runtime -and $runtime.mcpPort) {
  [int]$runtime.mcpPort
} else {
  7681
}

$tunnelProvider = if ($runtime -and $runtime.tunnelProvider) {
  [string]$runtime.tunnelProvider
} else {
  "unknown"
}

$ControlUrl = "http://127.0.0.1:$effectiveControlPort"

Write-Host "Stopping DevPilot services..." -ForegroundColor Yellow
Write-Host "MCP port       : $mcpPort"
Write-Host "Control port   : $effectiveControlPort"
Write-Host "Tunnel provider: $tunnelProvider"

try {
  Invoke-RestMethod -Uri "$ControlUrl/devpilot/api/services/stop" -Method Post -Headers @{ "x-devpilot-control" = "1" } -TimeoutSec 8 | Out-Null
} catch {}

$supervisorPid = $null
if ($runtime -and $runtime.supervisorPid) {
  $supervisorPid = [int]$runtime.supervisorPid
} else {
  $listener = Get-NetTCPConnection -LocalPort $effectiveControlPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $candidatePid = [int]$listener.OwningProcess
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $candidatePid" -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.CommandLine -match 'devpilot-cli\.js') {
      $supervisorPid = $candidatePid
    }
  }
}

if ($supervisorPid) {
  $process = Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $supervisorPid -Force -ErrorAction SilentlyContinue
  }
}

Remove-Item $RuntimePath -Force -ErrorAction SilentlyContinue
Remove-Item $InfoPath -Force -ErrorAction SilentlyContinue

Write-Host "DevPilot stopped." -ForegroundColor Green
Write-Host "Only the DevPilot instance recorded in its runtime state was targeted."
