#!/usr/bin/env bash
# Запуск браузерной версии агента в Docker
# Открой браузер: http://localhost:8765
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
echo "Сборка образа..."
docker build -t multi-cli-agent .
echo "Запуск (порт 8765)..."
docker run --rm -it -p 8765:8765 \
  -e OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}" \
  -e GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
  -e HF_TOKEN="${HF_TOKEN:-}" \
  -v "$PWD/data:/data" \
  multi-cli-agent
