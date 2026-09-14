param(
  [int]$McpPort = 47681,
  [int]$ControlPort = 47680,
  [int]$TunnelHealthPort = 47683,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ConfigDir = Join-Path $ProjectRoot ".devpilot-config"
$RuntimeDir = Join-Path $ProjectRoot ".devpilot-runtime"
$ConfigPath = Join-Path $ConfigDir "config.jsonc"
$AuthPath = Join-Path $ConfigDir "auth.json"
$RuntimePath = Join-Path $RuntimeDir "runtime.json"
$StdoutPath = Join-Path $RuntimeDir "devpilot.out.log"
$StderrPath = Join-Path $RuntimeDir "devpilot.err.log"
$ControlUrl = "http://127.0.0.1:$ControlPort"
$PanelUrl = "$ControlUrl/devpilot/"
$LocalTunnelConfig = Join-Path $ConfigDir "openai-tunnel.json"
$LocalTunnelClient = Join-Path $ProjectRoot "tools\tunnel-client.exe"
$ConfiguredTunnelConfig = $env:DEVPILOT_OPENAI_TUNNEL_CONFIG
$ConfiguredTunnelClient = $env:DEVPILOT_OPENAI_TUNNEL_CLIENT

New-Item -ItemType Directory -Force -Path $ConfigDir, $RuntimeDir, (Join-Path $ProjectRoot "tools") | Out-Null

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}
function New-OwnerToken {
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $bytes = New-Object byte[] 32; $rng.GetBytes($bytes); return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_') } finally { $rng.Dispose() }
}
function Read-Json([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  try { return Get-Content -Raw -Encoding UTF8 $Path | ConvertFrom-Json } catch { return $null }
}
function Test-Port([int]$Port) {
  $client = $null
  try { $client = New-Object System.Net.Sockets.TcpClient; $result = $client.BeginConnect("127.0.0.1", $Port, $null, $null); if (-not $result.AsyncWaitHandle.WaitOne(250)) { return $false }; $client.EndConnect($result); return $client.Connected } catch { return $false } finally { if ($client) { $client.Close() } }
}

if (Test-Port $ControlPort) {
  try {
    $status = Invoke-RestMethod -Uri "$ControlUrl/devpilot/api/status" -Method Get -TimeoutSec 1
    if ($status.product -eq "DevPilot") {
      Write-Host "DevPilot upstream-first is already running." -ForegroundColor Green
      Write-Host "Control Center: $PanelUrl"
      if (-not $NoOpen) { Start-Process $PanelUrl }
      exit 0
    }
  } catch {}
  throw "Port $ControlPort is already in use by another process."
}

if (-not (Test-Path $ConfigPath)) {
  $stateDir = (Join-Path $RuntimeDir "state").Replace('\','\\')
  $worktreeRoot = (Join-Path $RuntimeDir "worktrees").Replace('\','\\')
  $defaultRoot = (Split-Path -Parent $ProjectRoot).Replace('\','\\')
  $config = @"
{
  "configVersion": 1,
  "server": { "host": "127.0.0.1", "port": $McpPort, "publicBaseUrl": "http://127.0.0.1:$McpPort", "allowedHosts": [], "trustProxy": false },
  "workspaces": { "allowedRoots": ["$defaultRoot"], "worktreeRoot": "$worktreeRoot" },
  "storage": { "stateDir": "$stateDir" },
  "tools": { "mode": "codex" },
  "ui": { "enabled": true },
  "artifacts": { "enabled": true, "maxFileBytes": 104857600 },
  "skills": { "enabled": true, "paths": [], "agentDir": "~/.codex" },
  "subagents": { "enabled": false, "instructions": "on-demand", "providers": [] },
  "logging": { "level": "info", "format": "json", "requests": true, "assets": false, "toolCalls": true, "shellCommands": false },
  "oauth": { "accessTokenTtlSeconds": 3600, "refreshTokenTtlSeconds": 2592000, "scopes": ["devspace"], "allowedResourceUrls": [], "allowedRedirectHosts": ["chatgpt.com", "localhost", "127.0.0.1"] }
}
"@
  Write-Utf8NoBom $ConfigPath ($config.Trim() + [Environment]::NewLine)
}
if (-not (Test-Path $AuthPath)) { Write-Utf8NoBom $AuthPath ((@{ ownerToken = (New-OwnerToken) } | ConvertTo-Json) + [Environment]::NewLine) }

$tunnelConfigPath = if ($ConfiguredTunnelConfig -and (Test-Path $ConfiguredTunnelConfig)) { (Resolve-Path $ConfiguredTunnelConfig).Path } elseif (Test-Path $LocalTunnelConfig) { $LocalTunnelConfig } else { $null }
if (-not $tunnelConfigPath) { throw "OpenAI tunnel config was not found. Put openai-tunnel.json in $ConfigDir or set DEVPILOT_OPENAI_TUNNEL_CONFIG." }
$tunnel = Read-Json $tunnelConfigPath
$TunnelId = [string]$tunnel.tunnelId
$RuntimeKey = [string]$tunnel.runtimeApiKey
$Proxy = [string]$tunnel.controlPlaneProxy
if (-not $TunnelId -or -not $RuntimeKey) { throw "Tunnel config is missing tunnelId or runtimeApiKey." }

$TunnelClient = $null
foreach ($candidate in @($ConfiguredTunnelClient, $LocalTunnelClient)) {
  if ($candidate -and (Test-Path $candidate)) { $TunnelClient = (Resolve-Path $candidate).Path; break }
}
if (-not $TunnelClient) { $command = Get-Command tunnel-client -ErrorAction SilentlyContinue; if ($command) { $TunnelClient = $command.Source } }
if (-not $TunnelClient) { throw "tunnel-client was not found. Put tunnel-client.exe in tools, add tunnel-client to PATH, or set DEVPILOT_OPENAI_TUNNEL_CLIENT." }

$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpm) { $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue }
if (-not $pnpm) { throw "pnpm is required." }
$distCli = Join-Path $ProjectRoot "dist\devpilot-cli.js"
if (-not (Test-Path $distCli)) { Push-Location $ProjectRoot; try { & $pnpm.Source build } finally { Pop-Location }; if ($LASTEXITCODE -ne 0) { throw "pnpm build failed." } }

$env:DEVSPACE_CONFIG_DIR = $ConfigDir
$env:DEVPILOT_CONTROL_HOST = "127.0.0.1"
$env:DEVPILOT_CONTROL_PORT = [string]$ControlPort
$env:DEVPILOT_TUNNEL_PROVIDER = "openai-secure"
$env:DEVPILOT_OPENAI_TUNNEL_CLIENT = $TunnelClient
$env:DEVPILOT_OPENAI_TUNNEL_ID = $TunnelId
$env:DEVPILOT_OPENAI_TUNNEL_API_KEY = $RuntimeKey
$env:DEVPILOT_OPENAI_TUNNEL_HEALTH_ADDR = "127.0.0.1:$TunnelHealthPort"
$env:DEVPILOT_AUTOSTART = "1"
if ($Proxy) { $env:DEVPILOT_OPENAI_CONTROL_PLANE_PROXY = $Proxy }

Remove-Item $StdoutPath, $StderrPath -Force -ErrorAction SilentlyContinue
$node = (Get-Command node.exe -ErrorAction Stop).Source
$process = Start-Process -FilePath $node -ArgumentList @($distCli) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -PassThru
Write-Utf8NoBom $RuntimePath ((@{ pid=$process.Id; startedAt=(Get-Date).ToString("o"); controlPort=$ControlPort; mcpPort=$McpPort; tunnelHealthPort=$TunnelHealthPort; projectRoot=$ProjectRoot } | ConvertTo-Json -Depth 4) + [Environment]::NewLine)

$deadline = (Get-Date).AddSeconds(40); $status = $null
while ((Get-Date) -lt $deadline) {
  if ($process.HasExited) { $detail = if (Test-Path $StderrPath) { Get-Content -Raw -Encoding UTF8 $StderrPath } else { "" }; throw "DevPilot exited during startup. $detail" }
  try { $status = Invoke-RestMethod -Uri "$ControlUrl/devpilot/api/status" -TimeoutSec 1; if ($status.server.status -eq "online" -and $status.tunnel.ready -eq $true) { break } } catch {}
  Start-Sleep -Milliseconds 400
}

if ($status -and $status.server.status -eq "online" -and $status.tunnel.ready -eq $true) { Write-Host "DevPilot upstream-first is READY." -ForegroundColor Green } else { Write-Host "DevPilot started but is not fully READY; inspect the Control Center." -ForegroundColor Yellow }
Write-Host "Control Center : $PanelUrl"
Write-Host "MCP            : http://127.0.0.1:$McpPort/mcp"
Write-Host "Tool surface   : codex"
if (-not $NoOpen) { Start-Process $PanelUrl }
