<#
.SYNOPSIS
  Sandbox-only ASR benchmark harness. It never runs as part of the app.

.DESCRIPTION
  The caller must explicitly supply one existing PodPlayerDev audio file. The
  audio is read in place and never copied, deleted, or modified. All worker
  artifacts and metrics are written under the caller-supplied PodPlayerSandbox
  root. Do not use this script against prod userData.

.EXAMPLE
  .\scripts\asr_benchmark.ps1 `
    -InputAudio 'D:\MyYesPlayerMusic\PodPlayerData\PodPlayerDev\podcasts\sample.mp3' `
    -ModelDir 'D:\MyYesPlayerMusic\PodPlayerData\_models\asr\sensevoice-small' `
    -SandboxRoot 'D:\MyYesPlayerMusic\PodPlayerData\PodPlayerSandbox' `
    -DevRootPid 1234
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$InputAudio,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ModelDir,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$SandboxRoot,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, [int]::MaxValue)]
  [int]$DevRootPid,

  [ValidateRange(1, 32)]
  [int]$NumThreads = 4,

  [ValidateSet('auto', 'zh', 'en', 'yue', 'ja', 'ko')]
  [string]$Language = 'auto'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-ExistingFile([string]$PathValue, [string]$Label) {
  $item = Get-Item -LiteralPath $PathValue -ErrorAction Stop
  if (-not $item.PSIsContainer) { return $item.FullName }
  throw "$Label must be a file: $PathValue"
}

function Resolve-ExistingDirectory([string]$PathValue, [string]$Label) {
  $item = Get-Item -LiteralPath $PathValue -ErrorAction Stop
  if ($item.PSIsContainer) { return $item.FullName }
  throw "$Label must be a directory: $PathValue"
}

function Get-TreeProcessIds([int]$RootPid) {
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $children = @{}
  foreach ($row in $all) {
    $parent = [int]$row.ParentProcessId
    if (-not $children.ContainsKey($parent)) { $children[$parent] = @() }
    $children[$parent] += [int]$row.ProcessId
  }
  $out = New-Object System.Collections.Generic.List[int]
  $queue = New-Object System.Collections.Generic.Queue[int]
  $queue.Enqueue($RootPid)
  while ($queue.Count -gt 0) {
    $candidatePid = $queue.Dequeue()
    if ($out.Contains($candidatePid)) { continue }
    $out.Add($candidatePid)
    if ($children.ContainsKey($candidatePid)) {
      foreach ($child in $children[$candidatePid]) { $queue.Enqueue($child) }
    }
  }
  return @($out)
}

function Get-ProcessMetrics([int[]]$ProcessIds) {
  $cpuSeconds = 0.0
  $workingSet = [int64]0
  $privateBytes = [int64]0
  $alive = 0
  foreach ($processId in @($ProcessIds)) {
    try {
      $process = Get-Process -Id $processId -ErrorAction Stop
      $cpuSeconds += [double]$process.CPU
      $workingSet += [int64]$process.WorkingSet64
      $privateBytes += [int64]$process.PrivateMemorySize64
      $alive += 1
    } catch {
      # The process may exit between tree enumeration and sampling.
    }
  }
  return [pscustomobject]@{
    CpuSeconds = $cpuSeconds
    WorkingSetBytes = $workingSet
    PrivateBytes = $privateBytes
    AliveCount = $alive
  }
}

function Get-FileSize([string]$PathValue) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) { return 0 }
  return [int64](Get-Item -LiteralPath $PathValue).Length
}

