@echo off
setlocal
set PY=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe
set CLEAN=%USERPROFILE%\.dsh\profiles\desktop\node_modules\hsb-restart\src\cookie-clean.py
set EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe
set HERE=%~dp0

echo [1/6] Closing the app
taskkill /IM "DeepSeek Harness.exe" /T /F >nul 2>&1
timeout /t 4 /nobreak >nul

echo.
echo [2/6] Cookies before
"%PY%" "%HERE%count.py"

echo.
echo [3/6] Seeding 80 fake dsh-auth cookies + keep-me
"%PY%" "%HERE%seed.py" 80

echo.
echo [4/6] Running the plugin cookie cleanup
"%PY%" "%CLEAN%"

echo.
echo [5/6] Cookies after
"%PY%" "%HERE%count.py"

echo.
echo [6/6] Starting the app
start "" "%EXE%"

echo.
echo Expected: auth=0, only keep-me left, app opens straight into chat.
pause
