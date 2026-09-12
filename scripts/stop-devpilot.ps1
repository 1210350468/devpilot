param([int]$ControlPort = 47680)
$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RuntimePath = Join-Path $ProjectRoot ".devpilot-runtime\runtime.json"
$ControlUrl = "http://127.0.0.1:$ControlPort"
try { Invoke-RestMethod -Uri "$ControlUrl/devpilot/api/services/stop" -Method Post -Headers @{"x-devpilot-control"="1"} -TimeoutSec 12 | Out-Null } catch {}
$runtime = $null
if (Test-Path $RuntimePath) { try { $runtime = Get-Content -Raw -Encoding UTF8 $RuntimePath | ConvertFrom-Json } catch {} }
if ($runtime -and $runtime.pid) { try { Stop-Process -Id ([int]$runtime.pid) -Force -ErrorAction Stop; Write-Host "Stopped DevPilot supervisor PID $($runtime.pid)." -ForegroundColor Green } catch {} }
Remove-Item $RuntimePath -Force -ErrorAction SilentlyContinue
