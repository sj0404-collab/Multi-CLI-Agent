#!/usr/bin/env python3
"""
Multi Uni-Browser — backend server.
Проксирует любую страницу в чистый читаемый текст, отдаёт web-приложение,
AI-чат, перевод и OCR. Всё на стандартной библиотеке Python 3.
Запуск:  python3 server.py  →  http://0.0.0.0:8765
"""
import http.server
import urllib.request
import urllib.parse
import re
import json
import html
import os
import sys

PORT = int(os.environ.get("PORT", "8765"))
ROOT = os.path.dirname(os.path.abspath(__file__))

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

# ── Чистка HTML в читаемый текст ────────────────────────────────────────────
BLOCK_TAGS = ["p","div","section","article","h1","h2","h3","h4","h5","h6","li","br","tr","blockquote","pre","td","th","footer","header"]
IGNORE = re.compile(r"<(script|style|noscript|svg|canvas|iframe|form|button|nav|aside)[^>]*>.*?</\1>", re.S | re.I)

def html_to_text(raw):
    raw = IGNORE.sub(" ", raw)
    for tag in BLOCK_TAGS:
        raw = re.sub(r"</?(%s)[^>]*>" % tag, "\n", raw, flags=re.I)
    raw = re.sub(r"<[^>]+>", " ", raw)
    raw = html.unescape(raw)
    raw = re.sub(r"[ \t]+", " ", raw)
    raw = re.sub(r"\n\s*\n+", "\n\n", raw)
    lines = [l.strip() for l in raw.split("\n")]
    lines = [l for l in lines if l]
    return "\n".join(lines)

def fetch_page(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=25) as r:
        data = r.read()
        ctype = r.headers.get("Content-Type", "")
    charset = "utf-8"
    m = re.search(r"charset=([\w-]+)", ctype, re.I)
    if m: charset = m.group(1)
    try:
        text = data.decode(charset, errors="replace")
    except Exception:
        text = data.decode("utf-8", errors="replace")
    title = ""
    tm = re.search(r"<title[^>]*>(.*?)</title>", text, re.S | re.I)
    if tm: title = html.unescape(re.sub(r"<[^>]+>", "", tm.group(1))).strip()
    return {"url": url, "title": title or url, "content": html_to_text(text)}

# ── AI chat (OpenRouter / Zen) ───────────────────────────────────────────────
# Free-модели Zen для автосмены при исчерпании лимита/ошибке провайдера.
ZEN_MODELS = ["mimo-v2.5-free", "hy3-free", "nemotron-3.5-lightning-free",
              "laguna-s-2.1-free", "deepseek-v4-flash-free", "nemotron-3-ultra-free"]
OR_FREE = ["google/gemma-4-31b-it:free", "nvidia/nemotron-3-ultra-550b-a55b:free",
           "openai/gpt-oss-20b:free", "cohere/north-mini-code:free"]

def _is_limit(body):
    return "FreeUsageLimit" in body or "Rate limit" in body or "429" in body or "Internal server error" in body

def call_ai(provider, key, model, messages, max_tokens=1500):
    if provider == "openrouter":
        url = "https://openrouter.ai/api/v1/chat/completions"
        headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
        fallback_models = [model] + OR_FREE
    elif provider == "zen":
        url = "https://opencode.ai/zen/v1/chat/completions"
        headers = {"Content-Type": "application/json"}
        fallback_models = [model] + ZEN_MODELS
    else:
        return {"error": "Неизвестный провайдер"}

    seen = set()
    last = {"error": "нет ответа"}
    for m in fallback_models:
        if m in seen:
            continue
        seen.add(m)
        payload = {"model": m, "messages": messages, "max_tokens": max_tokens, "stream": False}
        try:
            req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=90) as r:
                j = json.loads(r.read())
            msg = j.get("choices", [{}])[0].get("message", {})
            content = msg.get("content") or ""
            if not content:
                content = msg.get("reasoning") or msg.get("reasoning_content") or ""
            if content:
                return {"reply": content, "model": j.get("model", m)}
            # пустой content — попробуем curl-fallback (Cloudflare)
            res = call_ai_curl(url, headers, payload)
            if res.get("reply"):
                return res
            last = {"error": "пустой ответ от " + m}
        except urllib.error.HTTPError as e:
            try: body = e.read().decode()
            except Exception: body = ""
            if _is_limit(body):
                last = {"error": f"лимит на {m}, пробую другую"}
                continue
            if e.code in (403, 429) or "1010" in body or e.code == 0:
                res = call_ai_curl(url, headers, payload)
                if res.get("reply"):
                    return res
                last = {"error": "curl: " + str(res.get("error", ""))}
                continue
            last = {"error": f"HTTP {e.code}: {body[:200]}"}
        except Exception as e:
            last = {"error": str(e)}
    return last

def call_ai_curl(url, headers, payload):
    import subprocess, tempfile
    try:
        tmp = tempfile.mktemp(suffix=".json")
        open(tmp, "w").write(json.dumps(payload))
        cmd = ["curl", "-s", "--max-time", "120", "-X", "POST", url,
               "-H", "Content-Type: application/json",
               "--data-binary", "@" + tmp]
        for k, v in headers.items():
            cmd += ["-H", f"{k}: {v}"]
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=130).stdout
        os.unlink(tmp)
        j = json.loads(out)
        msg = j.get("choices", [{}])[0].get("message", {})
        content = msg.get("content") or ""
        if not content:
            content = msg.get("reasoning") or msg.get("reasoning_content") or ""
        return {"reply": content, "model": j.get("model", "zen-curl")}
    except Exception as e:
        return {"error": "curl fallback: " + str(e)}

# ── HTTP handler ─────────────────────────────────────────────────────────────
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _html(self, body):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, rel, ctype):
        p = os.path.join(ROOT, rel)
        if not os.path.isfile(p):
            self.send_response(404); self.end_headers(); return
        data = open(p, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path in ("/", "/index.html"):
            self._file("index.html", "text/html; charset=utf-8")
        elif path == "/app.js":
            self._file("app.js", "application/javascript")
        elif path == "/style.css":
            self._file("style.css", "text/css")
        elif path == "/api/fetch":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            url = q.get("url", [""])[0]
            if not url:
                self._json(400, {"error": "url required"}); return
            if not url.startswith(("http://", "https://")):
                url = "https://" + url
            try:
                self._json(200, fetch_page(url))
            except Exception as e:
                self._json(502, {"error": "Не удалось загрузить страницу: " + str(e)})
        elif path == "/api/ai":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            self._json(200, {"status": "use POST /api/ai"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        ln = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(ln).decode("utf-8", errors="replace") if ln else "{}"
        try: body = json.loads(raw)
        except Exception: body = {}
        if path == "/api/ai":
            provider = body.get("provider", "zen")
            model = body.get("model", "deepseek-v4-flash-free" if provider == "zen" else "google/gemma-4-31b-it:free")
            messages = body.get("messages", [])
            key = body.get("key", "") or os.environ.get("OPENROUTER_API_KEY", "")
            self._json(200, call_ai(provider, key, model, messages))
        else:
            self._json(404, {"error": "not found"})

if __name__ == "__main__":
    print(f"Multi Uni-Browser running at http://0.0.0.0:{PORT}")
    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
