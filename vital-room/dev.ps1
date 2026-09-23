# Stealth Vital - dev launcher
# Starts backend (:8000) and frontend (:3000) in two separate PowerShell windows.
# Each window runs run-backend.ps1 / run-frontend.ps1 via -File (avoids quoting issues).
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\dev.ps1

$root = $PSScriptRoot

Start-Process powershell -ArgumentList @(
    '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "$root\run-backend.ps1"
)

Start-Process powershell -ArgumentList @(
    '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "$root\run-frontend.ps1"
)

Write-Host ""
Write-Host "Launched two windows." -ForegroundColor Cyan
Write-Host "  backend  -> http://localhost:8000  (check /health)"
Write-Host "  frontend -> http://localhost:3000"
Write-Host "Close each window to stop."
