# Recover an expired temporary public tunnel without restarting the application.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SharedInterview.Common.ps1')
$records = @(Read-InterviewProcesses)
$old = @($records | Where-Object { $_.role -eq 'tunnel' })
if ($old.Count -ne 1) { throw 'Exactly one recorded tunnel is required.' }
foreach ($role in @('backend', 'frontend')) {
    $entry = @($records | Where-Object { $_.role -eq $role })
    if ($entry.Count -ne 1 -or !(Get-OwnedInterviewProcess $entry[0])) { throw "The recorded $role is unavailable." }
}
$health = Invoke-RestMethod 'http://127.0.0.1:3000/api/health' -TimeoutSec 10
if ($health.status -ne 'ok') { throw 'The application health check failed.' }
$tunnelExe = Join-Path $script:InterviewSharingRoot 'cloudflared.exe'
if ((Get-FileHash -LiteralPath $tunnelExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2') { throw 'Unexpected cloudflared executable.' }
$config = Join-Path $script:InterviewSharingRoot 'tunnel.yml'
'{} ' | Set-Content -LiteralPath $config -Encoding ASCII
Stop-OwnedInterviewProcess $old[0]
$log = Join-Path $script:InterviewSharingRoot 'tunnel.err.log'
$process = Start-Process -FilePath $tunnelExe -ArgumentList '--config',('"' + $config + '"'),'tunnel','--no-autoupdate','--url','http://127.0.0.1:3000','--protocol','http2' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $script:InterviewSharingRoot 'tunnel.out.log') -RedirectStandardError $log
$replacement = New-InterviewProcessRecord $process 'tunnel'
Save-InterviewProcesses @($records | ForEach-Object { if ($_.role -eq 'tunnel') { $replacement } else { $_ } })
$deadline = [DateTime]::UtcNow.AddSeconds(45)
do {
    if (!(Get-OwnedInterviewProcess $replacement)) { throw 'The new tunnel exited. Check .sharing/tunnel.err.log.' }
    $logText = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
    if ($logText) {
        $match = [regex]::Match($logText, 'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($match.Success -and $logText.Contains('Registered tunnel connection')) {
            $pending = Join-Path $script:InterviewSharingRoot 'url.pending.txt'
            $match.Value | Set-Content -LiteralPath $pending -Encoding ASCII
            Move-Item -LiteralPath $pending -Destination (Join-Path $script:InterviewSharingRoot 'url.txt') -Force
            Write-Output ('New interview URL: ' + $match.Value)
            return
        }
    }
    Start-Sleep -Milliseconds 300
} while ([DateTime]::UtcNow -lt $deadline)
throw 'The public tunnel did not connect within 45 seconds. Check .sharing/tunnel.err.log.'
