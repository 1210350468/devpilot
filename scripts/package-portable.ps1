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
  # A portable ZIP must survive extraction without Windows junction/symlink
  # privileges. Use a physical hoisted node_modules tree instead of pnpm's
  # default virtual-store symlink graph.
  & $pnpm install --prod --frozen-lockfile --config.node-linker=hoisted
  if ($LASTEXITCODE -ne 0) { throw "Portable production dependency installation failed." }
  if (Test-Path (Join-Path $app "node_modules\@anthropic-ai\sandbox-runtime")) {
    throw "Security gate: unpatched Pi sandbox runtime must not be bundled in the Windows portable release."
  }
  & (Join-Path $app "runtime\node.exe") --version
  & (Join-Path $app "runtime\node.exe") --input-type=module -e "import('better-sqlite3').then(({default: DB}) => { const db = new DB(':memory:'); db.prepare('select 1').get(); db.close(); console.log('sqlite-native-ok'); })"
  if ($LASTEXITCODE -ne 0) { throw "Windows native SQLite smoke test failed." }
  # The ordinary runtime must still import without the optional Pi sandbox.
  & (Join-Path $app "runtime\node.exe") --input-type=module -e "await import('./dist/local-agent-pi-sandbox.js'); console.log('portable-runtime-import-ok')"
  if ($LASTEXITCODE -ne 0) { throw "Portable runtime cannot load without the excluded sandbox dependency." }
  & (Join-Path $app "runtime\node.exe") --input-type=module -e "const m=await import('./dist/local-agent-pi-sandbox.js');try{await m.registerPiSandboxSession({},process.cwd(),m.createPiSandboxModeRef('allowed'),'allowed');process.exitCode=10}catch(error){if(!String(error.message).includes('blocked instead of running without a sandbox')){console.error(error);process.exitCode=11}else{console.log('portable-pi-fail-closed-ok')}}"
  if ($LASTEXITCODE -ne 0) { throw "Portable Pi restricted mode must refuse to run without a safe sandbox." }
} finally { Pop-Location }

if (Test-Path $archive) { Remove-Item -LiteralPath $archive -Force }
Push-Location $stage
try {
  # PowerShell Compress-Archive does not reliably support deep pnpm store paths.
  # Windows ships bsdtar, which supports ZIP format and long paths.
  # -L materializes pnpm junction/symlink directories so Explorer extraction
  # does not require link privileges or restore links as ordinary text files.
  & tar.exe -a -c -L -f $archive DevPilot
  if ($LASTEXITCODE -ne 0) { throw "Windows ZIP creation failed (tar exit code $LASTEXITCODE)." }
} finally { Pop-Location }
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText("$archive.sha256", "$hash  $filename`n", [Text.Encoding]::ASCII)
Write-Host "Portable archive: $archive"
Write-Host "SHA256: $hash"
