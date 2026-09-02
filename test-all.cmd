@echo off
setlocal
set "ROOT=%~dp0"

call :check "vllm-manager\server.js" || exit /b 1
call :check "llama-manager\server.js" || exit /b 1
call :check "service-entry\server.js" || exit /b 1
if exist "%ROOT%search-gateway\server.js" (
  call :check "search-gateway\server.js" || exit /b 1
)
call :check "tests\frontend-smoke.spec.cjs" || exit /b 1
call :check "tests\connection-status.spec.cjs" || exit /b 1
call :check "tts-platform\gateway\static\app.js" || exit /b 1
call :check "platform-mcp\scripts\validate-live.mjs" || exit /b 1
call :checkps1 "build-github-release.ps1" || exit /b 1
call :checkps1 "scripts\check-powershell-syntax.ps1" || exit /b 1
call :checkps1 "scripts\new-worktree.ps1" || exit /b 1
call :checkps1 "scripts\remove-worktree.ps1" || exit /b 1
call :checkps1 "scripts\deploy-worktree.ps1" || exit /b 1
call :checkps1 "scripts\start-platform-mcp.ps1" || exit /b 1
call :checkps1 "scripts\stop-platform-mcp.ps1" || exit /b 1
call :checkps1 "scripts\status-platform-mcp.ps1" || exit /b 1
call :checkps1 "scripts\update-platform.ps1" || exit /b 1
call :checkps1 "tts-platform\scripts\runtime-root.ps1" || exit /b 1
call :checkps1 "tts-platform\scripts\install_gateway.ps1" || exit /b 1
call :checkps1 "tts-platform\scripts\start_all.ps1" || exit /b 1
call :checkps1 "tts-platform\scripts\start_gateway.ps1" || exit /b 1
call :checkps1 "tts-platform\scripts\start_chatterbox.ps1" || exit /b 1
call :checkps1 "tts-platform\scripts\start_qwen.ps1" || exit /b 1
call :checkps1 "tts-platform\scripts\start_fish.ps1" || exit /b 1
call :checkps1 "tts-platform\scripts\start_step_docker.ps1" || exit /b 1
call :checkps1 "tts-platform\scripts\start_voxcpm.ps1" || exit /b 1
call :checkps1 "tts-platform\scripts\start_qwen_design.ps1" || exit /b 1
call :checkps1 "tts-platform\scripts\install_model.ps1" || exit /b 1
call :checkps1 "tts-platform\scripts\status.ps1" || exit /b 1
call :checkpy "tts-platform\gateway\main.py" || exit /b 1
call :checkpy "tts-platform\gateway\tts_config.py" || exit /b 1
call :checkpy "tts-platform\gateway\tts_schemas.py" || exit /b 1
call :checkpy "tts-platform\gateway\tts_storage.py" || exit /b 1
call :checkpy "tts-platform\gateway\tts_services.py" || exit /b 1
call :checkpy "tts-platform\gateway\tts_jobs.py" || exit /b 1
call :checkpy "tts-platform\gateway\tts_catalog.py" || exit /b 1
call :checkpy "tts-platform\gateway\tts_lifecycle.py" || exit /b 1
call :checkpy "tts-platform\workers\chatterbox_worker.py" || exit /b 1
call :checkpy "tts-platform\workers\qwen_worker.py" || exit /b 1
call :checkpy "tts-platform\workers\step_server.py" || exit /b 1
call :checkpy "tts-platform\workers\voxcpm_worker.py" || exit /b 1
call :checkpy "tts-platform\workers\qwen_design_worker.py" || exit /b 1
call :testpy || exit /b 1
call :test "manager-core" || exit /b 1
call :test "service-entry" || exit /b 1
call :test "platform-mcp" || exit /b 1
if exist "%ROOT%search-gateway\package.json" (
  call :test "search-gateway" || exit /b 1
)
call :test "vllm-manager" || exit /b 1
call :test "llama-manager" || exit /b 1
call :frontendSmoke || exit /b 1

echo.
echo All tests completed.
exit /b 0

:check
set "FILE=%~1"
echo.
echo == Syntax check %FILE% ==
node --check "%ROOT%%FILE%"
exit /b %ERRORLEVEL%

:checkps1
set "FILE=%~1"
echo.
echo == Syntax check %FILE% ==
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\check-powershell-syntax.ps1" "%ROOT%%FILE%"
exit /b %ERRORLEVEL%

:checkpy
set "FILE=%~1"
set "PYEXE="
if defined TTS_RUNTIME_ROOT if exist "%TTS_RUNTIME_ROOT%\envs\gateway\Scripts\python.exe" set "PYEXE=%TTS_RUNTIME_ROOT%\envs\gateway\Scripts\python.exe"
if not defined PYEXE if exist "%ROOT%tts-runtime\envs\gateway\Scripts\python.exe" set "PYEXE=%ROOT%tts-runtime\envs\gateway\Scripts\python.exe"
if not defined PYEXE where python >nul 2>nul && set "PYEXE=python"
if not defined PYEXE (
  echo Skipping Python syntax check for %FILE%: Python not found.
  exit /b 0
)
echo.
echo == Syntax check %FILE% ==
"%PYEXE%" -c "import ast,pathlib; ast.parse(pathlib.Path(r'%ROOT%%FILE%').read_text(encoding='utf-8'))"
exit /b %ERRORLEVEL%

:testpy
set "PYEXE="
if defined TTS_RUNTIME_ROOT if exist "%TTS_RUNTIME_ROOT%\envs\gateway\Scripts\python.exe" set "PYEXE=%TTS_RUNTIME_ROOT%\envs\gateway\Scripts\python.exe"
if not defined PYEXE if exist "%ROOT%tts-runtime\envs\gateway\Scripts\python.exe" set "PYEXE=%ROOT%tts-runtime\envs\gateway\Scripts\python.exe"
if not defined PYEXE where python >nul 2>nul && set "PYEXE=python"
if not defined PYEXE (
  echo Skipping TTS Python tests: Python not found.
  exit /b 0
)
echo.
echo == Testing tts-platform Python ==
"%PYEXE%" -m unittest discover -s "%ROOT%tts-platform\tests" -p "test_*.py" -v
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

:frontendSmoke
if not exist "%ROOT%package.json" (
  echo Skipping frontend smoke: package.json not found.
  exit /b 0
)
echo.
echo == Testing frontend smoke ==
pushd "%ROOT%" >nul || exit /b 1
call npm run test:frontend-smoke
set "CODE=%ERRORLEVEL%"
popd >nul
exit /b %CODE%
