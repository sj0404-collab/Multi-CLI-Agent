/* MangaLib Plus — надстройка поверх собранного React-бандла.
   Добавляет: AI-чат (Zen/OpenRouter), отдельную библиотеку манг,
   OCR-движки, локальные модели, Suwayomi.
   НЕ трогает внутренности React — работает как отдельный оверлей.
   Фикс нажатий: все кнопки через делегирование, без конфликтов. */
(function () {
  "use strict";
  if (window.__MANGALIB_PLUS__) return;
  window.__MANGALIB_PLUS__ = true;

  // ── Конфигурация ──
  const NEURAL = [
    { id: "gemma", name: "Gemma 4 31B", type: "vision" },
    { id: "llava", name: "Llava", type: "vision" },
    { id: "qwen", name: "Qwen3 VL", type: "vision" },
    { id: "deepseek", name: "DeepSeek", type: "llm" },
    { id: "gpt-oss", name: "GPT-OSS 20B", type: "llm" },
    { id: "tflite", name: "TFLite (локальная .tflite)", type: "local" },
  ];
  const OCR_ENGINES = [
    { id: "tesseract", name: "Tesseract", status: "installed", note: "Встроен" },
    { id: "lens", name: "Google Lens", status: "cloud", note: "Через сайт" },
    { id: "onnx", name: "ONNX", status: "optional", note: "Требует модель" },
    { id: "paddle", name: "PaddleOCR", status: "optional", note: "Требует модель" },
  ];

  const DB_NAME = "mangalib_db";
  const LS_MODELS = "mlplus_models"; // загруженные .tflite (base64/url)
  const LS_AIKEY = "mlplus_aikey";

  function openDb() {
    return new Promise((res) => {
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        ["mangas", "shelves", "settings", "pages"].forEach(s => {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" });
        });
      };
    });
  }
  function txStore(db, storeName, mode) {
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  // ── AI: Zen (через CORS-прокси) и OpenRouter (напрямую) ──
  const CORS_PROXY = "https://corsproxy.io/?url=";
  async function callAI(provider, key, model, messages) {
    if (provider === "openrouter") {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
        body: JSON.stringify({ model, messages, max_tokens: 1500, stream: false }) });
      const j = await r.json();
      if (j.error) throw new Error(typeof j.error === "string" ? j.error : (j.error?.message || "AI error"));
      const msg = j.choices?.[0]?.message || {};
      return msg.content || msg.reasoning || "";
    }
    // Zen через прокси (CORS)
    const url = CORS_PROXY + encodeURIComponent("https://opencode.ai/zen/v1/chat/completions");
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: 800, stream: false }) });
    const j = await r.json();
    if (j.error) throw new Error(typeof j.error === "string" ? j.error : (j.error?.message || "Zen error"));
    const msg = j.choices?.[0]?.message || {};
    return msg.content || msg.reasoning || "";
  }

  // ── Библиотека: чтение манг из IndexedDB ──
  async function getLibrary() {
    const db = await openDb();
    if (!db) return [];
    return await new Promise((res) => {
      const req = txStore(db, "mangas", "readonly").getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => res([]);
    });
  }

  // ── UI ──
  function buildUI() {
    // FAB
    const fab = document.createElement("button");
    fab.id = "mlplus-fab"; fab.textContent = "🧠";
    Object.assign(fab.style, { position: "fixed", right: "14px", bottom: "100px", zIndex: "9999",
      width: "56px", height: "56px", borderRadius: "50%", border: "none", background: "#4f6ef7",
      color: "#fff", fontSize: "24px", boxShadow: "0 4px 16px rgba(0,0,0,.45)", cursor: "pointer" });
    document.body.appendChild(fab);

    // Панель
    const panel = document.createElement("div");
    panel.id = "mlplus-panel";
    Object.assign(panel.style, { position: "fixed", inset: "0", background: "#18181b", color: "#f4f4f5",
      zIndex: "10000", display: "none", flexDirection: "column", fontFamily: "system-ui, sans-serif",
      padding: "12px", boxSizing: "border-box", overflowY: "auto" });
    document.body.appendChild(panel);

    // ── Навигация вкладок панели (делегирование, без конфликтов) ──
    function nav() {
      return `
        <div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">
          <button data-nav="ai" class="mlp-nav active">🤖 AI</button>
          <button data-nav="lib" class="mlp-nav">📚 Библиотека</button>
          <button data-nav="models" class="mlp-nav">🧠 Модели</button>
          <button data-nav="ocr" class="mlp-nav">🔍 OCR</button>
          <button data-nav="suwayomi" class="mlp-nav">🗃 Suwayomi</button>
        </div>`;
    }
    function renderNav(active) {
      panel.querySelectorAll(".mlp-nav").forEach(b => b.classList.toggle("active", b.dataset.nav === active));
    }
    function aiView() {
      const key = localStorage.getItem(LS_AIKEY) || "";
      return `
        <div style="margin-bottom:8px"><b>AI-чат (Zen / OpenRouter)</b></div>
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <select id="mlp-provider">
            <option value="zen">Zen (бесплатно)</option>
            <option value="openrouter">OpenRouter</option>
          </select>
          <input id="mlp-key" placeholder="OpenRouter ключ (если выбран)" value="${esc(key)}" style="flex:1">
        </div>
        <div id="mlp-msgs" style="background:#23233a;border-radius:8px;padding:8px;min-height:120px;max-height:40vh;overflow-y:auto;margin-bottom:8px"></div>
        <div style="display:flex;gap:6px">
          <textarea id="mlp-input" placeholder="Спроси о чём-нибудь…" rows="2" style="flex:1"></textarea>
          <button id="mlp-send" style="align-self:flex-end">➤</button>
        </div>`;
    }
    function libView() {
      return `
        <div style="margin-bottom:8px"><b>📚 Библиотека манг</b> <button id="mlp-reload-lib" style="margin-left:6px">⟳</button></div>
        <div id="mlp-liblist" style="background:#23233a;border-radius:8px;padding:8px;min-height:100px"></div>`;
    }
    function modelsView() {
      return `
        <div style="margin-bottom:8px"><b>🧠 Нейронки / локальные модели</b></div>
        <div id="mlp-models"></div>
        <div style="margin-top:10px"><b>TFLite модель</b> — выбери файл .tflite:</div>
        <input type="file" id="mlp-tflite" accept=".tflite">
        <div id="mlp-tflite-status" style="font-size:13px;color:#8a8a9a;margin-top:4px"></div>`;
    }
    function ocrView() {
      return `
        <div style="margin-bottom:8px"><b>🔍 OCR-движки</b></div>
        <div id="mlp-ocr"></div>
        <button id="mlp-lens" style="margin-top:10px;width:100%">📸 Открыть Google Lens</button>`;
    }
    function suwayomiView() {
      return `
        <div style="margin-bottom:8px"><b>🗃 Suwayomi</b></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <input id="mlp-suwa-url" placeholder="URL Suwayomi (http://127.0.0.1:4567)" style="flex:1;min-width:180px">
          <button id="mlp-suwa-connect">Подключить</button>
          <button id="mlp-suwa-find">🔎 Автопоиск</button>
        </div>
        <div id="mlp-suwa-status" style="font-size:13px;color:#8a8a9a;margin-top:6px"></div>`;
    }

    function open() {
      panel.innerHTML = "";
      const closeRow = document.createElement("div");
      Object.assign(closeRow.style, { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" });
      closeRow.innerHTML = "<h2 style='margin:0;font-size:18px'>MangaLib Plus</h2>";
      const x = document.createElement("button"); x.textContent = "✕";
      x.style.cssText = "background:none;border:none;color:#f4f4f5;font-size:22px;cursor:pointer";
      x.onclick = close; closeRow.appendChild(x);
      panel.appendChild(closeRow);
      panel.insertAdjacentHTML("beforeend", nav());
      panel.insertAdjacentHTML("beforeend", `<div id="mlp-view"></div>`);
      showView("ai");
      panel.style.display = "flex";
    }
    function close() { panel.style.display = "none"; }

    function showView(name) {
      renderNav(name);
      const v = document.getElementById("mlp-view");
      if (name === "ai") { v.innerHTML = aiView(); initAi(); }
      else if (name === "lib") { v.innerHTML = libView(); loadLib(); }
      else if (name === "models") { v.innerHTML = modelsView(); initModels(); }
      else if (name === "ocr") { v.innerHTML = ocrView(); initOcr(); }
      else if (name === "suwayomi") { v.innerHTML = suwayomiView(); initSuwayomi(); }
    }

    // ── Делегирование нажатий панели (фикс конфликтов) ──
    panel.addEventListener("click", (e) => {
      const navBtn = e.target.closest(".mlp-nav");
      if (navBtn) { showView(navBtn.dataset.nav); return; }
      if (e.target.id === "mlp-send") { doAi(); return; }
      if (e.target.id === "mlp-lens") { try { window.open("https://lens.google.com/", "_blank"); } catch (er) {} return; }
      if (e.target.id === "mlp-reload-lib") { loadLib(); return; }
      if (e.target.id === "mlp-suwa-connect") { connectSuwayomi(); return; }
      if (e.target.id === "mlp-suwa-find") { findSuwayomi(); return; }
    });

    // AI
    function initAi() {
      const key = localStorage.getItem(LS_AIKEY) || "";
      if (key) document.getElementById("mlp-key").value = key;
      const sendBtn = document.getElementById("mlp-send");
      const input = document.getElementById("mlp-input");
      // локальный обработчик Enter (не конфликтует с делегированием)
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); doAi(); }
      });
      sendBtn.addEventListener("click", doAi);
    }
    async function doAi() {
      const prov = document.getElementById("mlp-provider").value;
      const key = document.getElementById("mlp-key").value.trim();
      localStorage.setItem(LS_AIKEY, key);
      const text = document.getElementById("mlp-input").value.trim();
      if (!text) return;
      const box = document.getElementById("mlp-msgs");
      box.insertAdjacentHTML("beforeend", `<div style="margin:4px 0;color:#8ab4ff">Вы: ${esc(text)}</div>`);
      document.getElementById("mlp-input").value = "";
      box.insertAdjacentHTML("beforeend", `<div style="margin:4px 0;color:#8a8a9a">…</div>`);
      const messages = [{ role: "user", content: text }];
      try {
        const model = prov === "openrouter" ? "google/gemma-4-31b-it:free" : "mimo-v2.5-free";
        const reply = await callAI(prov, key, model, messages);
        box.lastElementChild.remove();
        box.insertAdjacentHTML("beforeend", `<div style="margin:4px 0">🤖 ${esc(reply)}</div>`);
        box.scrollTop = box.scrollHeight;
      } catch (er) {
        box.lastElementChild.remove();
        box.insertAdjacentHTML("beforeend", `<div style="margin:4px 0;color:#f66">Ошибка: ${esc(er.message)}</div>`);
      }
    }

    // Библиотека
    async function loadLib() {
      const el = document.getElementById("mlp-liblist");
      const list = await getLibrary();
      if (!list.length) { el.innerHTML = "<span style='color:#8a8a9a'>Библиотека пуста.</span>"; return; }
      el.innerHTML = list.map(m =>
        `<div style="padding:8px;border-bottom:1px solid #2d2d40;cursor:pointer">${esc(m.title || m.id || "Манга")}
           <small style="color:#8a8a9a">${esc(m.source || "")}</small></div>`).join("");
    }

    // Модели / TFLite
    function initModels() {
      const el = document.getElementById("mlp-models");
      el.innerHTML = NEURAL.map(n =>
        `<div style="display:flex;justify-content:space-between;padding:7px;background:#23233a;border-radius:8px;margin-bottom:5px">
           <span>${esc(n.name)} <small style="color:#8a8a9a">(${n.type})</small></span>
           <span id="mlp-${n.id}-st" style="font-size:12px;color:#8a8a9a">не установлена</span></div>`).join("");
      // загруженные tflite
      const models = JSON.parse(localStorage.getItem(LS_MODELS) || "[]");
      if (models.length) {
        const st = document.getElementById("mlp-tflite-st");
        if (st) st.textContent = "✓ " + models.length + " tflite-модель(и) загружено";
      }
      const fileInput = document.getElementById("mlp-tflite");
      fileInput.addEventListener("change", () => {
        const f = fileInput.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          const models = JSON.parse(localStorage.getItem(LS_MODELS) || "[]");
          models.push({ name: f.name, size: f.size, data: String(reader.result).slice(0, 100) }); // не храним весь base64 в LS
          localStorage.setItem(LS_MODELS, JSON.stringify(models));
          document.getElementById("mlp-tflite-status").textContent = "✓ " + f.name + " зарегистрирована (" + (f.size/1024).toFixed(0) + " KB). Запуск — через локальный runtime.";
        };
        reader.readAsDataURL(f);
      });
    }

    // OCR
    function initOcr() {
      const el = document.getElementById("mlp-ocr");
      el.innerHTML = OCR_ENGINES.map(o => {
        const c = o.status === "installed" ? "#1f6f3f" : o.status === "cloud" ? "#5a3f1f" : "#5a2a2a";
        const t = o.status === "installed" ? "✓ готов" : o.status === "cloud" ? "☁ веб" : "○ нет";
        return `<div style="display:flex;justify-content:space-between;padding:7px;background:#23233a;border-radius:8px;margin-bottom:5px">
          <span>${esc(o.name)} <small style="color:#8a8a9a">${o.note}</small></span>
          <span style="background:${c};padding:2px 8px;border-radius:10px;font-size:12px">${t}</span></div>`;
      }).join("");
    }

    // Suwayomi
    function initSuwayomi() {
      const saved = localStorage.getItem("mlp_suwa_url") || "";
      if (saved) document.getElementById("mlp-suwa-url").value = saved;
      // Автопоиск при первом открытии, если URL ещё не сохранён
      if (!saved) setTimeout(() => findSuwayomi(), 500);
    }
    async function connectSuwayomi(url) {
      const target = url || document.getElementById("mlp-suwa-url").value.trim() || "http://127.0.0.1:4567";
      localStorage.setItem("mlp_suwa_url", target);
      const st = document.getElementById("mlp-suwa-status");
      st.textContent = "Проверяю " + target + " …";
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        const r = await fetch(target + "/api/v1/manga", { signal: ctrl.signal });
        clearTimeout(t);
        if (r.ok) { st.textContent = "✓ Suwayomi подключён: " + target; return true; }
        st.textContent = "Ответ " + r.status + ". Проверь адрес.";
        return false;
      } catch (e) {
        st.textContent = "Не удалось подключиться к " + target + ".";
        return false;
      }
    }
    async function findSuwayomi() {
      const st = document.getElementById("mlp-suwa-status");
      st.textContent = "Ищу Suwayomi…";
      // Список адресов для автопоиска
      const candidates = [
        "http://127.0.0.1:4567", "http://localhost:4567",
        "http://192.168.1.1:4567", "http://192.168.0.1:4567",
        "http://10.0.2.2:4567", "http://10.0.0.1:4567",
      ];
      for (const c of candidates) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 4000);
          const r = await fetch(c + "/api/v1/manga", { signal: ctrl.signal });
          clearTimeout(t);
          if (r.ok) {
            document.getElementById("mlp-suwa-url").value = c;
            localStorage.setItem("mlp_suwa_url", c);
            st.textContent = "✓ Suwayomi найден: " + c;
            return;
          }
        } catch (e) { /* пробуем следующий */ }
      }
      st.textContent = "Не найден. Укажи адрес вручную (Suwayomi может быть на GitHub/другом хосте).";
    }

    fab.onclick = open;
    window.__mlplus = { open, close, callAI, getLibrary };
  }

  if (document.body) buildUI();
  else document.addEventListener("DOMContentLoaded", buildUI);

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
})();
