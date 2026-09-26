# Shared helpers. Dot source this file; it never starts or stops a service itself.
$script:InterviewRoot = $PSScriptRoot
$script:InterviewSharingRoot = Join-Path $script:InterviewRoot '.sharing'
$script:InterviewFrontendRoot = Join-Path $script:InterviewRoot 'frontend'
$script:InterviewStatePath = Join-Path $script:InterviewSharingRoot 'processes.json'

function Write-InterviewJson([string]$Path, $Value) {
    $pending = $Path + '.' + [guid]::NewGuid().ToString('N') + '.pending'
    $json = ConvertTo-Json -InputObject $Value -Depth 10
    [IO.File]::WriteAllText($pending, $json, [Text.UTF8Encoding]::new($false))
    # Windows PowerShell coerces a null backup filename to an invalid empty path.
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($pending, $Path, ($Path + '.previous')) }
    else { Move-Item -LiteralPath $pending -Destination $Path }
}

function Read-InterviewProcesses {
    if (!(Test-Path -LiteralPath $script:InterviewStatePath)) { return }
    $state = Get-Content -LiteralPath $script:InterviewStatePath -Raw | ConvertFrom-Json
    # Older PowerShell helpers serialized an array as { value: [...], Count: n }.
    if ($state.PSObject.Properties.Name -contains 'processes') { $entries = @($state.processes) }
    elseif ($state.PSObject.Properties.Name -contains 'value') { $entries = @($state.value) }
    else { $entries = @($state) }
    $legacyRoles = @('backend', 'frontend', 'tunnel')
    for ($index = 0; $index -lt $entries.Count; $index++) {
        $entry = $entries[$index]
        if (!$entry.id -or !$entry.started) { throw 'Invalid sharing process record. No processes were changed.' }
        $role = $entry.role
        if (!$role) {
            if ($index -ge $legacyRoles.Count) { throw 'Unrecognized legacy sharing process record.' }
            $role = $legacyRoles[$index]
        }
        if ($role -notin $legacyRoles) { throw 'Unknown sharing process role.' }
        $dist = $entry.dist_dir
        if ($role -eq 'frontend' -and !$dist) { $dist = '.next' }
        [PSCustomObject]@{ role=[string]$role; id=[int]$entry.id; started=[string]$entry.started; dist_dir=$dist }
    }
}

function Save-InterviewProcesses([object[]]$Processes) {
    Write-InterviewJson $script:InterviewStatePath ([PSCustomObject]@{ version=2; processes=@($Processes) })
}

function New-InterviewProcessRecord($Process, [string]$Role, [string]$DistDir = '') {
    $Process.Refresh()
    [PSCustomObject]@{ role=$Role; id=$Process.Id; started=$Process.StartTime.ToUniversalTime().ToString('o'); dist_dir=$DistDir }
}

function Get-OwnedInterviewProcess($Record) {
    $owned = Get-Process -Id $Record.id -ErrorAction SilentlyContinue
    if (!$owned) { return $null }
    # A Windows venv launcher may exit after lookup when its worker stops.
    # Without a readable start time, ownership cannot be established.
    try { $started = $owned.StartTime } catch { return $null }
    if (!$started -or $started.ToUniversalTime().ToString('o') -ne $Record.started) { return $null }
    return $owned
}

function Test-InterviewBackendCommand($Description) {
    $pythonPath = Join-Path $script:InterviewRoot 'backend\.venv\Scripts\python.exe'
    $pattern = '^\s*"?' + [regex]::Escape($pythonPath) + '"?\s+-m\s+uvicorn\s+app:app\s+--host\s+127\.0\.0\.1\s+--port\s+8000\s+--no-access-log\s*$'
    return [bool]($Description.CommandLine -match $pattern)
}

