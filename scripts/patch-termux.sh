#!/usr/bin/env bash
# Используется в GitHub Actions: подготавливает termux-app к сборке как
# ОТДЕЛЬНОГО приложения (не конфликтующего с установленным Termux):
#   - меняет package name на com.termux.multiagent
#   - настраивает подпись своим ключом
#   - вшивает кастомный bootstrap + агента
set -e
TERMUX_APP="${1:?termux-app dir required}"
BOOTSTRAP_DIR="${2:?bootstrap dir required}"
REPO_DIR="${3:?repo dir required}"
NEW_PKG="${4:-com.termux.multiagent}"
NEW_PKG_SLUG="${NEW_PKG//./_}"

cd "$TERMUX_APP"

# 1. Меняем package name / namespace / applicationId с com.termux на уникальный.
python3 - "$TERMUX_APP" "$NEW_PKG" <<'PYEOF'
import sys, os, re
app, newpkg = sys.argv[1], sys.argv[2]
old = "com.termux"

def patch(path):
    if not os.path.exists(path): return
    s = open(path, encoding='utf-8', errors='ignore').read()
    ns = s.replace('namespace "%s"'%old, 'namespace "%s"'%newpkg) \
           .replace('applicationId "%s"'%old, 'applicationId "%s"'%newpkg) \
           .replace('package="%s"'%old, 'package="%s"'%newpkg)
    if ns != s:
        open(path,'w',encoding='utf-8').write(ns)
        print("patched", os.path.relpath(path, app))

# build.gradle (root + app)
for root in [app, app+"/app", app+"/termux-shared", app+"/terminal-emulator", app+"/terminal-view"]:
    patch(os.path.join(root, "build.gradle"))

# AndroidManifest.xml (app + libraries)
for root, dirs, files in os.walk(app):
    if 'build' in root.split(os.sep): continue
    for f in files:
        if f == 'AndroidManifest.xml':
            p = os.path.join(root, f)
            s = open(p, encoding='utf-8', errors='ignore').read()
            ns = s.replace('package="%s"'%old, 'package="%s"'%newpkg)
            if ns != s:
                open(p,'w',encoding='utf-8').write(ns)
                print("patched", os.path.relpath(p, app))
PYEOF

# 2. Вшиваем кастомный bootstrap (aarch64) в cpp.
mkdir -p app/src/main/cpp
f="$BOOTSTRAP_DIR/bootstrap-aarch64.zip"
if [ -f "$f" ]; then
  cp "$f" "app/src/main/cpp/bootstrap-aarch64.zip"
  echo "Embedded bootstrap-aarch64.zip ($(du -h "$f" | cut -f1))"
else
  echo "ERROR: bootstrap-aarch64.zip not found"; exit 1
fi

# 3. Запрещаем downloadBootstrap() перезаписывать наш кастомный bootstrap.
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

# 4. Настраиваем подпись своим ключом в app/build.gradle.
python3 - "$TERMUX_APP" "$REPO_DIR" <<'PYEOF'
import sys, re
app, repo = sys.argv[1], sys.argv[2]
p = app + "/app/build.gradle"
s = open(p).read()
# Добавляем signingConfigs + указываем его в release buildType
keystore = repo + "/keystore/release.jks"
signing = '''
signingConfigs {
    release {
        storeFile file('%s')
        storePassword 'multiagent123'
        keyAlias 'multiagent'
        keyPassword 'multiagent123'
    }
}
''' % keystore
if 'signingConfigs {' not in s:
    s = s.replace('android {', 'android {\n' + signing, 1)
# указать release signingConfig
if 'buildTypes' in s:
    s = re.sub(r"release \{\n(\s*)minifyEnabled", "release {\n\\1minifyEnabled", s, count=1)
    # простая вставка signingConfig в release buildType
    s = s.replace("buildTypes {\n        release {", "buildTypes {\n        release {\n            signingConfig signingConfigs.release", 1)
open(p,'w').write(s)
print("Signing configured")
PYEOF

# 5. Вшиваем агента, конфиг и скрипт первого запуска в assets.
mkdir -p app/src/main/assets/agent
cp "$REPO_DIR/agent-runtime.js" app/src/main/assets/agent/
cp -r "$REPO_DIR/config" app/src/main/assets/agent/

cat > app/src/main/assets/agent/setup.sh <<'SETUP'
#!/data/data/com.termux.multiagent/files/usr/bin/bash
# Первый запуск: доустанавливаем рантаймы поверх кастомного bootstrap.
# (bootstrap уже содержит apt/dpkg/bash; пути под com.termux.multiagent)
set -e
export PREFIX=/data/data/com.termux.multiagent/files/usr
echo "[setup] Обновление пакетов..."
apt-get update -y 2>/dev/null || pkg update -y
echo "[setup] Установка nodejs, python, git, openssh, curl..."
apt-get install -y nodejs python git openssh curl jq openssl-tool nano 2>/dev/null \
  || pkg install -y nodejs python git openssh curl jq openssl-tool nano
echo "[setup] Готово. Рантаймы:"
node --version 2>/dev/null || echo "  (node не установился)"
python --version 2>/dev/null || echo "  (python не установился)"
echo "[setup] Запуск агента..."
cp /data/data/com.termux.multiagent/files/usr/share/agent/agent-runtime.js "$HOME/agent-runtime.js" 2>/dev/null || true
exec node "$HOME/agent-runtime.js" 2>/dev/null || exec bash
SETUP
chmod +x app/src/main/assets/agent/setup.sh

mkdir -p app/src/main/assets/usr/share/agent
cp "$REPO_DIR/agent-runtime.js" app/src/main/assets/usr/share/agent/
cp -r "$REPO_DIR/config" app/src/main/assets/usr/share/agent/
echo "Agent + setup.sh embedded"
