param(
  [ValidateSet("cloudflare-quick", "openai-secure")]
  [string]$TunnelProvider,
  [int]$McpPort = 7681,
  [int]$ControlPort = 7680,
  [int]$TunnelHealthPort = 7683,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ConfigDir = Join-Path $ProjectRoot ".devpilot-config"
$RuntimeDir = Join-Path $ProjectRoot ".devpilot-runtime"
$ToolsDir = Join-Path $ProjectRoot "tools"
$ConfigPath = Join-Path $ConfigDir "config.json"
$AuthPath = Join-Path $ConfigDir "auth.json"
$TunnelConfigPath = Join-Path $ConfigDir "openai-tunnel.json"
$RuntimePath = Join-Path $RuntimeDir "runtime.json"
$InfoPath = Join-Path $ProjectRoot "DevPilot-connection.txt"
$StdoutPath = Join-Path $RuntimeDir "devpilot.out.log"
$StderrPath = Join-Path $RuntimeDir "devpilot.err.log"
$PanelUrl = "http://127.0.0.1:$McpPort/devpilot/"
$ControlUrl = "http://127.0.0.1:$ControlPort"
$TunnelHealthUrl = "http://127.0.0.1:$TunnelHealthPort"

New-Item -ItemType Directory -Force -Path $ConfigDir, $RuntimeDir, $ToolsDir | Out-Null

function Get-JsonFile([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  try { return Get-Content -Raw -Encoding UTF8 $Path | ConvertFrom-Json } catch { return $null }
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function New-OwnerToken {
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  } finally {
    $rng.Dispose()
  }
}

function Get-CloudflaredPath {
  $candidates = @(
    (Join-Path $ToolsDir "cloudflared.exe"),
    (Join-Path $HOME ".devspace\cloudflared.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
  }

  $command = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $target = Join-Path $ToolsDir "cloudflared.exe"
  Write-Host "cloudflared not found. Downloading official Windows amd64 build..." -ForegroundColor Yellow
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $target
  return $target
}

function Get-TunnelClientPath {
  $candidates = @(
    (Join-Path $ToolsDir "tunnel-client.exe"),
    (Join-Path $HOME ".devspace\tunnel-client.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
  }

  $command = Get-Command tunnel-client -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $target = Join-Path $ToolsDir "tunnel-client.exe"
  $archive = Join-Path $RuntimeDir "tunnel-client-windows-amd64.zip"
  $extract = Join-Path $RuntimeDir "tunnel-client-extract"
  $releaseApi = "https://api.github.com/repos/openai/tunnel-client/releases/latest"

  Write-Host "tunnel-client not found. Resolving latest official Windows amd64 release..." -ForegroundColor Yellow
  $headers = @{ "User-Agent" = "DevPilot"; "Accept" = "application/vnd.github+json" }
  $release = Invoke-RestMethod -UseBasicParsing -Headers $headers -Uri $releaseApi
  $asset = $release.assets | Where-Object {
    $_.name -match '^tunnel-client-(?:runtime-cloudflared-)?v.*-windows-amd64\.zip$'
  } | Select-Object -First 1
  if (-not $asset -or -not $asset.browser_download_url) {
    throw "Could not find a Windows amd64 zip in the latest openai/tunnel-client release."
  }

  $downloadUrl = [string]$asset.browser_download_url
  Write-Host ("Downloading tunnel-client " + [string]$release.tag_name + " from OpenAI GitHub...") -ForegroundColor Yellow
  Remove-Item $archive -Force -ErrorAction SilentlyContinue
  Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
  Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $downloadUrl -OutFile $archive
  Expand-Archive -Path $archive -DestinationPath $extract -Force
  $binary = Get-ChildItem -Path $extract -Filter "*.exe" -File -Recurse |
    Where-Object { $_.Name -match '^tunnel-client(?:-runtime-cloudflared)?\.exe$' } |
    Select-Object -First 1
  if (-not $binary) { throw "A tunnel-client executable was not found in the official release archive." }
  Copy-Item -Path $binary.FullName -Destination $target -Force
  Remove-Item $archive -Force -ErrorAction SilentlyContinue
  Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
  return $target
}

function Test-ControlApi {
  try {
    return Invoke-RestMethod -Uri "$ControlUrl/devpilot/api/status" -Method Get -TimeoutSec 1
  } catch {
    return $null
  }
}

function Select-TunnelProvider {
  $options = @(
    [pscustomobject]@{ Label = "Cloudflare Quick Tunnel"; Value = "cloudflare-quick" },
    [pscustomobject]@{ Label = "OpenAI Secure MCP Tunnel"; Value = "openai-secure" }
  )
  $selected = 0

  while ($true) {
    Clear-Host
    Write-Host "========================================" -ForegroundColor DarkGray
    Write-Host " DevPilot startup mode" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor DarkGray
    Write-Host "Use Up/Down arrows to select, Enter to start, Esc to cancel."
    Write-Host ""

    for ($i = 0; $i -lt $options.Count; $i++) {
      $prefix = if ($i -eq $selected) { ">" } else { " " }
      if ($i -eq $selected) {
        Write-Host ("{0} {1}" -f $prefix, $options[$i].Label) -ForegroundColor Black -BackgroundColor Cyan
      } else {
        Write-Host ("{0} {1}" -f $prefix, $options[$i].Label)
      }
    }

    Write-Host ""
    if ($selected -eq 0) {
      Write-Host "Public HTTPS MCP URL + OAuth. Best compatibility." -ForegroundColor DarkGray
    } else {
      Write-Host "OpenAI Tunnel ID + local secure-tunnel mode." -ForegroundColor DarkGray
    }

    $key = [Console]::ReadKey($true).Key
    switch ($key) {
      "UpArrow" {
        $selected = ($selected - 1 + $options.Count) % $options.Count
      }
      "DownArrow" {
        $selected = ($selected + 1) % $options.Count
      }
      "Enter" {
        Clear-Host
        return [string]$options[$selected].Value
      }
      "Escape" {
        Write-Host "Startup cancelled." -ForegroundColor Yellow
        exit 0
      }
    }
  }
}

if (-not $TunnelProvider) {
  $TunnelProvider = Select-TunnelProvider
}

Write-Host ("Selected mode : " + $TunnelProvider) -ForegroundColor Cyan

function Test-ProxyEndpoint([string]$ProxyUrl) {
  if (-not $ProxyUrl) { return $false }
  try {
    $uri = [Uri]$ProxyUrl
  } catch {
    return $false
  }
  if (-not $uri.Host -or $uri.Port -le 0) { return $false }
  if ($uri.Host -notin @("127.0.0.1", "localhost", "::1")) { return $true }

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $result = $client.BeginConnect($uri.Host, $uri.Port, $null, $null)
    if (-not $result.AsyncWaitHandle.WaitOne(300)) { return $false }
    $client.EndConnect($result)
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Find-LocalControlPlaneProxy {
  foreach ($port in @(10809, 10890, 7890, 7891, 7897, 1080)) {
    $candidate = "http://127.0.0.1:$port"
    if (Test-ProxyEndpoint $candidate) { return $candidate }
  }
  return $null
}

function Get-ActiveCodexChatgptWebTunnelId {
  $process = Get-Process -Name "tunnel-client" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path -like "*\.codex-chatgpt-web\bin\tunnel-client.exe" } |
    Select-Object -First 1
  if (-not $process) { return $null }

  $profilePath = Join-Path $HOME ".codex-chatgpt-web\tunnel\profiles\codex-chatgpt-web.yaml"
  if (-not (Test-Path $profilePath)) { return $null }
  $content = Get-Content -Raw -Encoding UTF8 $profilePath
  $match = [regex]::Match($content, '"tunnel_id"\s*:\s*"(tunnel_[0-9a-f]{32})"')
  if ($match.Success) { return $match.Groups[1].Value }
  return $null
}

$existing = Test-ControlApi
if ($existing -and $existing.server.status -eq "online") {
  if ($existing.tunnel.provider -eq $TunnelProvider) {
    Write-Host "DevPilot is already running." -ForegroundColor Green
    Write-Host "Panel      : $PanelUrl"
    if ($TunnelProvider -eq "cloudflare-quick") {
      Write-Host "Public MCP : $($existing.server.publicMcpUrl)"
      if ($existing.server.publicMcpUrl) { Set-Clipboard -Value $existing.server.publicMcpUrl }
    } else {
      Write-Host "Tunnel ID  : $($existing.tunnel.tunnelId)"
      Write-Host "Tunnel ready: $($existing.tunnel.ready)"
      if ($existing.tunnel.tunnelId) { Set-Clipboard -Value $existing.tunnel.tunnelId }
    }
    if (-not $NoOpen) { Start-Process $PanelUrl }
    exit 0
  }
  throw "DevPilot is already running with a different tunnel provider. Run the stop script, then start the requested mode."
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $nodeCommand -or -not $npmCommand) {
  throw "Node.js and npm are required. Install Node.js 22.19 or newer (but below 27), then run this launcher again."
}

if (-not (Test-Path (Join-Path $ProjectRoot "node_modules"))) {
  Write-Host "First run detected. Installing npm dependencies..." -ForegroundColor Cyan
  Push-Location $ProjectRoot
  try { & $npmCommand.Source install } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
}

$distCli = Join-Path $ProjectRoot "dist\devpilot-cli.js"
if (-not (Test-Path $distCli)) {
  Write-Host "Building DevPilot..." -ForegroundColor Cyan
  Push-Location $ProjectRoot
  try { & $npmCommand.Source run build } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw "DevPilot build failed." }
}

$existingConfig = Get-JsonFile $ConfigPath
$legacyConfig = Get-JsonFile (Join-Path $HOME ".devspace\config.json")
$roots = if ($existingConfig -and $existingConfig.allowedRoots -and $existingConfig.allowedRoots.Count -gt 0) {
  @($existingConfig.allowedRoots)
} elseif ($legacyConfig -and $legacyConfig.allowedRoots -and $legacyConfig.allowedRoots.Count -gt 0) {
  @($legacyConfig.allowedRoots)
} else {
  @($ProjectRoot)
}

$authMode = if ($TunnelProvider -eq "openai-secure") { "secure-tunnel" } else { "oauth" }
$config = [ordered]@{
  host = "127.0.0.1"
  port = $McpPort
  allowedRoots = $roots
  publicBaseUrl = "http://127.0.0.1:$McpPort"
  authMode = $authMode
  toolMode = "full"
  widgets = "off"
  subagents = $false
}
Write-Utf8NoBom $ConfigPath (($config | ConvertTo-Json -Depth 8) + [Environment]::NewLine)

$auth = Get-JsonFile $AuthPath
$legacyAuth = Get-JsonFile (Join-Path $HOME ".devspace\auth.json")
$ownerToken = if ($auth -and $auth.ownerToken) {
  [string]$auth.ownerToken
} elseif ($legacyAuth -and $legacyAuth.ownerToken) {
  [string]$legacyAuth.ownerToken
} else {
  New-OwnerToken
}
Write-Utf8NoBom $AuthPath ((([ordered]@{ ownerToken = $ownerToken }) | ConvertTo-Json) + [Environment]::NewLine)

$node = (Get-Command node -ErrorAction Stop).Source
$env:DEVSPACE_CONFIG_DIR = $ConfigDir
$env:HOST = "127.0.0.1"
$env:PORT = [string]$McpPort
$env:DEVSPACE_PUBLIC_BASE_URL = "http://127.0.0.1:$McpPort"
$env:DEVSPACE_AUTH_MODE = $authMode
$env:DEVSPACE_TOOL_MODE = "full"
$env:DEVSPACE_WIDGETS = "off"
$env:DEVSPACE_SUBAGENTS = "0"
$env:DEVPILOT_CONTROL_HOST = "127.0.0.1"
$env:DEVPILOT_CONTROL_PORT = [string]$ControlPort
$env:DEVPILOT_TUNNEL_PROVIDER = $TunnelProvider
$env:DEVPILOT_AUTOSTART = "1"

$tunnelId = $null
$controlPlaneProxy = $null
$arguments = @()

if ($TunnelProvider -eq "cloudflare-quick") {
  $cloudflared = Get-CloudflaredPath
  $env:DEVPILOT_CLOUDFLARED = $cloudflared
  $arguments = @(
    $distCli,
    "--control-port", [string]$ControlPort,
    "--tunnel", "cloudflare-quick",
    "--cloudflared", $cloudflared,
    "--autostart"
  )
} else {
  $tunnelConfig = Get-JsonFile $TunnelConfigPath
  if (-not $tunnelConfig -or -not $tunnelConfig.tunnelId) {
    throw "Missing OpenAI Secure MCP Tunnel config: $TunnelConfigPath"
  }

  $tunnelId = [string]$tunnelConfig.tunnelId
  $runtimeApiKey = if ($tunnelConfig.runtimeApiKey) { [string]$tunnelConfig.runtimeApiKey } elseif ($tunnelConfig.apiKey) { [string]$tunnelConfig.apiKey } else { "" }
  if (-not $runtimeApiKey) {
    throw "OpenAI Secure MCP Tunnel runtime API key is missing from $TunnelConfigPath"
  }
  if ($tunnelId -notmatch '^tunnel_[0-9a-f]{32}$') {
    throw "Invalid Tunnel ID format. Expected tunnel_ followed by 32 lowercase hex characters."
  }

  $codexTunnelId = Get-ActiveCodexChatgptWebTunnelId
  if ($codexTunnelId -and $codexTunnelId -eq $tunnelId) {
    throw "Tunnel ID $tunnelId is already used by the active codex-chatgpt-web tunnel-client. Configure a separate Tunnel ID for DevPilot to avoid queue and MCP session conflicts."
  }

  $configuredProxy = if ($tunnelConfig.controlPlaneProxy) {
    [string]$tunnelConfig.controlPlaneProxy
  } elseif ($env:DEVPILOT_OPENAI_CONTROL_PLANE_PROXY) {
    [string]$env:DEVPILOT_OPENAI_CONTROL_PLANE_PROXY
  } elseif ($env:CONTROL_PLANE_HTTP_PROXY) {
    [string]$env:CONTROL_PLANE_HTTP_PROXY
  } else {
    $null
  }

  $controlPlaneProxy = $configuredProxy
  if ($configuredProxy -and -not (Test-ProxyEndpoint $configuredProxy)) {
    Write-Host "Configured control-plane proxy is not reachable: $configuredProxy" -ForegroundColor Yellow
    $controlPlaneProxy = $null
  }
  if (-not $controlPlaneProxy) {
    $detectedProxy = Find-LocalControlPlaneProxy
    if ($detectedProxy) {
      $controlPlaneProxy = $detectedProxy
      Write-Host "Using detected local control-plane proxy: $controlPlaneProxy" -ForegroundColor Cyan
    } else {
      Write-Host "No local control-plane proxy detected. OpenAI tunnel-client will use direct network access." -ForegroundColor Yellow
    }
  }

  $tunnelClient = Get-TunnelClientPath
  $env:DEVPILOT_OPENAI_TUNNEL_CLIENT = $tunnelClient
  $env:DEVPILOT_OPENAI_TUNNEL_ID = $tunnelId
  $env:DEVPILOT_OPENAI_TUNNEL_API_KEY = $runtimeApiKey
  $env:DEVPILOT_OPENAI_TUNNEL_HEALTH_ADDR = "127.0.0.1:$TunnelHealthPort"
  if ($controlPlaneProxy) {
    $env:CONTROL_PLANE_HTTP_PROXY = $controlPlaneProxy
    $env:DEVPILOT_OPENAI_CONTROL_PLANE_PROXY = $controlPlaneProxy
  }

  $arguments = @(
    $distCli,
    "--control-port", [string]$ControlPort,
    "--tunnel", "openai-secure",
    "--tunnel-client", $tunnelClient,
    "--tunnel-id", $tunnelId,
    "--tunnel-health-addr", "127.0.0.1:$TunnelHealthPort",
    "--autostart"
  )
}

if ($arguments.Count -eq 0 -or @($arguments | Where-Object { $null -eq $_ -or [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0) {
  throw "DevPilot launcher built an invalid argument list. Check the selected tunnel provider configuration."
}

Remove-Item $StdoutPath, $StderrPath -Force -ErrorAction SilentlyContinue
$process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $ProjectRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath

$status = $null
for ($i = 0; $i -lt 200; $i++) {
  Start-Sleep -Milliseconds 250
  if ($process.HasExited) {
    $errorText = if (Test-Path $StderrPath) { Get-Content -Raw -Encoding UTF8 $StderrPath } else { "" }
    throw "DevPilot failed to start. $errorText"
  }

  $status = Test-ControlApi
  if (-not $status -or $status.server.status -ne "online" -or $status.tunnel.provider -ne $TunnelProvider) { continue }
  if ($TunnelProvider -eq "cloudflare-quick" -and $status.server.publicEndpointConfigured) { break }
  if ($TunnelProvider -eq "openai-secure" -and $status.tunnel.ready) { break }
}

$ready = $status -and $status.server.status -eq "online" -and $status.tunnel.provider -eq $TunnelProvider
if ($TunnelProvider -eq "cloudflare-quick") {
  $ready = $ready -and $status.server.publicEndpointConfigured
} else {
  $ready = $ready -and $status.tunnel.ready
}

if (-not $ready) {
  try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
  $errorText = if (Test-Path $StderrPath) { Get-Content -Raw -Encoding UTF8 $StderrPath } else { "" }
  throw "$TunnelProvider or DevSpace did not become ready. $errorText"
}

if ($TunnelProvider -eq "openai-secure") {
  try {
    $readyResponse = Invoke-WebRequest -UseBasicParsing -Uri "$TunnelHealthUrl/readyz" -TimeoutSec 3
    if ($readyResponse.StatusCode -ne 200) { throw "readyz=$($readyResponse.StatusCode)" }
  } catch {
    throw "tunnel-client started but /readyz failed: $($_.Exception.Message)"
  }
}

$publicMcp = if ($TunnelProvider -eq "cloudflare-quick") { [string]$status.server.publicMcpUrl } else { "tunnel:$tunnelId" }
$runtime = [ordered]@{
  supervisorPid = $process.Id
  mcpPort = $McpPort
  controlPort = $ControlPort
  panelUrl = $PanelUrl
  publicMcpUrl = $publicMcp
  tunnelProvider = $TunnelProvider
  tunnelId = $tunnelId
  tunnelHealthPort = if ($TunnelProvider -eq "openai-secure") { $TunnelHealthPort } else { $null }
  controlPlaneProxy = $controlPlaneProxy
  configDir = $ConfigDir
  startedAt = (Get-Date).ToString("o")
  stdoutLog = $StdoutPath
  stderrLog = $StderrPath
}
Write-Utf8NoBom $RuntimePath (($runtime | ConvertTo-Json -Depth 6) + [Environment]::NewLine)

if ($TunnelProvider -eq "cloudflare-quick") {
  $clipboardValue = [string]$status.server.publicMcpUrl
  $info = @"
DevPilot is running.

Mode: Cloudflare Quick Tunnel
Panel: $PanelUrl
Local MCP: http://127.0.0.1:$McpPort/mcp
Public MCP: $clipboardValue

Config: $ConfigDir
Runtime: $RuntimePath
Logs: $RuntimeDir
"@
} else {
  $clipboardValue = $tunnelId
  $proxyLine = if ($controlPlaneProxy) { $controlPlaneProxy } else { "direct" }
  $info = @"
DevPilot is running.

Mode: OpenAI Secure MCP Tunnel
Panel: $PanelUrl
Local MCP: http://127.0.0.1:$McpPort/mcp
Tunnel ID: $tunnelId
Tunnel UI: $TunnelHealthUrl/ui
Control plane proxy: $proxyLine

Config: $ConfigDir
Runtime: $RuntimePath
Logs: $RuntimeDir
"@
}
Write-Utf8NoBom $InfoPath ($info + [Environment]::NewLine)
Set-Clipboard -Value $clipboardValue

Write-Host ""
Write-Host "========================================" -ForegroundColor DarkGray
Write-Host " DevPilot started" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor DarkGray
Write-Host "Panel       : $PanelUrl"
Write-Host "Local MCP   : http://127.0.0.1:$McpPort/mcp"
if ($TunnelProvider -eq "cloudflare-quick") {
  Write-Host "Mode        : Cloudflare Quick Tunnel"
  Write-Host "Public MCP  : $clipboardValue" -ForegroundColor Cyan
  Write-Host "Clipboard   : Public MCP URL"
} else {
  Write-Host "Mode        : OpenAI Secure MCP Tunnel"
  Write-Host "Tunnel ID   : $tunnelId" -ForegroundColor Cyan
  Write-Host "Tunnel UI   : $TunnelHealthUrl/ui"
  Write-Host "CP proxy    : $(if ($controlPlaneProxy) { $controlPlaneProxy } else { 'direct' })"
  Write-Host "Clipboard   : Tunnel ID"
}
Write-Host "Tunnel state: READY"
Write-Host "Config      : $ConfigDir"
Write-Host "Connection  : $InfoPath"
Write-Host "Stop        : double-click the DevPilot stop script"

if (-not $NoOpen) { Start-Process $PanelUrl }
