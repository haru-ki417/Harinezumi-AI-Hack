# Backend launcher (called by dev.ps1 in a separate window)
Set-Location "$PSScriptRoot\backend"

$activate = ".\.venv\Scripts\Activate.ps1"

# If venv is missing or broken (no Activate.ps1), (re)create it
if (-not (Test-Path $activate)) {
    if (Test-Path .venv) {
        Write-Host "[backend] broken .venv detected, recreating ..." -ForegroundColor Yellow
        Remove-Item -Recurse -Force .venv
    }
    Write-Host "[backend] creating .venv ..." -ForegroundColor Cyan
    python -m venv .venv
}

if (Test-Path $activate) {
    & $activate
} else {
    Write-Host "[backend] venv unavailable; falling back to global Python." -ForegroundColor Yellow
}

python -m pip install -r requirements.txt

Write-Host "[backend] starting on http://localhost:8000 (check /health)" -ForegroundColor Green
python -m uvicorn app:app --port 8000 --reload
