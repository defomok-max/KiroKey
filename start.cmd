@echo off
REM kiro-router launcher (Windows).
REM
REM Usage:
REM   start.cmd
REM   set PORT=12345 && start.cmd
REM
REM See README for full configuration.

setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [kiro-router] ERROR: node is not installed.
  echo Install Node 20+ from https://nodejs.org/ and re-run this script.
  exit /b 1
)

if not exist node_modules (
  echo [kiro-router] installing dependencies ^(one-time^)...
  call npm install --silent --no-audit --no-fund
  if errorlevel 1 exit /b 1
)

if "%PORT%"=="" set PORT=11437
if "%HOST%"=="" set HOST=127.0.0.1
echo [kiro-router] starting on http://%HOST%:%PORT%

call npm start
