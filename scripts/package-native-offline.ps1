[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [string]$OutputDir = "artifacts",
  [switch]$SkipBuild,
  [switch]$KeepStaging
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "lib/zip-linux-permissions.ps1")
$outputRoot = Join-Path $repoRoot $OutputDir
$bundleName = "dw-resource-console-kylin-v10-dws821-$Version"
$stagingRoot = Join-Path $outputRoot "_native-build-$Version"
$bundleRoot = Join-Path $stagingRoot "dw-resource-console"
$zipPath = Join-Path $outputRoot "$bundleName.zip"

function Resolve-CommandPath([string[]]$Names) {
  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
  }
  throw "Required command not found: $($Names -join ', ')"
}

$node = Resolve-CommandPath @("node.exe", "node")
$npm = Resolve-CommandPath @("npm.cmd", "npm")

if (Test-Path -LiteralPath $stagingRoot) {
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

$tempRoot = Join-Path $stagingRoot ".temp"
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

Push-Location $repoRoot
try {
  if (-not $SkipBuild) {
    $oldTemp = $env:TEMP
    $oldTmp = $env:TMP
    $env:TEMP = $tempRoot
    $env:TMP = $tempRoot
    try {
      Write-Host "[1/5] Building shared, API and Web"
      & $npm run build
      if ($LASTEXITCODE -ne 0) { throw "Application build failed." }
    } finally {
      $env:TEMP = $oldTemp
      $env:TMP = $oldTmp
    }
  } else {
    Write-Host "[1/5] Build skipped; using existing dist files"
  }

  Write-Host "[2/5] Copying runtime files"
  $apiDir = Join-Path $bundleRoot "apps/api"
  $webDir = Join-Path $bundleRoot "apps/web"
  $sharedDir = Join-Path $bundleRoot "packages/shared"
  $deployDir = Join-Path $bundleRoot "deploy"
  $dataDir = Join-Path $bundleRoot "data"
  New-Item -ItemType Directory -Path $apiDir, $webDir, $sharedDir, $deployDir, $dataDir -Force |
    Out-Null

  Copy-Item -LiteralPath (Join-Path $repoRoot "package.json"), (Join-Path $repoRoot "package-lock.json") -Destination $bundleRoot -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot "apps/api/package.json"), (Join-Path $repoRoot "apps/api/dist"), (Join-Path $repoRoot "apps/api/drizzle"), (Join-Path $repoRoot "apps/api/drizzle-pg") -Destination $apiDir -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot "apps/web/package.json"), (Join-Path $repoRoot "apps/web/dist") -Destination $webDir -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot "packages/shared/package.json"), (Join-Path $repoRoot "packages/shared/dist") -Destination $sharedDir -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot "data/dw_console_data.sql") -Destination $dataDir -Force

  Copy-Item -LiteralPath (Join-Path $repoRoot "deploy/native/env.example") -Destination (Join-Path $bundleRoot ".env.native.example") -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot "deploy/native/start-api.sh"), (Join-Path $repoRoot "deploy/native/stop-api.sh") -Destination $bundleRoot -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot "deploy/native/nginx.conf") -Destination (Join-Path $deployDir "nginx-native.conf") -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot "deploy/native/README.md") -Destination (Join-Path $bundleRoot "NATIVE_DEPLOY.md") -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot "deploy/nginx.conf") -Destination $deployDir -Force

  $gitCommit = (& git -C $repoRoot rev-parse --short HEAD).Trim()
  $sqlHash = (Get-FileHash -LiteralPath (Join-Path $repoRoot "data/dw_console_data.sql") -Algorithm SHA256).Hash.ToLowerInvariant()
  $buildInfo = @(
    "Package: $bundleName.zip"
    "Build date: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    "Target: Kylin Linux Advanced Server V10, native Node.js + Nginx, no Docker"
    "Base commit: $gitCommit"
    "Data SQL SHA256: $sqlHash"
    "Node requirement: >=20.19.0"
    "DWS compatibility mode: DB_COMPAT_MODE=dws"
  )
  Set-Content -LiteralPath (Join-Path $bundleRoot "BUILD_INFO.txt") -Value $buildInfo -Encoding utf8

  Write-Host "[3/5] Installing production dependencies"
  Push-Location $bundleRoot
  try {
    & $npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "Production dependency installation failed." }

    $sharedRuntime = Join-Path $bundleRoot "apps/api/node_modules/@dw/shared"
    New-Item -ItemType Directory -Path (Split-Path -Parent $sharedRuntime) -Force | Out-Null
    Copy-Item -LiteralPath $sharedDir -Destination $sharedRuntime -Recurse -Force

    $workspaceLinks = Join-Path $bundleRoot "node_modules/@dw"
    if (Test-Path -LiteralPath $workspaceLinks) {
      Get-ChildItem -LiteralPath $workspaceLinks -Force | ForEach-Object {
        [System.IO.Directory]::Delete($_.FullName, $false)
      }
      [System.IO.Directory]::Delete($workspaceLinks, $false)
    }
  } finally {
    Pop-Location
  }

  Write-Host "[4/5] Verifying packaged runtime"
  Push-Location $apiDir
  try {
    & $node -e "Promise.all([import('@dw/shared'),import('fastify'),import('pg')]).catch(e=>{console.error(e);process.exit(1)})"
    if ($LASTEXITCODE -ne 0) { throw "Packaged runtime dependency verification failed." }
  } finally {
    Pop-Location
  }

  Write-Host "[5/5] Creating archive"
  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  Compress-Archive -LiteralPath $bundleRoot -DestinationPath $zipPath -CompressionLevel Optimal
  Set-LinuxZipPermissions -Path $zipPath

  $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Host "Package: $zipPath"
  Write-Host "SHA256:  $zipHash"
} finally {
  Pop-Location
  if (-not $KeepStaging -and (Test-Path -LiteralPath $stagingRoot)) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
}
