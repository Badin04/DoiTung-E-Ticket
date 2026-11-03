@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js 22.13 or newer from https://nodejs.org
  pause
  exit /b 1
)
echo =========================================
echo   DoiTung E-Ticket
 echo   Open in browser: http://localhost:3000
 echo   Press Ctrl+C to stop the server
 echo =========================================
node server.js
pause
