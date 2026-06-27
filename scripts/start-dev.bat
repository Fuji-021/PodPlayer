@echo off
title PodPlayer Dev (profile=dev)
echo ============================================================
echo  PodPlayer - DEV instance (profile=dev)
echo  name=PodPlayerDev  devserver=20201  neapi=10755  express=27233
echo ============================================================
echo.

REM [事故根治] 实例隔离：本脚本只启动 / 只清理「开发版(dev)」这一个实例。
REM   身份 PodPlayerDev -> %APPDATA%\PodPlayerDev\ -> 独立 IndexedDB，永不与
REM   正式版(PodPlayer)/测试床(PodPlayerSandbox) 抢同一个 LevelDB 锁。
REM   详见 docs/实例隔离规范.md。

REM 0) 实例三件套（端口）+ profile。这些环境变量会被 electron 主进程与 vue-cli 继承，
REM    且 vue-cli(4.5) 的 dotenv 不会覆盖已存在的 process.env，故此处设置优先于 .env。
set "PODPLAYER_PROFILE=dev"
set "DEV_SERVER_PORT=20201"
set "VUE_APP_ELECTRON_API_URL_DEV=http://127.0.0.1:10755"

REM 1) Switch to Node 16
set "PATH=C:\nvm4w\nodejs;%PATH%"

REM 2) 只释放「本实例(dev)」占用的端口，绝不再 taskkill /IM electron.exe 一锅端
REM    （那会误杀测试床/其它实例）。按端口精确清理：20201(webpack) 10755(neapi) 27233(express)。
REM    [事故根治·关键] 用 /T 连子进程树一起杀：electron 主进程(占 27233 express)的「渲染子进程」
REM    才是真正持有 PodPlayerDev IndexedDB(LevelDB)文件锁的人；只杀主进程会留下渲染子进程攥着锁，
REM    导致重开时新实例报「本地数据库无法打开 / Internal error opening backing store」。/T = 杀整棵树。
echo [1/4] Releasing DEV ports 20201 / 10755 / 27233 (kill whole process tree) ...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":20201" ^| findstr "LISTENING"') do taskkill /F /T /PID %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":10755" ^| findstr "LISTENING"') do taskkill /F /T /PID %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":27233" ^| findstr "LISTENING"') do taskkill /F /T /PID %%P >nul 2>&1
REM 等 3s 让 OS 释放 LevelDB 文件锁(渲染进程退出到锁真正释放有延迟，1s 偶发不够 → 撞锁)。
timeout /t 3 /nobreak >nul

REM 3) Enter project dir
echo [2/4] Entering project dir...
cd /d "D:\MyYesPlayerMusic\YesPlayMusic"
if errorlevel 1 (
    echo *** ERROR: cd to project failed ***
    pause
    exit /b 1
)

REM 4) Verify Node available
echo [3/4] Checking Node...
node -v
if errorlevel 1 (
    echo *** ERROR: node not on PATH. Check nvm-windows install. ***
    pause
    exit /b 1
)
echo.

REM 5) Run dev
echo [4/4] yarn electron:serve (profile=dev) ...
echo ------------------------------------------------------------
echo  Closing this window = stopping the whole dev (webpack + electron)
echo ------------------------------------------------------------
echo.
call yarn electron:serve

echo.
echo ============================================================
echo  dev exited (exit code %errorlevel%). Press any key to close...
pause >nul
