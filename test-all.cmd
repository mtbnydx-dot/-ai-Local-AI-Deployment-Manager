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

rem Syntax checks discover their files (scripts\check-syntax.js): one step per
rem language, each printing how many files it checked.
call :syntax js
call :syntax ps1
call :findpy
call :syntax py
call :testpy
call :i18nReport
call :testscripts
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

:syntax
rem node scripts\check-syntax.js --lang js|ps1|py. Exit code 77 means the
rem language's interpreter is missing, which is a skipped step.
set "SYNTAX_LANG=%~1"
if /i "%SYNTAX_LANG%"=="py" if not defined PYEXE (
  call :skip "syntax py" "Python not found"
  exit /b 0
)
echo.
echo == Syntax check (%SYNTAX_LANG%) ==
if /i "%SYNTAX_LANG%"=="py" goto syntaxPython
node "%ROOT%scripts\check-syntax.js" --lang %SYNTAX_LANG%
goto syntaxDone
:syntaxPython
node "%ROOT%scripts\check-syntax.js" --lang py --python "%PYEXE%"
:syntaxDone
set "CODE=%ERRORLEVEL%"
if "%CODE%"=="77" (
  call :skip "syntax %SYNTAX_LANG%" "interpreter not found"
  exit /b 0
)
call :record "syntax %SYNTAX_LANG%" %CODE%
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

:testscripts
rem Root script tests (scripts\test): the release-manifest check that every
rem tracked file is shipped or excluded with a reason, the check-syntax tests,
rem and the hygiene test, which also holds the *.cmd/*.ps1 encoding rule.
if not exist "%ROOT%package.json" (
  call :skip "scripts tests" "package.json not found"
  exit /b 0
)
echo.
echo == Testing scripts ==
pushd "%ROOT%" >nul || (call :record "scripts tests" 1 & exit /b 0)
call npm run test:scripts
set "CODE=%ERRORLEVEL%"
popd >nul
call :record "scripts tests" %CODE%
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
