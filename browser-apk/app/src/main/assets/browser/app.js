"use strict";
/* Uni-Browser — статическая версия (GitHub Pages).
   Работает без локального сервера: OpenRouter напрямую (CORS), остальное через прокси. */

const $ = id => document.getElementById(id);

// CORS-прокси для страниц и Zen (у OpenRouter CORS открыт)
const PROXY = "https://corsproxy.io/?url=";
const API = ""; // не используется в статике

const state = {
  currentUrl: null, currentTitle: "", currentText: "",
  dark: false,
  library: JSON.parse(localStorage.getItem("mub_lib") || "[]"),
  aiMsgs: [],
  tabs: JSON.parse(localStorage.getItem("mub_tabs") || "[]"),
  activeTab: 0,
  history: JSON.parse(localStorage.getItem("mub_hist") || "[]"),
};
let tabIdSeq = Date.now();

const content = $("content"), pageHeader = $("pageHeader"), urlInput = $("urlInput"),
  aiMsgs = $("aiMsgs"), aiInput = $("aiInput"), aiProvider = $("aiProvider"),
  aiKey = $("aiKey"), libItems = $("libItems"), ocrOverlay = $("ocrOverlay"), ocrResult = $("ocrResult");

// ── Загрузка страницы (через прокси, т.к. браузерный fetch не читает чужой HTML напрямую)
async function fetchViaProxy(url) {
  // Пытаемся напрямую (если CORS), иначе через прокси
  try {
    const r = await fetch(url, { mode: "cors" });
    if (r.ok) return await r.text();
  } catch (e) {}
  const r2 = await fetch(PROXY + encodeURIComponent(url));
  if (!r2.ok) throw new Error("HTTP " + r2.status);
  return await r2.text();
}
function htmlToText(raw) {
  raw = raw.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  raw = raw.replace(/<(p|div|section|article|h[1-6]|li|br|tr|blockquote)[^>]*>/gi, "\n");
  raw = raw.replace(/<[^>]+>/g, " ");
  raw = raw.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  raw = raw.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n");
  return raw.split("\n").map(l => l.trim()).filter(Boolean).join("\n");
}
async function loadPage(url) {
  url = url.trim(); if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  content.innerHTML = '<p style="color:var(--muted)">Загрузка…</p>';
  try {
    const html = await fetchViaProxy(url);
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [,""])[1] || url;
    const text = htmlToText(html);
    state.currentUrl = url; state.currentTitle = title; state.currentText = text;
    const t = state.tabs[state.activeTab];
    if (t) { t.url = url; t.title = title; t.text = text; saveTabs(); renderTabs(); }
    addHistory(url, title);
    urlInput.value = url;
    pageHeader.innerHTML = "<h1>" + esc(title) + '</h1><div class="url">' + esc(url) + "</div>";
    renderText(text);
  } catch (e) { content.innerHTML = '<p style="color:red">Ошибка: ' + esc(String(e)) + "</p>"; }
}
function renderText(text) {
  content.innerHTML = text.split(/\n{2,}/).map(p => "<p>" + esc(p.trim()) + "</p>").join("");
}

