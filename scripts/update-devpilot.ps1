param(
  [ValidateSet("stable", "preview")][string]$Channel = "stable",
  [switch]$Apply,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifest = Join-Path $root ".devpilot-portable.json"
$repo = "1210350468/devpilot"

if (-not (Test-Path -LiteralPath $manifest)) {
  throw "本更新器只支持带内置 Node.js 的官方 DevPilot Windows 便携包。源码安装请使用 git pull --ff-only 和 pnpm build。"
}
$installed = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
if ($installed.version -notmatch '^\d+\.\d+\.\d+(?:-(?:beta|rc)\.\d+)?$') { throw "当前版本信息无效。" }
if (-not $PSBoundParameters.ContainsKey("Channel") -and $installed.version -match '-') {
  $Channel = "preview"
}

function Parse-Semver([string]$Value) {
  if ($Value -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-(beta|rc)\.(\d+))?$') { throw "Invalid version: $Value" }
  return @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], $(if ($Matches[4]) { if ($Matches[4] -eq "beta") { -2 } else { -1 } } else { 0 }), $(if ($Matches[5]) { [int]$Matches[5] } else { 0 }))
}

function Compare-Semver([string]$Left, [string]$Right) {
  $a = Parse-Semver $Left
  $b = Parse-Semver $Right
  for ($i = 0; $i -lt 5; $i++) {
    if ($a[$i] -gt $b[$i]) { return 1 }
    if ($a[$i] -lt $b[$i]) { return -1 }
  }
  return 0
}

function Get-LatestRelease {
  $headers = @{ "User-Agent" = "DevPilot-updater"; "Accept" = "application/vnd.github+json" }
  $releases = @(Invoke-RestMethod -UseBasicParsing -Headers $headers -TimeoutSec 15 -Uri "https://api.github.com/repos/$repo/releases?per_page=20")
  $valid = @()
  foreach ($item in $releases) {
    if ($item.draft -or $item.tag_name -notmatch '^v\d+\.\d+\.\d+(?:-(?:beta|rc)\.\d+)?$') { continue }
    if ($Channel -eq "stable" -and $item.prerelease) { continue }
    $zipName = "DevPilot-windows-x64-$($item.tag_name).zip"
    $hashName = "$zipName.sha256"
    $zip = $item.assets | Where-Object { $_.name -eq $zipName -and $_.browser_download_url -like "https://github.com/$repo/releases/download/*" } | Select-Object -First 1
    $hash = $item.assets | Where-Object { $_.name -eq $hashName -and $_.browser_download_url -like "https://github.com/$repo/releases/download/*" } | Select-Object -First 1
    if ($zip -and $hash) {
      $valid += [pscustomobject]@{ version = $item.tag_name.Substring(1); tag = $item.tag_name; zip = $zip; hash = $hash; url = $item.html_url }
    }
  }
  $best = $null
  foreach ($candidate in $valid) {
    if (-not $best -or (Compare-Semver $candidate.version $best.version) -gt 0) { $best = $candidate }
  }
  return $best
}

Write-Host "DevPilot 更新检查 ($Channel)" -ForegroundColor Cyan
Write-Host ("当前版本: " + $installed.version)
$latest = Get-LatestRelease
if (-not $latest) {
  Write-Host "此频道尚无带 Windows ZIP + SHA256 的正式 GitHub Release。" -ForegroundColor Yellow
  exit 0
}
Write-Host ("GitHub 最新: " + $latest.tag)
Write-Host ("发行页面: " + $latest.url)
if ((Compare-Semver $latest.version $installed.version) -le 0) {
  Write-Host "已经是最新版本，无需更新。" -ForegroundColor Green
  exit 0
}
if (-not $Apply) {
  Write-Host "有新版本。退出 DevPilot 后运行「更新-DevPilot.cmd」下载并安装。"
  exit 0
}

# Do not touch a running or possibly shared DevPilot instance.
$runtimePath = Join-Path $root ".devpilot-runtime\runtime.json"
if (Test-Path $runtimePath) {
  try {
    $runtime = Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $pidValue = if ($runtime.supervisorPid) { [int]$runtime.supervisorPid } else { [int]$runtime.pid }
    if ($pidValue -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
      throw "当前 DevPilot Supervisor (PID $pidValue) 仍在运行。请先使用「关闭-DevPilot.cmd」退出。"
    }
  } catch {
    if ($_.Exception.Message -match '仍在运行') { throw }
    Write-Host "运行状态文件无法解析，将继续执行端口预检。" -ForegroundColor Yellow
  }
}
try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:47680/devpilot/api/status" -TimeoutSec 2
  if ($response.StatusCode -eq 200) {
    throw "本机仍有 DevPilot Control Center 运行在 47680，请先停止，避免破坏活跃连接。"
  }
} catch {
  if ($_.Exception.Message -match 'Control Center 运行') { throw }
}

