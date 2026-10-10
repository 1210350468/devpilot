param(
  [Parameter(Mandatory=$true)][string]$Tag,
  [string]$OutputDirectory = "releases"
)

$ErrorActionPreference = "Stop"
if ($Tag -notmatch '^v\d+\.\d+\.\d+(?:-(?:beta|rc)\.\d+)?$') { throw "Invalid version tag: $Tag" }
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$destination = [System.IO.Path]::GetFullPath((Join-Path $root $OutputDirectory))
$stage = Join-Path $destination "staging"
$app = Join-Path $stage "DevPilot"
$filename = "DevPilot-windows-x64-$Tag.zip"
$archive = Join-Path $destination $filename
$node = (Get-Command node.exe -ErrorAction Stop).Source
$pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source

if (-not (Test-Path (Join-Path $root "dist\devpilot-cli.js"))) {
  throw "Build artifacts are missing. Run pnpm build first."
}
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $app -Force | Out-Null
foreach ($name in @("dist","bin","docs","examples","schema","skills","scripts")) {
  Copy-Item -LiteralPath (Join-Path $root $name) -Destination $app -Recurse -Force
}
foreach ($name in @("README.md","CHANGELOG.md","LICENSE","package.json","pnpm-lock.yaml","pnpm-workspace.yaml","启动-DevPilot.cmd","关闭-DevPilot.cmd","首次配置-DevPilot.cmd","更新-DevPilot.cmd")) {
  Copy-Item -LiteralPath (Join-Path $root $name) -Destination $app -Force
}
New-Item -ItemType Directory -Path (Join-Path $app "runtime") -Force | Out-Null
Copy-Item -LiteralPath $node -Destination (Join-Path $app "runtime\node.exe")
$markerJson = @{ version = $Tag.Substring(1); tag = $Tag; repository = "1210350468/devpilot"; platform = "windows-x64" } | ConvertTo-Json
[System.IO.File]::WriteAllText(
  (Join-Path $app ".devpilot-portable.json"),
  $markerJson,
  (New-Object System.Text.UTF8Encoding($false))
)

# Install native dependencies on the target OS/architecture, not on Linux and not from a developer checkout.
Push-Location $app
try {
  & $pnpm install --prod --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "Portable production dependency installation failed." }
  & (Join-Path $app "runtime\node.exe") --version
  & (Join-Path $app "runtime\node.exe") --input-type=module -e "import('better-sqlite3').then(({default: DB}) => { const db = new DB(':memory:'); db.prepare('select 1').get(); db.close(); console.log('sqlite-native-ok'); })"
  if ($LASTEXITCODE -ne 0) { throw "Windows native SQLite smoke test failed." }
} finally { Pop-Location }

if (Test-Path $archive) { Remove-Item -LiteralPath $archive -Force }
Compress-Archive -Path $app -DestinationPath $archive -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText("$archive.sha256", "$hash  $filename`n", [Text.Encoding]::ASCII)
Write-Host "Portable archive: $archive"
Write-Host "SHA256: $hash"
