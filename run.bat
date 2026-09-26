@echo off
rem Starts the API and the web app, each in its own window.
rem
rem Separate consoles keep the two log streams readable and leave a crash on
rem screen instead of closing over it. Closing a window stops that process;
rem closing this one does not.
rem
rem   run.bat                      start both on the default ports
rem   set WEB_PORT=8080 & run.bat  serve the web app somewhere else
setlocal
cd /d "%~dp0"

if "%WEB_PORT%"=="" set "WEB_PORT=3000"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm was not found on PATH.
  pause
  exit /b 1
)

if not exist ".env" (
  echo Warning: no .env in %CD%, falling back to built-in defaults.
  echo.
)

echo Starting the API...
start "KernelArchive API" cmd /k pnpm --filter @kernelarchive/api start

rem A ping loopback rather than timeout, which refuses to run when this script
rem is launched with its input redirected. The web app talks to the API, so let
rem the API bind its port first.
"%SystemRoot%\System32\ping.exe" -n 4 127.0.0.1 >nul 2>nul

rem The port is passed explicitly: PORT in .env belongs to the API, and next
rem start would pick that up and collide with it.
echo Starting the web app on port %WEB_PORT%...
start "KernelArchive Web" cmd /k pnpm --filter @kernelarchive/web start -p %WEB_PORT%

echo.
echo Both are starting in their own windows. This one can be closed.
"%SystemRoot%\System32\ping.exe" -n 5 127.0.0.1 >nul 2>nul
endlocal
