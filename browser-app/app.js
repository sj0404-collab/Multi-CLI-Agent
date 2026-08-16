"use strict";
/* Multi Uni-Browser — клиентская логика. */

const $ = id => document.getElementById(id);

// ── База API: в APK (file://) — локальный сервер 127.0.0.1:8765, в вебе — относительный.
const API = (typeof AndroidBridge !== "undefined" && AndroidBridge.backendBase)
  ? AndroidBridge.backendBase() + "/api"
  : "/api";
const fetchPageApi = (url) => API + "/fetch?url=" + encodeURIComponent(url);

// ── Состояние ─────────────────────────────────────────────────────────────
const state = {
  currentUrl: null,
  currentTitle: "",
  currentText: "",
  dark: false,
  library: JSON.parse(localStorage.getItem("mub_lib") || "[]"),
  aiMsgs: [],
  ocrText: "",
  tabs: JSON.parse(localStorage.getItem("mub_tabs") || "[]"),   // массив вкладок
  activeTab: 0,
  history: JSON.parse(localStorage.getItem("mub_hist") || "[]"), // история
};
let tabIdSeq = Date.now();

// ── Элементы ──────────────────────────────────────────────────────────────
const urlInput = $("urlInput"), btnGo = $("btnGo"), content = $("content"),
  pageHeader = $("pageHeader"), aiPanel = $("aiPanel"), libPanel = $("libPanel"),
  aiMsgs = $("aiMsgs"), aiInput = $("aiInput"), aiProvider = $("aiProvider"),
  aiKey = $("aiKey"), libItems = $("libItems"), ocrOverlay = $("ocrOverlay"),
  ocrResult = $("ocrResult");

// ── Загрузка страницы в читаемый вид ─────────────────────────────────────
async function loadPage(url) {
  url = url.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  content.innerHTML = '<p style="color:var(--muted)">Загрузка…</p>';
  try {
    const r = await fetch(fetchPageApi(url));
    const j = await r.json();
    if (j.error) { content.innerHTML = '<p style="color:red">' + esc(j.error) + "</p>"; return; }
    // Сохраняем в активную вкладку + историю
    state.currentUrl = j.url; state.currentTitle = j.title; state.currentText = j.content;
    const t = state.tabs[state.activeTab];
    if (t) { t.url = j.url; t.title = j.title; t.text = j.content; saveTabs(); renderTabs(); }
    addHistory(j.url, j.title);
    urlInput.value = j.url;
    pageHeader.innerHTML = "<h1>" + esc(j.title) + '</h1><div class="url">' + esc(j.url) + "</div>";
    renderText(j.content);
  } catch (e) {
    content.innerHTML = '<p style="color:red">Ошибка: ' + esc(String(e)) + "</p>";
  }
}

function renderText(text) {
  const paras = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  content.innerHTML = paras.map(p => "<p>" + esc(p) + "</p>").join("");
}

// ── Вкладки ───────────────────────────────────────────────────────────────
function saveTabs() { localStorage.setItem("mub_tabs", JSON.stringify(state.tabs)); }
function newTab() {
  state.tabs.push({ id: tabIdSeq++, url: "", title: "Новая вкладка", text: "", textShown: false });
  state.activeTab = state.tabs.length - 1;
  saveTabs(); renderTabs(); showTabContent();
  urlInput.value = ""; urlInput.focus();
}
function closeTab(id) {
  const i = state.tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  state.tabs.splice(i, 1);
  if (state.tabs.length === 0) newTab();
  if (state.activeTab >= state.tabs.length) state.activeTab = state.tabs.length - 1;
  saveTabs(); renderTabs(); showTabContent();
}
function activateTab(id) {
  const i = state.tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  state.activeTab = i;
  saveTabs(); renderTabs(); showTabContent();
}
function renderTabs() {
  $("tabbar").innerHTML = state.tabs.map((t, i) =>
    `<div class="tab ${i === state.activeTab ? "active" : ""}" data-id="${t.id}">
       <span class="t-title">${esc(t.title || "Новая вкладка")}</span>
       <span class="t-close" data-close="${t.id}">✕</span>
     </div>`).join("");
  $("tabbar").querySelectorAll(".tab").forEach(el => {
    el.onclick = () => activateTab(+el.dataset.id);
    el.querySelector(".t-close").onclick = (e) => { e.stopPropagation(); closeTab(+el.dataset.close); };
  });
}
function showTabContent() {
  const t = state.tabs[state.activeTab];
  if (!t) return;
  if (t.url && t.text) {
    urlInput.value = t.url;
    pageHeader.innerHTML = "<h1>" + esc(t.title) + '</h1><div class="url">' + esc(t.url) + "</div>";
    renderText(t.text);
  } else {
    urlInput.value = "";
    pageHeader.innerHTML = "<h1>Multi Uni-Browser</h1>";
    content.innerHTML = "<p>Введите URL или текст для чтения.</p>";
  }
}

