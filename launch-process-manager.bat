@echo off
setlocal
title Process Manager - setup and launch
cd /d "%~dp0"

echo.
echo  ============================================
echo   Process Manager — setup and launch
echo  ============================================
echo   Folder: %cd%
echo.

REM --- Python: create venv only if missing ---
if exist "venv\Scripts\python.exe" (
  echo [OK] Python venv already exists.
) else (
  echo [..] Creating Python virtual environment...
  where python >nul 2>&1
  if errorlevel 1 (
    echo [!!] "python" not found in PATH. Install Python 3.10+ from https://www.python.org/downloads/
    echo      Enable "Add python.exe to PATH", then run this script again.
    pause
    exit /b 1
  )
  python -m venv venv
  if errorlevel 1 (
    echo [!!] Failed to create venv.
    pause
    exit /b 1
  )
  echo [OK] venv created.
)

REM --- pip: install / upgrade deps (no-op when already satisfied) ---
echo [..] Ensuring Python packages ^(requirements.txt^)...
"venv\Scripts\python.exe" -m pip install -r requirements.txt -q
if errorlevel 1 (
  echo [!!] pip install failed.
  pause
  exit /b 1
)
echo [OK] Python dependencies ready.

REM --- npm: install only if node_modules missing ---
if exist "frontend\node_modules\" (
  echo [OK] npm packages already installed.
) else (
  echo [..] Installing frontend dependencies ^(first run, may take a minute^)...
  where npm >nul 2>&1
  if errorlevel 1 (
    echo [!!] "npm" not found. Install Node.js LTS from https://nodejs.org/
    pause
    exit /b 1
  )
  pushd frontend
  call npm install
  if errorlevel 1 (
    echo [!!] npm install failed.
    popd
    pause
    exit /b 1
  )
  popd
  echo [OK] npm install finished.
)

REM --- Launch API and UI in separate windows ---
echo.
echo [..] Starting servers in new windows...
echo     API: http://127.0.0.1:8000
echo     UI:  http://localhost:5173  ^(after Vite starts^)
echo.

start "Process Manager - API" /D "%~dp0" cmd /k "venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload"
start "Process Manager - UI" /D "%~dp0frontend" cmd /k "npm run dev"

echo [OK] Launched. Close each window to stop that server.
echo.
pause
exit /b 0
