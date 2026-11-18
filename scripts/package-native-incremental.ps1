[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [Parameter(Mandatory = $true)]
  [ValidateSet("api", "web", "shared", "migrations", "data")]
  [string[]]$Areas,
  [string]$OutputDir = "artifacts",
  [switch]$SkipBuild,
  [switch]$KeepStaging
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "lib/zip-linux-permissions.ps1")
$outputRoot = Join-Path $repoRoot $OutputDir
$bundleName = "dw-resource-console-kylin-v10-dws821-incremental-$Version"
$stagingRoot = Join-Path $outputRoot "_native-incremental-$Version"
$bundleRoot = Join-Path $stagingRoot $bundleName
$zipPath = Join-Path $outputRoot "$bundleName.zip"
$selected = @($Areas | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique)

function Resolve-CommandPath([string[]]$Names) {
  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
  }
  throw "Required command not found: $($Names -join ', ')"
}

$npm = Resolve-CommandPath @("npm.cmd", "npm")

if (Test-Path -LiteralPath $stagingRoot) {
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null

Push-Location $repoRoot
try {
  if (-not $SkipBuild) {
    $tempRoot = Join-Path $stagingRoot ".temp"
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $oldTemp = $env:TEMP
    $oldTmp = $env:TMP
    $env:TEMP = $tempRoot
    $env:TMP = $tempRoot
    try {
      if ($selected -contains "shared") {
        Write-Host "[build] shared changes require rebuilding shared, API and Web"
        & $npm run build -w @dw/shared
        if ($LASTEXITCODE -ne 0) { throw "Shared build failed." }
        & $npm run build -w @dw/api
        if ($LASTEXITCODE -ne 0) { throw "API build failed." }
        & $npm run build -w @dw/web
        if ($LASTEXITCODE -ne 0) { throw "Web build failed." }
      } else {
        if ($selected -contains "api") {
          Write-Host "[build] API"
          & $npm run build -w @dw/api
          if ($LASTEXITCODE -ne 0) { throw "API build failed." }
        }
        if ($selected -contains "web") {
          Write-Host "[build] Web"
          & $npm run build -w @dw/web
          if ($LASTEXITCODE -ne 0) { throw "Web build failed." }
        }
      }
    } finally {
      $env:TEMP = $oldTemp
      $env:TMP = $oldTmp
    }
  } else {
    Write-Host "[build] skipped; using existing dist files"
  }

  if ($selected -contains "api" -or $selected -contains "shared") {
    New-Item -ItemType Directory -Path (Join-Path $bundleRoot "apps/api") -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot "apps/api/dist") -Destination (Join-Path $bundleRoot "apps/api") -Recurse -Force
  }
  if ($selected -contains "web" -or $selected -contains "shared") {
    New-Item -ItemType Directory -Path (Join-Path $bundleRoot "apps/web") -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot "apps/web/dist") -Destination (Join-Path $bundleRoot "apps/web") -Recurse -Force
  }
  if ($selected -contains "shared") {
    $sharedTarget = Join-Path $bundleRoot "packages/shared"
    $runtimeTarget = Join-Path $bundleRoot "apps/api/node_modules/@dw/shared"
    New-Item -ItemType Directory -Path $sharedTarget, (Split-Path -Parent $runtimeTarget) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot "packages/shared/package.json"), (Join-Path $repoRoot "packages/shared/dist") -Destination $sharedTarget -Recurse -Force
    Copy-Item -LiteralPath $sharedTarget -Destination $runtimeTarget -Recurse -Force
  }
  if ($selected -contains "migrations") {
    $apiTarget = Join-Path $bundleRoot "apps/api"
    New-Item -ItemType Directory -Path $apiTarget -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot "apps/api/drizzle"), (Join-Path $repoRoot "apps/api/drizzle-pg") -Destination $apiTarget -Recurse -Force
  }
  if ($selected -contains "data") {
    $dataTarget = Join-Path $bundleRoot "data"
    New-Item -ItemType Directory -Path $dataTarget -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot "data/dw_console_data.sql") -Destination $dataTarget -Force
  }

  Copy-Item -LiteralPath (Join-Path $repoRoot "deploy/native/apply-update.sh") -Destination $bundleRoot -Force
  $gitCommit = (& git -C $repoRoot rev-parse --short HEAD).Trim()
  $updateInfo = @(
    "Package: $bundleName.zip"
    "Build date: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    "Base commit: $gitCommit"
    "Areas: $($selected -join ', ')"
    "Apply: ./apply-update.sh /path/to/dw-resource-console"
  )
  Set-Content -LiteralPath (Join-Path $bundleRoot "UPDATE_INFO.txt") -Value $updateInfo -Encoding utf8

  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  Compress-Archive -LiteralPath $bundleRoot -DestinationPath $zipPath -CompressionLevel Optimal
  Set-LinuxZipPermissions -Path $zipPath
  $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Host "Package: $zipPath"
  Write-Host "SHA256:  $zipHash"
  Write-Host "Areas:   $($selected -join ', ')"
} finally {
  Pop-Location
  if (-not $KeepStaging -and (Test-Path -LiteralPath $stagingRoot)) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
}
