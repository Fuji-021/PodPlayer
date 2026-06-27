# Kill the DEV instance reliably. Covers:
#   (1) the dev electron main + renderer processes, and
#   (2) electron processes that SURVIVE after closing the terminal / minimizing to tray
#       and still hold the PodPlayerDev IndexedDB (LevelDB) file lock.
#
# Why kill by project electron.exe path (not only by port): renderer processes
# (--type=renderer) listen on NO TCP port. If electron survives a terminal close,
# a port-based kill cannot find it, so it keeps the DB lock and the next launch fails
# with "Internal error opening backing store". That is the real root cause.
#
# Only this project's node_modules\electron processes are killed (dev). A LIVE sandbox
# is spared by excluding the process tree rooted at the sandbox ports (20202 / 27234).
# Prod is a packaged exe (different path) and is never affected.
#
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads a BOM-less .ps1 using the system
# ANSI code page (GBK on zh-CN Windows); UTF-8 Chinese comments get mis-decoded and break
# parsing (ParserError -> whole script skipped -> kill silently fails).

$ErrorActionPreference = 'SilentlyContinue'
$projDir = 'D:\MyYesPlayerMusic\YesPlayMusic\node_modules\'
$all = Get-CimInstance Win32_Process

function Get-Tree($rootPid) {
  $acc = @([int]$rootPid)
  $kids = $all | Where-Object { $_.ParentProcessId -eq $rootPid }
  foreach ($c in $kids) { $acc += Get-Tree ([int]$c.ProcessId) }
  return $acc
}

# 1) Spare set = full process tree of any LIVE sandbox (ports 20202 webpack / 27234 express).
$spare = @()
foreach ($sbPort in 20202, 27234) {
  $owners = (Get-NetTCPConnection -State Listen -LocalPort $sbPort -ErrorAction SilentlyContinue).OwningProcess
  foreach ($owner in $owners) { if ($owner) { $spare += Get-Tree ([int]$owner) } }
}
$spare = $spare | Sort-Object -Unique

# 2) Kill every project electron.exe not in the sandbox spare set (main + renderer + survivors).
$elec = $all | Where-Object { $_.Name -eq 'electron.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($projDir) }
foreach ($p in $elec) {
  if ($spare -notcontains [int]$p.ProcessId) { & taskkill /F /T /PID $p.ProcessId 2>$null | Out-Null }
}

# 3) Kill the dev-port (20201/10755/27233) owning trees - dev-only ports, never the sandbox.
foreach ($devPort in 20201, 10755, 27233) {
  $owners = (Get-NetTCPConnection -State Listen -LocalPort $devPort -ErrorAction SilentlyContinue).OwningProcess
  foreach ($owner in $owners) { if ($owner -and ($spare -notcontains [int]$owner)) { & taskkill /F /T /PID $owner 2>$null | Out-Null } }
}