// ── История ───────────────────────────────────────────────────────────────
function saveHistory() { localStorage.setItem("mub_hist", JSON.stringify(state.history)); }
function addHistory(url, title) {
  if (!url) return;
  state.history = state.history.filter(h => h.url !== url);
  state.history.unshift({ url, title: title || url, ts: Date.now() });
  if (state.history.length > 200) state.history = state.history.slice(0, 200);
  saveHistory();
}
function renderHistory() {
  $("histItems").innerHTML = state.history.length
    ? state.history.map((h, i) => `<div class="hist-item" data-i="${i}">
        <div class="t">${esc(h.title)}</div><div class="u">${esc(h.url)}</div>
        <div class="d">${new Date(h.ts).toLocaleString()}</div></div>`).join("")
    : '<p style="color:var(--muted)">История пуста.</p>';
  $("histItems").querySelectorAll(".hist-item").forEach(el => {
    el.onclick = () => { const h = state.history[+el.dataset.i]; loadPage(h.url); toggleHist(false); };
  });
}
function toggleHist(on) { $("histPanel").classList.toggle("hidden", on === undefined ? !$("histPanel").classList.contains("hidden") : !on); }

// ── Библиотека ────────────────────────────────────────────────────────────
function saveLibrary() {
  localStorage.setItem("mub_lib", JSON.stringify(state.library));
}
function addToLibrary() {
  if (!state.currentText) { alert("Сначала откройте страницу"); return; }
  state.library.unshift({ url: state.currentUrl, title: state.currentTitle || state.currentUrl,
    text: state.currentText.slice(0, 200000), saved: Date.now() });
  saveLibrary();
  renderLibrary();
  flash("Сохранено в библиотеку ✓");
}
function renderLibrary() {
  libItems.innerHTML = state.library.length
    ? state.library.map((it, i) => `<div class="lib-item" data-i="${i}">
        <div class="t">${esc(it.title)}</div><div class="u">${esc(it.url)}</div></div>`).join("")
    : '<p style="color:var(--muted)">Библиотека пуста. Откройте страницу и нажмите 💾.</p>';
  libItems.querySelectorAll(".lib-item").forEach(el => {
    el.onclick = () => { const it = state.library[+el.dataset.i]; openLibItem(it); };
  });
}
function openLibItem(it) {
  state.currentUrl = it.url; state.currentTitle = it.title; state.currentText = it.text;
  urlInput.value = it.url;
  pageHeader.innerHTML = "<h1>" + esc(it.title) + '</h1><div class="url">' + esc(it.url) + "</div>";
  renderText(it.text);
  toggleLib(false);
}

// ── Голос (TTS + распознавание) ──────────────────────────────────────────
function speak() {
  if (!("speechSynthesis" in window)) { alert("TTS недоступен в этом браузере"); return; }
  speechSynthesis.cancel();
  const clean = state.currentText.replace(/\s+/g, " ").slice(0, 5000);
  if (!clean) { alert("Нет текста для озвучивания"); return; }
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = "ru-RU";
  speechSynthesis.speak(u);
  flash("🔊 Озвучиваю…");
}
function stopVoice() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

// ── AI-чат ───────────────────────────────────────────────────────────────
function renderAi() {
  aiMsgs.innerHTML = state.aiMsgs.map(m =>
    `<div class="msg ${m.role}">${esc(m.content)}</div>`).join("");
  aiMsgs.scrollTop = aiMsgs.scrollHeight;
}
async function sendAi() {
  const text = aiInput.value.trim();
  if (!text) return;
  state.aiMsgs.push({ role: "user", content: text });
  aiInput.value = "";
  renderAi();
  // контекст страницы
  const ctx = state.currentText ? state.currentText.slice(0, 8000) : "";
  const messages = [
    { role: "system", content: "Ты — умный помощник в браузере-читалке. Отвечай кратко и по делу на русском." + (ctx ? "\n\nКонтекст страницы:\n" + ctx : "") },
    ...state.aiMsgs.map(m => ({ role: m.role, content: m.content })),
  ];
  state.aiMsgs.push({ role: "ai", content: "…" });
  renderAi();
  try {
    const r = await fetch(API + "/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: aiProvider.value,
        model: aiProvider.value === "zen" ? "mimo-v2.5-free" : "google/gemma-4-31b-it:free",
        key: aiKey.value.trim(),
        messages,
      }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    state.aiMsgs[state.aiMsgs.length - 1] = { role: "ai", content: j.reply || "…" };
  } catch (e) {
    state.aiMsgs[state.aiMsgs.length - 1] = { role: "ai", content: "Ошибка: " + e.message };
  }
  renderAi();
}

