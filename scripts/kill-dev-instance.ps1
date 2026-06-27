# [事故根治·实例隔离] 杀掉「开发版(dev)」实例：占用 dev 端口 20201(webpack)/10755(neapi)/27233(express)
#   的进程及其整棵子进程树(taskkill /F /T)。electron 主进程是 webpack(20201)节点的后代，杀这几棵树即
#   连同 electron 主进程 + 渲染子进程一起干掉——渲染子进程才是真正攥着 PodPlayerDev IndexedDB(LevelDB)
#   文件锁的人；不杀干净，重开就报「本地数据库无法打开 / Internal error opening backing store」。
#
#   为什么独立成 .ps1：原来在 start-dev.bat 里用 `netstat^|findstr^|for /f` 或 `powershell -Command "...|..."`
#   都不可靠(cmd 对管道/引号的解析会让杀进程静默失败 → 重开时旧实例没死 → 新旧两实例撞同一个库锁=故障真因)。
#   用 -File 调用本脚本可彻底绕开 cmd 的引号/管道地狱，行为与手动运行一致、可靠。
#
#   只针对 dev 三端口 → 绝不误伤：测试床(sandbox: 20202/27234)、正式版(打包，exe 路径不同)、其它 Electron 应用。

$ErrorActionPreference = 'SilentlyContinue'
$ports = 20201, 10755, 27233
$ids = @()
foreach ($pt in $ports) {
  $conns = Get-NetTCPConnection -State Listen -LocalPort $pt -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    $procId = $c.OwningProcess
    if ($procId -and ($ids -notcontains $procId)) { $ids += $procId }
  }
}
foreach ($procId in $ids) {
  if ($procId) {
    & taskkill /F /T /PID $procId 2>$null | Out-Null
  }
}
