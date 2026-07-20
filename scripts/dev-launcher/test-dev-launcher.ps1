[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$LauncherRoot,
  [Parameter(Mandatory = $true)][string]$SourceRoot
)

$ErrorActionPreference = 'Stop'
$sourceScriptRoot = $PSScriptRoot
. (Join-Path $sourceScriptRoot 'DevLauncher.Common.ps1')

function Assert-TestResult {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$Message
  )
  if (-not $Condition) { throw "TEST FAIL: $Message" }
}

function Invoke-DryRun {
  param([Parameter(Mandatory = $true)][string]$ConfigPath)
  $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $LauncherRoot 'start-dev.ps1') -ConfigPath $ConfigPath -DryRun 2>&1
  return [pscustomobject]@{ exitCode = $LASTEXITCODE; output = ($output -join "`n") }
}

function New-SelectionObject {
  param([Parameter(Mandatory = $true)][string]$Root)
  $normalizedRoot = Get-LauncherPath -Path $Root
  $registry = Get-LauncherWorktreePaths -Repository $normalizedRoot
  return [ordered]@{
    canonicalRepo = $registry | Select-Object -First 1
    sourceRoot = $normalizedRoot
    branch = Invoke-LauncherGit -Repository $normalizedRoot -Arguments @('branch', '--show-current')
    expectedHead = Invoke-LauncherGit -Repository $normalizedRoot -Arguments @('rev-parse', 'HEAD')
    requireClean = $true
    requiredAncestors = @()
    selectedAt = (Get-Date).ToUniversalTime().ToString('o')
    selectedBy = 'launcher-smoke'
    purpose = 'fail-closed gate smoke'
  }
}

$temporaryDirectory = Join-Path $env:TEMP ('PodPlayerDevLauncher-test-' + [Guid]::NewGuid().ToString('N'))
$dirtyWorktree = Join-Path $env:TEMP ('PodPlayerDevLauncher-dirty-' + [Guid]::NewGuid().ToString('N'))
$dirtyBranch = 'test/dev-launcher-gate-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$dirtyFixtureCreated = $false

