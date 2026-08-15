#!/usr/bin/env bash
# Используется в GitHub Actions: вшивает кастомный bootstrap + агент в termux-app
set -e
TERMUX_APP="${1:?termux-app dir required}"
PACKAGES_DIR="${2:?termux-packages dir required}"
REPO_DIR="${3:?repo dir required}"

cd "$TERMUX_APP"
BOOTSTRAP=$(find "$PACKAGES_DIR" -name 'bootstrap-aarch64.zip' | head -1)
if [ -z "$BOOTSTRAP" ]; then
  echo "ERROR: bootstrap-aarch64.zip not found"; exit 1
fi
mkdir -p app/src/main/cpp
cp "$BOOTSTRAP" app/src/main/cpp/bootstrap-aarch64.zip
echo "Embedded bootstrap: $BOOTSTRAP ($(du -h "$BOOTSTRAP" | cut -f1))"

# Запрещаем downloadBootstrap() перезаписывать наш кастомный bootstrap
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

# Вшиваем агент и конфиг в assets
mkdir -p app/src/main/assets/agent
cp "$REPO_DIR/agent-runtime.js" app/src/main/assets/agent/
cp -r "$REPO_DIR/config" app/src/main/assets/agent/
echo "Agent embedded into assets"
