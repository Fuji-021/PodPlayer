@echo off
title PodPlayer 测试床 (profile=sandbox)
echo ============================================================
echo  PodPlayer - SANDBOX / 测试床 (profile=sandbox)
echo  name=PodPlayerSandbox  devserver=20202  neapi=10756  express=27234
echo ============================================================
echo.

REM [事故根治] 实例隔离：测试床实例。身份 PodPlayerSandbox -> %APPDATA%\PodPlayerSandbox\
REM   -> 独立 IndexedDB。在这里跑种子/试破坏性操作/回归验证，绝不影响开发版与正式版数据。
REM   详见 docs/实例隔离规范.md。

REM 0) 实例三件套（端口）+ profile（与 dev/正式版全部错开，可三实例同时启动）。
set "PODPLAYER_PROFILE=sandbox"
set "DEV_SERVER_PORT=20202"
set "VUE_APP_ELECTRON_API_URL_DEV=http://127.0.0.1:10756"

REM 1) Switch to Node 16
set "PATH=C:\nvm4w\nodejs;%PATH%"

REM 2) 只释放「测试床(sandbox)」占用的端口：20202(webpack) 10756(neapi) 27234(express)。
echo [1/4] Releasing SANDBOX ports 20202 / 10756 / 27234 ...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":20202" ^| findstr "LISTENING"') do taskkill /F /PID %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":10756" ^| findstr "LISTENING"') do taskkill /F /PID %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":27234" ^| findstr "LISTENING"') do taskkill /F /PID %%P >nul 2>&1
timeout /t 1 /nobreak >nul

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

REM 5) Run sandbox
echo [4/4] yarn electron:serve (profile=sandbox) ...
echo ------------------------------------------------------------
echo  Closing this window = stopping the sandbox (webpack + electron)
echo ------------------------------------------------------------
echo.
call yarn electron:serve

echo.
echo ============================================================
echo  sandbox exited (exit code %errorlevel%). Press any key to close...
pause >nul
