# Regression checks for process-state compatibility and safe ownership checks.
# This script does not start, stop or reconfigure any live service.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SharedInterview.Common.ps1')
function Assert-InterviewTest([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}
$livePath = $script:InterviewStatePath
$liveRecords = @(Read-InterviewProcesses)
Write-Output ('Current state readable: ' + $liveRecords.Count + ' records (unchanged).')
$testRoot = Join-Path $script:InterviewSharingRoot ('state-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$script:InterviewStatePath = Join-Path $testRoot 'processes.json'
$sample = @(
    [PSCustomObject]@{ id=101; started='2026-01-01T00:00:00.0000000Z' },
    [PSCustomObject]@{ id=102; started='2026-01-01T00:00:00.0000000Z' },
    [PSCustomObject]@{ id=103; started='2026-01-01T00:00:00.0000000Z' }
)
try {
    Write-InterviewJson $script:InterviewStatePath $sample
    $plain = @(Read-InterviewProcesses)
    Assert-InterviewTest ($plain.Count -eq 3 -and $plain[1].role -eq 'frontend' -and $plain[1].dist_dir -eq '.next') 'Legacy array was not decoded.'
    Write-InterviewJson $script:InterviewStatePath ([PSCustomObject]@{ value=$sample; Count=3 })
    $wrapped = @(Read-InterviewProcesses)
    Assert-InterviewTest ($wrapped.Count -eq 3 -and $wrapped[2].role -eq 'tunnel') 'Legacy wrapped array was not decoded.'
    Save-InterviewProcesses $wrapped
    $versioned = Get-Content -LiteralPath $script:InterviewStatePath -Raw | ConvertFrom-Json
    Assert-InterviewTest ($versioned.version -eq 2 -and $versioned.processes -is [array] -and $versioned.processes.Count -eq 3) 'Versioned state did not preserve its array.'
    Save-InterviewProcesses @($wrapped[0])
    $single = Get-Content -LiteralPath $script:InterviewStatePath -Raw | ConvertFrom-Json
    Assert-InterviewTest ($single.processes -is [array] -and $single.processes.Count -eq 1) 'A single process lost its array wrapper.'
    Assert-InterviewTest (@(Read-InterviewProcesses).Count -eq 1) 'A single process could not be read.'
    $self = Get-Process -Id $PID
    $correct = New-InterviewProcessRecord $self 'frontend' '.next-shared/test'
    Assert-InterviewTest ([bool](Get-OwnedInterviewProcess $correct)) 'Current process identity was not matched.'
    $wrong = [PSCustomObject]@{ id=$self.Id; started='2000-01-01T00:00:00.0000000Z'; role='frontend' }
    Assert-InterviewTest (!(Get-OwnedInterviewProcess $wrong)) 'A reused process ID was considered owned.'
    # A bad timestamp must make the stop helper a no-op, even for this test process.
    Stop-OwnedInterviewProcess $wrong
    # The process can exit between lookup and reading StartTime.
    function Get-Process { [CmdletBinding()] param([int]$Id) [PSCustomObject]@{ Id=$Id; StartTime=$null } }
    try { Assert-InterviewTest (!(Get-OwnedInterviewProcess $correct)) 'An exited process without a start time was considered owned.' }
    finally { Remove-Item Function:Get-Process }
    $backendCommand = '"' + (Join-Path $script:InterviewRoot 'backend\.venv\Scripts\python.exe') + '" -m uvicorn app:app --host 127.0.0.1 --port 8000 --no-access-log '
    Assert-InterviewTest (Test-InterviewBackendCommand ([PSCustomObject]@{ CommandLine=$backendCommand })) 'The managed workspace backend was not recognized.'
    Assert-InterviewTest (!(Test-InterviewBackendCommand ([PSCustomObject]@{ CommandLine=$backendCommand.Replace('app:app', 'other:app') }))) 'An unrelated Python app was accepted.'
    Assert-InterviewTest (!(Test-InterviewBackendCommand ([PSCustomObject]@{ CommandLine=$backendCommand.Replace('backend\.venv', 'other\.venv') }))) 'Another workspace Python was accepted.'
    foreach ($path in @('../elsewhere', '.next-shared/../../elsewhere', 'C:\elsewhere', '.next')) {
        $rejected = $false
        try { Resolve-InterviewDist $path | Out-Null } catch { $rejected = $true }
        Assert-InterviewTest $rejected ('Unsafe build path was accepted: ' + $path)
    }
    Write-Output 'PASS: legacy states, atomic versioned writes, one-item arrays, PID/start-time ownership, build path validation.'
} finally {
    $script:InterviewStatePath = $livePath
    # Only these known files are removed. No recursive deletion or process cleanup.
    $testState = Join-Path $testRoot 'processes.json'
    try {
        if (Test-Path -LiteralPath $testState) { Remove-Item -LiteralPath $testState }
        if (Test-Path -LiteralPath ($testState + '.previous')) { Remove-Item -LiteralPath ($testState + '.previous') }
        Remove-Item -LiteralPath $testRoot
    } catch { Write-Warning ('Test cleanup failed: ' + $_.Exception.Message) }
}
