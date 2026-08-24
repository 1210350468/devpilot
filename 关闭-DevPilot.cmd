@echo off
chcp 65001 >nul
title DevPilot 关闭
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-devpilot.ps1"
echo.
pause
