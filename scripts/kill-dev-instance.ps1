# Kill the DEV instance reliably (main + renderer + survivors after terminal close / tray).
# Kill by project electron.exe path because renderers listen on no port; spare a LIVE sandbox
# (ports 20202/27234). ASCII-only + single-line Where-Object for Windows PowerShell 5.1.
#
# NOTE on the 2026-06-27 "DB can't open" saga: the deepest cause was environment, not this script
# -- the assistant tool ran as Administrator in a sandbox while the human double-clicks as a
# different user (Fuji); whichever account's instance holds the IndexedDB lock blocks the other,
# and neither can kill the other's processes. So: do NOT leave stray dev instances from another
# account/session running. This script still reliably clears THIS user's dev instances.

$ErrorActionPreference = 'SilentlyContinue'
$projDir = 'D:\MyYesPlayerMusic\YesPlayMusic\node_modules\'
$all = Get-CimInstance Win32_Process

function Get-Tree($rootPid) {
  $acc = @([int]$rootPid)
  $kids = $all | Where-Object { $_.ParentProcessId -eq $rootPid }
  foreach ($c in $kids) { $acc += Get-Tree ([int]$c.ProcessId) }
  return $acc
}

$spare = @()
foreach ($sbPort in 20202, 27234) {
  $owners = (Get-NetTCPConnection -State Listen -LocalPort $sbPort -ErrorAction SilentlyContinue).OwningProcess
  foreach ($owner in $owners) { if ($owner) { $spare += Get-Tree ([int]$owner) } }
}
$spare = $spare | Sort-Object -Unique

$elec = $all | Where-Object { $_.Name -eq 'electron.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($projDir) }
foreach ($p in $elec) {
  if ($spare -notcontains [int]$p.ProcessId) { & taskkill /F /T /PID $p.ProcessId 2>$null | Out-Null }
}

foreach ($devPort in 20201, 10755, 27233) {
  $owners = (Get-NetTCPConnection -State Listen -LocalPort $devPort -ErrorAction SilentlyContinue).OwningProcess
  foreach ($owner in $owners) { if ($owner -and ($spare -notcontains [int]$owner)) { & taskkill /F /T /PID $owner 2>$null | Out-Null } }
}