#!/usr/bin/env python3
"""
Multi CLI-Agent — Python launcher.
Запускает агента: если есть Node — запускает agent-runtime.js,
иначе запускает встроенную Python-версию (agent_py.py).
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def main():
    args = sys.argv[1:]
    node = shutil.which("node")
    if node:
        # запуск основной (Node) версии агента
        script = ROOT / "agent-runtime.js"
        if script.exists():
            os.chdir(ROOT)
            cmd = [node, str(script)] + args
            try:
                os.execvp(node, cmd)
            except Exception as e:
                print(f"[launcher] Не удалось запустить Node-версию: {e}", file=sys.stderr)
    # fallback: Python-версия
    py = ROOT / "python" / "agent_py.py"
    if py.exists():
        os.chdir(ROOT)
        cmd = [sys.executable, str(py)] + args
        try:
            os.execvp(sys.executable, cmd)
        except Exception as e:
            print(f"[launcher] Не удалось запустить Python-версию: {e}", file=sys.stderr)
    print("[launcher] Агент не найден. Установи Node.js или запусти python/agent_py.py", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
