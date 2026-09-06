@echo off
setlocal
set "ROOT=%~dp0"
set "PASSED=0"
set "FAILCOUNT=0"
set "SKIPCOUNT=0"
set "FAILFILE=%TEMP%\test-all-failures-%RANDOM%.txt"
set "SKIPFILE=%TEMP%\test-all-skips-%RANDOM%.txt"
if exist "%FAILFILE%" del /q "%FAILFILE%"
if exist "%SKIPFILE%" del /q "%SKIPFILE%"

rem Every step records its result and the run continues, so one red package
rem no longer hides the state of the packages behind it. The exit code is 1
rem when any step failed.

call :check "vllm-manager\server.js"
call :check "llama-manager\server.js"
call :check "service-entry\server.js"
if exist "%ROOT%search-gateway\server.js" call :check "search-gateway\server.js"
call :check "tests\frontend-smoke.spec.cjs"
call :check "tests\connection-status.spec.cjs"
call :check "tts-platform\gateway\static\app.js"
call :check "platform-mcp\scripts\validate-live.mjs"
call :check "scripts\sqlite-snapshot.js"
call :check "scripts\verify-backup.js"
call :check "tests\billing-page.spec.cjs"
call :check "scripts\check-i18n.js"
call :check "manager-core\model-storage.js"
call :check "manager-core\model-migration.js"
call :check "manager-core\model-storage-routes.js"
call :check "shared-public\js\model-storage-page.js"
call :check "tests\model-storage.spec.cjs"
call :checkps1 "build-github-release.ps1"
call :checkps1 "scripts\install-download-cli.ps1"
call :checkps1 "scripts\check-powershell-syntax.ps1"
call :checkps1 "scripts\new-worktree.ps1"
call :checkps1 "scripts\remove-worktree.ps1"
call :checkps1 "scripts\deploy-worktree.ps1"
call :checkps1 "scripts\start-platform-mcp.ps1"
call :checkps1 "scripts\stop-platform-mcp.ps1"
call :checkps1 "scripts\status-platform-mcp.ps1"
call :checkps1 "scripts\update-platform.ps1"
call :checkps1 "scripts\setup-public.ps1"
call :checkps1 "scripts\backup-platform.ps1"
call :checkps1 "scripts\nightly-e2e.ps1"
call :checkps1 "tts-platform\scripts\runtime-root.ps1"
call :checkps1 "tts-platform\scripts\install_gateway.ps1"
call :checkps1 "tts-platform\scripts\start_all.ps1"
call :checkps1 "tts-platform\scripts\start_gateway.ps1"
call :checkps1 "tts-platform\scripts\stop_gateway.ps1"
call :checkps1 "tts-platform\scripts\start_chatterbox.ps1"
call :checkps1 "tts-platform\scripts\start_qwen.ps1"
call :checkps1 "tts-platform\scripts\start_fish.ps1"
call :checkps1 "tts-platform\scripts\start_step_docker.ps1"
call :checkps1 "tts-platform\scripts\start_voxcpm.ps1"
call :checkps1 "tts-platform\scripts\start_qwen_design.ps1"
call :checkps1 "tts-platform\scripts\install_model.ps1"
call :checkps1 "tts-platform\scripts\status.ps1"
call :findpy
call :checkpy "tts-platform\gateway\main.py"
call :checkpy "tts-platform\gateway\tts_config.py"
call :checkpy "tts-platform\gateway\tts_schemas.py"
call :checkpy "tts-platform\gateway\tts_storage.py"
call :checkpy "tts-platform\gateway\tts_services.py"
call :checkpy "tts-platform\gateway\tts_jobs.py"
call :checkpy "tts-platform\gateway\tts_identity.py"
call :checkpy "tts-platform\gateway\tts_receipts.py"
call :checkpy "tts-platform\gateway\tts_catalog.py"
call :checkpy "tts-platform\gateway\tts_lifecycle.py"
call :checkpy "tts-platform\workers\chatterbox_worker.py"
call :checkpy "tts-platform\workers\qwen_worker.py"
call :checkpy "tts-platform\workers\step_server.py"
call :checkpy "tts-platform\workers\voxcpm_worker.py"
call :checkpy "tts-platform\workers\qwen_design_worker.py"
call :testpy
call :i18nReport
call :test "manager-core"
call :test "service-entry"
call :test "platform-mcp"
if exist "%ROOT%search-gateway\package.json" call :test "search-gateway"
call :test "vllm-manager"
call :test "llama-manager"
if not "%SKIP_FRONTEND_SMOKE%"=="1" call :frontendSmoke
if "%SKIP_FRONTEND_SMOKE%"=="1" call :skip "frontend smoke" "SKIP_FRONTEND_SMOKE=1"

echo.
echo ==================== test-all summary ====================
echo Passed steps:  %PASSED%
echo Skipped steps: %SKIPCOUNT%
if exist "%SKIPFILE%" type "%SKIPFILE%"
echo Failed steps:  %FAILCOUNT%
if exist "%FAILFILE%" type "%FAILFILE%"
if exist "%FAILFILE%" del /q "%FAILFILE%"
if exist "%SKIPFILE%" del /q "%SKIPFILE%"
if not "%FAILCOUNT%"=="0" (
  echo RESULT: FAILED
  exit /b 1
)
echo RESULT: All tests completed.
exit /b 0

