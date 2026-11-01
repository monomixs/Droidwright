@echo off
rem Double-click this to turn robot.svg into ..\app.ico  (or drag another .svg onto it).
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org  and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing the SVG renderer...
  call npm install
  if errorlevel 1 ( echo Install failed. & pause & exit /b 1 )
)

if "%~1"=="" ( node make-icon.js ) else ( node make-icon.js "%~1" )
echo.
echo Done. Rebuild the project in Visual Studio to use the new icon.
pause
