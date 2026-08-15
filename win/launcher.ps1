# Multi CLI-Agent (Windows PowerShell)
$dir = Split-Path -Parent $PSScriptRoot
Set-Location $dir
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "[ERROR] Node.js не найден. Установи его: https://nodejs.org" -ForegroundColor Red
  exit 1
}
node .\agent-runtime.js @args
