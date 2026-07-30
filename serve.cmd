@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   로컬 서버를 켭니다. 이 창을 닫으면 서버도 꺼집니다.
echo.
start "" http://localhost:8777
node serve.js %1
pause
