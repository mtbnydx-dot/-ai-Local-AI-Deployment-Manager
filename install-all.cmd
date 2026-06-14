@echo off
setlocal
set "ROOT=%~dp0"

call :install "vllm-manager" || exit /b 1
call :install "llama-manager" || exit /b 1

echo.
echo All install steps completed.
exit /b 0

:install
set "DIR=%~1"
if not exist "%ROOT%%DIR%\package.json" (
  echo Skipping %DIR%: package.json not found.
  exit /b 0
)
echo.
echo == Installing %DIR% ==
pushd "%ROOT%%DIR%" >nul || exit /b 1
if exist package-lock.json (
  call npm ci
) else (
  call npm install
)
set "CODE=%ERRORLEVEL%"
popd >nul
exit /b %CODE%
