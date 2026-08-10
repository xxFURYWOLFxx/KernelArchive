@echo off
setlocal EnableExtensions
set "WSC_SCRIPT=%~dp0windows_sys_collector.py"
set "WSC_WORKING_DIR=%~dp0"
set "WSC_BATCH=%~f0"

where py.exe >nul 2>&1
if errorlevel 1 (
    echo Python Launcher py.exe was not found. Install Python 3.10 or later first.
    pause
    exit /b 2
)

powershell.exe -NoProfile -Command "$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $principal = [Security.Principal.WindowsPrincipal]::new($identity); if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 }; exit 1" >nul 2>&1
if errorlevel 1 (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$command = [char]34 + [char]34 + $env:WSC_BATCH + [char]34 + [char]34; Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/k', $command) -WorkingDirectory $env:WSC_WORKING_DIR -Verb RunAs"
    exit /b %errorlevel%
)

py.exe -3 -c "import requests" >nul 2>&1
if errorlevel 1 (
    echo The required Python packages are not installed for the Python selected by py -3.
    echo Run: py -3 -m pip install -r "%~dp0requirements.txt"
    pause
    exit /b 2
)

py.exe -3 "%WSC_SCRIPT%" --drivers-only %*
set "WSC_EXIT=%errorlevel%"
if not "%WSC_EXIT%"=="0" (
    echo.
    echo Collector exited with code %WSC_EXIT%. Review the message above.
    pause
)
exit /b %WSC_EXIT%
