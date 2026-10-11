param([int]$ControlPort = 47680)
$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RuntimePath = Join-Path $ProjectRoot ".devpilot-runtime\runtime.json"
$ControlUrl = "http://127.0.0.1:$ControlPort"
try { Invoke-RestMethod -Uri "$ControlUrl/devpilot/api/services/stop" -Method Post -Headers @{"x-devpilot-control"="1"} -TimeoutSec 12 | Out-Null } catch {}
$runtime = $null
if (Test-Path $RuntimePath) { try { $runtime = Get-Content -Raw -Encoding UTF8 $RuntimePath | ConvertFrom-Json } catch {} }
$supervisorPid = $null
if ($runtime) {
  if ($runtime.supervisorPid) { $supervisorPid = [int]$runtime.supervisorPid }
  elseif ($runtime.pid) { $supervisorPid = [int]$runtime.pid }
}
if ($supervisorPid) {
  try {
    Stop-Process -Id $supervisorPid -Force -ErrorAction Stop
    Write-Host "Stopped DevPilot supervisor PID $supervisorPid." -ForegroundColor Green
  } catch {}
}
Remove-Item $RuntimePath -Force -ErrorAction SilentlyContinue
