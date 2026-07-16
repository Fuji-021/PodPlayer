[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceRoot,
  [string]$ExpectedHead,
  [bool]$RequireClean = $true,
  [string]$Purpose = 'manual GUI verification',
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DevLauncher.Common.ps1')

try {
  $sourcePath = Get-LauncherPath -Path $SourceRoot
  $registry = Get-LauncherWorktreePaths -Repository $sourcePath
  $registeredSource = $registry | Where-Object { Test-LauncherPathEquals -Left $_ -Right $sourcePath } | Select-Object -First 1
  if ($null -eq $registeredSource) {
    Write-LauncherFailure "Source root is not a Git-registered worktree: $sourcePath"
  }
  $canonicalRepo = $registry | Select-Object -First 1
  $actualBranch = Invoke-LauncherGit -Repository $sourcePath -Arguments @('branch', '--show-current')
  if ([string]::IsNullOrWhiteSpace($actualBranch)) {
    Write-LauncherFailure "Cannot select a detached worktree: $sourcePath"
  }
  $actualHead = Invoke-LauncherGit -Repository $sourcePath -Arguments @('rev-parse', 'HEAD')
  if (-not [string]::IsNullOrWhiteSpace($ExpectedHead) -and -not [string]::Equals($ExpectedHead, $actualHead, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-LauncherFailure "ExpectedHead does not match the selected worktree. expected=$ExpectedHead actual=$actualHead"
  }

  $selection = [ordered]@{
    canonicalRepo = $canonicalRepo
    sourceRoot = $sourcePath
    branch = $actualBranch
    expectedHead = $actualHead
    requireClean = $RequireClean
    selectedAt = (Get-Date).ToUniversalTime().ToString('o')
    selectedBy = "$env:USERNAME@$env:COMPUTERNAME"
    purpose = $Purpose
  }
  $verified = Assert-SelectedDevSource -Selection ([pscustomobject]$selection)

  if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $PSScriptRoot 'selected-source.json'
  }
  Write-LauncherJsonAtomically -Path $OutputPath -Value $selection
  Write-Host "[selected] $($verified.actualBranch)@$($verified.actualHead.Substring(0, 7)) -> $OutputPath" -ForegroundColor Green
  exit 0
} catch {
  if ($_.Exception.Message) {
    Write-Host "[selector-error] $($_.Exception.Message)" -ForegroundColor Red
  }
  exit 1
}
