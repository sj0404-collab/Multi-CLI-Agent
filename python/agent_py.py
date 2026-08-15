#!/usr/bin/env python3
"""
Multi CLI-Agent — Python edition.
Чистый Python 3, только стандартная библиотека (без pip-зависимостей).

Поддерживает провайдеры:
  zen          — бесплатные модели OpenCode Zen (без ключа)
  openrouter   — OpenRouter (ключ OPENROUTER_API_KEY)
  github       — GitHub Models (ключ GITHUB_TOKEN / GITHUB_MODELS_TOKEN)
  huggingface  — Hugging Face Inference (ключ HF_TOKEN / HUGGINGFACE_TOKEN)

Смена модели: config/models.env (редактируется в блокноте) или флаги ниже.

Использование:
  python3 agent_py.py "твоя задача"          # одноразовый запуск
  python3 agent_py.py --interactive           # интерактивный чат
  python3 agent_py.py --model <id> "задача"   # конкретная модель
  python3 agent_py.py --tools                 # список доступных инструментов

Инструменты: read_file, write_file, edit_file, list_dir, run_cmd, todo.
"""
import argparse
import base64
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.request
import urllib.error
import pathlib
from datetime import datetime

# ────────────────────────────────────────────────────────────────────────────
#  CONFIG
# ────────────────────────────────────────────────────────────────────────────
CONFIG = {
    "provider": "zen",
    "model": "deepseek-v4-flash-free",
    "vision_model": "google/gemma-4-31b-it:free",
    "agent_mode": "build",
    "auto_approve": False,
    "max_steps": 25,
    "temperature": 0.5,
    "zen_api": "https://opencode.ai/zen/v1",
    "openrouter_api": "https://openrouter.ai/api/v1",
    "github_api": "https://models.github.ai/inference/chat/completions",
    "hf_api": "https://router.huggingface.co/v1/chat/completions",
}

ZEN_MODELS = [
    "deepseek-v4-flash-free", "mimo-v2.5-free", "nemotron-3-ultra-free",
    "hy3-free", "nemotron-3.5-lightning-free", "laguna-s-2.1-free",
]
OPENROUTER_FREE = [
    "google/gemma-4-31b-it:free", "nvidia/nemotron-3-ultra-550b-a55b:free",
    "nvidia/nemotron-3-super-120b-a12b:free", "openai/gpt-oss-20b:free",
]
GITHUB_MODELS = [
    "openai/gpt-4.1", "openai/gpt-4.1-mini", "openai/gpt-4o-mini",
    "meta-llama/llama-3.3-70b-instruct",
]
HF_MODELS = [
    "openai/gpt-oss-120b:cerebras", "meta-llama/Llama-3.3-70B-Instruct",
    "Qwen/Qwen2.5-72B-Instruct", "microsoft/phi-4",
]


def load_config():
    """Читает config/models.env, если есть."""
    here = pathlib.Path(__file__).resolve().parent
    for cand in [here / ".." / "config" / "models.env", here / "config" / "models.env"]:
        if cand.exists():
            for line in cand.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip().upper()
                v = v.strip().strip('"').strip("'")
                if k == "PROVIDER" and v:
                    CONFIG["provider"] = v.lower()
                elif k == "MODEL" and v:
                    CONFIG["model"] = v
                elif k == "VISION_MODEL" and v:
                    CONFIG["vision_model"] = v
                elif k == "AGENT_MODE" and v:
                    CONFIG["agent_mode"] = v.lower()
                elif k == "AUTO_APPROVE" and v in ("1", "true", "yes"):
                    CONFIG["auto_approve"] = True
                elif k == "OPENROUTER_API_KEY" and v:
                    os.environ.setdefault("OPENROUTER_API_KEY", v)
                elif k == "GITHUB_TOKEN" and v:
                    os.environ.setdefault("GITHUB_TOKEN", v)
                elif k == "HF_TOKEN" and v:
                    os.environ.setdefault("HF_TOKEN", v)
            break
    # env переопределяет
    for e in ("OPENROUTER_API_KEY", "GITHUB_TOKEN", "GITHUB_MODELS_TOKEN", "HF_TOKEN"):
        if os.environ.get(e):
            pass


def models_for(provider):
    if provider == "zen":
        return ZEN_MODELS
    if provider == "openrouter":
        return OPENROUTER_FREE
    if provider == "github":
        return GITHUB_MODELS
    if provider == "huggingface":
        return HF_MODELS
    return ZEN_MODELS


