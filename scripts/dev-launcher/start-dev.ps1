[CmdletBinding()]
param(
  [string]$ConfigPath,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DevLauncher.Common.ps1')

$source = $null
try {
  $launcher = Assert-LauncherIntegrity -LauncherRoot $PSScriptRoot
  if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $launcher.root 'selected-source.json'
  }
  $selection = Read-LauncherJson -Path $ConfigPath
  $source = Assert-SelectedDevSource -Selection $selection

  if ($DryRun) {
    Write-Host '[dry-run] Source gates passed; no process was stopped or launched.' -ForegroundColor Green
    [pscustomobject]@{
      sourceRoot = $source.sourceRoot
      branch = $source.actualBranch
      head = $source.actualHead
      workingTreeClean = $source.workingTreeClean
      profile = $script:DevProfile
      ports = $script:DevPorts
    } | ConvertTo-Json -Compress
    exit 0
  }

  $dependency = Get-NodeModulesMode -SourceRoot $source.sourceRoot -CanonicalRepo $source.canonicalRepo
  $receiptPath = Join-Path $launcher.root 'runtime-receipt.json'

  Write-Host ''
  Write-Host '============================================================'
  Write-Host ' PodPlayer Dev Launcher - verified source'
  Write-Host " SOURCE ROOT: $($source.sourceRoot)"
  Write-Host " BRANCH:      $($source.actualBranch)"
  Write-Host " HEAD:        $($source.actualHead)"
  Write-Host " PROFILE:     $script:DevProfile"
  Write-Host " USER DATA:   $script:DevUserData"
  Write-Host " PORTS:       webpack=20201 neapi=10755 express=27233"
  Write-Host " DEPENDENCY:  $($dependency.mode)"
  Write-Host '============================================================'

  # All source gates have passed. Only now may the launcher stop an existing Dev profile.
  Stop-DevProfileProcesses -ReceiptPath $receiptPath | Out-Null

  $shortHead = $source.actualHead.Substring(0, 7)
  $launchToken = [Guid]::NewGuid().ToString('N')
  $env:PODPLAYER_PROFILE = $script:DevProfile
  $env:DEV_SERVER_PORT = '20201'
  $env:VUE_APP_ELECTRON_API_URL_DEV = 'http://127.0.0.1:10755'
  $env:PODPLAYER_DEV_SOURCE_ROOT = $source.sourceRoot
  $env:PODPLAYER_DEV_SOURCE_BRANCH = $source.actualBranch
  $env:PODPLAYER_DEV_SOURCE_HEAD = $source.actualHead
  $env:PODPLAYER_DEV_LAUNCH_TOKEN = $launchToken
  $env:PODPLAYER_RUNTIME_RECEIPT = $receiptPath
  $env:PATH = 'C:\nvm4w\nodejs;' + $env:PATH

  $title = "PodPlayer Dev $($source.actualBranch)@$shortHead"
  $escapedSource = $source.sourceRoot.Replace('"', '""')
  $command = "title $title & echo SOURCE ROOT: $escapedSource & echo BRANCH: $($source.actualBranch) & echo HEAD: $($source.actualHead) & echo PROFILE: dev & call yarn.cmd --cwd `"$escapedSource`" electron:serve"
  $launcherProcess = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', $command) -WorkingDirectory $source.sourceRoot -PassThru
  $launcherStartedAt = $launcherProcess.StartTime.ToUniversalTime().ToString('o')

  if (-not (Wait-DevPortsReady -TimeoutSeconds 90)) {
    $timeoutStop = Stop-DevProcessTreeIdempotently -ProcessId $launcherProcess.Id -ExpectedStartedAt $launcherStartedAt -Adapter (New-DevProcessAdapter)
    if ($timeoutStop.status -notin @('stopped', 'already-stopped')) {
      Write-Host "[launcher] Timed-out Dev wrapper could not be stopped cleanly. pid=$($launcherProcess.Id) status=$($timeoutStop.status)" -ForegroundColor Yellow
    }
    Write-LauncherFailure 'Dev ports did not become ready within 90 seconds. The new Dev process was stopped.'
  }

  $portOwners = Get-DevPortOwners
  $liveLauncher = Get-Process -Id $launcherProcess.Id -ErrorAction SilentlyContinue
  $relevantProcess = $liveLauncher
  if ($null -eq $relevantProcess) {
    $relevantProcess = $portOwners | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
  }
  if ($null -eq $relevantProcess) {
    Write-LauncherFailure 'Dev ports are listening but no owning process can be audited for the runtime receipt.'
  }
  $relevantStartedAt = $relevantProcess.StartTime.ToUniversalTime().ToString('o')
  $treePids = Get-DevProcessTree -RootPid $relevantProcess.Id
  $audit = Get-ProcessAudit -Pids ($treePids + $portOwners | Sort-Object -Unique)
  $electronProcess = $audit | Where-Object { $_.name -ieq 'electron.exe' } | Select-Object -First 1
  $webpackProcess = $audit | Where-Object { $_.commandLine -match 'vue-cli-service|webpack' } | Select-Object -First 1

  $receipt = [ordered]@{
    actualSourceRoot = $source.sourceRoot
    actualBranch = $source.actualBranch
    actualHead = $source.actualHead
    workingTreeClean = $source.workingTreeClean
    profile = $script:DevProfile
    userData = $script:DevUserData
    ports = [ordered]@{ webpack = 20201; neapi = 10755; express = 27233 }
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    launcherVersion = $script:DevLauncherVersion
    launcherSourceHash = $launcher.launcherSourceHash
    launcherRoot = $launcher.root
    relevantPid = $relevantProcess.Id
    relevantProcessStartedAt = $relevantStartedAt
    launchWrapperPid = $launcherProcess.Id
    launchWrapperStartedAt = $launcherStartedAt
    launchToken = $launchToken
    dependencyMode = $dependency.mode
    dependencyTarget = $dependency.target
    launchWorkingDirectory = $source.sourceRoot
    portOwnerPids = @($portOwners)
    processAudit = @($audit)
    webpackProcess = $webpackProcess
    electronProcess = $electronProcess
  }
  Write-LauncherJsonAtomically -Path $receiptPath -Value $receipt
  $errorResolution = Resolve-LauncherStartError -LauncherRoot $launcher.root -SourceRoot $source.sourceRoot -Branch $source.actualBranch -Head $source.actualHead

  Write-Host "[ready] Dev started from $($source.actualBranch)@$shortHead. Receipt: $receiptPath errorState=$errorResolution" -ForegroundColor Green
  exit 0
} catch {
  try {
    $failure = [ordered]@{
      status = 'failed'
      failedAt = (Get-Date).ToUniversalTime().ToString('o')
      launcherVersion = $script:DevLauncherVersion
      error = $_.Exception.Message
      selectedSourceRoot = if ($source) { $source.sourceRoot } else { $null }
      selectedBranch = if ($source) { $source.actualBranch } else { $null }
      selectedHead = if ($source) { $source.actualHead } else { $null }
    }
    Write-LauncherJsonAtomically -Path (Join-Path $PSScriptRoot 'last-start-error.json') -Value $failure
  } catch {
    # The original failure is still printed below if the audit write also fails.
  }
  if ($_.Exception.Message) {
    Write-Host "[launcher-error] $($_.Exception.Message)" -ForegroundColor Red
  }
  exit 1
}