// ── Вкладки ──
function saveTabs() { localStorage.setItem("mub_tabs", JSON.stringify(state.tabs)); }
function newTab() {
  state.tabs.push({ id: tabIdSeq++, url: "", title: "Новая вкладка", text: "" });
  state.activeTab = state.tabs.length - 1; saveTabs(); renderTabs(); showTabContent();
}
function closeTab(id) {
  const i = state.tabs.findIndex(t => t.id === id); if (i < 0) return;
  state.tabs.splice(i, 1);
  if (!state.tabs.length) newTab();
  if (state.activeTab >= state.tabs.length) state.activeTab = state.tabs.length - 1;
  saveTabs(); renderTabs(); showTabContent();
}
function activateTab(id) {
  const i = state.tabs.findIndex(t => t.id === id); if (i < 0) return;
  state.activeTab = i; saveTabs(); renderTabs(); showTabContent();
}
function renderTabs() {
  $("tabbar").innerHTML = state.tabs.map((t, i) =>
    `<div class="tab ${i === state.activeTab ? "active" : ""}" data-id="${t.id}">
       <span class="t-title">${esc(t.title || "Новая вкладка")}</span>
       <span class="t-close" data-close="${t.id}">✕</span></div>`).join("");
  $("tabbar").querySelectorAll(".tab").forEach(el => {
    el.onclick = () => activateTab(+el.dataset.id);
    el.querySelector(".t-close").onclick = e => { e.stopPropagation(); closeTab(+el.dataset.close); };
  });
}
function showTabContent() {
  const t = state.tabs[state.activeTab]; if (!t) return;
  if (t.url && t.text) {
    urlInput.value = t.url;
    pageHeader.innerHTML = "<h1>" + esc(t.title) + '</h1><div class="url">' + esc(t.url) + "</div>";
    renderText(t.text);
  } else {
    urlInput.value = ""; pageHeader.innerHTML = "<h1>Uni-Browser</h1>";
    content.innerHTML = "<p>Введите URL для чтения.</p>";
  }
}

// ── История ──
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
    ? state.history.map((h, i) => `<div class="hist-item" data-i="${i}"><div class="t">${esc(h.title)}</div><div class="u">${esc(h.url)}</div></div>`).join("")
    : '<p style="color:var(--muted)">История пуста.</p>';
  $("histItems").querySelectorAll(".hist-item").forEach(el => {
    el.onclick = () => { const h = state.history[+el.dataset.i]; loadPage(h.url); toggleHist(false); };
  });
}
function toggleHist(on) { $("histPanel").classList.toggle("hidden", on === undefined ? !$("histPanel").classList.contains("hidden") : !on); }

// ── AI-чат (OpenRouter напрямую, Zen через прокси) ──
async function callAI(provider, key, model, messages) {
  const url = provider === "openrouter"
    ? "https://openrouter.ai/api/v1/chat/completions"
    : PROXY + encodeURIComponent("https://opencode.ai/zen/v1/chat/completions");
  const headers = { "Content-Type": "application/json" };
  if (provider === "openrouter" && key) headers["Authorization"] = "Bearer " + key;
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({
    model, messages, max_tokens: 1500, stream: false }) });
  const j = await r.json();
  if (j.error) throw new Error(typeof j.error === "string" ? j.error : (j.error?.message || "ошибка"));
  const msg = j.choices?.[0]?.message || {};
  return msg.content || msg.reasoning || "";
}
function renderAi() { aiMsgs.innerHTML = state.aiMsgs.map(m => `<div class="msg ${m.role}">${esc(m.content)}</div>`).join(""); aiMsgs.scrollTop = aiMsgs.scrollHeight; }
async function sendAi() {
  const text = aiInput.value.trim(); if (!text) return;
  state.aiMsgs.push({ role: "user", content: text }); aiInput.value = ""; renderAi();
  const ctx = state.currentText ? state.currentText.slice(0, 8000) : "";
  const messages = [
    { role: "system", content: "Ты — умный помощник в браузере-читалке. Отвечай кратко на русском." + (ctx ? "\n\nКонтекст:\n" + ctx : "") },
    ...state.aiMsgs.map(m => ({ role: m.role, content: m.content }))];
  state.aiMsgs.push({ role: "ai", content: "…" }); renderAi();
  try {
    const reply = await callAI(aiProvider.value, aiKey.value.trim(),
      aiProvider.value === "zen" ? "mimo-v2.5-free" : "google/gemma-4-31b-it:free", messages);
    state.aiMsgs[state.aiMsgs.length - 1] = { role: "ai", content: reply };
  } catch (e) { state.aiMsgs[state.aiMsgs.length - 1] = { role: "ai", content: "Ошибка: " + e.message }; }
  renderAi();
}

