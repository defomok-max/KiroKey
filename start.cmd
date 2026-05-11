@echo off
REM kiro-router launcher (Windows).
REM
REM Usage:
REM   start.cmd                          - start the server
REM   start.cmd --set-password           - set a password (prompts interactively)
REM   start.cmd --set-password <pw>      - set a password in one line
REM   start.cmd --set-password --random  - generate a strong random password
REM   start.cmd --show-password          - print the current password (if any)
REM   start.cmd --clear-password         - remove the persistent password
REM   set PORT=12345 ^&^& start.cmd
REM   set HOST=127.0.0.1 ^&^& start.cmd
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

if "%~1"=="--set-password" (
  shift
  call npm run --silent set-password -- %*
  exit /b %errorlevel%
)
if "%~1"=="--clear-password" (
  call npm run --silent clear-password
  exit /b %errorlevel%
)
if "%~1"=="--show-password" (
  call npm run --silent show-password
  exit /b %errorlevel%
)
if "%~1"=="-h"     goto :help
if "%~1"=="--help" goto :help

if "%PORT%"=="" set PORT=11437
if "%HOST%"=="" set HOST=0.0.0.0
echo [kiro-router] starting on http://%HOST%:%PORT%

call npm start
exit /b %errorlevel%

:help
echo Usage:
echo   start.cmd                          start the server
echo   start.cmd --set-password [^<pw^>]    set a password
echo   start.cmd --set-password --random  generate a random password
echo   start.cmd --show-password          print the current password
echo   start.cmd --clear-password         clear the persistent password
exit /b 0
