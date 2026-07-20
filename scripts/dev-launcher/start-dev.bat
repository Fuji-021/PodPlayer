@echo off
setlocal
set "LAUNCHER_ROOT=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER_ROOT%start-dev.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo PodPlayer Dev was not started. Press any key to close.
  pause >nul
)
exit /b %EXIT_CODE%
