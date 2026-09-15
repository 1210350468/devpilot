param(
  [ValidateSet("cloudflare-quick", "openai-secure")]
  [string]$TunnelProvider,
  [int]$McpPort = 47681,
  [int]$ControlPort = 47680,
  [int]$TunnelHealthPort = 47683,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ConfigDir = Join-Path $ProjectRoot ".devpilot-config"
$RuntimeDir = Join-Path $ProjectRoot ".devpilot-runtime"
$ToolsDir = Join-Path $ProjectRoot "tools"
$ConfigPath = Join-Path $ConfigDir "config.jsonc"
$AuthPath = Join-Path $ConfigDir "auth.json"
$TunnelConfigPath = if ($env:DEVPILOT_OPENAI_TUNNEL_CONFIG) { $env:DEVPILOT_OPENAI_TUNNEL_CONFIG } else { Join-Path $ConfigDir "openai-tunnel.json" }
$RuntimePath = Join-Path $RuntimeDir "runtime.json"
$InfoPath = Join-Path $ProjectRoot "DevPilot-connection.txt"
$StdoutPath = Join-Path $RuntimeDir "devpilot.out.log"
$StderrPath = Join-Path $RuntimeDir "devpilot.err.log"
$ControlUrl = "http://127.0.0.1:$ControlPort"
$PanelUrl = "$ControlUrl/devpilot/"
$TunnelHealthUrl = "http://127.0.0.1:$TunnelHealthPort"
$LocalMcpUrl = "http://127.0.0.1:$McpPort/mcp"

New-Item -ItemType Directory -Force -Path $ConfigDir, $RuntimeDir, $ToolsDir | Out-Null

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Get-JsonFile([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  try { return Get-Content -Raw -Encoding UTF8 $Path | ConvertFrom-Json } catch { return $null }
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

function Test-Port([int]$Port) {
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $result = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $result.AsyncWaitHandle.WaitOne(300)) { return $false }
    $client.EndConnect($result)
    return $client.Connected
  } catch {
    return $false
  } finally {
    if ($client) { $client.Close() }
  }
}

function Test-ControlApi {
  try {
    return Invoke-RestMethod -Uri "$ControlUrl/devpilot/api/status" -Method Get -TimeoutSec 2
  } catch {
    return $null
  }
}

function Select-TunnelProvider {
  $options = @(
    [pscustomobject]@{ Label = "Cloudflare Quick Tunnel"; Value = "cloudflare-quick"; Help = "临时公网 MCP URL + OAuth，首次测试最直观" },
    [pscustomobject]@{ Label = "OpenAI Secure MCP Tunnel"; Value = "openai-secure"; Help = "固定 Tunnel ID，适合 ChatGPT 自定义 MCP / App" }
  )
  $selected = 1

  while ($true) {
    Clear-Host
    Write-Host "============================================================" -ForegroundColor DarkGray
    Write-Host " DevPilot · Upstream-first" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor DarkGray
    Write-Host "请选择连接模式：↑/↓ 选择，Enter 启动，Esc 取消" -ForegroundColor White
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
    Write-Host $options[$selected].Help -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "当前 Codex 工具面：open_workspace / read / show_changes / apply_patch / exec_command / write_stdin" -ForegroundColor DarkGray

    $key = [Console]::ReadKey($true).Key
    switch ($key) {
      "UpArrow" { $selected = ($selected - 1 + $options.Count) % $options.Count }
      "DownArrow" { $selected = ($selected + 1) % $options.Count }
      "Enter" { Clear-Host; return [string]$options[$selected].Value }
      "Escape" { Write-Host "已取消启动。" -ForegroundColor Yellow; exit 0 }
    }
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
  Write-Host "[准备] 未找到 cloudflared，正在下载 Cloudflare 官方 Windows amd64 版本..." -ForegroundColor Yellow
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $target
  return $target
}

function Get-TunnelClientPath {
  if ($env:DEVPILOT_OPENAI_TUNNEL_CLIENT -and (Test-Path $env:DEVPILOT_OPENAI_TUNNEL_CLIENT)) {
    return (Resolve-Path $env:DEVPILOT_OPENAI_TUNNEL_CLIENT).Path
  }
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
  Write-Host "[准备] 未找到 tunnel-client，正在解析 OpenAI 官方最新 Windows amd64 release..." -ForegroundColor Yellow
  $headers = @{ "User-Agent" = "DevPilot"; "Accept" = "application/vnd.github+json" }
  $release = Invoke-RestMethod -UseBasicParsing -Headers $headers -Uri "https://api.github.com/repos/openai/tunnel-client/releases/latest"
  $asset = $release.assets | Where-Object {
    $_.name -match '^tunnel-client-(?:runtime-cloudflared-)?v.*-windows-amd64\.zip$'
  } | Select-Object -First 1
  if (-not $asset -or -not $asset.browser_download_url) {
    throw "无法在 OpenAI tunnel-client 最新 release 中找到 Windows amd64 zip。"
  }
  Write-Host ("[准备] 下载 tunnel-client " + [string]$release.tag_name + " ...") -ForegroundColor Yellow
  Remove-Item $archive -Force -ErrorAction SilentlyContinue
  Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
  Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri ([string]$asset.browser_download_url) -OutFile $archive
  Expand-Archive -Path $archive -DestinationPath $extract -Force
  $binary = Get-ChildItem -Path $extract -Filter "*.exe" -File -Recurse |
    Where-Object { $_.Name -match '^tunnel-client(?:-runtime-cloudflared)?\.exe$' } |
    Select-Object -First 1
  if (-not $binary) { throw "下载包里没有找到 tunnel-client 可执行文件。" }
  Copy-Item -Path $binary.FullName -Destination $target -Force
  Remove-Item $archive -Force -ErrorAction SilentlyContinue
  Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
  return $target
}

function Test-ProxyEndpoint([string]$ProxyUrl) {
  if (-not $ProxyUrl) { return $false }
  try { $uri = [Uri]$ProxyUrl } catch { return $false }
  if (-not $uri.Host -or $uri.Port -le 0) { return $false }
  if ($uri.Host -notin @("127.0.0.1", "localhost", "::1")) { return $true }
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $result = $client.BeginConnect($uri.Host, $uri.Port, $null, $null)
    if (-not $result.AsyncWaitHandle.WaitOne(300)) { return $false }
    $client.EndConnect($result)
    return $client.Connected
  } catch { return $false } finally { $client.Close() }
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

function Wait-PortFree([int]$Port, [int]$TimeoutMs = 8000) {
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-Port $Port)) { return $true }
    Start-Sleep -Milliseconds 200
  }
  return -not (Test-Port $Port)
}

