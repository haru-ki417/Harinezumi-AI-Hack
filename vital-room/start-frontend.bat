@echo off
REM Double-click to start the frontend (installs deps on first run).
cd /d "%~dp0frontend"
if not exist node_modules (
  echo Installing dependencies ...
  call npm install
)
echo Starting frontend on http://localhost:3000
call npm run dev
echo.
echo Frontend stopped. Press any key to close.
pause >nul
