[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DevLauncher.Common.ps1')

function Assert-TestResult {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$Message
  )

  if (-not $Condition) {
    throw "TEST FAIL: $Message"
  }
}

function Assert-Throws {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Action,
    [Parameter(Mandatory = $true)][string]$Message
  )

  $threw = $false
  try {
    & $Action
  } catch {
    $threw = $true
  }
  Assert-TestResult -Condition $threw -Message $Message
}

function New-FakeProcess {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][datetime]$StartedAt
  )

  return [pscustomobject]@{
    Id = $ProcessId
    StartTime = $StartedAt
    ProcessName = 'cmd'
  }
}

function New-FakeCleanupAdapter {
  param(
    [hashtable]$Processes = @{},
    [int[]]$PortOwners = @(),
    [hashtable]$Trees = @{},
    [int]$TaskkillExitCode = 0,
    [bool]$RemoveProcessOnStop = $true,
    [bool]$ReleasePortsOnStop = $true
  )

  $state = [pscustomobject]@{
    Processes = $Processes
    PortOwners = @($PortOwners)
    Trees = $Trees
    TaskkillExitCode = $TaskkillExitCode
    RemoveProcessOnStop = $RemoveProcessOnStop
    ReleasePortsOnStop = $ReleasePortsOnStop
    StopCalls = New-Object System.Collections.Generic.List[int]
  }
  $stateRef = $state

  $adapter = [pscustomobject]@{
    GetProcess = ({
      param([int]$ProcessId)
      if ($stateRef.Processes.ContainsKey($ProcessId)) {
        return $stateRef.Processes[$ProcessId]
      }
    }.GetNewClosure())
    StopProcessTree = ({
      param([int]$ProcessId)
      $stateRef.StopCalls.Add($ProcessId) | Out-Null
      if ($stateRef.RemoveProcessOnStop) {
        $stateRef.Processes.Remove($ProcessId) | Out-Null
      }
      if ($stateRef.ReleasePortsOnStop) {
        $stateRef.PortOwners = @()
      }
      return [pscustomobject]@{
        exitCode = $stateRef.TaskkillExitCode
        output = 'fake taskkill'
        invocationError = $null
      }
    }.GetNewClosure())
    GetPortOwners = ({
      @($stateRef.PortOwners)
    }.GetNewClosure())
    GetProcessTree = ({
      param([int]$RootPid)
      if ($stateRef.Trees.ContainsKey($RootPid)) {
        return @($stateRef.Trees[$RootPid])
      }
      return @($RootPid)
    }.GetNewClosure())
    Sleep = ({
      param([int]$Milliseconds)
      # Tests advance fake state synchronously; no real wait is needed.
    }.GetNewClosure())
  }

  return [pscustomobject]@{ adapter = $adapter; state = $state }
}

function New-FakeReceipt {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][datetime]$StartedAt
  )

  return [ordered]@{
    profile = 'dev'
    relevantPid = $ProcessId
    relevantProcessStartedAt = $StartedAt.ToUniversalTime().ToString('o')
  }
}

function Write-FakeReceipt {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Receipt
  )

  Write-LauncherJsonAtomically -Path $Path -Value $Receipt
}

