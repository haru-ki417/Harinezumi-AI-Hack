# Build a fresh generation without touching any running frontend or its files.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SharedInterview.Common.ps1')
New-Item -ItemType Directory -Path $script:InterviewSharingRoot -Force | Out-Null
$generation = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$dist = '.next-shared/' + $generation
$configName = '.tsconfig-shared-' + $generation + '.json'
# Next adds its generated types to tsconfig. Keep those edits private to this build.
$tsconfig = Get-Content -LiteralPath (Join-Path $script:InterviewFrontendRoot 'tsconfig.json') -Raw | ConvertFrom-Json
$tsconfig.include = @($tsconfig.include | Where-Object { $_ -notmatch '^\.next' }) + @($dist + '/types/**/*.ts')
$oldBuilds = @(Get-ChildItem -LiteralPath (Join-Path $script:InterviewFrontendRoot '.next-shared') -Directory -ErrorAction SilentlyContinue | ForEach-Object { '.next-shared/' + $_.Name })
$tsconfig.exclude = @($tsconfig.exclude) + @('.next', '.next-dev', '.next-test') + $oldBuilds
Write-InterviewJson (Join-Path $script:InterviewFrontendRoot $configName) $tsconfig
$previousDist = $env:NEXT_DIST_DIR
$previousTypes = $env:NEXT_TYPESCRIPT_CONFIG
$previousApi = $env:NEXT_PUBLIC_API_URL
$previousBackend = $env:BACKEND_INTERNAL_URL
Push-Location $script:InterviewFrontendRoot
try {
    $env:NEXT_DIST_DIR = $dist
    $env:NEXT_TYPESCRIPT_CONFIG = $configName
    $env:NEXT_PUBLIC_API_URL = ''
    $env:BACKEND_INTERNAL_URL = 'http://127.0.0.1:8000'
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Shared build failed. The running interview service and previous build were left unchanged.' }
    Resolve-InterviewDist $dist | Out-Null
    Write-InterviewJson (Join-Path $script:InterviewSharingRoot 'build.json') ([PSCustomObject]@{ version=1; dist_dir=$dist; created=[DateTime]::UtcNow.ToString('o') })
    Write-Output ('Shared build ready: ' + $dist)
} finally {
    Pop-Location
    $env:NEXT_DIST_DIR = $previousDist
    $env:NEXT_TYPESCRIPT_CONFIG = $previousTypes
    $env:NEXT_PUBLIC_API_URL = $previousApi
    $env:BACKEND_INTERNAL_URL = $previousBackend
}
