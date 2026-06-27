@echo off
title PodPlayer Dev (profile=dev)
echo ============================================================
echo  PodPlayer - DEV instance (profile=dev)
echo  name=PodPlayerDev  devserver=20201  neapi=10755  express=27233
echo ============================================================
echo.

REM Instance isolation: this script starts/cleans ONLY the dev instance.
REM Identity PodPlayerDev -> %APPDATA%\PodPlayerDev\ -> its own IndexedDB,
REM never sharing a LevelDB LOCK with prod(PodPlayer)/sandbox(PodPlayerSandbox).
REM NOTE: keep this file ASCII-only. Chinese + special chars in comments get
REM garbled under the default console code page when double-clicked, which can
REM corrupt parsing and silently skip the kill step (caused the DB-lock bug).

REM 0) profile + ports (inherited by electron main and vue-cli)
set "PODPLAYER_PROFILE=dev"
set "DEV_SERVER_PORT=20201"
set "VUE_APP_ELECTRON_API_URL_DEV=http://127.0.0.1:10755"

REM 1) Node 16 on PATH
set "PATH=C:\nvm4w\nodejs;%PATH%"

REM 2) Kill any previous DEV instance (dev ports 20201/10755/27233 + whole tree).
REM    Logic lives in kill-dev-instance.ps1 (called via -File) so cmd quoting and
REM    console code page can never corrupt it. Only dev ports - never sandbox/prod.
echo [1/4] Stopping any previous DEV instance ...
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\MyYesPlayerMusic\YesPlayMusic\scripts\kill-dev-instance.ps1"
REM Wait 3s so the OS releases the LevelDB file lock before the new instance opens it.
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