// ── OCR ──
async function ocrRun(file) {
  ocrResult.textContent = "Распознаю…";
  try {
    if (!window.Tesseract) throw new Error("tesseract.js не загрузился (нужен интернет)");
    const { data } = await Tesseract.recognize(file, "rus+eng");
    ocrResult.textContent = data.text || "(не распознано)";
  } catch (e) { ocrResult.textContent = "OCR ошибка: " + e.message; }
}

// ── Библиотека ──
function saveLibrary() { localStorage.setItem("mub_lib", JSON.stringify(state.library)); }
function addToLibrary() {
  if (!state.currentText) return;
  state.library.unshift({ url: state.currentUrl, title: state.currentTitle, text: state.currentText.slice(0, 200000), saved: Date.now() });
  saveLibrary(); renderLibrary(); flash("Сохранено ✓");
}
function renderLibrary() {
  libItems.innerHTML = state.library.length
    ? state.library.map((it, i) => `<div class="lib-item" data-i="${i}"><div class="t">${esc(it.title)}</div><div class="u">${esc(it.url)}</div></div>`).join("")
    : '<p style="color:var(--muted)">Библиотека пуста.</p>';
  libItems.querySelectorAll(".lib-item").forEach(el => { el.onclick = () => { const it = state.library[+el.dataset.i]; state.currentUrl = it.url; state.currentTitle = it.title; state.currentText = it.text; urlInput.value = it.url; renderText(it.text); toggleLib(false); }; });
}
function toggleLib(on) { $("libPanel").classList.toggle("hidden", on === undefined ? !$("libPanel").classList.contains("hidden") : !on); }

// ── UI helpers ──
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function toggleAi(on) { $("aiPanel").classList.toggle("hidden", on === undefined ? !$("aiPanel").classList.contains("hidden") : !on); }
function flash(msg) { const e = document.createElement("div"); e.textContent = msg; e.style.cssText = "position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:#4f6ef7;color:#fff;padding:10px 18px;border-radius:20px;z-index:40;"; document.body.appendChild(e); setTimeout(() => e.remove(), 1800); }

// ── События ──
$("btnGo").onclick = () => loadPage(urlInput.value);
urlInput.addEventListener("keydown", e => { if (e.key === "Enter") loadPage(urlInput.value); });
$("btnAi").onclick = () => { toggleAi(true); toggleLib(false); toggleHist(false); };
$("btnAiClose").onclick = () => toggleAi(false);
$("btnLibrary").onclick = () => { toggleLib(true); toggleAi(false); toggleHist(false); renderLibrary(); };
$("btnLibClose").onclick = () => toggleLib(false);
$("btnNewTab").onclick = newTab;
$("btnHistory").onclick = () => { toggleHist(true); toggleLib(false); toggleAi(false); renderHistory(); };
$("btnHistClose").onclick = () => toggleHist(false);
$("btnAiSend").onclick = sendAi;
aiInput.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAi(); } });
$("fabVoice").onclick = () => { if (state.currentText && "speechSynthesis" in window) { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(state.currentText.replace(/\s+/g," ").slice(0,5000)); u.lang="ru-RU"; speechSynthesis.speak(u); } };
$("fabStopVoice").onclick = () => { if ("speechSynthesis" in window) speechSynthesis.cancel(); };
$("fabSave").onclick = addToLibrary;
$("fabMode").onclick = () => { state.dark = !state.dark; document.body.classList.toggle("dark", state.dark); };
$("btnOcrClose").onclick = () => $("ocrOverlay").classList.add("hidden");
$("ocrFile").addEventListener("change", e => { if (e.target.files[0]) ocrRun(e.target.files[0]); });
$("ocrDrop").addEventListener("dragover", e => e.preventDefault());
$("ocrDrop").addEventListener("drop", e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) ocrRun(f); });

// ── Инициализация ──
renderLibrary(); renderAi();
if (!state.tabs.length) { state.tabs.push({ id: tabIdSeq++, url: "", title: "Новая вкладка", text: "" }); state.activeTab = 0; saveTabs(); }
renderTabs(); showTabContent();
