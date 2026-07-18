Set-StrictMode -Version Latest

$script:DevLauncherVersion = '1.0.5'
$script:DevProfile = 'dev'
$script:DevPorts = @(20201, 10755, 27233)
$script:DevUserData = 'D:\MyYesPlayerMusic\PodPlayerData\PodPlayerDev'
$script:ManagedLauncherFiles = @(
  'start-dev.bat',
  'start-dev.ps1',
  'select-dev-source.ps1',
  'DevLauncher.Common.ps1',
  'README.md'
)

function Write-LauncherFailure {
  param([Parameter(Mandatory = $true)][string]$Message)

  Write-Host ''
  Write-Host '[FAIL-CLOSED] PodPlayer Dev was not started.' -ForegroundColor Red
  Write-Host $Message -ForegroundColor Red
  Write-Host 'Fix the selected source or launcher configuration, then try again.' -ForegroundColor Yellow
  throw $Message
}

function Get-LauncherPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    Write-LauncherFailure "Required path does not exist: $Path"
  }

  return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path).TrimEnd('\\')
}

function Test-LauncherPathEquals {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )

  return [string]::Equals(
    ([System.IO.Path]::GetFullPath($Left).TrimEnd('\\')),
    ([System.IO.Path]::GetFullPath($Right).TrimEnd('\\')),
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

function Invoke-LauncherGit {
  param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $safeRepository = $Repository -replace '\\', '/'
  $output = & git -C $Repository -c "safe.directory=$safeRepository" @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    $joined = ($output -join [Environment]::NewLine).Trim()
    Write-LauncherFailure "Git command failed in ${Repository}: git $($Arguments -join ' ')`n$joined"
  }

  return ($output -join [Environment]::NewLine).Trim()
}

function Get-LauncherWorktreePaths {
  param([Parameter(Mandatory = $true)][string]$Repository)

  $porcelain = Invoke-LauncherGit -Repository $Repository -Arguments @('worktree', 'list', '--porcelain')
  $paths = New-Object System.Collections.Generic.List[string]
  foreach ($line in ($porcelain -split "`r?`n")) {
    if ($line.StartsWith('worktree ')) {
      $paths.Add((Get-LauncherPath -Path $line.Substring(9)))
    }
  }

  if ($paths.Count -eq 0) {
    Write-LauncherFailure "Git returned no registered worktrees for $Repository."
  }

  return @($paths)
}

function Get-LauncherFileHash {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-LauncherFailure "Required file does not exist: $Path"
  }

  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Get-LauncherStringHash {
  param([Parameter(Mandatory = $true)][string]$Text)

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '')
  } finally {
    $sha.Dispose()
  }
}

function Get-LauncherBundleHash {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string[]]$Files
  )

  $entries = foreach ($file in ($Files | Sort-Object)) {
    "${file}:$((Get-LauncherFileHash -Path (Join-Path $Root $file)))"
  }
  return Get-LauncherStringHash -Text (($entries -join "`n") + "`n")
}

function Read-LauncherJson {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-LauncherFailure "Required JSON file does not exist: $Path"
  }

  try {
    return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
  } catch {
    Write-LauncherFailure "Cannot parse JSON file ${Path}: $($_.Exception.Message)"
  }
}

function Write-LauncherJsonAtomically {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )

  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  $temporaryPath = Join-Path $directory ('.' + [System.IO.Path]::GetFileName($Path) + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
  }
}

function Read-LauncherJsonBestEffort {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return [pscustomobject]@{
      exists = $false
      valid = $true
      value = $null
      error = $null
    }
  }

  try {
    return [pscustomobject]@{
      exists = $true
      valid = $true
      value = (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
      error = $null
    }
  } catch {
    return [pscustomobject]@{
      exists = $true
      valid = $false
      value = $null
      error = $_.Exception.Message
    }
  }
}