def provider_ready(provider):
    if provider == "zen":
        return True
    if provider == "openrouter":
        return bool(os.environ.get("OPENROUTER_API_KEY"))
    if provider in ("github",):
        return bool(os.environ.get("GITHUB_TOKEN") or os.environ.get("GITHUB_MODELS_TOKEN"))
    if provider == "huggingface":
        return bool(os.environ.get("HF_TOKEN"))
    return False


# ────────────────────────────────────────────────────────────────────────────
#  HTTP helper
# ────────────────────────────────────────────────────────────────────────────
def http_post_json(url, payload, headers=None, timeout=90):
    data = json.dumps(payload).encode("utf-8")
    hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdrs, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"error": {"message": body[:300]}}
    except Exception as e:
        return 0, {"error": {"message": str(e)}}


def http_post_json_curl(url, payload, headers=None, timeout=90):
    """POST через curl (обходит Cloudflare TLS fingerprinting, как Node-версия)."""
    import shutil
    if not shutil.which("curl"):
        return 0, {"error": {"message": "curl не найден"}}
    data = json.dumps(payload).encode("utf-8")
    tmp = "/tmp/mca_req_" + str(int(time.time() * 1000)) + ".json"
    pathlib.Path(tmp).write_bytes(data)
    hdrs = ["-H", "Content-Type: application/json"]
    if headers:
        for k, v in headers.items():
            hdrs += ["-H", f"{k}: {v}"]
    cmd = ["curl", "-s", "--max-time", str(timeout), "-X", "POST", url] + hdrs + \
          ["--data-binary", "@" + tmp, "-w", "\n%{http_code}"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10).stdout
    except Exception as e:
        pathlib.Path(tmp).unlink(missing_ok=True)
        return 0, {"error": {"message": str(e)}}
    pathlib.Path(tmp).unlink(missing_ok=True)
    out = out.strip()
    if not out:
        return 0, {"error": {"message": "curl пустой ответ"}}
    # последняя строка — HTTP-код
    lines = out.rsplit("\n", 1)
    try:
        code = int(lines[1].strip())
    except (IndexError, ValueError):
        code = 0
    body = lines[0] if lines else ""
    try:
        return code, json.loads(body)
    except Exception:
        return code, {"error": {"message": body[:300]}}


def call_provider(provider, model, messages, max_tokens=2000):
    """Вызывает модель через выбранного провайдера. Возвращает текст или бросает."""
    if provider == "zen":
        url = CONFIG["zen_api"] + "/chat/completions"
        payload = {"model": model, "messages": messages, "max_tokens": max_tokens,
                   "temperature": CONFIG["temperature"], "stream": False}
        status, j = http_post_json(url, payload)
        # Cloudflare 1010/403 — urllib блокируется. Обходим через curl (как Node-версия).
        if status in (403, 0) or (status >= 400 and "1010" in json.dumps(j)):
            status, j = http_post_json_curl(url, payload)
        if status >= 300:
            raise RuntimeError(j.get("error", {}).get("message", f"HTTP {status}"))
        msg = j.get("choices", [{}])[0].get("message", {})
        text = msg.get("content") or ""
        if not text:
            text = msg.get("reasoning") or msg.get("reasoning_content") or ""
        return text, model

    if provider == "openrouter":
        key = os.environ.get("OPENROUTER_API_KEY")
        if not key:
            raise RuntimeError("Нет OPENROUTER_API_KEY")
        url = CONFIG["openrouter_api"] + "/chat/completions"
        payload = {"model": model, "messages": messages, "max_tokens": max_tokens,
                   "temperature": CONFIG["temperature"]}
        status, j = http_post_json(url, payload,
                                   headers={"Authorization": "Bearer " + key})
        if status >= 300:
            raise RuntimeError(j.get("error", {}).get("message", f"HTTP {status}"))
        msg = j.get("choices", [{}])[0].get("message", {})
        return (msg.get("content") or ""), (j.get("model") or model)

    if provider == "github":
        key = os.environ.get("GITHUB_TOKEN") or os.environ.get("GITHUB_MODELS_TOKEN")
        if not key:
            raise RuntimeError("Нет GITHUB_TOKEN/GITHUB_MODELS_TOKEN")
        payload = {"model": model, "messages": messages, "max_tokens": max_tokens}
        status, j = http_post_json(CONFIG["github_api"], payload,
                                   headers={"Authorization": "Bearer " + key,
                                            "Accept": "application/vnd.github+json"})
        if status >= 300:
            raise RuntimeError(j.get("error", {}).get("message", f"HTTP {status}"))
        msg = j.get("choices", [{}])[0].get("message", {})
        return (msg.get("content") or ""), (j.get("model") or model)

    if provider == "huggingface":
        key = os.environ.get("HF_TOKEN")
        if not key:
            raise RuntimeError("Нет HF_TOKEN")
        payload = {"model": model, "messages": messages, "max_tokens": max_tokens}
        status, j = http_post_json(CONFIG["hf_api"], payload,
                                   headers={"Authorization": "Bearer " + key})
        if status >= 300:
            raise RuntimeError(j.get("error", {}).get("message", f"HTTP {status}"))
        msg = j.get("choices", [{}])[0].get("message", {})
        return (msg.get("content") or ""), (j.get("model") or model)

    raise RuntimeError("Неизвестный провайдер: " + provider)


