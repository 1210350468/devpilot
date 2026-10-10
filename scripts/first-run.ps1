param(
  [ValidateSet("cloudflare-quick", "openai-secure")]
  [string]$TunnelProvider,
  [string]$AllowedRoot,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$config = Join-Path $root ".devpilot-config\config.jsonc"
$legacyConfig = Join-Path $root ".devpilot-config\config.json"
$portable = Test-Path (Join-Path $root ".devpilot-portable.json")

Write-Host "DevPilot 首次配置向导" -ForegroundColor Cyan
Write-Host ("安装位置: " + $root)
Write-Host ("安装类型: " + $(if ($portable) { "Windows 便携包（内置 Node.js）" } else { "源码版本" }))

if (-not $portable) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if (-not $node -or -not $pnpm) {
    throw "源码安装需要 Node.js 和 pnpm；请按 README 构建，或下载带 Node.js 的 Windows 便携包。"
  }
}

if ((Test-Path $config) -or (Test-Path $legacyConfig)) {
  Write-Host "检测到已有私有配置，将保留原配置和已授权工作目录。" -ForegroundColor Yellow
} else {
  if (-not $AllowedRoot) {
    Write-Host ""
    Write-Host "请选择允许 ChatGPT 操作的工作目录（只授予你信任的项目，禁止直接开放整个磁盘）。"
    $answer = Read-Host ("工作目录 [默认 " + $root + "]")
    $AllowedRoot = if ($answer.Trim()) { $answer.Trim().Trim('"') } else { $root }
  }
  $AllowedRoot = [System.IO.Path]::GetFullPath($AllowedRoot)
  if (-not (Test-Path -LiteralPath $AllowedRoot -PathType Container)) {
    throw "工作目录不存在：$AllowedRoot。请创建目录后重试。"
  }
  if ($AllowedRoot -match '^[A-Za-z]:\\?$') {
    throw "为了安全，首次设置不允许直接授权整个磁盘：$AllowedRoot"
  }
  Write-Host ("已选择工作目录: " + $AllowedRoot) -ForegroundColor Green
}

if (-not $TunnelProvider) {
  Write-Host ""
  Write-Host "1. Cloudflare Quick Tunnel（推荐首次使用，不需要私有 Tunnel ID）"
  Write-Host "2. OpenAI Secure MCP Tunnel（需要你自己的密钥与 Tunnel ID）"
  $choice = Read-Host "模式 [默认 1]"
  $TunnelProvider = if ($choice -eq "2") { "openai-secure" } else { "cloudflare-quick" }
}

if ($TunnelProvider -eq "openai-secure") {
  $privateTunnel = Join-Path $root ".devpilot-config\openai-tunnel.json"
  if (-not (Test-Path $privateTunnel)) {
    Write-Host "Secure Tunnel 需要本地私有配置，切勿把密钥放入聊天记录或 GitHub。" -ForegroundColor Yellow
    throw "未找到 OpenAI Tunnel 配置。请先参考 README 配置，然后重新运行。"
  }
}

if ($NoStart) {
  Write-Host "预检通过，未启动任何服务。" -ForegroundColor Green
  exit 0
}

Write-Host "接下来启动 DevPilot，等待 MCP 和 Tunnel READY。" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "start-devpilot.ps1") -TunnelProvider $TunnelProvider -AllowedRoot $AllowedRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
