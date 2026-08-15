#!/usr/bin/env bash
# Используется в GitHub Actions: вшивает официальный bootstrap + агент в termux-app
# и добавляет скрипт первого запуска, который ставит node/python.
set -e
TERMUX_APP="${1:?termux-app dir required}"
BOOTSTRAP_DIR="${2:?bootstrap dir required}"
REPO_DIR="${3:?repo dir required}"

cd "$TERMUX_APP"
BOOTSTRAP="$BOOTSTRAP_DIR/bootstrap-aarch64.zip"
if [ ! -f "$BOOTSTRAP" ]; then
  echo "ERROR: bootstrap-aarch64.zip not found in $BOOTSTRAP_DIR"; exit 1
fi

# Кладём кастомный bootstrap в cpp, чтобы он не перезаписался при сборке.
mkdir -p app/src/main/cpp
cp "$BOOTSTRAP" app/src/main/cpp/bootstrap-aarch64.zip
echo "Embedded bootstrap: $BOOTSTRAP ($(du -h "$BOOTSTRAP" | cut -f1))"

# Запрещаем downloadBootstrap() перезаписывать наш кастомный bootstrap.
python3 - "$TERMUX_APP" <<'PYEOF'
import sys
app = sys.argv[1]
p = app + "/app/build.gradle"
s = open(p).read()
head, sep, rest = s.partition('downloadBootstrap() {')
if sep and 'return;' not in rest.split('}',1)[0][:400]:
    s = head + sep + "\n        return; // injected: keep custom bootstrap\n" + rest
    open(p,'w').write(s)
    print("Patched downloadBootstrap() with return;")
else:
    print("downloadBootstrap already patched / not found")
PYEOF

# Вшиваем агента, конфиг и скрипт первого запуска в assets.
mkdir -p app/src/main/assets/agent
cp "$REPO_DIR/agent-runtime.js" app/src/main/assets/agent/
cp -r "$REPO_DIR/config" app/src/main/assets/agent/
# Скрипт первого запуска: ставит node/python/git/openssh через apt (bootstrap содержит apt-get).
cat > app/src/main/assets/agent/setup.sh <<'SETUP'
#!/data/data/com.termux/files/usr/bin/bash
# Первый запуск: доустанавливаем рантаймы поверх официального bootstrap.
# (bootstrap уже содержит apt/dpkg/bash)
set -e
export PREFIX=/data/data/com.termux/files/usr
echo "[setup] Обновление пакетов..."
apt-get update -y 2>/dev/null || pkg update -y
echo "[setup] Установка nodejs, python, git, openssh, curl..."
apt-get install -y nodejs python git openssh curl jq openssl-tool nano 2>/dev/null \
  || pkg install -y nodejs python git openssh curl jq openssl-tool nano
echo "[setup] Готово. Рантаймы установлены:"
node --version 2>/dev/null || echo "  (node не установился)"
python --version 2>/dev/null || echo "  (python не установился)"
echo "[setup] Запуск агента..."
cd "$PREFIX/../home" 2>/dev/null || cd "$HOME"
cp "$PREFIX/../usr/share/agent/agent-runtime.js" "$HOME/agent-runtime.js" 2>/dev/null || \
  cp /data/data/com.termux/files/usr/share/agent/agent-runtime.js "$HOME/agent-runtime.js" 2>/dev/null || true
exec node "$HOME/agent-runtime.js" 2>/dev/null || exec bash
SETUP
chmod +x app/src/main/assets/agent/setup.sh
# Также положим агент в usr/share для доступа из setup.sh.
mkdir -p app/src/main/assets/usr/share/agent
cp "$REPO_DIR/agent-runtime.js" app/src/main/assets/usr/share/agent/
cp -r "$REPO_DIR/config" app/src/main/assets/usr/share/agent/
echo "Agent + setup.sh embedded"
