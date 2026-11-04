@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Can cai Node.js 22.23.2 tro len de chay Sentai Shop.
  pause
  exit /b 1
)
echo Mo trinh duyet tai http://127.0.0.1:3000
call npm start
pause
