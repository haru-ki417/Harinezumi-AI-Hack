# Publish a tested frontend generation while retaining the backend, data and URL.
[CmdletBinding()]
param([switch]$SkipBuild, [switch]$RecoverStoppedFrontend)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SharedInterview.Common.ps1')
$records = @(Read-InterviewProcesses)
$frontends = @($records | Where-Object { $_.role -eq 'frontend' })
if ($frontends.Count -ne 1) { throw 'Exactly one recorded frontend is required. No service was changed.' }
$previous = $frontends[0]
$previousRunning = [bool](Get-OwnedInterviewProcess $previous)
if (!$previousRunning) {
    if (!$RecoverStoppedFrontend) { throw 'The recorded frontend is no longer running. Use -RecoverStoppedFrontend only to recover this recorded session.' }
    if (Get-Process -Id $previous.id -ErrorAction SilentlyContinue) { throw 'The recorded frontend PID has been reused. No unrelated process was changed.' }
    Assert-InterviewPortAvailable 3000
}
foreach ($role in @('backend', 'tunnel')) {
    $record = @($records | Where-Object { $_.role -eq $role })
    if ($record.Count -ne 1 -or !(Get-OwnedInterviewProcess $record[0])) { throw "The recorded $role service is unavailable. No service was changed." }
}
if (!$SkipBuild) { & (Join-Path $PSScriptRoot 'Build-SharedInterview.ps1') }
$dist = Get-LatestInterviewBuild
if ($previousRunning -and $previous.dist_dir -eq $dist) { Write-Output 'The latest shared build is already running.'; return }
$staging = $null
try {
    $stagingPort = Get-InterviewFreePort
    $staging = New-InterviewProcessRecord (Start-InterviewFrontend $dist $stagingPort 'frontend-check') 'frontend' $dist
    Test-InterviewFrontend $stagingPort $staging
} finally {
    if ($staging) { Stop-OwnedInterviewProcess $staging }
}
# Re-read ownership after the build; another start/stop operation must not be overwritten.
$current = @(Read-InterviewProcesses)
if ((ConvertTo-Json -InputObject $current -Depth 5 -Compress) -ne (ConvertTo-Json -InputObject $records -Depth 5 -Compress)) { throw 'The recorded sharing session changed during the build. No live service was changed.' }
if ($previousRunning -and !(Get-OwnedInterviewProcess $previous)) { throw 'The original frontend exited during validation. No service was changed.' }
$replacement = $null
$previousStopped = $false
try {
    if ($previousRunning) {
        Stop-OwnedInterviewProcess $previous
        $previousStopped = $true
    }
    $replacement = New-InterviewProcessRecord (Start-InterviewFrontend $dist 3000 'frontend') 'frontend' $dist
    $records = @($records | ForEach-Object { if ($_.role -eq 'frontend') { $replacement } else { $_ } })
    Save-InterviewProcesses $records
    Test-InterviewFrontend 3000 $replacement
} catch {
    $updateError = $_
    if ($replacement) { Stop-OwnedInterviewProcess $replacement }
    if (!$previousStopped) { throw $updateError }
    try {
        $restored = New-InterviewProcessRecord (Start-InterviewFrontend $previous.dist_dir 3000 'frontend-rollback' -AllowLegacy) 'frontend' $previous.dist_dir
        $records = @($records | ForEach-Object { if ($_.role -eq 'frontend') { $restored } else { $_ } })
        Save-InterviewProcesses $records
        Test-InterviewFrontend 3000 $restored
        Write-Warning 'The new frontend failed its final check. The previous frontend was restored; the public URL was retained.'
    } catch {
        Write-Warning ('Frontend recovery failed: ' + $_.Exception.Message + ' The backend, interview data and tunnel were retained. A legacy .next build may already have been damaged by a development server.')
    }
    throw $updateError
}
Write-Output 'The updated invitation page and its JavaScript/CSS are available. The public URL and interview data were retained.'