function Get-OwnedInterviewBackendChildren($Record) {
    if (!(Get-OwnedInterviewProcess $Record)) { return }
    $parent = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$Record.id) -ErrorAction Stop
    if (!$parent -or !(Test-InterviewBackendCommand $parent)) { throw 'The recorded backend command does not match this workspace. No backend process was stopped.' }
    $descriptions = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + [int]$Record.id) -ErrorAction Stop)
    $children = @()
    foreach ($description in $descriptions) {
        # A hidden Windows console may have a system console-host child. It is
        # not uvicorn and exits with its console; never explicitly terminate it.
        $consoleHostPath = Join-Path $env:WINDIR 'System32\conhost.exe'
        if ($description.Name -eq 'conhost.exe' -and $description.ExecutablePath -eq $consoleHostPath) { continue }
        if (!(Test-InterviewBackendCommand $description)) { throw 'An unexpected backend child process was found. No backend process was stopped.' }
        $child = Get-Process -Id $description.ProcessId -ErrorAction SilentlyContinue
        if (!$child) { continue }
        # WMI timestamps have microsecond precision, whereas StartTime has 100 ns precision.
        if ([Math]::Abs(($child.StartTime.ToUniversalTime() - $description.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 2) {
            throw 'A backend child process identity changed. No backend process was stopped.'
        }
        if ($child.StartTime.ToUniversalTime() -lt [DateTime]::Parse($Record.started).ToUniversalTime()) { throw 'The backend child predates its recorded parent.' }
        $children += New-InterviewProcessRecord $child 'backend-worker'
    }
    if (!(Get-OwnedInterviewProcess $Record)) { throw 'The backend parent exited during ownership verification.' }
    return $children
}

function Stop-OwnedInterviewProcess($Record) {
    $owned = Get-OwnedInterviewProcess $Record
    if ($owned) {
        if ($Record.role -eq 'backend') {
            # The Windows venv launcher starts a real Python child. Stop verified
            # direct uvicorn children first so they cannot survive the launcher.
            $children = @(Get-OwnedInterviewBackendChildren $Record)
            foreach ($child in $children) { Stop-OwnedInterviewProcess $child }
            $owned = Get-OwnedInterviewProcess $Record
            if (!$owned) { return }
        }
        try { Stop-Process -Id $owned.Id -ErrorAction Stop }
        catch {
            # A Windows venv launcher can exit naturally as its worker stops.
            if (Get-OwnedInterviewProcess $Record) { throw }
            return
        }
        if (!$owned.WaitForExit(10000)) { throw "The recorded $($Record.role) process did not exit." }
    }
}

function Start-InterviewBackend([string]$LogName = 'backend') {
    Assert-InterviewPortAvailable 8000
    $pythonPath = Join-Path $script:InterviewRoot 'backend\.venv\Scripts\python.exe'
    if (!(Test-Path -LiteralPath $pythonPath)) { throw 'Install backend dependencies before sharing.' }
    return Start-Process -FilePath $pythonPath -ArgumentList '-m','uvicorn','app:app','--host','127.0.0.1','--port','8000','--no-access-log' -WorkingDirectory (Join-Path $script:InterviewRoot 'backend') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $script:InterviewSharingRoot ($LogName + '.out.log')) -RedirectStandardError (Join-Path $script:InterviewSharingRoot ($LogName + '.err.log'))
}

function Assert-InterviewPortAvailable([int]$Port) {
    $probe = [Net.Sockets.TcpClient]::new()
    try {
        $probe.Connect('127.0.0.1', $Port)
        throw "Port $Port is occupied. The existing service was left running."
    } catch [Net.Sockets.SocketException] {
    } finally { $probe.Dispose() }
}

function Get-InterviewFreePort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try { $listener.Start(); return $listener.LocalEndpoint.Port }
    finally { $listener.Stop() }
}