function Convert-WorkerEvents([string]$StdoutPath) {
  if (-not (Test-Path -LiteralPath $StdoutPath -PathType Leaf)) { return @() }
  $events = @()
  foreach ($line in Get-Content -LiteralPath $StdoutPath -Encoding UTF8) {
    if (-not $line.StartsWith('@@ASR@@')) { continue }
    try { $events += ($line.Substring(7) | ConvertFrom-Json) } catch {}
  }
  return @($events)
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$audioPath = Resolve-ExistingFile $InputAudio 'InputAudio'
$modelsPath = Resolve-ExistingDirectory $ModelDir 'ModelDir'
$sandboxPath = [System.IO.Path]::GetFullPath($SandboxRoot)

if ($audioPath -notmatch '(?i)\\PodPlayerData\\PodPlayerDev\\') {
  throw 'InputAudio must be an explicitly supplied PodPlayerDev local-audio path.'
}
if ($sandboxPath -notmatch '(?i)\\PodPlayerSandbox(?:\\|$)') {
  throw 'SandboxRoot must be inside the PodPlayerSandbox profile. Refusing to write elsewhere.'
}
if (-not (Get-Process -Id $DevRootPid -ErrorAction SilentlyContinue)) {
  throw "DevRootPid $DevRootPid is not running. Refusing to report a missing Dev tree."
}

$workerPath = Join-Path $repoRoot 'src\electron\asrWorker.js'
$electronPath = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
$modelFile = Join-Path $modelsPath 'model.int8.onnx'
$tokensFile = Join-Path $modelsPath 'tokens.txt'
$vadModel = Join-Path $modelsPath 'silero_vad.onnx'
foreach ($required in @($workerPath, $electronPath, $modelFile, $tokensFile, $vadModel)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required benchmark dependency is missing: $required"
  }
}

$runId = 'asr-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$runDir = Join-Path $sandboxPath (Join-Path 'benchmarks' $runId)
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$stdoutPath = Join-Path $runDir 'worker.stdout.log'
$stderrPath = Join-Path $runDir 'worker.stderr.log'
$metricsPath = Join-Path $runDir 'metrics.json'
$resultPath = Join-Path $runDir 'result.json'
$wavPath = Join-Path $runDir 'audio16k.wav'

$workerParams = @{
  audioPath = $audioPath
  workDir = $runDir
  modelFile = $modelFile
  tokensFile = $tokensFile
  vadModel = $vadModel
  numThreads = $NumThreads
  language = $Language
  model = 'SenseVoiceSmall'
} | ConvertTo-Json -Compress

$oldElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
$env:ELECTRON_RUN_AS_NODE = '1'
$startedAt = Get-Date
$samples = New-Object System.Collections.Generic.List[object]
$peakWorkerWorkingSet = [int64]0
$peakWorkerPrivate = [int64]0
$peakDevWorkingSet = [int64]0
$peakDevPrivate = [int64]0
$peakWavBytes = [int64]0
$lastWorker = $null
$lastDev = $null
$lastSampleAt = Get-Date
$child = $null
$workerExitCode = -1
$failure = $null