def call_with_failover(provider, model, messages):
    """Пробует запрошенную модель, затем остальные модели провайдера."""
    seen = set()
    candidates = [model] + [m for m in models_for(provider) if m != model]
    last_err = None
    for m in candidates:
        if m in seen:
            continue
        seen.add(m)
        try:
            text, used = call_provider(provider, m, messages)
            if text and text.strip():
                return text, used
        except Exception as e:
            last_err = e
            print(f"  ⚠️ модель {m}: {e}. Пробую следующую...")
    raise last_err or RuntimeError("Ни одна модель не ответила")


# ────────────────────────────────────────────────────────────────────────────
#  ИНСТРУМЕНТЫ (файлы, команды, todo)
# ────────────────────────────────────────────────────────────────────────────
def run_cmd(cmd, cwd=None):
    try:
        r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True,
                           text=True, timeout=120)
        return {"success": r.returncode == 0, "stdout": r.stdout[-2000:],
                "stderr": r.stderr[-2000:], "exit": r.returncode}
    except subprocess.TimeoutExpired:
        return {"success": False, "stdout": "", "stderr": "timeout", "exit": 124}


def read_file(path):
    p = pathlib.Path(path)
    if not p.exists():
        return {"error": "Файл не найден: " + path}
    if p.stat().st_size > 2_000_000:
        return {"error": "Файл слишком большой"}
    try:
        return {"success": True, "path": str(p), "content": p.read_text(encoding="utf-8")}
    except Exception as e:
        return {"error": str(e)}


def write_file(path, content):
    p = pathlib.Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return {"success": True, "path": str(p), "bytes": p.stat().st_size}


def list_dir(path="."):
    p = pathlib.Path(path)
    if not p.is_dir():
        return {"error": "Не папка: " + path}
    items = []
    for e in sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name)):
        items.append({"name": e.name, "type": "directory" if e.is_dir() else "file"})
    return {"success": True, "path": str(p), "items": items[:200]}


def todo_list(todo_file):
    if os.path.exists(todo_file):
        try:
            return json.loads(pathlib.Path(todo_file).read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def todo_add(todo_file, text):
    todos = todo_list(todo_file)
    todos.append({"id": len(todos) + 1, "text": text, "done": False,
                  "ts": datetime.now().isoformat()})
    pathlib.Path(todo_file).write_text(json.dumps(todos, ensure_ascii=False, indent=2),
                                       encoding="utf-8")
    return {"success": True, "id": len(todos)}


def todo_done(todo_file, tid):
    todos = todo_list(todo_file)
    for t in todos:
        if t.get("id") == int(tid):
            t["done"] = True
            pathlib.Path(todo_file).write_text(
                json.dumps(todos, ensure_ascii=False, indent=2), encoding="utf-8")
            return {"success": True, "id": int(tid)}
    return {"error": "Задача не найдена"}


def execute_tool(name, args, state):
    """Выполняет один инструмент. state — {cwd, todo_file}."""
    cwd = state.get("cwd", ".")
    if name == "run_cmd":
        return run_cmd(args.get("command", ""), cwd=args.get("cwd", cwd))
    if name == "read_file":
        return read_file(args.get("path", ""))
    if name == "write_file":
        return write_file(args.get("path", ""), args.get("content", ""))
    if name == "list_dir":
        return list_dir(args.get("path", "."))
    if name == "todo_list":
        return {"success": True, "todos": todo_list(state["todo_file"])}
    if name == "todo_add":
        return todo_add(state["todo_file"], args.get("text", ""))
    if name == "todo_done":
        return todo_done(state["todo_file"], args.get("id"))
    if name == "pwd":
        return {"success": True, "cwd": os.getcwd()}
    return {"error": "Неизвестный инструмент: " + name}


TOOL_SCHEMA = {
    "run_cmd": "Выполнить shell-команду. args: {command}",
    "read_file": "Прочитать файл. args: {path}",
    "write_file": "Записать файл. args: {path, content}",
    "list_dir": "Список папки. args: {path}",
    "todo_list": "Показать задачи.",
    "todo_add": "Добавить задачу. args: {text}",
    "todo_done": "Отметить задачу. args: {id}",
    "pwd": "Текущая папка.",
}

SYSTEM_PROMPT = """Ты — Python-CLI-агент Multi CLI-Agent.
Работай через инструменты (TOOL_JSON), а не догадки. Доступные инструменты:
{schemas}
Отвечай кратко на русском. Показывай честные результаты: если инструмент вернул ошибку — не утверждай, что сделал."""


def parse_tool_json(text):
    """Извлекает все JSON-объекты с полем tool. Возвращает список вызовов."""
    calls = []
    # вариант: TOOL_JSON:{...}
    for m in re.finditer(r'TOOL_JSON\s*:\s*(\{)', text):
        start = m.start(1)
        obj, end = extract_json(text, start)
        if obj:
            try:
                j = json.loads(obj)
                if "tool" in j:
                    calls.append(j)
            except Exception:
                pass
    # вариант: голый {...tool...} на строке
    if not calls:
        for m in re.finditer(r'\{[^{}]*"tool"\s*:', text):
            obj, end = extract_json(text, m.start())
            if obj:
                try:
                    j = json.loads(obj)
                    if "tool" in j:
                        calls.append(j)
                except Exception:
                    pass
    return calls


def extract_json(text, start):
    """Балансирует скобки, начиная с '{' на позиции start. Возвращает (json_str, end)."""
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1], i + 1
    return None, len(text)


