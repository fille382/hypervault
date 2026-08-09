# Hypervault one-line installer — sets up the local backend for the live site.
#
#   irm https://raw.githubusercontent.com/fille382/hypervault/master/scripts/install.ps1 | iex
#
# Safe to re-run: an existing install is updated (git pull + dependency sync).
# What it does:
#   1. Clones (or updates) the repo into %USERPROFILE%\hypervault
#      — set  $env:HYPERVAULT_DIR = 'D:\somewhere'  first to install elsewhere.
#   2. Creates the Python venv and installs backend dependencies
#      (uses uv if you have it — uv can also download Python for you).
#   3. Creates backend\.env from the template if missing (the viewer works
#      with no key; trading needs your API-wallet key added later).
#   4. Registers the hypervault:// protocol so the site's "start backend"
#      button works from then on.
#   5. Starts the backend and waits for http://127.0.0.1:8001 to respond.
# Needs: git, plus Python 3.11+ or uv. No admin rights required.

function Install-Hypervault {
    # Explicit error handling throughout — 'Stop' + native stderr misbehaves in
    # PS 5.1, and this script must never kill the user's shell (it runs via iex).
    $ErrorActionPreference = 'Continue'

    $repoUrl = 'https://github.com/fille382/hypervault.git'
    $dir = if ($env:HYPERVAULT_DIR) { $env:HYPERVAULT_DIR } else { Join-Path $HOME 'hypervault' }
    $backend = Join-Path $dir 'backend'
    $venvPy = Join-Path $backend '.venv\Scripts\python.exe'

    function Step([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
    function Fail([string]$m) { Write-Host "`nInstall failed: $m" -ForegroundColor Red }

    function Test-Backend {
        try {
            $null = Invoke-RestMethod 'http://127.0.0.1:8001/api/health' -TimeoutSec 2
            return $true
        } catch { return $false }
    }

    # Best CPython on this machine (3.11+), newest first, via the py launcher.
    function Find-Python {
        $ErrorActionPreference = 'SilentlyContinue'
        if (Get-Command py -ErrorAction SilentlyContinue) {
            foreach ($v in '3.14', '3.13', '3.12', '3.11') {
                $exe = & py "-$v" -c 'import sys; print(sys.executable)' 2>$null
                if ($LASTEXITCODE -eq 0 -and $exe) { return "$exe".Trim() }
            }
        }
        $cmd = Get-Command python -ErrorAction SilentlyContinue
        if ($cmd) {
            # Rejects the Microsoft Store stub too (it exits non-zero).
            $minor = & $cmd.Source -c 'import sys; print(sys.version_info[1])' 2>$null
            if ($LASTEXITCODE -eq 0 -and "$minor".Trim() -match '^\d+$' -and [int]"$minor".Trim() -ge 11) {
                return $cmd.Source
            }
        }
        return $null
    }

    # --- prerequisites ------------------------------------------------------
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Fail 'git was not found.'
        Write-Host 'Install it with:   winget install --id Git.Git -e'
        Write-Host 'then open a NEW PowerShell window and run this installer again.'
        return
    }

    $uv = Get-Command uv -ErrorAction SilentlyContinue
    $python = $null
    if (-not $uv) {
        $python = Find-Python
        if (-not $python) {
            Fail 'Python 3.11+ was not found.'
            Write-Host 'Install it with:   winget install --id Python.Python.3.12 -e'
            Write-Host 'then open a NEW PowerShell window and run this installer again.'
            return
        }
    }

    # --- clone or update ----------------------------------------------------
    if (Test-Path (Join-Path $dir '.git')) {
        Step "Updating existing install in $dir"
        git -C $dir pull --ff-only
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'Could not fast-forward (local changes?) — continuing with the current version.' -ForegroundColor Yellow
        }
    } elseif (Test-Path $dir) {
        Fail "$dir already exists but is not a Hypervault checkout."
        Write-Host 'Move it aside, or point the installer elsewhere:'
        Write-Host '  $env:HYPERVAULT_DIR = ''D:\hypervault''  # then re-run'
        return
    } else {
        Step "Cloning Hypervault into $dir"
        git clone $repoUrl $dir
        if ($LASTEXITCODE -ne 0) { Fail 'git clone failed (no network?).'; return }
    }

    # --- venv + dependencies ------------------------------------------------
    if (-not (Test-Path $venvPy)) {
        Step 'Creating the Python virtualenv'
        if ($uv) { & $uv.Source venv (Join-Path $backend '.venv') --python 3.14 }
        else { & $python -m venv (Join-Path $backend '.venv') }
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $venvPy)) { Fail 'could not create the virtualenv.'; return }
    }

    Step 'Installing backend dependencies'
    $req = Join-Path $backend 'requirements.txt'
    if ($uv) { & $uv.Source pip install --python $venvPy -r $req }
    else { & $venvPy -m pip install --disable-pip-version-check -q -r $req }
    if ($LASTEXITCODE -ne 0) { Fail 'dependency install failed.'; return }

    # --- config -------------------------------------------------------------
    $envFile = Join-Path $backend '.env'
    if (-not (Test-Path $envFile)) {
        Copy-Item (Join-Path $backend '.env.example') $envFile
        Write-Host 'Created backend\.env from the template (viewer mode — no key yet).'
    }

    # --- protocol + start ---------------------------------------------------
    Step 'Registering the hypervault:// start link'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'scripts\register-backend-protocol.ps1')

    if (Test-Backend) {
        Step 'Backend is already running'
    } else {
        Step 'Starting the backend'
        Start-Process powershell -WindowStyle Minimized -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $dir 'start-backend.ps1')
        )
        $up = $false
        for ($i = 0; $i -lt 30; $i++) {
            if (Test-Backend) { $up = $true; break }
            Start-Sleep -Seconds 1
        }
        if ($up) { Write-Host 'Backend is up on http://127.0.0.1:8001' -ForegroundColor Green }
        else {
            Write-Host 'Backend has not responded yet — check the minimized "Hypervault" PowerShell window in your taskbar for errors.' -ForegroundColor Yellow
        }
    }

    # --- done ---------------------------------------------------------------
    Write-Host ''
    Write-Host '=================================================================' -ForegroundColor Green
    Write-Host ' Hypervault is installed.' -ForegroundColor Green
    Write-Host "   Dashboard:  https://fille382.github.io/hypervault/"
    Write-Host "   Installed:  $dir"
    Write-Host ''
    Write-Host ' Next time the site shows "Backend offline", just click'
    Write-Host ' "start backend" (first click: allow the hypervault:// popup,'
    Write-Host ' tick "Always allow").'
    Write-Host ''
    Write-Host " To enable trading, add your API-wallet key to backend\.env"
    Write-Host ' (see the README''s Setup section). The viewer needs no key.'
    Write-Host '=================================================================' -ForegroundColor Green
}

Install-Hypervault
