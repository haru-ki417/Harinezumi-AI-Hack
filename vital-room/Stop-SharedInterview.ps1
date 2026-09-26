# Stop only recorded processes, protecting unrelated services and reused PIDs.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SharedInterview.Common.ps1')
$urlPath = Join-Path $script:InterviewSharingRoot 'url.txt'
$records = @(Read-InterviewProcesses)
if (Test-Path -LiteralPath $urlPath) { Remove-Item -LiteralPath $urlPath }
if ($records.Count -eq 0) { Write-Output 'No sharing session is recorded.'; return }
[array]::Reverse($records)
foreach ($record in $records) { Stop-OwnedInterviewProcess $record }
Remove-Item -LiteralPath $script:InterviewStatePath
Write-Output 'Interview sharing stopped.'
