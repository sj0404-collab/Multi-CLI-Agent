@echo off
rem Multi CLI-Agent (Windows)
rem Смена модели: отредактируй config\models.env в блокноте
setlocal
cd /d "%~dp0.."
if not exist node_modules\agent-runtime.js (
  echo [MultiCLI] Запускаю agent-runtime.js...
)
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js не найден. Установи его: https://nodejs.org
  pause
  exit /b 1
)
node agent-runtime.js %*
endlocal
