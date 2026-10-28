@echo off
setlocal
set PY=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe
set EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe
set HERE=%~dp0

echo [REPRO] no cleanup, expect Web authentication failed
taskkill /IM "DeepSeek Harness.exe" /T /F >nul 2>&1
timeout /t 4 /nobreak >nul
"%PY%" "%HERE%seed.py" 120
start "" "%EXE%"
pause