if (-not $Yes) {
  $confirm = Read-Host "此操作会停止使用旧安装目录并保留完整回滚备份。输入 UPDATE 以确认"
  if ($confirm -cne "UPDATE") { Write-Host "用户取消，未修改文件。"; exit 0 }
}

$parent = Split-Path $root -Parent
$name = Split-Path $root -Leaf
$tmp = Join-Path $parent (".devpilot-update-" + [guid]::NewGuid().ToString("N"))
$backup = Join-Path $parent ("$name.backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$archive = Join-Path $tmp $latest.zip.name
$checksumFile = Join-Path $tmp $latest.hash.name
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$movedOld = $false
$movedNew = $false

try {
  Invoke-WebRequest -UseBasicParsing -Uri $latest.zip.browser_download_url -OutFile $archive -TimeoutSec 180
  Invoke-WebRequest -UseBasicParsing -Uri $latest.hash.browser_download_url -OutFile $checksumFile -TimeoutSec 30
  $checksumLine = (Get-Content -LiteralPath $checksumFile -Raw -Encoding ASCII).Trim()
  $escapedFilename = [regex]::Escape($latest.zip.name)
  if ($checksumLine -notmatch "^([a-fA-F0-9]{64})\s+\*?$escapedFilename$") {
    throw "SHA256 校验文件格式不正确，拒绝安装。"
  }
  $expected = $Matches[1].ToLowerInvariant()
  $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "SHA256 校验失败，下载包可能损坏或被篡改。" }
  Write-Host "SHA256 验证通过。" -ForegroundColor Green

  $extract = Join-Path $tmp "unpacked"
  New-Item -ItemType Directory -Path $extract -Force | Out-Null
  Push-Location $extract
  try {
    & tar.exe -xf $archive
    if ($LASTEXITCODE -ne 0) { throw "ZIP 解压失败（tar exit $LASTEXITCODE）。" }
  } finally { Pop-Location }
  $newApp = Join-Path $extract "DevPilot"
  $newManifest = Join-Path $newApp ".devpilot-portable.json"
  if (-not (Test-Path $newManifest) -or
      -not (Test-Path (Join-Path $newApp "runtime\node.exe")) -or
      -not (Test-Path (Join-Path $newApp "node_modules")) -or
      -not (Test-Path (Join-Path $newApp "dist\devpilot-cli.js"))) {
    throw "ZIP 缺少完整便携安装所需的文件。"
  }
  $newVersion = (Get-Content -LiteralPath $newManifest -Raw -Encoding UTF8 | ConvertFrom-Json).version
  if ($newVersion -ne $latest.version) { throw "解压后的版本信息与 Release 不一致。" }

  Set-Location $parent
  Move-Item -LiteralPath $root -Destination $backup -ErrorAction Stop
  $movedOld = $true
  Move-Item -LiteralPath $newApp -Destination $root -ErrorAction Stop
  $movedNew = $true

  # Credentials, Goal state and managed worktrees are user-owned; never replace with release contents.
  foreach ($private in @(".devpilot-config", ".devpilot-runtime")) {
    $source = Join-Path $backup $private
    if (Test-Path -LiteralPath $source) {
      $target = Join-Path $root $private
      if (Test-Path -LiteralPath $target) { throw "Release unexpectedly contains private data: $private" }
      Copy-Item -LiteralPath $source -Destination $target -Recurse -Force -ErrorAction Stop
    }
  }
  Remove-Item -LiteralPath (Join-Path $root ".devpilot-runtime\runtime.json") -Force -ErrorAction SilentlyContinue
  Write-Host ("更新成功: " + $latest.tag) -ForegroundColor Green
  Write-Host ("旧版完整备份: " + $backup)
  Write-Host "请使用「启动-DevPilot.cmd」重新启动并检查 Tunnel READY。"
} catch {
  Write-Host ("更新失败: " + $_.Exception.Message) -ForegroundColor Red
  if ($movedOld) {
    if ($movedNew -and (Test-Path -LiteralPath $root)) {
      Move-Item -LiteralPath $root -Destination (Join-Path $tmp "failed-install") -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath $root)) {
      Move-Item -LiteralPath $backup -Destination $root -ErrorAction Stop
      Write-Host "已恢复原安装目录。" -ForegroundColor Yellow
    }
  }
  throw
} finally {
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
