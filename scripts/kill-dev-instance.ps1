# Kill the DEV instance reliably (main + renderer + survivors after terminal close / tray).
# Kill by project electron.exe path because renderers listen on no port; spare a LIVE sandbox
# (ports 20202/27234). ASCII-only + single-line Where-Object for Windows PowerShell 5.1.
#
# NOTE on the 2026-06-27 "DB can't open" saga: this script (and the cross-account "lock contention"
# idea) turned out to be a RED HERRING. The real, verified cause was NOT lock contention -- a single
# clean instance failed too. It was: the old data dir C:\Users\Administrator\...\PodPlayerDev got an
# AppContainer ACL from the sandbox, so a Medium-integrity normal double-click could not open the
# IndexedDB there (High-integrity could). Fixed by moving userData to a clean fixed disk path
# (D:\MyYesPlayerMusic\PodPlayerData) in background.js -- see KB D162 / the sandbox-ACL incident.
# This script is kept only as reasonable dev hygiene (clear THIS user's stray dev instances).

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