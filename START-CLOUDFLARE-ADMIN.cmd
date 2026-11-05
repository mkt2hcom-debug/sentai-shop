@echo off
cd /d "%~dp0"
node scripts\cloudflare_admin_link.mjs %*
pause