:record
if "%~2"=="0" (
  set /a PASSED+=1
) else (
  set /a FAILCOUNT+=1
  >>"%FAILFILE%" echo   - %~1 (exit %~2^)
)
exit /b 0

:skip
set /a SKIPCOUNT+=1
>>"%SKIPFILE%" echo   - %~1: %~2
echo Skipping %~1: %~2
exit /b 0

:check
set "FILE=%~1"
echo.
echo == Syntax check %FILE% ==
node --check "%ROOT%%FILE%"
call :record "syntax %FILE%" %ERRORLEVEL%
exit /b 0

:checkps1
set "FILE=%~1"
echo.
echo == Syntax check %FILE% ==
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\check-powershell-syntax.ps1" "%ROOT%%FILE%"
call :record "syntax %FILE%" %ERRORLEVEL%
exit /b 0

:findpy
rem The TTS gateway environment lives under the live root (tts-runtime\envs\gateway),
rem so a worktree two levels below the live root also looks there.
set "PYEXE="
set "GATEWAY_PY="
if defined TTS_RUNTIME_ROOT if exist "%TTS_RUNTIME_ROOT%\envs\gateway\Scripts\python.exe" set "GATEWAY_PY=%TTS_RUNTIME_ROOT%\envs\gateway\Scripts\python.exe"
if not defined GATEWAY_PY if exist "%ROOT%tts-runtime\envs\gateway\Scripts\python.exe" set "GATEWAY_PY=%ROOT%tts-runtime\envs\gateway\Scripts\python.exe"
if not defined GATEWAY_PY if exist "%ROOT%..\..\tts-runtime\envs\gateway\Scripts\python.exe" set "GATEWAY_PY=%ROOT%..\..\tts-runtime\envs\gateway\Scripts\python.exe"
if not defined GATEWAY_PY if defined AI_ROOT if exist "%AI_ROOT%\tts-runtime\envs\gateway\Scripts\python.exe" set "GATEWAY_PY=%AI_ROOT%\tts-runtime\envs\gateway\Scripts\python.exe"
if defined GATEWAY_PY set "PYEXE=%GATEWAY_PY%"
if not defined PYEXE where python >nul 2>nul && set "PYEXE=python"
exit /b 0

:checkpy
set "FILE=%~1"
if not defined PYEXE (
  call :skip "syntax %FILE%" "Python not found"
  exit /b 0
)
echo.
echo == Syntax check %FILE% ==
"%PYEXE%" -c "import ast,pathlib; ast.parse(pathlib.Path(r'%ROOT%%FILE%').read_text(encoding='utf-8'))"
call :record "syntax %FILE%" %ERRORLEVEL%
exit /b 0

:testpy
if not defined PYEXE (
  if "%REQUIRE_TTS_TESTS%"=="1" (call :record "required TTS tests missing Python" 1 & exit /b 0)
  call :skip "tts-platform Python tests" "Python not found"
  exit /b 0
)
if not defined GATEWAY_PY (
  "%PYEXE%" -c "import httpx, fastapi" >nul 2>nul
  if errorlevel 1 (
    if "%REQUIRE_TTS_TESTS%"=="1" (call :record "required TTS test dependencies missing" 1 & exit /b 0)
    call :skip "tts-platform Python tests" "gateway environment not installed; run tts-platform\scripts\install_gateway.ps1 from the live root"
    exit /b 0
  )
)
echo.
echo == Testing tts-platform Python ==
"%PYEXE%" -m unittest discover -s "%ROOT%tts-platform\tests" -p "test_*.py" -v
call :record "tts-platform Python tests" %ERRORLEVEL%
exit /b 0

:i18nReport
echo.
echo == i18n coverage report (static manager strings without an English entry) ==
node "%ROOT%scripts\check-i18n.js"
call :record "i18n coverage report" %ERRORLEVEL%
exit /b 0

:test
set "DIR=%~1"
if not exist "%ROOT%%DIR%\package.json" (
  call :skip "%DIR% tests" "package.json not found"
  exit /b 0
)
echo.
echo == Testing %DIR% ==
pushd "%ROOT%%DIR%" >nul || (call :record "%DIR% tests" 1 & exit /b 0)
call npm test
set "CODE=%ERRORLEVEL%"
popd >nul
call :record "%DIR% tests" %CODE%
exit /b 0

:frontendSmoke
if not exist "%ROOT%package.json" (
  call :skip "frontend smoke" "package.json not found"
  exit /b 0
)
echo.
echo == Testing frontend smoke ==
pushd "%ROOT%" >nul || (call :record "frontend smoke" 1 & exit /b 0)
call npm run test:frontend-smoke
set "CODE=%ERRORLEVEL%"
popd >nul
call :record "frontend smoke" %CODE%
exit /b 0