function Archive-LauncherStateFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$PreviousPath
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }

  $directory = Split-Path -Parent $PreviousPath
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  $temporaryPath = Join-Path $directory ('.' + [System.IO.Path]::GetFileName($PreviousPath) + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $backupPath = Join-Path $directory ('.' + [System.IO.Path]::GetFileName($PreviousPath) + '.' + [Guid]::NewGuid().ToString('N') + '.bak')
  try {
    Copy-Item -LiteralPath $Path -Destination $temporaryPath -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $PreviousPath -PathType Leaf) {
      [System.IO.File]::Replace($temporaryPath, $PreviousPath, $backupPath)
    } else {
      [System.IO.File]::Move($temporaryPath, $PreviousPath)
    }
    Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    return $true
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
    if (Test-Path -LiteralPath $backupPath) {
      Remove-Item -LiteralPath $backupPath -Force
    }
  }
}

function Resolve-LauncherStartError {
  param(
    [Parameter(Mandatory = $true)][string]$LauncherRoot,
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$Branch,
    [Parameter(Mandatory = $true)][string]$Head
  )

  $errorPath = Join-Path $LauncherRoot 'last-start-error.json'
  if (-not (Test-Path -LiteralPath $errorPath -PathType Leaf)) {
    return 'none'
  }

  $previousPath = Join-Path $LauncherRoot 'last-start-error.previous.json'
  try {
    Archive-LauncherStateFile -Path $errorPath -PreviousPath $previousPath | Out-Null
    return 'archived'
  } catch {
    # A successful launch must never leave an old failure looking current. If an
    # archival rename is unavailable, atomically replace the current error with
    # an explicit resolved record instead.
    $resolved = [ordered]@{
      status = 'resolved'
      resolvedAt = (Get-Date).ToUniversalTime().ToString('o')
      launcherVersion = $script:DevLauncherVersion
      resolution = 'A subsequent verified PodPlayer Dev launch completed successfully.'
      archiveError = $_.Exception.Message
      actualSourceRoot = $SourceRoot
      actualBranch = $Branch
      actualHead = $Head
    }
    Write-LauncherJsonAtomically -Path $errorPath -Value $resolved
    return 'resolved'
  }
}

function Assert-LauncherIntegrity {
  param([Parameter(Mandatory = $true)][string]$LauncherRoot)

  $root = Get-LauncherPath -Path $LauncherRoot
  $manifestPath = Join-Path $root 'launcher-manifest.json'
  $manifest = Read-LauncherJson -Path $manifestPath

  if ($manifest.launcherVersion -ne $script:DevLauncherVersion) {
    Write-LauncherFailure "Launcher version mismatch. expected=$script:DevLauncherVersion actual=$($manifest.launcherVersion)"
  }

  if ($null -eq $manifest.fileHashes) {
    Write-LauncherFailure "Launcher manifest has no fileHashes: $manifestPath"
  }

  foreach ($file in $script:ManagedLauncherFiles) {
    $expectedProperty = $manifest.fileHashes.PSObject.Properties[$file]
    if ($null -eq $expectedProperty) {
      Write-LauncherFailure "Launcher manifest has no hash for $file"
    }

    $actualHash = Get-LauncherFileHash -Path (Join-Path $root $file)
    if ($actualHash -ne $expectedProperty.Value) {
      Write-LauncherFailure "Launcher file hash mismatch for $file. expected=$($expectedProperty.Value) actual=$actualHash"
    }
  }

  $actualBundleHash = Get-LauncherBundleHash -Root $root -Files $script:ManagedLauncherFiles
  if ($actualBundleHash -ne $manifest.launcherSourceHash) {
    Write-LauncherFailure "Launcher bundle hash mismatch. expected=$($manifest.launcherSourceHash) actual=$actualBundleHash"
  }

  return [pscustomobject]@{
    root = $root
    manifest = $manifest
    launcherSourceHash = $actualBundleHash
  }
}

function Get-LauncherWorkingTreeStatus {
  param([Parameter(Mandatory = $true)][string]$Repository)

  return Invoke-LauncherGit -Repository $Repository -Arguments @('status', '--porcelain=v1', '--untracked-files=normal')
}