// ── OCR ───────────────────────────────────────────────────────────────────
function ocrSetup() {
  ocrOverlay.classList.remove("hidden");
  ocrResult.textContent = "";
}
async function ocrRun(file) {
  ocrResult.textContent = "Распознаю текст… (может занять время)";
  try {
    if (!window.Tesseract) throw new Error("tesseract.js не загрузился (нужен интернет)");
    const { data } = await Tesseract.recognize(file, "rus+eng");
    state.ocrText = data.text;
    ocrResult.textContent = data.text || "(текст не распознан)";
  } catch (e) {
    ocrResult.textContent = "OCR ошибка: " + e.message;
  }
}

// ── Перевод ───────────────────────────────────────────────────────────────
async function translate() {
  if (!state.currentText) { alert("Сначала откройте страницу"); return; }
  flash("Перевожу…");
  const chunk = state.currentText.slice(0, 6000);
  try {
    const r = await fetch(API + "/ai", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: aiProvider.value,
        model: aiProvider.value === "zen" ? "mimo-v2.5-free" : "google/gemma-4-31b-it:free",
        key: aiKey.value.trim(),
        messages: [{ role: "system", content: "Переведи следующий текст на русский. Верни только перевод." },
                   { role: "user", content: chunk }],
      }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    renderText(j.reply || "");
    flash("Переведено ✓");
  } catch (e) {
    alert("Ошибка перевода: " + e.message);
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toggleAi(on) { aiPanel.classList.toggle("hidden", on === undefined ? !aiPanel.classList.contains("hidden") : !on); }
function toggleLib(on) { libPanel.classList.toggle("hidden", on === undefined ? !libPanel.classList.contains("hidden") : !on); }
function flash(msg) { const e = document.createElement("div"); e.textContent = msg;
  e.style.cssText = "position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;padding:10px 18px;border-radius:20px;z-index:40;font-size:15px;";
  document.body.appendChild(e); setTimeout(() => e.remove(), 1800); }

// ── События ───────────────────────────────────────────────────────────────
btnGo.onclick = () => loadPage(urlInput.value);
urlInput.addEventListener("keydown", e => { if (e.key === "Enter") loadPage(urlInput.value); });
$("btnAi").onclick = () => { toggleAi(true); toggleLib(false); toggleHist(false); };
$("btnManga").onclick = () => {
  // Открыть читалку манги (MangaLib) — в APK/вебе.
  const base = (typeof AndroidBridge !== "undefined" && AndroidBridge.backendBase)
    ? AndroidBridge.backendBase() : location.origin;
  window.open(base + "/mangalib", "_self");
};
$("btnAiClose").onclick = () => toggleAi(false);
$("btnLibrary").onclick = () => { toggleLib(true); toggleAi(false); toggleHist(false); renderLibrary(); };
$("btnLibClose").onclick = () => toggleLib(false);
$("btnNewTab").onclick = newTab;
$("btnHistory").onclick = () => { toggleHist(true); toggleLib(false); toggleAi(false); renderHistory(); };
$("btnHistClose").onclick = () => toggleHist(false);
$("btnAiSend").onclick = sendAi;
aiInput.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAi(); } });

$("fabVoice").onclick = speak;
$("fabStopVoice").onclick = stopVoice;
$("fabOcr").onclick = ocrSetup;
$("fabTranslate").onclick = translate;
$("fabSave").onclick = addToLibrary;
$("fabMode").onclick = () => { state.dark = !state.dark; document.body.classList.toggle("dark", state.dark); };
$("btnOcrClose").onclick = () => ocrOverlay.classList.add("hidden");
$("ocrFile").addEventListener("change", e => { if (e.target.files[0]) ocrRun(e.target.files[0]); });

// Drag&drop OCR
$("ocrDrop").addEventListener("dragover", e => e.preventDefault());
$("ocrDrop").addEventListener("drop", e => { e.preventDefault();
  const f = e.dataTransfer.files[0]; if (f) ocrRun(f); });

// ── Инициализация ─────────────────────────────────────────────────────────
renderLibrary();
renderAi();
// Вкладки: если нет ни одной — создаём
if (!state.tabs.length) {
  state.tabs.push({ id: tabIdSeq++, url: "", title: "Новая вкладка", text: "", textShown: false });
  state.activeTab = 0;
  saveTabs();
}
renderTabs();
showTabContent();
// Приветствие (если активная вкладка пуста)
if (!state.tabs[state.activeTab] || !state.tabs[state.activeTab].url) {
  pageHeader.innerHTML = "<h1>Multi Uni-Browser</h1>";
  content.innerHTML = "<p>Введите URL в строку выше или задайте вопрос AI-ассистенту.</p>" +
    "<p>Плавающие кнопки: 🔊 озвучить · ⏹ стоп · 🔍 OCR · 🌐 перевести · 💾 в библиотеку · 🌙 тема.</p>" +
    "<p>Вкладки: ＋ новая · 🕘 история просмотра · 📚 библиотека.</p>";
}
