@echo off
title YesPlayMusic Podcast - Dev
echo ============================================================
echo  YesPlayMusic Podcast (fork) - Dev Mode
echo ============================================================
echo.

REM 1) Switch to Node 16
set "PATH=C:\nvm4w\nodejs;%PATH%"

REM 2) Kill stale electron processes
echo [1/5] Killing stale electron processes...
taskkill /F /IM electron.exe /T >nul 2>&1

REM 3) IMPORTANT: Release port 20201 (used by webpack-dev-server, a node process).
REM     If port 20201 stays occupied, webpack will silently switch to 20202,
REM     and IndexedDB (per-origin) on the new port will show no podcasts.
echo [2/5] Releasing port 20201 (webpack-dev-server)...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":20201" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%P >nul 2>&1
)
REM Also release port 10755 (NetEase API embedded server) and 27233 (express)
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":10755" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%P >nul 2>&1
)
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":27233" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%P >nul 2>&1
)
timeout /t 1 /nobreak >nul

REM 4) Enter project dir
echo [3/5] Entering project dir...
cd /d "D:\MyYesPlayerMusic\YesPlayMusic"
if errorlevel 1 (
    echo *** ERROR: cd to project failed ***
    pause
    exit /b 1
)

REM 5) Verify Node available
echo [4/5] Checking Node...
node -v
if errorlevel 1 (
    echo *** ERROR: node not on PATH. Check nvm-windows install. ***
    pause
    exit /b 1
)
echo.

REM 6) Run dev
echo [5/5] yarn electron:serve ...
echo ------------------------------------------------------------
echo  Closing this window = stopping the whole dev (webpack + electron)
echo ------------------------------------------------------------
echo.
call yarn electron:serve

echo.
echo ============================================================
echo  dev exited (exit code %errorlevel%). Press any key to close...
pause >nul
