@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-devpilot.ps1" -Apply
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo 更新未完成，请检查上面的错误。旧版不会主动删除。
pause
exit /b %RESULT%
