#!/usr/bin/env bash
# Multi CLI-Agent — Linux (auto-installs Node if missing)
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "[MultiCLI] Установка/проверка Node.js..."
if ! command -v node >/dev/null 2>&1; then
  echo "[MultiCLI] Node.js не найден. Устанавливаю Node 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>/dev/null || {
    echo "Не удалось через nodesource. Пробую apt install nodejs npm..."
    sudo apt-get install -y nodejs npm
  }
  sudo apt-get install -y nodejs 2>/dev/null || true
fi
node --version
echo "[MultiCLI] Запуск агента..."
exec node "$DIR/agent-runtime.js" "$@"