if (-not $TunnelProvider) { $TunnelProvider = Select-TunnelProvider }

Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host " DevPilot 正在启动" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host ("模式          : " + $(if ($TunnelProvider -eq "cloudflare-quick") { "Cloudflare Quick Tunnel" } else { "OpenAI Secure MCP Tunnel" }))
Write-Host "Control Center: $PanelUrl"
Write-Host "本地 MCP      : $LocalMcpUrl"
Write-Host "工具面        : codex (6 tools)"
Write-Host ""

$existing = Test-ControlApi
if ($existing -and $existing.supervisor.status -eq "online") {
  if ($existing.tunnel.provider -eq $TunnelProvider -and $existing.server.status -eq "online" -and $existing.tunnel.ready -eq $true) {
    Write-Host "[状态] DevPilot 已经运行且 Tunnel READY，无需重复启动。" -ForegroundColor Green
    $readyValue = if ($TunnelProvider -eq "cloudflare-quick") { [string]$existing.tunnel.publicMcpUrl } else { [string]$existing.tunnel.tunnelId }
    if ($readyValue) { Set-Clipboard -Value $readyValue }
    Write-Host ""
    Write-Host "Panel         : $PanelUrl"
    if ($TunnelProvider -eq "cloudflare-quick") {
      Write-Host "Public MCP    : $($existing.tunnel.publicMcpUrl)" -ForegroundColor Cyan
      Write-Host "Clipboard     : Public MCP URL"
    } else {
      Write-Host "Tunnel ID     : $($existing.tunnel.tunnelId)" -ForegroundColor Cyan
      Write-Host "Clipboard     : Tunnel ID"
    }
    if (-not $NoOpen) { Start-Process $PanelUrl }
    exit 0
  }

  if ($existing.tunnel.provider -eq $TunnelProvider) {
    Write-Host "[恢复] 检测到 Supervisor 存活但服务未 READY，正在尝试重启服务..." -ForegroundColor Yellow
    try {
      Invoke-RestMethod -Uri "$ControlUrl/devpilot/api/services/restart" -Method Post -Headers @{"x-devpilot-control"="1"} -TimeoutSec 40 | Out-Null
      Start-Sleep -Milliseconds 500
      $recovered = Test-ControlApi
      if ($recovered -and $recovered.server.status -eq "online" -and $recovered.tunnel.ready -eq $true) {
        Write-Host "[恢复] 服务已恢复 READY。" -ForegroundColor Green
        $readyValue = if ($TunnelProvider -eq "cloudflare-quick") { [string]$recovered.tunnel.publicMcpUrl } else { [string]$recovered.tunnel.tunnelId }
        if ($readyValue) { Set-Clipboard -Value $readyValue }
        if (-not $NoOpen) { Start-Process $PanelUrl }
        exit 0
      }
    } catch {
      Write-Host "[恢复] 原 Supervisor 无法恢复，将做干净重启：$($_.Exception.Message)" -ForegroundColor Yellow
    }
  } else {
    Write-Host "[切换] 当前运行模式为 $($existing.tunnel.provider)，正在切换到 $TunnelProvider ..." -ForegroundColor Yellow
  }

  try { Invoke-RestMethod -Uri "$ControlUrl/devpilot/api/services/stop" -Method Post -Headers @{"x-devpilot-control"="1"} -TimeoutSec 15 | Out-Null } catch {}
  if ($existing.supervisor.pid) { try { Stop-Process -Id ([int]$existing.supervisor.pid) -Force -ErrorAction SilentlyContinue } catch {} }
  if (-not (Wait-PortFree $ControlPort 8000)) { throw "旧 DevPilot Supervisor 没有释放端口 $ControlPort。" }
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
if (-not $node) { throw "未找到 Node.js。需要 Node.js >=22.19 且 <27。" }
$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpm) { $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue }
if (-not $pnpm) { throw "未找到 pnpm。请先安装 pnpm 11.25.0。" }

