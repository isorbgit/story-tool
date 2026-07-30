@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   단일 파일로 합칩니다.
echo.
node build.js
echo.
pause
