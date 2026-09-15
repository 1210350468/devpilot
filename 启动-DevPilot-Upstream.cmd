@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-devpilot.ps1"
set "ERR=%ERRORLEVEL%"
echo.
if not "%ERR%"=="0" echo DevPilot 启动失败，请查看上面的错误信息。
echo 按任意键关闭此窗口...
pause >nul
exit /b %ERR%
