[CmdletBinding()]
param(
  [string]$Destination = 'D:\MyYesPlayerMusic\PodPlayerDevLauncher'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DevLauncher.Common.ps1')

try {
  $sourceRoot = Get-LauncherPath -Path $PSScriptRoot
  if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  }
  $destinationRoot = Get-LauncherPath -Path $Destination

  foreach ($file in $script:ManagedLauncherFiles) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination (Join-Path $destinationRoot $file) -Force
  }

  foreach ($stateFile in @('selected-source.json', 'runtime-receipt.json')) {
    $destinationState = Join-Path $destinationRoot $stateFile
    if (-not (Test-Path -LiteralPath $destinationState)) {
      Copy-Item -LiteralPath (Join-Path $sourceRoot ($stateFile + '.template')) -Destination $destinationState
    }
  }

  $fileHashes = [ordered]@{}
  foreach ($file in $script:ManagedLauncherFiles) {
    $fileHashes[$file] = Get-LauncherFileHash -Path (Join-Path $sourceRoot $file)
  }
  $sourceRepository = Split-Path -Parent (Split-Path -Parent $sourceRoot)
  $manifest = [ordered]@{
    launcherVersion = $script:DevLauncherVersion
    launcherSourceRoot = $sourceRoot
    launcherSourceBranch = Invoke-LauncherGit -Repository $sourceRepository -Arguments @('branch', '--show-current')
    launcherSourceCommit = Invoke-LauncherGit -Repository $sourceRepository -Arguments @('rev-parse', 'HEAD')
    deployedAt = (Get-Date).ToUniversalTime().ToString('o')
    fileHashes = $fileHashes
    launcherSourceHash = Get-LauncherBundleHash -Root $sourceRoot -Files $script:ManagedLauncherFiles
  }
  Write-LauncherJsonAtomically -Path (Join-Path $destinationRoot 'launcher-manifest.json') -Value $manifest

  Assert-LauncherIntegrity -LauncherRoot $destinationRoot | Out-Null
  Write-Host "[deployed] PodPlayer Dev launcher $script:DevLauncherVersion -> $destinationRoot" -ForegroundColor Green
  exit 0
} catch {
  if ($_.Exception.Message) {
    Write-Host "[deploy-error] $($_.Exception.Message)" -ForegroundColor Red
  }
  exit 1
}