function Assert-SelectedDevSource {
  param([Parameter(Mandatory = $true)]$Selection)

  foreach ($name in @('canonicalRepo', 'sourceRoot', 'branch', 'expectedHead', 'requireClean')) {
    if ($null -eq $Selection.PSObject.Properties[$name]) {
      Write-LauncherFailure "Selected source has no $name field."
    }
  }

  if ([string]::IsNullOrWhiteSpace([string]$Selection.expectedHead) -or $Selection.expectedHead -notmatch '^[0-9a-fA-F]{40}$') {
    Write-LauncherFailure "Selected source expectedHead is not a full Git SHA: $($Selection.expectedHead)"
  }

  $canonicalRepo = Get-LauncherPath -Path $Selection.canonicalRepo
  $sourceRoot = Get-LauncherPath -Path $Selection.sourceRoot
  $registeredPaths = Get-LauncherWorktreePaths -Repository $canonicalRepo
  $registeredSource = $registeredPaths | Where-Object { Test-LauncherPathEquals -Left $_ -Right $sourceRoot } | Select-Object -First 1
  if ($null -eq $registeredSource) {
    Write-LauncherFailure "Selected source is not a registered worktree of canonical repo. canonicalRepo=$canonicalRepo sourceRoot=$sourceRoot"
  }

  $sourceRegistry = Get-LauncherWorktreePaths -Repository $sourceRoot
  $derivedCanonical = $sourceRegistry | Select-Object -First 1
  if (-not (Test-LauncherPathEquals -Left $canonicalRepo -Right $derivedCanonical)) {
    Write-LauncherFailure "Selected canonical repo does not match the source Git registry. expected=$canonicalRepo actual=$derivedCanonical"
  }

  $actualBranch = Invoke-LauncherGit -Repository $sourceRoot -Arguments @('branch', '--show-current')
  if ([string]::IsNullOrWhiteSpace($actualBranch)) {
    Write-LauncherFailure "Selected source is detached; a named branch is required. sourceRoot=$sourceRoot"
  }
  if ($actualBranch -ne $Selection.branch) {
    Write-LauncherFailure "Selected branch mismatch. expected=$($Selection.branch) actual=$actualBranch sourceRoot=$sourceRoot"
  }

  $actualHead = Invoke-LauncherGit -Repository $sourceRoot -Arguments @('rev-parse', 'HEAD')
  if (-not [string]::Equals($actualHead, [string]$Selection.expectedHead, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-LauncherFailure "Selected HEAD mismatch. expected=$($Selection.expectedHead) actual=$actualHead sourceRoot=$sourceRoot"
  }

  $workingTreeStatus = Get-LauncherWorkingTreeStatus -Repository $sourceRoot
  $workingTreeClean = [string]::IsNullOrWhiteSpace($workingTreeStatus)
  if ([bool]$Selection.requireClean -and -not $workingTreeClean) {
    Write-LauncherFailure "Selected worktree is dirty while requireClean=true. sourceRoot=$sourceRoot`n$workingTreeStatus"
  }

  foreach ($requiredFile in @('package.json', 'vue.config.js', 'yarn.lock', 'src\\background.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $requiredFile) -PathType Leaf)) {
      Write-LauncherFailure "Selected source is missing required project entry: $requiredFile"
    }
  }

  return [pscustomobject]@{
    canonicalRepo = $canonicalRepo
    sourceRoot = $sourceRoot
    actualBranch = $actualBranch
    actualHead = $actualHead
    workingTreeClean = $workingTreeClean
    workingTreeStatus = $workingTreeStatus
  }
}

function Get-NodeModulesMode {
  param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$CanonicalRepo
  )

  $sourceNodeModules = Join-Path $SourceRoot 'node_modules'
  $canonicalNodeModules = Join-Path $CanonicalRepo 'node_modules'
  if (Test-Path -LiteralPath $sourceNodeModules) {
    $item = Get-Item -LiteralPath $sourceNodeModules -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
      return [pscustomobject]@{ mode = 'existing-real'; sourceNodeModules = $sourceNodeModules; target = $null }
    }

    $target = $null
    if ($item.PSObject.Properties['Target']) {
      $target = @($item.Target | Select-Object -First 1)[0]
    }
    if ([string]::IsNullOrWhiteSpace([string]$target)) {
      Write-LauncherFailure "Selected worktree has an unknown node_modules reparse point. Refusing to overwrite: $sourceNodeModules"
    }
    if (-not (Test-LauncherPathEquals -Left $target -Right $canonicalNodeModules)) {
      Write-LauncherFailure "Selected worktree node_modules points to an unexpected target. expected=$canonicalNodeModules actual=$target"
    }
    return [pscustomobject]@{ mode = 'existing-junction'; sourceNodeModules = $sourceNodeModules; target = $canonicalNodeModules }
  }

  if (-not (Test-Path -LiteralPath $canonicalNodeModules -PathType Container)) {
    Write-LauncherFailure "Canonical repo has no node_modules. Automatic installation is forbidden. expected=$canonicalNodeModules"
  }

  $sourceLock = Get-LauncherFileHash -Path (Join-Path $SourceRoot 'yarn.lock')
  $canonicalLock = Get-LauncherFileHash -Path (Join-Path $CanonicalRepo 'yarn.lock')
  if ($sourceLock -ne $canonicalLock) {
    Write-LauncherFailure "yarn.lock mismatch; refusing dependency reuse. source=$sourceLock canonical=$canonicalLock"
  }

  New-Item -ItemType Junction -Path $sourceNodeModules -Target $canonicalNodeModules -ErrorAction Stop | Out-Null
  return [pscustomobject]@{ mode = 'created-junction'; sourceNodeModules = $sourceNodeModules; target = $canonicalNodeModules }
}

