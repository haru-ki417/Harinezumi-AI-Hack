# Frontend launcher (called by dev.ps1 in a separate window)
Set-Location "$PSScriptRoot\frontend"

if (-not (Test-Path node_modules)) {
    Write-Host "[frontend] installing deps (npm install) ..." -ForegroundColor Cyan
    npm install
}

Write-Host "[frontend] starting on http://localhost:3000" -ForegroundColor Green
npm run dev
