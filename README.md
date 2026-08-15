# Multi CLI-Agent

Две версии одного агента:

| Версия | Платформа | Что внутри |
|--------|-----------|------------|
| **APK** | Android (arm64) | Termux с встроенными **Node.js**, **Python**, git, openssh, curl и др. + CLI-агент `agent-runtime.js` |
| **PC** | Linux / macOS / Windows (WSL) | Тот же `agent-runtime.js`, запускается через `node` |

## Смена модели
Модель (и провайдер) меняются:
1. Через **конфиг-файл** `config/models.env` (редактируется в любом текстовом редакторе/блокноте) — см. раздел «Настройка».
2. Или изнутри лаунчера: `/provider` и `/models` в CLI.

## Сборка APK
APK собирается на **GitHub Actions** (терминбокс-раннер) и публикуется в Releases.
См. `.github/workflows/build.yml`.

## Запуск
- **APK**: установи `app-arm64.apk` из Releases → открой Termux → `cli` → `agent`.
- **PC**: `node agent-runtime.js` или `./launcher-pc.sh`.
