@echo off
setlocal

REM ============================================================================
REM  实时协作白板 · Windows 一键启动
REM
REM  启动两个进程：
REM    - 信令服务（WebSocket + HTTP API），默认 1234
REM    - 前端 dev server（Vite），默认 5173
REM
REM  端口可覆盖：环境变量优先，其次 web\.env.local，最后默认值。
REM  例如：set WEB_PORT=5180 && start.bat
REM ============================================================================

set "ROOT=%~dp0"

set "SERVER_PORT=%SERVER_PORT%"
if "%SERVER_PORT%"=="" set "SERVER_PORT=1234"

REM 前端端口：环境变量 > web\.env.local > 5173
set "WEB_PORT=%WEB_PORT%"
if "%WEB_PORT%"=="" (
  if exist "%ROOT%web\.env.local" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%ROOT%web\.env.local") do (
      if "%%a"=="WEB_PORT" set "WEB_PORT=%%b"
    )
  )
)
if "%WEB_PORT%"=="" set "WEB_PORT=5173"

REM ---- 检查 Node.js ---------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 未找到 node 命令，请先安装 Node.js 18+ 并加入 PATH。
  pause
  exit /b 1
)

if not exist "%ROOT%node_modules" (
  echo [ERROR] 依赖未安装。请先在项目根目录执行：npm install
  pause
  exit /b 1
)

REM ---- 启动信令服务 ---------------------------------------------------------
netstat -ano | findstr /R /C:":%SERVER_PORT% .*LISTENING" >nul
if errorlevel 1 (
  echo [启动] 信令服务  端口 %SERVER_PORT%
  start "whiteboard-server-%SERVER_PORT%" cmd /k "cd /d "%ROOT%" && node server\src\index.js"
) else (
  echo [跳过] 端口 %SERVER_PORT% 已被占用，判定为信令服务已在运行
)

REM ---- 启动前端 -------------------------------------------------------------
netstat -ano | findstr /R /C:":%WEB_PORT% .*LISTENING" >nul
if errorlevel 1 (
  echo [启动] 前端页面  端口 %WEB_PORT%
  start "whiteboard-web-%WEB_PORT%" cmd /k "cd /d "%ROOT%web" && node ..\node_modules\vite\bin\vite.js"
) else (
  echo [跳过] 端口 %WEB_PORT% 已被占用，判定为前端已在运行
)

echo.
echo   打开 http://localhost:%WEB_PORT%/?room=demo
echo   多开几个标签页即可体验多人协作
echo.
timeout /t 4 >nul