function Get-DevPortOwners {
  $owners = New-Object System.Collections.Generic.List[int]
  foreach ($port in $script:DevPorts) {
    $connections = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    foreach ($connection in @($connections)) {
      if ($connection -and $connection.OwningProcess) {
        $owners.Add([int]$connection.OwningProcess)
      }
    }
  }
  return @($owners | Sort-Object -Unique)
}

function Get-DevProcessTree {
  param([Parameter(Mandatory = $true)][int]$RootPid)

  try {
    $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  } catch {
    # WMI metadata is audit-only. A denied query must not make a running Dev
    # process lose its receipt or mask the verified source identity.
    return @($RootPid)
  }
  $result = New-Object System.Collections.Generic.List[int]
  $pending = New-Object System.Collections.Generic.Queue[int]
  $pending.Enqueue($RootPid)
  while ($pending.Count -gt 0) {
    $currentPid = $pending.Dequeue()
    if ($result.Contains($currentPid)) { continue }
    $result.Add($currentPid)
    foreach ($child in $allProcesses | Where-Object { [int]$_.ParentProcessId -eq $currentPid }) {
      $pending.Enqueue([int]$child.ProcessId)
    }
  }
  return @($result)
}

function New-DevProcessAdapter {
  return [pscustomobject]@{
    GetProcess = {
      param([Parameter(Mandatory = $true)][int]$ProcessId)
      Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    }
    StopProcessTree = {
      param([Parameter(Mandatory = $true)][int]$ProcessId)
      Invoke-DevTaskkill -ProcessId $ProcessId
    }
    GetPortOwners = {
      @(Get-DevPortOwners)
    }
    GetProcessTree = {
      param([Parameter(Mandatory = $true)][int]$RootPid)
      @(Get-DevProcessTree -RootPid $RootPid)
    }
    Sleep = {
      param([Parameter(Mandatory = $true)][int]$Milliseconds)
      Start-Sleep -Milliseconds $Milliseconds
    }
  }
}

