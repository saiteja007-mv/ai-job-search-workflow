@echo off
title Career Ops Dashboard

:: Move into webapp/ so node finds express + js-yaml in webapp/node_modules
cd /d "%~dp0webapp"

:: Kill any existing process on port 5050 to avoid EADDRINUSE
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5050 " ^| findstr "LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: Open Chrome after a delay (give node ~6s for first-time imports)
start /B cmd /c "ping -n 7 127.0.0.1 >nul && start chrome http://localhost:5050"

:: Start server — keeps this window alive
node server.js

echo.
echo Server stopped (exit code %errorlevel%). Press any key to close.
pause >nul