def agent_loop(user_input, state):
    """Один цикл агента: зовёт модель, выполняет инструменты, повторяет."""
    history = [{"role": "user", "content": user_input}]
    for step in range(CONFIG["max_steps"]):
        schemas = "\n".join(f"  {k}: {v}" for k, v in TOOL_SCHEMA.items())
        messages = [{"role": "system", "content": SYSTEM_PROMPT.format(schemas=schemas)}] + history
        text, used = call_with_failover(CONFIG["provider"], CONFIG["model"], messages)
        print(f"\n[{used}] {text}\n")
        calls = parse_tool_json(text)
        if not calls:
            return text
        # выполняем все вызовы последовательно
        for tool in calls:
            name, args = tool.get("tool"), tool.get("args", {})
            if CONFIG["agent_mode"] in ("plan", "explore") and name in ("write_file", "run_cmd"):
                res = {"error": "Режим " + CONFIG["agent_mode"] + ": изменения запрещены"}
            else:
                res = execute_tool(name, args, state)
            print(f"  🛠 {name} => {json.dumps(res, ensure_ascii=False)[:300]}")
            history.append({"role": "assistant", "content": "TOOL_JSON:" + json.dumps(tool)})
            history.append({"role": "user", "content": "Результат: " + json.dumps(res, ensure_ascii=False)})
    return "Достигнут лимит шагов"


# ────────────────────────────────────────────────────────────────────────────
#  CLI
# ────────────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Multi CLI-Agent (Python)")
    ap.add_argument("prompt", nargs="*", help="задача")
    ap.add_argument("--interactive", action="store_true", help="интерактивный чат")
    ap.add_argument("--model", help="id модели")
    ap.add_argument("--provider", help="zen|openrouter|github|huggingface")
    ap.add_argument("--tools", action="store_true", help="список инструментов")
    args = ap.parse_args()

    load_config()
    if args.provider:
        CONFIG["provider"] = args.provider.lower()
    if args.model:
        CONFIG["model"] = args.model

    state = {"cwd": os.getcwd(), "todo_file": os.path.join(os.getcwd(), ".python_todo.json")}

    if args.tools:
        for k, v in TOOL_SCHEMA.items():
            print(f"  {k}: {v}")
        print(f"\nПровайдер: {CONFIG['provider']} | модель: {CONFIG['model']}")
        print("Готовность провайдера:", "да" if provider_ready(CONFIG["provider"]) else "нет (нужен ключ)")
        return

    if not args.interactive and not args.prompt:
        ap.print_help()
        return

    if not provider_ready(CONFIG["provider"]):
        print(f"[!] Провайдер {CONFIG['provider']} не готов (нужен ключ).")
        print("  openrouter: OPENROUTER_API_KEY; github: GITHUB_TOKEN; huggingface: HF_TOKEN")
        return

    if args.interactive:
        print(f"Multi CLI-Agent (Python) | {CONFIG['provider']} | {CONFIG['model']} | Ctrl+D — выход")
        while True:
            try:
                u = input("\n> ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\nПока!")
                break
            if not u:
                continue
            if u in ("exit", "/exit", "quit"):
                break
            agent_loop(u, state)
    else:
        agent_loop(" ".join(args.prompt), state)


if __name__ == "__main__":
    main()