function Get-DevProcessAdapterMember {
  param(
    [Parameter(Mandatory = $true)]$Adapter,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $member = $Adapter.PSObject.Properties[$Name]
  if ($null -eq $member -or $member.Value -isnot [scriptblock]) {
    throw "Dev process adapter is missing required scriptblock: $Name"
  }
  return $member.Value
}

function Invoke-DevTaskkill {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  # Native-command stderr and a non-zero exit must become structured cleanup
  # evidence. Under a terminating ErrorActionPreference, letting taskkill write
  # directly to the error stream skips the authoritative port-release gate.
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
      $PSNativeCommandUseErrorActionPreference = $false
    }
    $output = @(& taskkill.exe /F /T /PID $ProcessId 2>&1 | ForEach-Object { [string]$_ })
    return [pscustomobject]@{
      exitCode = [int]$LASTEXITCODE
      output = ($output -join [Environment]::NewLine).Trim()
      invocationError = $null
    }
  } catch {
    return [pscustomobject]@{
      exitCode = $null
      output = $null
      invocationError = $_.Exception.Message
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

function Get-ReceiptProcessIdentity {
  param(
    [Parameter(Mandatory = $true)]$Receipt,
    [Parameter(Mandatory = $true)]$Adapter
  )

  if ($null -eq $Receipt.PSObject.Properties['relevantPid'] -or $null -eq $Receipt.PSObject.Properties['relevantProcessStartedAt']) {
    return [pscustomobject]@{ status = 'invalid-receipt'; pid = $null; process = $null; expectedStartedAt = $null; actualStartedAt = $null }
  }

  try {
    $processId = [int]$Receipt.relevantPid
    $expectedStartedAt = ([datetime]$Receipt.relevantProcessStartedAt).ToUniversalTime().ToString('o')
  } catch {
    return [pscustomobject]@{ status = 'invalid-receipt'; pid = $null; process = $null; expectedStartedAt = $null; actualStartedAt = $null }
  }

  $getProcess = Get-DevProcessAdapterMember -Adapter $Adapter -Name 'GetProcess'
  $process = & $getProcess $processId | Select-Object -First 1
  if ($null -eq $process) {
    return [pscustomobject]@{ status = 'not-found'; pid = $processId; process = $null; expectedStartedAt = $expectedStartedAt; actualStartedAt = $null }
  }

  try {
    $actualStartedAt = ([datetime]$process.StartTime).ToUniversalTime().ToString('o')
  } catch {
    return [pscustomobject]@{ status = 'unverifiable-process'; pid = $processId; process = $process; expectedStartedAt = $expectedStartedAt; actualStartedAt = $null }
  }

  if ($actualStartedAt -ne $expectedStartedAt) {
    return [pscustomobject]@{ status = 'pid-reused'; pid = $processId; process = $process; expectedStartedAt = $expectedStartedAt; actualStartedAt = $actualStartedAt }
  }

  return [pscustomobject]@{ status = 'match'; pid = $processId; process = $process; expectedStartedAt = $expectedStartedAt; actualStartedAt = $actualStartedAt }
}

function Stop-DevProcessTreeIdempotently {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$ExpectedStartedAt,
    [Parameter(Mandatory = $true)]$Adapter
  )

  $getProcess = Get-DevProcessAdapterMember -Adapter $Adapter -Name 'GetProcess'
  $before = & $getProcess $ProcessId | Select-Object -First 1
  if ($null -eq $before) {
    return [pscustomobject]@{ status = 'already-stopped'; pid = $ProcessId; taskkill = $null }
  }

  try {
    $actualStartedAt = ([datetime]$before.StartTime).ToUniversalTime().ToString('o')
    $expectedUtc = ([datetime]$ExpectedStartedAt).ToUniversalTime().ToString('o')
  } catch {
    return [pscustomobject]@{ status = 'unverifiable-process'; pid = $ProcessId; taskkill = $null }
  }
  if ($actualStartedAt -ne $expectedUtc) {
    return [pscustomobject]@{ status = 'pid-reused'; pid = $ProcessId; taskkill = $null; expectedStartedAt = $expectedUtc; actualStartedAt = $actualStartedAt }
  }

  $stopProcessTree = Get-DevProcessAdapterMember -Adapter $Adapter -Name 'StopProcessTree'
  try {
    $taskkill = & $stopProcessTree $ProcessId | Select-Object -First 1
  } catch {
    $taskkill = [pscustomobject]@{ exitCode = $null; output = $null; invocationError = $_.Exception.Message }
  }

  # The process can exit after the initial identity check but before taskkill
  # reaches it. Its final presence, not the native exit code, decides whether
  # cleanup succeeded; port release is checked by the caller immediately after.
  $after = & $getProcess $ProcessId | Select-Object -First 1
  if ($null -eq $after) {
    return [pscustomobject]@{ status = 'stopped'; pid = $ProcessId; taskkill = $taskkill }
  }

  return [pscustomobject]@{ status = 'still-running'; pid = $ProcessId; taskkill = $taskkill }
}

function Test-DevPortOwnersBelongToReceipt {
  param(
    [Parameter(Mandatory = $true)]$Receipt,
    [Parameter(Mandatory = $true)][int[]]$Owners,
    [Parameter(Mandatory = $true)]$Adapter
  )

  $identity = Get-ReceiptProcessIdentity -Receipt $Receipt -Adapter $Adapter
  if ($identity.status -ne 'match') {
    return [pscustomobject]@{ trusted = $false; identity = $identity; processTree = @(); foreignOwners = @($Owners) }
  }

  $getProcessTree = Get-DevProcessAdapterMember -Adapter $Adapter -Name 'GetProcessTree'
  $processTree = @(& $getProcessTree $identity.pid | ForEach-Object { [int]$_ } | Sort-Object -Unique)
  if ($processTree -notcontains $identity.pid) {
    $processTree += $identity.pid
  }
  $foreignOwners = @($Owners | Where-Object { $processTree -notcontains $_ })
  return [pscustomobject]@{
    trusted = ($foreignOwners.Count -eq 0)
    identity = $identity
    processTree = @($processTree)
    foreignOwners = $foreignOwners
  }
}

function Wait-DevPortsReleased {
  param(
    [Parameter(Mandatory = $true)]$Adapter,
    [int]$MaxAttempts = 48,
    [int]$SleepMilliseconds = 250
  )

  $getPortOwners = Get-DevProcessAdapterMember -Adapter $Adapter -Name 'GetPortOwners'
  $sleep = Get-DevProcessAdapterMember -Adapter $Adapter -Name 'Sleep'
  for ($attempt = 0; $attempt -le $MaxAttempts; $attempt++) {
    $owners = @(& $getPortOwners | ForEach-Object { [int]$_ } | Sort-Object -Unique)
    if ($owners.Count -eq 0) {
      return [pscustomobject]@{ released = $true; owners = @(); attempts = $attempt }
    }
    if ($attempt -lt $MaxAttempts) {
      & $sleep $SleepMilliseconds
    }
  }

  return [pscustomobject]@{ released = $false; owners = $owners; attempts = $MaxAttempts }
}

function Get-DevPortOwnerAuditText {
  param([Parameter(Mandatory = $true)][int[]]$Owners)

  $audit = @(Get-ProcessAudit -Pids $Owners)
  if ($audit.Count -eq 0) {
    return "owners=$($Owners -join ', ')"
  }
  return ($audit | ForEach-Object {
    "pid=$($_.pid) name=$($_.name) parent=$($_.parentPid) command=$($_.commandLine)"
  }) -join '; '
}

function Stop-DevProfileProcesses {
  param(
    [Parameter(Mandatory = $true)][string]$ReceiptPath,
    $Adapter = $null,
    [int]$PortReleaseAttempts = 48
  )

  if ($null -eq $Adapter) {
    $Adapter = New-DevProcessAdapter
  }

  $receiptState = Read-LauncherJsonBestEffort -Path $ReceiptPath
  $receipt = $receiptState.value
  $getPortOwners = Get-DevProcessAdapterMember -Adapter $Adapter -Name 'GetPortOwners'
  $initialOwners = @(& $getPortOwners | ForEach-Object { [int]$_ } | Sort-Object -Unique)
  $identity = $null
  $stopResult = $null

  if ($receiptState.valid -and $null -ne $receipt -and $receipt.PSObject.Properties['profile'] -and $receipt.profile -eq $script:DevProfile) {
    $identity = Get-ReceiptProcessIdentity -Receipt $receipt -Adapter $Adapter
    if ($identity.status -eq 'pid-reused') {
      Write-LauncherFailure "Previous Dev receipt PID was reused. Refusing to terminate PID $($identity.pid). expectedStart=$($identity.expectedStartedAt) actualStart=$($identity.actualStartedAt)"
    }
    if ($identity.status -eq 'unverifiable-process') {
      Write-LauncherFailure "Previous Dev receipt process cannot be identified safely. Refusing to terminate PID $($identity.pid)."
    }

    if ($identity.status -eq 'match') {
      if ($initialOwners.Count -gt 0) {
        $ownership = Test-DevPortOwnersBelongToReceipt -Receipt $receipt -Owners $initialOwners -Adapter $Adapter
        if (-not $ownership.trusted) {
          $audit = Get-DevPortOwnerAuditText -Owners $initialOwners
          Write-LauncherFailure "Dev ports are owned by a process outside the verified prior Dev tree. Refusing to terminate it. foreignOwners=$($ownership.foreignOwners -join ', ') audit=$audit"
        }
      }
      $stopResult = Stop-DevProcessTreeIdempotently -ProcessId $identity.pid -ExpectedStartedAt $identity.expectedStartedAt -Adapter $Adapter
      if ($stopResult.status -notin @('stopped', 'already-stopped')) {
        Write-LauncherFailure "Verified prior Dev process could not be stopped safely. pid=$($identity.pid) status=$($stopResult.status) taskkillExit=$($stopResult.taskkill.exitCode)"
      }
    } elseif ($initialOwners.Count -gt 0) {
      $audit = Get-DevPortOwnerAuditText -Owners $initialOwners
      Write-LauncherFailure "Dev ports are occupied but the prior receipt cannot prove ownership. receiptStatus=$($identity.status) audit=$audit"
    } else {
      $stopResult = [pscustomobject]@{ status = 'already-stopped'; pid = $identity.pid; taskkill = $null }
    }
  } elseif ($initialOwners.Count -gt 0) {
    $audit = Get-DevPortOwnerAuditText -Owners $initialOwners
    $receiptStatus = if ($receiptState.valid) { 'missing-or-non-dev' } else { 'unreadable' }
    Write-LauncherFailure "Dev ports are occupied but no verified prior Dev receipt authorizes cleanup. receiptStatus=$receiptStatus audit=$audit"
  }

  $release = Wait-DevPortsReleased -Adapter $Adapter -MaxAttempts $PortReleaseAttempts
  if (-not $release.released) {
    $audit = Get-DevPortOwnerAuditText -Owners $release.owners
    Write-LauncherFailure "Dev ports remained occupied after targeted cleanup. owners=$($release.owners -join ', ') audit=$audit"
  }

  # A previous receipt is historical only after the old instance is gone and all
  # three Dev ports have been authoritatively observed as released.
  if ($receiptState.exists) {
    $previousReceiptPath = Join-Path (Split-Path -Parent $ReceiptPath) 'runtime-receipt.previous.json'
    Archive-LauncherStateFile -Path $ReceiptPath -PreviousPath $previousReceiptPath | Out-Null
  }

  return [pscustomobject]@{
    status = if ($null -eq $stopResult) { 'no-previous-dev' } else { $stopResult.status }
    stop = $stopResult
    released = $release
  }
}

function Wait-DevPortsReady {
  param([int]$TimeoutSeconds = 90)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $readyPorts = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $script:DevPorts -contains $_.LocalPort } |
      Select-Object -ExpandProperty LocalPort -Unique)
    if (@($readyPorts).Count -eq $script:DevPorts.Count) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Get-ProcessAudit {
  param([Parameter(Mandatory = $true)][int[]]$Pids)

  try {
    $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    return @($all | Where-Object { $Pids -contains [int]$_.ProcessId } | ForEach-Object {
      [pscustomobject]@{
        pid = [int]$_.ProcessId
        parentPid = [int]$_.ParentProcessId
        name = $_.Name
        executablePath = $_.ExecutablePath
        commandLine = $_.CommandLine
      }
    })
  } catch {
    return @($Pids | ForEach-Object {
      $process = Get-Process -Id $_ -ErrorAction SilentlyContinue
      if ($process) {
        [pscustomobject]@{
          pid = [int]$process.Id
          parentPid = $null
          name = $process.ProcessName
          executablePath = $null
          commandLine = $null
        }
      }
    } | Where-Object { $_ })
  }
}
