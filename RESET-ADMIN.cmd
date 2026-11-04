@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Can cai Node.js 22.13 tro len de khoi phuc tai khoan Sentai Shop.
  pause
  exit /b 1
)

echo Khoi phuc tai khoan quan tri tren may dang chay web.
call npm run admin:reset
pause
