# Starts the Hypervault terminal app: runs the backend (FastAPI on
# http://127.0.0.1:8001) inside an interactive console — no browser needed.
# If a backend is already running on 8001 it attaches to it instead.
Set-Location "$PSScriptRoot\backend"
& .\.venv\Scripts\python.exe -m app.terminal
