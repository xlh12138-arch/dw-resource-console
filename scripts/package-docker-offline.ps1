[CmdletBinding()]
param(
  [string]$Version = "1.0.0",
  [ValidateSet("linux/amd64", "linux/arm64")]
  [string]$Platform = "linux/amd64",
  [string]$OutputDir = "artifacts"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$bundleName = "dw-resource-console-offline-$Version"
$bundleDir = Join-Path (Join-Path $repoRoot $OutputDir) $bundleName
$imageTar = Join-Path $bundleDir "dw-resource-console-$Version-images.tar"
$zipPath = "$bundleDir.zip"
$apiImage = "dw-resource-console-api:$Version"
$webImage = "dw-resource-console-web:$Version"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker CLI was not found. Install and start Docker Desktop first."
}

Push-Location $repoRoot
try {
  New-Item -ItemType Directory -Path $bundleDir -Force | Out-Null

  Write-Host "[1/4] Building API image: $apiImage ($Platform)"
  & docker build --platform $Platform --target api -t $apiImage .
  if ($LASTEXITCODE -ne 0) { throw "API image build failed." }

  Write-Host "[2/4] Building Web image: $webImage ($Platform)"
  & docker build --platform $Platform --target web -t $webImage .
  if ($LASTEXITCODE -ne 0) { throw "Web image build failed." }

  Write-Host "[3/4] Exporting images: $imageTar"
  & docker save -o $imageTar $apiImage $webImage
  if ($LASTEXITCODE -ne 0) { throw "Image export failed." }

  Copy-Item -LiteralPath (Join-Path $repoRoot "compose.yaml") -Destination $bundleDir
  Copy-Item -LiteralPath (Join-Path $repoRoot "docs/DOCKER_OFFLINE_DEPLOY.md") -Destination $bundleDir
  $importDir = Join-Path $bundleDir "import"
  New-Item -ItemType Directory -Path $importDir -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repoRoot "import/README.md") -Destination $importDir

  $envExample = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "deploy/.env.example")
  $envExample = $envExample.Replace("IMAGE_TAG=1.0.0", "IMAGE_TAG=$Version")
  Set-Content -LiteralPath (Join-Path $bundleDir ".env.example") -Value $envExample -Encoding utf8

  Write-Host "[4/4] Creating offline deployment archive: $zipPath"
  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  Compress-Archive -Path (Join-Path $bundleDir "*") -DestinationPath $zipPath -Force

  Write-Host "Done: $zipPath"
  Write-Host "Copy the archive to the intranet server and create .env from .env.example."
} finally {
  Pop-Location
}