try {
  # Preserve each JSON argument as one argv element for asrWorker.js.
  $workerArg = '"' + $workerPath.Replace('"', '\"') + '"'
  $jsonArg = '"' + $workerParams.Replace('"', '\"') + '"'
  $child = Start-Process -FilePath $electronPath -ArgumentList @($workerArg, $jsonArg) -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

  while (-not $child.HasExited) {
    Start-Sleep -Seconds 1
    $now = Get-Date
    $elapsedSec = [Math]::Max(0.001, ($now - $lastSampleAt).TotalSeconds)
    $worker = Get-ProcessMetrics @($child.Id)
    $devIds = Get-TreeProcessIds $DevRootPid
    $dev = Get-ProcessMetrics $devIds
    $workerCpuPct = if ($lastWorker) { (($worker.CpuSeconds - $lastWorker.CpuSeconds) / $elapsedSec) * 100.0 } else { 0.0 }
    $devCpuPct = if ($lastDev) { (($dev.CpuSeconds - $lastDev.CpuSeconds) / $elapsedSec) * 100.0 } else { 0.0 }
    $peakWorkerWorkingSet = [Math]::Max($peakWorkerWorkingSet, $worker.WorkingSetBytes)
    $peakWorkerPrivate = [Math]::Max($peakWorkerPrivate, $worker.PrivateBytes)
    $peakDevWorkingSet = [Math]::Max($peakDevWorkingSet, $dev.WorkingSetBytes)
    $peakDevPrivate = [Math]::Max($peakDevPrivate, $dev.PrivateBytes)
    $peakWavBytes = [Math]::Max($peakWavBytes, (Get-FileSize $wavPath))
    $samples.Add([pscustomobject]@{
      at = $now.ToString('o')
      workerCpuPct = [Math]::Round($workerCpuPct, 2)
      workerWorkingSetBytes = $worker.WorkingSetBytes
      workerPrivateBytes = $worker.PrivateBytes
      devTreeCpuPct = [Math]::Round($devCpuPct, 2)
      devTreeWorkingSetBytes = $dev.WorkingSetBytes
      devTreePrivateBytes = $dev.PrivateBytes
      devTreeProcessCount = $dev.AliveCount
      tempWavBytes = Get-FileSize $wavPath
    })
    $lastWorker = $worker
    $lastDev = $dev
    $lastSampleAt = $now
    $child.Refresh()
  }
  $child.WaitForExit()
  try { $workerExitCode = $child.ExitCode } catch {}
} catch {
  $failure = $_.Exception.Message
} finally {
  if ($null -eq $oldElectronRunAsNode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
  else { $env:ELECTRON_RUN_AS_NODE = $oldElectronRunAsNode }
}

$finishedAt = Get-Date
$events = Convert-WorkerEvents $stdoutPath
$doneEvents = @($events | Where-Object { $_.type -eq 'done' })
$errorEvents = @($events | Where-Object { $_.type -eq 'error' })
$doneEvent = if ($doneEvents.Count) { $doneEvents[-1] } else { $null }
$errorEvent = if ($errorEvents.Count) { $errorEvents[-1] } else { $null }
$audioDurationMs = if ($doneEvent) { [int64]$doneEvent.durationMs } else { 0 }
$wallMs = [int64]($finishedAt - $startedAt).TotalMilliseconds
$result = [ordered]@{
  status = if ($failure -or $errorEvent -or -not $doneEvent) { 'failed' } else { 'completed' }
  startedAt = $startedAt.ToString('o')
  finishedAt = $finishedAt.ToString('o')
  input = @{ audioPath = $audioPath; readOnly = $true }
  sandboxRunDir = $runDir
  worker = @{ pid = if ($child) { $child.Id } else { 0 }; exitCode = $workerExitCode }
  duration = @{
    wallMs = $wallMs
    audioDurationMs = $audioDurationMs
    realTimeFactor = if ($audioDurationMs -gt 0) { [Math]::Round($wallMs / [double]$audioDurationMs, 4) } else { $null }
  }
  peaks = @{
    workerWorkingSetBytes = $peakWorkerWorkingSet
    workerPrivateBytes = $peakWorkerPrivate
    devTreeWorkingSetBytes = $peakDevWorkingSet
    devTreePrivateBytes = $peakDevPrivate
    tempWavBytes = $peakWavBytes
  }
  artifacts = @{
    tempWavCurrentBytes = Get-FileSize $wavPath
    segmentsJsonlBytes = Get-FileSize (Join-Path $runDir 'segments.jsonl')
    segmentsJsonBytes = Get-FileSize (Join-Path $runDir 'segments.json')
    transcriptTxtBytes = Get-FileSize (Join-Path $runDir 'transcript.txt')
    transcriptSrtBytes = Get-FileSize (Join-Path $runDir 'transcript.srt')
    stdoutBytes = Get-FileSize $stdoutPath
    stderrBytes = Get-FileSize $stderrPath
  }
  error = if ($failure) { $failure } elseif ($errorEvent) { $errorEvent.msg } elseif (-not $doneEvent) { 'worker exited without a done event' } else { '' }
}

$samples.ToArray() | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metricsPath -Encoding UTF8
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultPath -Encoding UTF8
Write-Host "ASR benchmark result: $($result.status)"
Write-Host "Sandbox artifacts: $runDir"
if ($result.status -ne 'completed') { exit 1 }
