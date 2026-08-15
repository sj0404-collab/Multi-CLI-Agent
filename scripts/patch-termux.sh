#!/usr/bin/env bash
# Используется в GitHub Actions: вшивает официальные bootstraps (все ABI) + агента
# в termux-app и добавляет скрипт первого запуска, который ставит node/python.
set -e
TERMUX_APP="${1:?termux-app dir required}"
BOOTSTRAP_DIR="${2:?bootstrap dir required}"
REPO_DIR="${3:?repo dir required}"

cd "$TERMUX_APP"

# Вшиваем bootstrap для всех ABI в cpp (termux-app компилирует native для всех).
mkdir -p app/src/main/cpp
for arch in aarch64 arm i686 x86_64; do
  f="$BOOTSTRAP_DIR/bootstrap-${arch}.zip"
  if [ -f "$f" ]; then
    cp "$f" "app/src/main/cpp/bootstrap-${arch}.zip"
    echo "Embedded bootstrap-${arch}.zip ($(du -h "$f" | cut -f1))"
  else
    echo "WARN: $f not found"
  fi
done

# Запрещаем downloadBootstrap() перезаписывать наши кастомные bootstraps.
python3 - "$TERMUX_APP" <<'PYEOF'
import sys
app = sys.argv[1]
p = app + "/app/build.gradle"
s = open(p).read()
head, sep, rest = s.partition('downloadBootstrap() {')
if sep and 'return;' not in rest.split('}',1)[0][:400]:
    s = head + sep + "\n        return; // injected: keep custom bootstraps\n" + rest
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
echo "[setup] Готово. Рантаймы:"
node --version 2>/dev/null || echo "  (node не установился)"
python --version 2>/dev/null || echo "  (python не установился)"
echo "[setup] Запуск агента..."
cp /data/data/com.termux/files/usr/share/agent/agent-runtime.js "$HOME/agent-runtime.js" 2>/dev/null || true
exec node "$HOME/agent-runtime.js" 2>/dev/null || exec bash
SETUP
chmod +x app/src/main/assets/agent/setup.sh

# Также положим агента в usr/share/agent для доступа из setup.sh.
mkdir -p app/src/main/assets/usr/share/agent
cp "$REPO_DIR/agent-runtime.js" app/src/main/assets/usr/share/agent/
cp -r "$REPO_DIR/config" app/src/main/assets/usr/share/agent/
echo "Agent + setup.sh embedded"
