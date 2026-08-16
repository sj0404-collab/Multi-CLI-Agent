/* MangaLib Plus — надстройка поверх собранного React-бандла.
   Добавляет: список нейронок, OCR-движки (Google Lens и др.),
   локальные модели из папки со статусом установки.
   НЕ трогает внутренности React — работает как отдельный оверлей. */
(function () {
  "use strict";
  if (window.__MANGALIB_PLUS__) return;
  window.__MANGALIB_PLUS__ = true;

  // Конфигурация нейронок / OCR-движков
  const NEURAL = [
    { id: "gemma", name: "Gemma 4 31B", type: "vision", url: "https://huggingface.co/google/gemma-4-31b-it" },
    { id: "llava", name: "Llava", type: "vision", url: "https://huggingface.co/llava-hf" },
    { id: "qwen", name: "Qwen3 VL", type: "vision", url: "https://huggingface.co/Qwen" },
    { id: "deepseek", name: "DeepSeek", type: "llm", url: "https://deepseek.com" },
    { id: "gpt-oss", name: "GPT-OSS 20B", type: "llm", url: "https://huggingface.co/openai" },
  ];
  const OCR_ENGINES = [
    { id: "tesseract", name: "Tesseract", status: "installed", note: "Встроен" },
    { id: "goggle-lens", name: "Google Lens", status: "cloud", note: "Через веб/API" },
    { id: "onnx", name: "ONNX", status: "installed", note: "Встроен" },
    { id: "paddle", name: "PaddleOCR", status: "optional", note: "Требует модель" },
  ];

  // Хранилище (совместимо с IndexedDB MangaLib: settings)
  const DB_NAME = "mangalib_db";
  function openDb() {
    return new Promise((res) => {
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
    });
  }
  async function getSetting(key) {
    try {
      const db = await openDb();
      if (!db) return null;
      const tx = db.transaction("settings", "readonly");
      const store = tx.objectStore("settings");
      const r = await new Promise((res) => { const q = store.get(key); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
      return r !== undefined ? r : null;
    } catch (e) { return null; }
  }
  async function setSetting(key, val) {
    try {
      const db = await openDb();
      if (!db) return;
      const tx = db.transaction("settings", "readwrite");
      const store = tx.objectStore("settings");
      store.put(val, key);
    } catch (e) {}
  }

  // Определение локальных моделей (из IndexedDB settings ключ "models" или метаданных)
  async function detectLocalModels() {
    const known = await getSetting("models");
    const list = Array.isArray(known) ? known : [];
    return NEURAL.map(n => ({
      ...n,
      installed: list.some(m => m.id === n.id),
    }));
  }

  function buildUI() {
    // Плавающая кнопка
    const fab = document.createElement("button");
    fab.id = "mlplus-fab";
    fab.textContent = "🧠";
    fab.title = "Нейронки / OCR / модели";
    Object.assign(fab.style, {
      position: "fixed", right: "14px", bottom: "90px", zIndex: "9999",
      width: "54px", height: "54px", borderRadius: "50%", border: "none",
      background: "#4f6ef7", color: "#fff", fontSize: "24px",
      boxShadow: "0 4px 16px rgba(0,0,0,.45)", cursor: "pointer",
      display: "flex", alignItems: "center", justifyContent: "center",
    });
    document.body.appendChild(fab);

    // Панель
    const panel = document.createElement("div");
    panel.id = "mlplus-panel";
    Object.assign(panel.style, {
      position: "fixed", top: "0", right: "0", bottom: "0", width: "min(420px, 94vw)",
      background: "#18181b", color: "#f4f4f5", zIndex: "10000",
      boxShadow: "-10px 0 40px rgba(0,0,0,.6)", display: "none",
      flexDirection: "column", fontFamily: "system-ui, sans-serif",
      padding: "14px", boxSizing: "border-box", overflowY: "auto",
    });
    document.body.appendChild(panel);

    function close() { panel.style.display = "none"; }
    function open() {
      renderPanel();
      panel.style.display = "flex";
    }

    function renderPanel() {
      panel.innerHTML = "";
      const head = document.createElement("div");
      Object.assign(head.style, { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" });
      head.innerHTML = "<h2 style='margin:0;font-size:18px'>🧠 Нейронки · OCR · Модели</h2>";
      const x = document.createElement("button"); x.textContent = "✕"; x.style.cssText = "background:none;border:none;color:#f4f4f5;font-size:20px;cursor:pointer"; x.onclick = close;
      head.appendChild(x);
      panel.appendChild(head);

      // Секция нейронок
      const nh = document.createElement("div"); nh.textContent = "Нейронки"; Object.assign(nh.style, { fontWeight: "700", margin: "12px 0 6px", color: "#8ab4ff" });
      panel.appendChild(nh);
      detectLocalModels().then(models => {
        models.forEach(m => {
          const row = document.createElement("div");
          Object.assign(row.style, { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: "#23233a", borderRadius: "8px", marginBottom: "6px" });
          row.innerHTML = `<span>${m.name} <small style='color:#8a8a9a'>(${m.type})</small></span>`;
          const badge = document.createElement("span");
          badge.textContent = m.installed ? "✓ установлена" : "не установлена";
          badge.style.cssText = "font-size:12px;padding:3px 8px;border-radius:10px;background:" + (m.installed ? "#1f6f3f" : "#5a2a2a");
          row.appendChild(badge);
          panel.appendChild(row);
        });
      });

      // Секция OCR
      const oh = document.createElement("div"); oh.textContent = "OCR-движки"; Object.assign(oh.style, { fontWeight: "700", margin: "14px 0 6px", color: "#8ab4ff" });
      panel.appendChild(oh);
      OCR_ENGINES.forEach(e => {
        const row = document.createElement("div");
        Object.assign(row.style, { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: "#23233a", borderRadius: "8px", marginBottom: "6px" });
        const st = e.status === "installed" ? "✓" : e.status === "cloud" ? "☁" : "○";
        const color = e.status === "installed" ? "#1f6f3f" : e.status === "cloud" ? "#5a3f1f" : "#5a2a2a";
        row.innerHTML = `<span>${e.name} <small style='color:#8a8a9a'>${e.note}</small></span>`;
        const badge = document.createElement("span");
        badge.textContent = st + " " + (e.status === "installed" ? "готов" : e.status === "cloud" ? "веб" : "нет");
        badge.style.cssText = "font-size:12px;padding:3px 8px;border-radius:10px;background:" + color;
        row.appendChild(badge);
        panel.appendChild(row);
      });

      // Google Lens кнопка
      const lens = document.createElement("button");
      lens.textContent = "📸 Открыть Google Lens";
      Object.assign(lens.style, { width: "100%", padding: "10px", marginTop: "14px", borderRadius: "8px", border: "none", background: "#4f6ef7", color: "#fff", fontSize: "14px", cursor: "pointer" });
      lens.onclick = () => { try { window.open("https://lens.google.com/", "_blank"); } catch (e) {} };
      panel.appendChild(lens);
    }

    fab.onclick = open;
    // Надстройка готова
    window.__mlplus = { open, close, detectLocalModels, getSetting, setSetting };
  }

  // Ждём загрузки DOM/React
  if (document.body) buildUI();
  else document.addEventListener("DOMContentLoaded", buildUI);
})();
