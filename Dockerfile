# Multi CLI-Agent — браузерная (Docker) версия
# Запускает встроенный web-интерфейс агента на порту 8765.
FROM node:20-slim

WORKDIR /app

# системные зависимости для агента (git, openssh, curl)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client curl ca-certificates bash \
    && rm -rf /var/lib/apt/lists/*

# копируем агента и конфиг
COPY agent-runtime.js ./agent-runtime.js
COPY config/ ./config/
COPY launcher-pc.sh ./launcher-pc.sh

# порт встроенного web/MCP-сервера
ENV MCP_PORT=8765
EXPOSE 8765

# ключи (опционально) через env при docker run
ENV OPENROUTER_API_KEY=""
ENV GITHUB_TOKEN=""
ENV HF_TOKEN=""

CMD ["node", "agent-runtime.js"]
