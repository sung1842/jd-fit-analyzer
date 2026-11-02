@echo off
setlocal EnableExtensions

REM -----------------------------------------------------------------------
REM ROOT CAUSE (why window closed immediately on double-click):
REM   Explorer runs:  cmd.exe /c "start-ngrok.bat"
REM   When the .bat ends (even with "cmd /k" or "pause" at the end),
REM   the outer cmd /c CLOSES THE WHOLE CONSOLE.
REM FIX:
REM   First launch opens a NEW window with cmd /k, then this flash exits.
REM   All work runs in the /k window which stays open after the bat finishes.
REM -----------------------------------------------------------------------

if /i "%~1"=="run" goto :main

REM Double-click / Explorer: spawn persistent window (only this line runs here)
start "ngrok setup" cmd /k call "%~f0" run
exit /b 0

:main
title ngrok setup - orchestrator :3001
cd /d "%~dp0.."

echo.
echo ============================================
echo  ngrok setup for Slack (orchestrator :3001)
echo ============================================
echo.

set "NGROK_SETUP_FROM_BAT=1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-ngrok.ps1"
set "NGROK_SETUP_FROM_BAT="
set "PS_EXIT=%ERRORLEVEL%"

echo.
echo ============================================
if exist "%~dp0last-ngrok-url.txt" (
  echo  Saved URLs ^(also in last-ngrok-url.txt^):
  echo --------------------------------------------
  type "%~dp0last-ngrok-url.txt"
  echo --------------------------------------------
  start "" notepad "%~dp0last-ngrok-url.txt"
) else (
  echo  FAILED - no URL file. Set ngrok authtoken first:
  echo    ngrok config add-authtoken YOUR_TOKEN
)
echo.

if not "%PS_EXIT%"=="0" (
  echo  PowerShell script exit code: %PS_EXIT%
)

echo  This window stays open. Type  exit  and press Enter to close.
echo ============================================
echo.

REM Do NOT use bare "cmd /k" here - we are already inside cmd /k from "start" above.
exit /b 0
