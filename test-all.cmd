@echo off
setlocal
set "ROOT=%~dp0"

call :check "vllm-manager\server.js" || exit /b 1
call :check "llama-manager\server.js" || exit /b 1
call :check "service-entry\server.js" || exit /b 1
call :test "manager-core" || exit /b 1
call :test "service-entry" || exit /b 1
call :test "vllm-manager" || exit /b 1
call :test "llama-manager" || exit /b 1

echo.
echo All tests completed.
exit /b 0

:check
set "FILE=%~1"
echo.
echo == Syntax check %FILE% ==
node --check "%ROOT%%FILE%"
exit /b %ERRORLEVEL%

:test
set "DIR=%~1"
if not exist "%ROOT%%DIR%\package.json" (
  echo Skipping %DIR%: package.json not found.
  exit /b 0
)
echo.
echo == Testing %DIR% ==
pushd "%ROOT%%DIR%" >nul || exit /b 1
call npm test
set "CODE=%ERRORLEVEL%"
popd >nul
exit /b %CODE%
