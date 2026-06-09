# Starts the Hypervault backend (FastAPI) on http://127.0.0.1:8001
# First frees port 8001 by killing any leftover uvicorn process (and its --reload
# supervisor), so you never hit the "address already in use" / stale-code problem.
$ErrorActionPreference = 'SilentlyContinue'

Write-Host "Freeing port 8001..." -ForegroundColor Cyan
for ($i = 0; $i -lt 6; $i++) {
    $conns = Get-NetTCPConnection -LocalPort 8001 -State Listen
    if (-not $conns) { break }
    foreach ($c in $conns) {
        $owner = $c.OwningProcess
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$owner"
        # kill the --reload supervisor (parent) too, so it can't respawn a worker
        if ($cim -and $cim.ParentProcessId) {
            $par = Get-CimInstance Win32_Process -Filter "ProcessId=$($cim.ParentProcessId)"
            if ($par -and $par.Name -eq 'python.exe') { Stop-Process -Id $par.ProcessId -Force }
        }
        Stop-Process -Id $owner -Force
    }
    Start-Sleep -Milliseconds 700
}

$ErrorActionPreference = 'Continue'
Set-Location "$PSScriptRoot\backend"
Write-Host "Starting backend -> http://127.0.0.1:8001" -ForegroundColor Green
& .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8001
