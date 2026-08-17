/* MangaLib Plus v3 — мощная надстройка.
   Рабочий OCR (Tesseract из бандла), AI-чат (Zen/OpenRouter),
   библиотека, Suwayomi (список манг), модели/TFLite, красивый UI. */
(function () {
  "use strict";
  if (window.__MANGALIB_PLUS__) return;
  window.__MANGALIB_PLUS__ = true;

  const NEURAL = [
    { id: "gemma", name: "Gemma 4 31B", type: "vision" },
    { id: "llava", name: "Llava", type: "vision" },
    { id: "qwen", name: "Qwen3 VL", type: "vision" },
    { id: "deepseek", name: "DeepSeek", type: "llm" },
    { id: "gpt-oss", name: "GPT-OSS 20B", type: "llm" },
  ];
  const DB_NAME = "mangalib_db";
  const LS_AIKEY = "mlplus_aikey";
  const CORS = "https://corsproxy.io/?url=";

  function openDb() {
    return new Promise((res) => {
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        ["mangas","shelves","settings","pages"].forEach(s => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s,{keyPath:"id"}); });
      };
    });
  }

  async function callAI(provider, key, model, messages) {
    if (provider === "openrouter") {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method:"POST", headers:{"Content-Type":"application/json","Authorization":"Bearer "+key},
        body: JSON.stringify({ model, messages, max_tokens:1500, stream:false }) });
      const j = await r.json();
      if (j.error) throw new Error(typeof j.error==="string"?j.error:(j.error?.message||"AI error"));
      const m = j.choices?.[0]?.message||{}; return m.content || m.reasoning || "";
    }
    const url = CORS + encodeURIComponent("https://opencode.ai/zen/v1/chat/completions");
    const r = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ model, messages, max_tokens:800, stream:false }) });
    const j = await r.json();
    if (j.error) throw new Error(typeof j.error==="string"?j.error:(j.error?.message||"Zen error"));
    const m = j.choices?.[0]?.message||{}; return m.content || m.reasoning || "";
  }

  async function getLibrary() {
    const db = await openDb(); if (!db) return [];
    return await new Promise(res => { const q = db.transaction("mangas","readonly").objectStore("mangas").getAll(); q.onsuccess=()=>res(q.result||[]); q.onerror=()=>res([]); });
  }

  // ── Рабочий OCR через Tesseract (если он доступен в бандле) ──
  async function runOcr(file) {
    const T = window.Tesseract || (window.tesseract);
    if (!T) throw new Error("Tesseract не найден в бандле");
    const worker = await T.createWorker("rus+eng");
    const { data } = await worker.recognize(file);
    await worker.terminate();
    return data.text || "";
  }

  function css(o){ return Object.keys(o).map(k=>k.replace(/[A-Z]/g,m=>'-'+m.toLowerCase())+':'+o[k]).join(';'); }

  function buildUI() {
    const fab = document.createElement("button");
    fab.id="mlplus-fab"; fab.textContent="🧠";
    fab.style.cssText=css({position:"fixed",right:"14px",bottom:"100px",zIndex:"9999",width:"58px",height:"58px",borderRadius:"50%",border:"none",background:"linear-gradient(135deg,#4f6ef7,#7c3aed)",color:"#fff",fontSize:"26px",boxShadow:"0 6px 20px rgba(79,110,247,.5)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"transform .2s"});
    fab.onmousedown=()=>fab.style.transform="scale(.92)";
    fab.onmouseup=()=>fab.style.transform="";
    document.body.appendChild(fab);

    const panel=document.createElement("div"); panel.id="mlplus-panel";
    panel.style.cssText=css({position:"fixed",inset:"0",background:"#0f1117",color:"#e5e7eb",zIndex:"10000",display:"none",flexDirection:"column",fontFamily:"system-ui,-apple-system,sans-serif",padding:"0",boxSizing:"border-box"});
    document.body.appendChild(panel);

    function nav(){ return `<div style="display:flex;gap:6px;padding:12px;flex-wrap:wrap;background:#161a24;border-bottom:1px solid #252a38">
      <button data-nav="ai" class="mlp-nav">🤖 AI</button>
      <button data-nav="lib" class="mlp-nav">📚 Библиотека</button>
      <button data-nav="ocr" class="mlp-nav">🔍 OCR</button>
      <button data-nav="suwa" class="mlp-nav">🗃 Suwayomi</button>
      <button data-nav="models" class="mlp-nav">🧠 Модели</button></div>`;
    }
    function renderNav(a){ panel.querySelectorAll(".mlp-nav").forEach(b=>{b.classList.toggle("active",b.dataset.nav===a); b.style.cssText=(b.dataset.nav===a? "background:#4f6ef7;color:#fff;": "background:#232a3a;color:#b0b6c4;")+"padding:8px 12px;border:none;border-radius:8px;cursor:pointer;font-size:14px";}); }

    function open(){
      panel.innerHTML="";
      const head=document.createElement("div");
      head.style.cssText=css({display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 16px",background:"#161a24",borderBottom:"1px solid #252a38"});
      head.innerHTML="<div style='font-size:19px;font-weight:700;background:linear-gradient(90deg,#4f6ef7,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent'>MangaLib Plus</div>";
      const x=document.createElement("button"); x.textContent="✕"; x.style.cssText="background:none;border:none;color:#b0b6c4;font-size:22px;cursor:pointer"; x.onclick=close; head.appendChild(x);
      panel.appendChild(head);
      panel.insertAdjacentHTML("beforeend",nav());
      const v=document.createElement("div"); v.id="mlp-view"; v.style.cssText=css({flex:"1",overflowY:"auto",padding:"14px"}); panel.appendChild(v);
      renderNav("ai"); show("ai"); panel.style.display="flex";
    }
    function close(){ panel.style.display="none"; }

    function show(name){
      renderNav(name);
      const v=document.getElementById("mlp-view");
      if(name==="ai"){ v.innerHTML=aiView(); initAi(); }
      else if(name==="lib"){ v.innerHTML=libView(); loadLib(); }
      else if(name==="ocr"){ v.innerHTML=ocrView(); initOcr(); }
      else if(name==="suwa"){ v.innerHTML=suwaView(); initSuwa(); }
      else if(name==="models"){ v.innerHTML=modelsView(); initModels(); }
    }

    function card(inner){ return `<div style="background:#161a24;border:1px solid #252a38;border-radius:12px;padding:12px;margin-bottom:10px">${inner}</div>`; }

    function aiView(){
      const key=localStorage.getItem(LS_AIKEY)||"";
      return card(`
        <div style="font-weight:600;margin-bottom:10px">AI-чат</div>
        <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">
          <select id="mlp-provider" style="flex:1;min-width:120px;padding:8px;border-radius:8px;background:#232a3a;color:#e5e7eb;border:1px solid #333"><option value="zen">Zen (бесплатно)</option><option value="openrouter">OpenRouter</option></select>
          <input id="mlp-key" placeholder="OpenRouter ключ" value="${esc(key)}" style="flex:1.4;min-width:160px;padding:8px;border-radius:8px;background:#232a3a;color:#e5e7eb;border:1px solid #333">
        </div>
        <div id="mlp-msgs" style="background:#0f1117;border-radius:10px;padding:10px;min-height:120px;max-height:42vh;overflow-y:auto;margin-bottom:8px;font-size:14px;line-height:1.5"></div>
        <div style="display:flex;gap:8px">
          <textarea id="mlp-input" placeholder="Спроси о чём-нибудь…" rows="2" style="flex:1;padding:10px;border-radius:10px;background:#232a3a;color:#e5e7eb;border:1px solid #333;resize:none"></textarea>
          <button id="mlp-send" style="align-self:flex-end;padding:10px 18px;border:none;border-radius:10px;background:#4f6ef7;color:#fff;cursor:pointer;font-size:16px">➤</button>
        </div>`);
    }
    function libView(){ return card(`<div style="font-weight:600;margin-bottom:8px">📚 Библиотека манг <button id="mlp-reload-lib" style="background:none;border:none;color:#4f6ef7;cursor:pointer;margin-left:6px">⟳</button></div><div id="mlp-liblist" style="background:#0f1117;border-radius:10px;padding:8px;min-height:80px"></div>`); }
    function ocrView(){ return card(`
      <div style="font-weight:600;margin-bottom:10px">🔍 OCR-распознавание</div>
      <input type="file" id="mlp-ocrfile" accept="image/*" style="margin-bottom:10px">
      <div id="mlp-ocrresult" style="background:#0f1117;border-radius:10px;padding:10px;min-height:80px;white-space:pre-wrap;font-size:14px">Выбери изображение — текст распознается через Tesseract.</div>`);
    }
    function suwaView(){ return card(`
      <div style="font-weight:600;margin-bottom:10px">🗃 Suwayomi</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <input id="mlp-suwa-url" placeholder="http://127.0.0.1:4567" style="flex:1;min-width:160px;padding:8px;border-radius:8px;background:#232a3a;color:#e5e7eb;border:1px solid #333">
        <button id="mlp-suwa-connect" style="padding:8px 12px;border:none;border-radius:8px;background:#4f6ef7;color:#fff;cursor:pointer">Подключить</button>
        <button id="mlp-suwa-find" style="padding:8px 12px;border:none;border-radius:8px;background:#7c3aed;color:#fff;cursor:pointer">🔎 Автопоиск</button>
      </div>
      <div id="mlp-suwa-status" style="font-size:13px;color:#8a93a6;margin-bottom:8px"></div>
      <div id="mlp-suwa-manga" style="background:#0f1117;border-radius:10px;padding:8px;min-height:60px;font-size:13px"></div>`);
    }
    function modelsView(){
      return card(`
        <div style="font-weight:600;margin-bottom:10px">🧠 Модели</div>
        <div id="mlp-models"></div>
        <div style="margin-top:12px;font-weight:600;margin-bottom:6px">TFLite локальная модель</div>
        <input type="file" id="mlp-tflite" accept=".tflite,.onnx">
        <div id="mlp-tflite-status" style="font-size:13px;color:#8a93a6;margin-top:6px"></div>`);
    }

    panel.addEventListener("click",(e)=>{
      const nb=e.target.closest(".mlp-nav"); if(nb){show(nb.dataset.nav);return;}
      const id=e.target.id;
      if(id==="mlp-send") doAi();
      else if(id==="mlp-reload-lib") loadLib();
      else if(id==="mlp-suwa-connect") connectSuwayomi();
      else if(id==="mlp-suwa-find") findSuwayomi();
    });

    function initAi(){ const k=localStorage.getItem(LS_AIKEY); if(k)document.getElementById("mlp-key").value=k; const inp=document.getElementById("mlp-input"); inp.addEventListener("keydown",ev=>{ if(ev.key==="Enter"&&!ev.shiftKey){ev.preventDefault();doAi();} }); document.getElementById("mlp-send").addEventListener("click",doAi); }
    async function doAi(){
      const prov=document.getElementById("mlp-provider").value;
      const key=document.getElementById("mlp-key").value.trim(); localStorage.setItem(LS_AIKEY,key);
      const t=document.getElementById("mlp-input").value.trim(); if(!t)return;
      const box=document.getElementById("mlp-msgs");
      box.insertAdjacentHTML("beforeend",`<div style="text-align:right;color:#8ab4ff;margin:4px 0">${esc(t)}</div>`);
      document.getElementById("mlp-input").value="";
      box.insertAdjacentHTML("beforeend",`<div style="color:#6b7280;margin:4px 0">…</div>`);
      try{
        const model=prov==="openrouter"?"google/gemma-4-31b-it:free":"mimo-v2.5-free";
        const r=await callAI(prov,key,model,[{role:"user",content:t}]);
        box.lastElementChild.remove();
        box.insertAdjacentHTML("beforeend",`<div style="color:#e5e7eb;margin:4px 0">${esc(r)}</div>`);
        box.scrollTop=box.scrollHeight;
      }catch(er){ box.lastElementChild.remove(); box.insertAdjacentHTML("beforeend",`<div style="color:#f66;margin:4px 0">Ошибка: ${esc(er.message)}</div>`); }
    }

    async function loadLib(){
      const el=document.getElementById("mlp-liblist");
      const list=await getLibrary();
      if(!list.length){el.innerHTML="<span style='color:#6b7280'>Библиотека пуста.</span>";return;}
      el.innerHTML=list.map(m=>`<div style="padding:8px;border-bottom:1px solid #252a38;display:flex;justify-content:space-between;align-items:center"><span>${esc(m.title||m.id||"Манга")}</span><small style="color:#6b7280">${esc(m.source||"")}</small></div>`).join("");
    }

    function initOcr(){
      const f=document.getElementById("mlp-ocrfile");
      f.addEventListener("change",async()=>{
        const file=f.files[0]; if(!file)return;
        const el=document.getElementById("mlp-ocrresult");
        el.textContent="Распознаю…";
        try{ const text=await runOcr(file); el.textContent=text||"(текст не распознан)"; }
        catch(e){ el.textContent="OCR ошибка: "+e.message; }
      });
    }

    function initSuwa(){ const s=localStorage.getItem("mlp_suwa_url"); if(s)document.getElementById("mlp-suwa-url").value=s; else setTimeout(()=>findSuwayomi(),500); }
    async function connectSuwayomi(url){
      const target=url||document.getElementById("mlp-suwa-url").value.trim()||"http://127.0.0.1:4567";
      localStorage.setItem("mlp_suwa_url",target);
      const st=document.getElementById("mlp-suwa-status");
      const box=document.getElementById("mlp-suwa-manga");
      st.textContent="Проверяю "+target+" …";
      try{
        const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),8000);
        const r=await fetch(target+"/api/v1/manga",{signal:ctrl.signal}); clearTimeout(t);
        if(r.ok){ st.textContent="✓ Подключён: "+target; const data=await r.json();
          const list=data.data||data.manga||[];
          box.innerHTML=list.length?list.slice(0,20).map(m=>`<div style="padding:6px;border-bottom:1px solid #252a38">${esc(m.title||"?")}</div>`).join(""):"<span style='color:#6b7280'>Манг не найдено.</span>";
        } else { st.textContent="Ответ "+r.status; box.innerHTML=""; }
      }catch(e){ st.textContent="Не подключиться к "+target; box.innerHTML=""; }
    }
    async function findSuwayomi(){
      const st=document.getElementById("mlp-suwa-status"); st.textContent="Ищу Suwayomi…";
      const cands=["http://127.0.0.1:4567","http://localhost:4567","http://10.0.2.2:4567","http://192.168.0.1:4567"];
      for(const c of cands){
        try{ const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),4000);
          const r=await fetch(c+"/api/v1/manga",{signal:ctrl.signal}); clearTimeout(t);
          if(r.ok){ document.getElementById("mlp-suwa-url").value=c; localStorage.setItem("mlp_suwa_url",c); st.textContent="✓ Найден: "+c; return; } }
        catch(e){}
      }
      st.textContent="Не найден. Укажи URL вручную.";
    }

    function initModels(){
      const el=document.getElementById("mlp-models");
      el.innerHTML=NEURAL.map(n=>`<div style="display:flex;justify-content:space-between;padding:8px;background:#0f1117;border-radius:8px;margin-bottom:5px"><span>${esc(n.name)} <small style="color:#6b7280">(${n.type})</small></span><span style="font-size:12px;color:#6b7280">готов</span></div>`).join("");
      const f=document.getElementById("mlp-tflite");
      f.addEventListener("change",()=>{
        const file=f.files[0]; if(!file)return;
        const models=JSON.parse(localStorage.getItem("mlp_models")||"[]");
        models.push({name:file.name,size:file.size});
        localStorage.setItem("mlp_models",JSON.stringify(models));
        document.getElementById("mlp-tflite-status").textContent="✓ "+file.name+" зарегистрирована ("+(file.size/1024).toFixed(0)+" KB)";
      });
    }

    fab.onclick=open;
    window.__mlplus={open,close,callAI,getLibrary,runOcr};
  }

  if(document.body) buildUI(); else document.addEventListener("DOMContentLoaded",buildUI);
  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
})();
