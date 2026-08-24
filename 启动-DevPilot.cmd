@echo off
chcp 65001 >nul
title DevPilot 启动模式选择
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-devpilot.ps1"

if errorlevel 1 (
  echo.
  echo DevPilot 启动失败，请查看上面的错误信息。
)

echo.
pause