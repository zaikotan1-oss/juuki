@echo off
cd /d "%~dp0"
start "juuki-server" /min python -m http.server 8820 --bind 127.0.0.1
timeout /t 1 >nul
start "" http://localhost:8820/