$temporaryDirectory = Join-Path $env:TEMP ('PodPlayerDevLauncher-cleanup-' + [Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
  $receiptPath = Join-Path $temporaryDirectory 'runtime-receipt.json'
  $previousReceiptPath = Join-Path $temporaryDirectory 'runtime-receipt.previous.json'
  $startedAt = [datetime]::UtcNow.AddMinutes(-2)

  # No prior receipt or ports is intentionally a no-op.
  $fixture = New-FakeCleanupAdapter
  $result = Stop-DevProfileProcesses -ReceiptPath $receiptPath -Adapter $fixture.adapter -PortReleaseAttempts 0
  Assert-TestResult -Condition ($result.status -eq 'no-previous-dev') -Message 'No receipt and no Dev ports must be idempotent.'
  Assert-TestResult -Condition ($fixture.state.StopCalls.Count -eq 0) -Message 'No receipt must not attempt a process stop.'

  # A receipt whose PID has already exited is stale, not an error, once ports are free.
  Write-FakeReceipt -Path $receiptPath -Receipt (New-FakeReceipt -ProcessId 3100 -StartedAt $startedAt)
  $fixture = New-FakeCleanupAdapter
  $result = Stop-DevProfileProcesses -ReceiptPath $receiptPath -Adapter $fixture.adapter -PortReleaseAttempts 0
  Assert-TestResult -Condition ($result.status -eq 'already-stopped') -Message 'An exited receipt PID must be already-stopped.'
  Assert-TestResult -Condition (-not (Test-Path -LiteralPath $receiptPath)) -Message 'A stale receipt must be removed after ports are confirmed free.'
  Assert-TestResult -Condition (Test-Path -LiteralPath $previousReceiptPath) -Message 'A stale receipt must be retained in the bounded previous receipt.'

  # The process can disappear between the first check and taskkill. A non-zero
  # taskkill result is still success only because the final process and ports are gone.
  Write-FakeReceipt -Path $receiptPath -Receipt (New-FakeReceipt -ProcessId 3200 -StartedAt $startedAt)
  $fixture = New-FakeCleanupAdapter -Processes @{ 3200 = (New-FakeProcess -ProcessId 3200 -StartedAt $startedAt) } -PortOwners @(3201, 3202) -Trees @{ 3200 = @(3200, 3201, 3202) } -TaskkillExitCode 128 -RemoveProcessOnStop $true -ReleasePortsOnStop $true
  $result = Stop-DevProfileProcesses -ReceiptPath $receiptPath -Adapter $fixture.adapter -PortReleaseAttempts 0
  Assert-TestResult -Condition ($result.status -eq 'stopped') -Message 'A process that exits during taskkill must be treated as stopped.'
  Assert-TestResult -Condition ($result.stop.taskkill.exitCode -eq 128) -Message 'The race fixture must retain the non-zero taskkill evidence.'
  Assert-TestResult -Condition ($result.released.released) -Message 'Taskkill race success still requires released Dev ports.'

  # A non-zero taskkill while the PID remains alive is a real failure.
  $fixture = New-FakeCleanupAdapter -Processes @{ 3300 = (New-FakeProcess -ProcessId 3300 -StartedAt $startedAt) } -TaskkillExitCode 1 -RemoveProcessOnStop $false -ReleasePortsOnStop $false
  $result = Stop-DevProcessTreeIdempotently -ProcessId 3300 -ExpectedStartedAt $startedAt.ToUniversalTime().ToString('o') -Adapter $fixture.adapter
  Assert-TestResult -Condition ($result.status -eq 'still-running') -Message 'A live PID after taskkill must remain a cleanup failure.'

  # A reused PID must never be sent to taskkill, even when it owns a Dev port.
  $reusedStartedAt = $startedAt.AddMinutes(1)
  Write-FakeReceipt -Path $receiptPath -Receipt (New-FakeReceipt -ProcessId 3400 -StartedAt $startedAt)
  $fixture = New-FakeCleanupAdapter -Processes @{ 3400 = (New-FakeProcess -ProcessId 3400 -StartedAt $reusedStartedAt) } -PortOwners @(3400) -Trees @{ 3400 = @(3400) }
  Assert-Throws -Action { Stop-DevProfileProcesses -ReceiptPath $receiptPath -Adapter $fixture.adapter -PortReleaseAttempts 0 | Out-Null } -Message 'A PID reuse must fail closed.'
  Assert-TestResult -Condition ($fixture.state.StopCalls.Count -eq 0) -Message 'A reused PID must not be terminated.'

  # A corrupted receipt is harmless only when no Dev port is occupied, then it
  # is archived instead of treated as proof for a kill.
  Set-Content -LiteralPath $receiptPath -Value '{ not-json' -Encoding UTF8
  $fixture = New-FakeCleanupAdapter
  $result = Stop-DevProfileProcesses -ReceiptPath $receiptPath -Adapter $fixture.adapter -PortReleaseAttempts 0
  Assert-TestResult -Condition ($result.released.released) -Message 'A corrupted receipt with empty ports must remain restartable.'
  Assert-TestResult -Condition (Test-Path -LiteralPath $previousReceiptPath) -Message 'A corrupted stale receipt must be archived after port confirmation.'

  # A port owner outside the verified receipt tree is never a cleanup target.
  Write-FakeReceipt -Path $receiptPath -Receipt (New-FakeReceipt -ProcessId 3500 -StartedAt $startedAt)
  $fixture = New-FakeCleanupAdapter -Processes @{ 3500 = (New-FakeProcess -ProcessId 3500 -StartedAt $startedAt) } -PortOwners @(3599) -Trees @{ 3500 = @(3500) }
  Assert-Throws -Action { Stop-DevProfileProcesses -ReceiptPath $receiptPath -Adapter $fixture.adapter -PortReleaseAttempts 0 | Out-Null } -Message 'An unrelated Dev-port owner must fail closed.'
  Assert-TestResult -Condition ($fixture.state.StopCalls.Count -eq 0) -Message 'An unrelated port owner must not trigger a root kill.'

  # Normal cleanup stops the verified root, releases ports, archives once, and
  # can be repeated without a second process action.
  Write-FakeReceipt -Path $receiptPath -Receipt (New-FakeReceipt -ProcessId 3600 -StartedAt $startedAt)
  $fixture = New-FakeCleanupAdapter -Processes @{ 3600 = (New-FakeProcess -ProcessId 3600 -StartedAt $startedAt) } -PortOwners @(3601, 3602) -Trees @{ 3600 = @(3600, 3601, 3602) }
  $result = Stop-DevProfileProcesses -ReceiptPath $receiptPath -Adapter $fixture.adapter -PortReleaseAttempts 0
  Assert-TestResult -Condition ($result.status -eq 'stopped') -Message 'A verified prior Dev tree must stop normally.'
  Assert-TestResult -Condition ($fixture.state.StopCalls.Count -eq 1) -Message 'Normal cleanup must stop exactly one verified root.'
  $repeat = Stop-DevProfileProcesses -ReceiptPath $receiptPath -Adapter $fixture.adapter -PortReleaseAttempts 0
  Assert-TestResult -Condition ($repeat.status -eq 'no-previous-dev') -Message 'Repeated cleanup must be idempotent.'
  Assert-TestResult -Condition ($fixture.state.StopCalls.Count -eq 1) -Message 'Repeated cleanup must not issue another stop.'

  # If the root exits but a port stays bound, the port gate is authoritative and
  # the receipt stays current for diagnosis rather than being archived early.
  Write-FakeReceipt -Path $receiptPath -Receipt (New-FakeReceipt -ProcessId 3700 -StartedAt $startedAt)
  $fixture = New-FakeCleanupAdapter -Processes @{ 3700 = (New-FakeProcess -ProcessId 3700 -StartedAt $startedAt) } -PortOwners @(3701) -Trees @{ 3700 = @(3700, 3701) } -TaskkillExitCode 0 -RemoveProcessOnStop $true -ReleasePortsOnStop $false
  Assert-Throws -Action { Stop-DevProfileProcesses -ReceiptPath $receiptPath -Adapter $fixture.adapter -PortReleaseAttempts 0 | Out-Null } -Message 'Released root with occupied Dev port must fail closed.'
  Assert-TestResult -Condition (Test-Path -LiteralPath $receiptPath) -Message 'A receipt must not be archived until ports are released.'

  # A later successful launch archives the old failure into one bounded file so
  # it cannot continue to appear as the current launcher state.
  $errorPath = Join-Path $temporaryDirectory 'last-start-error.json'
  Write-LauncherJsonAtomically -Path $errorPath -Value ([ordered]@{ status = 'failed'; error = 'old failure' })
  $resolution = Resolve-LauncherStartError -LauncherRoot $temporaryDirectory -SourceRoot 'D:\Fake\Source' -Branch 'fake-branch' -Head ('a' * 40)
  Assert-TestResult -Condition ($resolution -eq 'archived') -Message 'A successful launch must archive the old current error.'
  Assert-TestResult -Condition (-not (Test-Path -LiteralPath $errorPath)) -Message 'The old current error must not remain after success.'
  Assert-TestResult -Condition (Test-Path -LiteralPath (Join-Path $temporaryDirectory 'last-start-error.previous.json')) -Message 'The previous launcher error must remain auditable.'

  Write-Host 'PodPlayer Dev launcher cleanup smoke passed.' -ForegroundColor Green
  exit 0
} finally {
  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
  }
}