function Resolve-InterviewDist([string]$DistDir, [switch]$AllowLegacy) {
    if (!($AllowLegacy -and $DistDir -eq '.next') -and $DistDir -notmatch '^\.next-shared/[a-zA-Z0-9][a-zA-Z0-9._-]*$') { throw 'Invalid shared build path.' }
    $full = [IO.Path]::GetFullPath((Join-Path $script:InterviewFrontendRoot $DistDir))
    $allowed = [IO.Path]::GetFullPath($script:InterviewFrontendRoot).TrimEnd('\') + '\'
    if (!$full.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Build path is outside the frontend directory.' }
    if (!(Test-Path -LiteralPath (Join-Path $full 'BUILD_ID'))) { throw "Shared build is missing: $DistDir. Run Build-SharedInterview.ps1 first." }
    return $full
}

function Get-LatestInterviewBuild {
    $manifestPath = Join-Path $script:InterviewSharingRoot 'build.json'
    if (!(Test-Path -LiteralPath $manifestPath)) { throw 'Run Build-SharedInterview.ps1 before sharing.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    Resolve-InterviewDist $manifest.dist_dir | Out-Null
    return [string]$manifest.dist_dir
}

function Start-InterviewFrontend([string]$DistDir, [int]$Port, [string]$LogName, [switch]$AllowLegacy) {
    Resolve-InterviewDist $DistDir -AllowLegacy:$AllowLegacy | Out-Null
    Assert-InterviewPortAvailable $Port
    $nextScript = Join-Path $script:InterviewFrontendRoot 'node_modules\next\dist\bin\next'
    $previousDist = $env:NEXT_DIST_DIR
    $previousApi = $env:NEXT_PUBLIC_API_URL
    $previousBackend = $env:BACKEND_INTERNAL_URL
    try {
        $env:NEXT_DIST_DIR = $DistDir
        $env:NEXT_PUBLIC_API_URL = ''
        $env:BACKEND_INTERNAL_URL = 'http://127.0.0.1:8000'
        return Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList ('"' + $nextScript + '"'),'start','--hostname','127.0.0.1','--port',([string]$Port) -WorkingDirectory $script:InterviewFrontendRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $script:InterviewSharingRoot ($LogName + '.out.log')) -RedirectStandardError (Join-Path $script:InterviewSharingRoot ($LogName + '.err.log'))
    } finally {
        $env:NEXT_DIST_DIR = $previousDist
        $env:NEXT_PUBLIC_API_URL = $previousApi
        $env:BACKEND_INTERNAL_URL = $previousBackend
    }
}

function Wait-InterviewEndpoint([string]$Uri, $Record = $null) {
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        if ($Record -and !(Get-OwnedInterviewProcess $Record)) { throw "The new $($Record.role) process exited. Check .sharing logs." }
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return }
        } catch { }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Startup timed out: $Uri. Check .sharing logs."
}

function Test-InterviewFrontend([int]$Port, $Record) {
    $origin = 'http://127.0.0.1:' + $Port
    Wait-InterviewEndpoint ($origin + '/api/health') $Record
    $page = Invoke-WebRequest -UseBasicParsing -Uri ($origin + '/interviews/join') -TimeoutSec 15
    if ($page.StatusCode -ne 200 -or $page.Content -notmatch '<html') { throw 'The invitation page did not return HTML.' }
    $assets = @([regex]::Matches($page.Content, '(?:src|href)="(/_next/static/[^"?#]+\.(?:js|css)(?:\?[^"#]*)?)"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
    if (!($assets | Where-Object { $_ -match '\.js(?:\?|$)' }) -or !($assets | Where-Object { $_ -match '\.css(?:\?|$)' })) { throw 'The invitation page did not include its JavaScript and stylesheet assets.' }
    foreach ($asset in $assets) {
        $response = Invoke-WebRequest -UseBasicParsing -Uri ($origin + [Net.WebUtility]::HtmlDecode($asset)) -TimeoutSec 15
        $contentType = [string]$response.Headers['Content-Type']
        if ($response.StatusCode -ne 200 -or $contentType -match 'text/html' -or $response.RawContentLength -eq 0) { throw "An invitation page asset failed to load: $asset" }
    }
}
