@echo off
REM Double-click to start the backend (global Python, no venv needed).
cd /d "%~dp0backend"
echo Starting backend on http://localhost:8000  (check /health)
python -m uvicorn app:app --port 8000 --reload
echo.
echo Backend stopped. Press any key to close.
pause >nul
