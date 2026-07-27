# Registers the hypervault:// URL protocol for the CURRENT USER (no admin
# needed), so the "Start backend" button on the GitHub Pages site can launch
# start-backend.ps1 from the browser. Re-run this if you move the repo.
#
# First click in a browser shows an "Open Hypervault backend?" dialog —
# tick "Always allow" and it's one click from then on.
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$starter = Join-Path $repo 'start-backend.ps1'
if (-not (Test-Path $starter)) { throw "start-backend.ps1 not found at $starter" }

$root = 'HKCU:\Software\Classes\hypervault'
New-Item -Path "$root\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $root -Name '(default)' -Value 'URL:Hypervault backend starter'
Set-ItemProperty -Path $root -Name 'URL Protocol' -Value ''
# The clicked URL would arrive as an extra argument; start-backend.ps1 ignores it.
Set-ItemProperty -Path "$root\shell\open\command" -Name '(default)' -Value (
    "powershell.exe -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$starter`""
)

Write-Host "Registered hypervault:// -> $starter" -ForegroundColor Green
Write-Host "Test it: open hypervault://start from any browser or Win+R."
