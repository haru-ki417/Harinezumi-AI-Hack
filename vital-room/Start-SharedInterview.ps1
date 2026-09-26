# Start a dedicated production build and publish one temporary HTTPS entry point.
# Run Build-SharedInterview.ps1 first. Use Update-SharedInterview.ps1 to keep the URL.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SharedInterview.Common.ps1')
$sharingRoot = $script:InterviewSharingRoot
$statePath = $script:InterviewStatePath
$dist = Get-LatestInterviewBuild
$tunnelExe = Join-Path $sharingRoot 'cloudflared.exe'
$expectedHash = 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2'
$pythonExe = Join-Path $PSScriptRoot 'backend\.venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $pythonExe)) { throw 'Install backend dependencies before sharing.' }
if (Test-Path -LiteralPath $statePath) {
    throw 'A sharing session is recorded. Use Update-SharedInterview.ps1 to update it, or Stop-SharedInterview.ps1 before starting again.'
}
New-Item -ItemType Directory -Path $sharingRoot -Force | Out-Null
if (!(Test-Path -LiteralPath $tunnelExe)) {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/download/2026.9.3/cloudflared-windows-amd64.exe' -OutFile $tunnelExe -TimeoutSec 120
}
if ((Get-FileHash -LiteralPath $tunnelExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'Cloudflared checksum does not match its official release. Sharing was not started.'
}
# Do not reuse or stop unrelated services occupying these ports.
foreach ($port in @(8000, 3000)) { Assert-InterviewPortAvailable $port }
$started = @()
try {
    $backendProcess = Start-InterviewBackend
    $backend = New-InterviewProcessRecord $backendProcess 'backend'
    $started += $backend
    Save-InterviewProcesses $started
    Wait-InterviewEndpoint 'http://127.0.0.1:8000/health' $backend
    $frontend = New-InterviewProcessRecord (Start-InterviewFrontend $dist 3000 'frontend') 'frontend' $dist
    $started += $frontend
    Save-InterviewProcesses $started
    Test-InterviewFrontend 3000 $frontend
    $emptyConfig = Join-Path $sharingRoot 'tunnel.yml'
    '{} ' | Set-Content -LiteralPath $emptyConfig -Encoding ASCII
    $logPath = Join-Path $sharingRoot 'tunnel.err.log'
    $tunnelProcess = Start-Process -FilePath $tunnelExe -ArgumentList '--config',('"' + $emptyConfig + '"'),'tunnel','--no-autoupdate','--url','http://127.0.0.1:3000','--protocol','http2' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $sharingRoot 'tunnel.out.log') -RedirectStandardError $logPath
    $tunnel = New-InterviewProcessRecord $tunnelProcess 'tunnel'
    $started += $tunnel
    Save-InterviewProcesses $started
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        if (!(Get-OwnedInterviewProcess $tunnel)) { throw 'The tunnel process exited. Check .sharing/tunnel.err.log.' }
        if (Test-Path -LiteralPath $logPath) {
            $logText = Get-Content -LiteralPath $logPath -Raw -ErrorAction SilentlyContinue
            if (![string]::IsNullOrEmpty($logText)) {
              $match = [regex]::Match($logText, 'https://[a-z0-9-]+\.trycloudflare\.com')
              if ($match.Success) {
                $pendingUrl = Join-Path $sharingRoot 'url.pending.txt'
                $match.Value | Set-Content -LiteralPath $pendingUrl -Encoding ASCII
                Move-Item -LiteralPath $pendingUrl -Destination (Join-Path $sharingRoot 'url.txt') -Force
                Write-Output ('Interview URL: ' + $match.Value)
                Write-Output ('Employer page: ' + $match.Value + '/company')
                Write-Output ('Candidate page: ' + $match.Value + '/interviews/join')
                Write-Output 'Keep this PC awake. Update-SharedInterview.ps1 updates the app without changing this URL.'
                return
              }
            }
        }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'No public URL was received. Check .sharing/tunnel.err.log.'
} catch {
    $startupError = $_
    # Clean up only processes created by this invocation, even if saving state failed.
    [array]::Reverse($started)
    foreach ($record in $started) { try { Stop-OwnedInterviewProcess $record } catch { Write-Warning $_ } }
    if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath }
    throw $startupError
}
