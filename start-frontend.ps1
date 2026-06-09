# Starts the Hypervault web app (Vite) on http://localhost:5174
Set-Location "$PSScriptRoot\frontend"
Write-Host "Starting frontend -> http://localhost:5174" -ForegroundColor Green
npm run dev
