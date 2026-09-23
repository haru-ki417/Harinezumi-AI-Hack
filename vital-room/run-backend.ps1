# Backend launcher (called by dev.ps1 in a separate window)
Set-Location "$PSScriptRoot\backend"

if (-not (Test-Path .venv)) {
    Write-Host "[backend] creating .venv ..." -ForegroundColor Cyan
    python -m venv .venv
}

& .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

Write-Host "[backend] starting on http://localhost:8000 (check /health)" -ForegroundColor Green
uvicorn app:app --port 8000 --reload
