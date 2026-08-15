#!/usr/bin/env bash
# PC-версия: запускает agent-runtime.js через node.
# Смена модели — редактируй config/models.env
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "$DIR/config/models.env" ]; then
  echo "Нет config/models.env"; exit 1
fi
# читаем конфиг в окружение
set -a; source "$DIR/config/models.env"; set +a
# экспортируем только если непустые
[ -n "$PROVIDER" ] && export ZEN_PROVIDER="$PROVIDER"
[ -n "$MODEL" ] && export ZEN_MODEL="$MODEL"
[ -n "$AUTO_APPROVE" ] && [ "$AUTO_APPROVE" = "1" ] && export ZEN_AUTO=1
[ -n "$OPENROUTER_API_KEY" ] && export OPENROUTER_API_KEY="$OPENROUTER_API_KEY"
[ -n "$GITHUB_TOKEN" ] && export GITHUB_TOKEN="$GITHUB_TOKEN"
[ -n "$HF_TOKEN" ] && export HF_TOKEN="$HF_TOKEN"
exec node "$DIR/agent-runtime.js" "$@"