if (-not (Test-Path (Join-Path $ProjectRoot "node_modules"))) {
  Write-Host "[准备] 首次运行，安装依赖..." -ForegroundColor Cyan
  Push-Location $ProjectRoot
  try { & $pnpm.Source install --frozen-lockfile } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw "pnpm install --frozen-lockfile 失败。" }
}

$distCli = Join-Path $ProjectRoot "dist\devpilot-cli.js"
if (-not (Test-Path $distCli)) {
  Write-Host "[准备] 构建 DevPilot..." -ForegroundColor Cyan
  Push-Location $ProjectRoot
  try { & $pnpm.Source build } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw "pnpm build 失败。" }
}

if (-not (Test-Path $ConfigPath)) {
  $defaultRoot = (Split-Path $ProjectRoot -Parent).Replace('\','\\')
  $stateDir = (Join-Path $RuntimeDir "state").Replace('\','\\')
  $worktreeRoot = (Join-Path $RuntimeDir "worktrees").Replace('\','\\')
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
  Write-Host "[配置] 首次配置已创建。默认 allowed root: $(Split-Path $ProjectRoot -Parent)" -ForegroundColor Cyan
}
if (-not (Test-Path $AuthPath)) {
  Write-Utf8NoBom $AuthPath ((@{ ownerToken = (New-OwnerToken) } | ConvertTo-Json) + [Environment]::NewLine)
}

$env:DEVSPACE_CONFIG_DIR = $ConfigDir
$env:DEVPILOT_CONTROL_HOST = "127.0.0.1"
$env:DEVPILOT_CONTROL_PORT = [string]$ControlPort
$env:DEVPILOT_TUNNEL_PROVIDER = $TunnelProvider
$env:DEVPILOT_AUTOSTART = "1"
$env:DEVPILOT_CLOUDFLARED = $null
$env:DEVPILOT_OPENAI_TUNNEL_CLIENT = $null
$env:DEVPILOT_OPENAI_TUNNEL_ID = $null
$env:DEVPILOT_OPENAI_TUNNEL_API_KEY = $null
$env:DEVPILOT_OPENAI_TUNNEL_HEALTH_ADDR = $null
$env:DEVPILOT_OPENAI_CONTROL_PLANE_PROXY = $null

$tunnelId = $null
$controlPlaneProxy = $null

if ($TunnelProvider -eq "cloudflare-quick") {
  $cloudflared = Get-CloudflaredPath
  $env:DEVPILOT_CLOUDFLARED = $cloudflared
  Write-Host "[Tunnel] cloudflared: $cloudflared" -ForegroundColor DarkGray
} else {
  if (-not (Test-Path $TunnelConfigPath)) {
    throw "缺少 OpenAI Secure Tunnel 配置：$TunnelConfigPath`n请创建该文件，包含 tunnelId 与 runtimeApiKey；或者先选择 Cloudflare Quick Tunnel。"
  }
  $tunnelConfig = Get-JsonFile $TunnelConfigPath
  if (-not $tunnelConfig) { throw "无法解析 OpenAI Tunnel 配置：$TunnelConfigPath" }
  $tunnelId = [string]$tunnelConfig.tunnelId
  $runtimeApiKey = if ($tunnelConfig.runtimeApiKey) { [string]$tunnelConfig.runtimeApiKey } elseif ($tunnelConfig.apiKey) { [string]$tunnelConfig.apiKey } else { "" }
  if ($tunnelId -notmatch '^tunnel_[0-9a-f]{32}$') { throw "Tunnel ID 格式错误，应为 tunnel_ + 32 位小写十六进制。" }
  if (-not $runtimeApiKey) { throw "OpenAI Tunnel runtimeApiKey 缺失。" }

  $codexTunnelId = Get-ActiveCodexChatgptWebTunnelId
  if ($codexTunnelId -and $codexTunnelId -eq $tunnelId) {
    throw "Tunnel ID $tunnelId 正被 codex-chatgpt-web 使用。请给 DevPilot 配置独立 Tunnel ID，避免队列和 MCP session 冲突。"
  }

  $configuredProxy = if ($tunnelConfig.controlPlaneProxy) {
    [string]$tunnelConfig.controlPlaneProxy
  } elseif ($env:CONTROL_PLANE_HTTP_PROXY) {
    [string]$env:CONTROL_PLANE_HTTP_PROXY
  } else { $null }
  if ($configuredProxy -and (Test-ProxyEndpoint $configuredProxy)) { $controlPlaneProxy = $configuredProxy }
  elseif ($configuredProxy) { Write-Host "[网络] 配置的 control-plane proxy 不可达：$configuredProxy" -ForegroundColor Yellow }
  if (-not $controlPlaneProxy) {
    $controlPlaneProxy = Find-LocalControlPlaneProxy
    if ($controlPlaneProxy) { Write-Host "[网络] 自动检测代理：$controlPlaneProxy" -ForegroundColor Cyan }
    else { Write-Host "[网络] 未检测到本地代理，Tunnel 将直连 OpenAI control plane。" -ForegroundColor Yellow }
  }

  $tunnelClient = Get-TunnelClientPath
  $env:DEVPILOT_OPENAI_TUNNEL_CLIENT = $tunnelClient
  $env:DEVPILOT_OPENAI_TUNNEL_ID = $tunnelId
  $env:DEVPILOT_OPENAI_TUNNEL_API_KEY = $runtimeApiKey
  $env:DEVPILOT_OPENAI_TUNNEL_HEALTH_ADDR = "127.0.0.1:$TunnelHealthPort"
  if ($controlPlaneProxy) { $env:DEVPILOT_OPENAI_CONTROL_PLANE_PROXY = $controlPlaneProxy }
  Write-Host "[Tunnel] Tunnel ID: $tunnelId" -ForegroundColor DarkGray
  Write-Host "[Tunnel] client   : $tunnelClient" -ForegroundColor DarkGray
}

Remove-Item $StdoutPath, $StderrPath -Force -ErrorAction SilentlyContinue
Write-Host "[启动] 正在启动 Supervisor / MCP / Tunnel，请等待 READY..." -ForegroundColor Cyan
$process = Start-Process -FilePath $node.Source -ArgumentList @($distCli) -WorkingDirectory $ProjectRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath

$status = $null
$deadline = (Get-Date).AddSeconds(55)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 300
  if ($process.HasExited) {
    $detail = if (Test-Path $StderrPath) { Get-Content -Raw -Encoding UTF8 $StderrPath } else { "" }
    throw "DevPilot 启动进程提前退出。$detail"
  }
  $status = Test-ControlApi
  if (-not $status) { continue }
  if ($status.server.status -eq "online" -and $status.tunnel.provider -eq $TunnelProvider -and $status.tunnel.ready -eq $true) { break }
}

$ready = $status -and $status.server.status -eq "online" -and $status.tunnel.provider -eq $TunnelProvider -and $status.tunnel.ready -eq $true
if (-not $ready) {
  try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
  $detail = if (Test-Path $StderrPath) { Get-Content -Raw -Encoding UTF8 $StderrPath } else { "" }
  throw "DevPilot 没有在 55 秒内进入 READY。请查看 $StderrPath`n$detail"
}

if ($TunnelProvider -eq "openai-secure") {
  try {
    $readyResponse = Invoke-WebRequest -UseBasicParsing -Uri "$TunnelHealthUrl/readyz" -TimeoutSec 3
    if ($readyResponse.StatusCode -ne 200) { throw "readyz=$($readyResponse.StatusCode)" }
  } catch {
    throw "Tunnel 状态看似 READY，但 /readyz 实际不可用：$($_.Exception.Message)"
  }
}

$clipboardValue = if ($TunnelProvider -eq "cloudflare-quick") { [string]$status.tunnel.publicMcpUrl } else { $tunnelId }
if (-not $clipboardValue) { throw "Tunnel READY 但没有生成可用的连接信息。" }
Set-Clipboard -Value $clipboardValue

$runtime = [ordered]@{
  supervisorPid = $process.Id
  mcpPort = $McpPort
  controlPort = $ControlPort
  panelUrl = $PanelUrl
  tunnelProvider = $TunnelProvider
  publicMcpUrl = if ($TunnelProvider -eq "cloudflare-quick") { [string]$status.tunnel.publicMcpUrl } else { $null }
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
  $info = @"
DevPilot is running.
Mode: Cloudflare Quick Tunnel
Control Center: $PanelUrl
Local MCP: $LocalMcpUrl
Public MCP: $($status.tunnel.publicMcpUrl)
Tool surface: codex
Config: $ConfigDir
Runtime: $RuntimePath
Logs: $RuntimeDir
"@
} else {
  $info = @"
DevPilot is running.
Mode: OpenAI Secure MCP Tunnel
Control Center: $PanelUrl
Local MCP: $LocalMcpUrl
Tunnel ID: $tunnelId
Tunnel Health: $TunnelHealthUrl/readyz
Control plane proxy: $(if ($controlPlaneProxy) { $controlPlaneProxy } else { 'direct' })
Tool surface: codex
Config: $ConfigDir
Runtime: $RuntimePath
Logs: $RuntimeDir
"@
}
Write-Utf8NoBom $InfoPath ($info + [Environment]::NewLine)

Write-Host ""
Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host " DevPilot 已启动 · READY" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host "Control Center : $PanelUrl"
Write-Host "Local MCP      : $LocalMcpUrl"
Write-Host "Tool surface   : codex"
Write-Host "Tools          : open_workspace / read / show_changes / apply_patch / exec_command / write_stdin"
if ($TunnelProvider -eq "cloudflare-quick") {
  Write-Host "Mode           : Cloudflare Quick Tunnel"
  Write-Host "Public MCP     : $($status.tunnel.publicMcpUrl)" -ForegroundColor Cyan
  Write-Host "Clipboard      : Public MCP URL"
  Write-Host "ChatGPT        : 新建/更新 Remote MCP，填上面 Public MCP URL。" -ForegroundColor Yellow
} else {
  Write-Host "Mode           : OpenAI Secure MCP Tunnel"
  Write-Host "Tunnel ID      : $tunnelId" -ForegroundColor Cyan
  Write-Host "Tunnel ready   : TRUE"
  Write-Host "CP proxy       : $(if ($controlPlaneProxy) { $controlPlaneProxy } else { 'direct' })"
  Write-Host "Clipboard      : Tunnel ID"
  Write-Host "ChatGPT        : 使用绑定这个 Tunnel ID 的 devpilot_upstream；如果工具缓存不刷新，新建一个 MCP 名称。" -ForegroundColor Yellow
}
Write-Host "Connection     : $InfoPath"
Write-Host "Logs           : $RuntimeDir"
Write-Host "Stop           : 双击 关闭-DevPilot.cmd"
Write-Host ""
Write-Host "只有看到本窗口显示 READY，GPT 才应该能正常调用。" -ForegroundColor Green

if (-not $NoOpen) { Start-Process $PanelUrl }