try {
  New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
  $baseSelection = New-SelectionObject -Root $SourceRoot
  $correctConfig = Join-Path $temporaryDirectory 'correct.json'
  Write-LauncherJsonAtomically -Path $correctConfig -Value $baseSelection

  $missing = Invoke-DryRun -ConfigPath (Join-Path $temporaryDirectory 'missing.json')
  Assert-TestResult -Condition ($missing.exitCode -ne 0) -Message 'Missing configuration must fail closed.'

  $wrongBranch = [ordered]@{} + $baseSelection
  $wrongBranch.branch = 'not-the-selected-branch'
  $wrongBranchConfig = Join-Path $temporaryDirectory 'wrong-branch.json'
  Write-LauncherJsonAtomically -Path $wrongBranchConfig -Value $wrongBranch
  $wrongBranchResult = Invoke-DryRun -ConfigPath $wrongBranchConfig
  Assert-TestResult -Condition ($wrongBranchResult.exitCode -ne 0) -Message 'Wrong branch must fail closed.'

  $wrongHead = [ordered]@{} + $baseSelection
  $wrongHead.expectedHead = ('0' * 40)
  $wrongHeadConfig = Join-Path $temporaryDirectory 'wrong-head.json'
  Write-LauncherJsonAtomically -Path $wrongHeadConfig -Value $wrongHead
  $wrongHeadResult = Invoke-DryRun -ConfigPath $wrongHeadConfig
  Assert-TestResult -Condition ($wrongHeadResult.exitCode -ne 0) -Message 'Wrong expectedHead must fail closed.'

  $missingAncestorsField = [ordered]@{} + $baseSelection
  $missingAncestorsField.Remove('requiredAncestors')
  $missingAncestorsFieldConfig = Join-Path $temporaryDirectory 'missing-ancestors-field.json'
  Write-LauncherJsonAtomically -Path $missingAncestorsFieldConfig -Value $missingAncestorsField
  $missingAncestorsFieldResult = Invoke-DryRun -ConfigPath $missingAncestorsFieldConfig
  Assert-TestResult -Condition ($missingAncestorsFieldResult.exitCode -ne 0) -Message 'Missing requiredAncestors field must fail closed.'

  $presentAncestor = [ordered]@{} + $baseSelection
  $presentAncestor.requiredAncestors = @($baseSelection.expectedHead)
  $presentAncestorConfig = Join-Path $temporaryDirectory 'present-ancestor.json'
  Write-LauncherJsonAtomically -Path $presentAncestorConfig -Value $presentAncestor
  $presentAncestorResult = Invoke-DryRun -ConfigPath $presentAncestorConfig
  Assert-TestResult -Condition ($presentAncestorResult.exitCode -eq 0) -Message 'A selected HEAD must satisfy itself as a required ancestor.'
  Assert-TestResult -Condition ($presentAncestorResult.output -match 'requiredAncestorChecks') -Message 'Successful dry-run must expose required ancestor receipt data.'

  $nonAncestorOutput = Invoke-LauncherGit -Repository ([string]$baseSelection.canonicalRepo) -Arguments @('rev-list', '--all', '--not', $baseSelection.expectedHead)
  $outsideAncestor = ($nonAncestorOutput -split "`r?`n" | Where-Object { $_ } | Select-Object -First 1)
  Assert-TestResult -Condition (-not [string]::IsNullOrWhiteSpace($outsideAncestor)) -Message 'Fixture repository must provide a known non-ancestor commit.'
  $missingAncestor = [ordered]@{} + $baseSelection
  $missingAncestor.requiredAncestors = @($outsideAncestor)
  $missingAncestorConfig = Join-Path $temporaryDirectory 'missing-ancestor.json'
  Write-LauncherJsonAtomically -Path $missingAncestorConfig -Value $missingAncestor
  $missingAncestorResult = Invoke-DryRun -ConfigPath $missingAncestorConfig
  Assert-TestResult -Condition ($missingAncestorResult.exitCode -ne 0) -Message 'Correct path, branch, and HEAD with a missing feature ancestor must fail closed.'
  Assert-TestResult -Condition ($missingAncestorResult.output -match 'missing required ancestor') -Message 'Missing feature ancestor failure must identify the failed gate.'

  $correct = Invoke-DryRun -ConfigPath $correctConfig
  Assert-TestResult -Condition ($correct.exitCode -eq 0) -Message 'Correct clean configuration must pass the gates.'

  $canonicalRepo = [string]$baseSelection.canonicalRepo
  & git -C $canonicalRepo -c ("safe.directory=" + ($canonicalRepo -replace '\\', '/')) worktree add -b $dirtyBranch $dirtyWorktree master | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated dirty-worktree fixture.' }
  $dirtyFixtureCreated = $true
  Set-Content -LiteralPath (Join-Path $dirtyWorktree '.launcher-dirty-probe') -Value 'fixture' -Encoding ASCII
  $dirtySelection = New-SelectionObject -Root $dirtyWorktree
  $dirtyConfig = Join-Path $temporaryDirectory 'dirty.json'
  Write-LauncherJsonAtomically -Path $dirtyConfig -Value $dirtySelection
  $dirty = Invoke-DryRun -ConfigPath $dirtyConfig
  Assert-TestResult -Condition ($dirty.exitCode -ne 0) -Message 'Dirty worktree with requireClean=true must fail closed.'

  Write-Host 'PodPlayer Dev launcher fail-closed smoke passed.' -ForegroundColor Green
  exit 0
} finally {
  if ($dirtyFixtureCreated) {
    if (Test-Path -LiteralPath (Join-Path $dirtyWorktree '.launcher-dirty-probe')) {
      Remove-Item -LiteralPath (Join-Path $dirtyWorktree '.launcher-dirty-probe') -Force
    }
    & git -C ([string](New-SelectionObject -Root $SourceRoot).canonicalRepo) -c ("safe.directory=" + (([string](New-SelectionObject -Root $SourceRoot).canonicalRepo) -replace '\\', '/')) worktree remove --force $dirtyWorktree 2>$null
    & git -C ([string](New-SelectionObject -Root $SourceRoot).canonicalRepo) -c ("safe.directory=" + (([string](New-SelectionObject -Root $SourceRoot).canonicalRepo) -replace '\\', '/')) branch -D $dirtyBranch 2>$null
  }
  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
  }
}
