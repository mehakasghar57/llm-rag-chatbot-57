/* Groq Chat: ChatGPT-style assistant. Normal chat + (optional) answers from uploaded documents.
 * Chats and documents live in this browser (IndexedDB). The server is stateless. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = {
    sidebar: $("sidebar"), overlay: $("overlay"), openSidebar: $("openSidebar"), closeSidebar: $("closeSidebar"),
    newChat: $("newChatBtn"), chatList: $("chatList"),
    docCount: $("docCount"), dropzone: $("dropzone"), limitsText: $("limitsText"), fileInput: $("fileInput"),
    docList: $("docList"), clearBtn: $("clearBtn"),
    saveJson: $("saveJsonBtn"), saveTxt: $("saveTxtBtn"), load: $("loadBtn"), historyInput: $("historyInput"),
    modelInfo: $("modelInfo"), modelSelect: $("modelSelect"), theme: $("themeBtn"),
    chat: $("chat"), messages: $("messages"), form: $("form"), input: $("input"),
    attach: $("attachBtn"), docsToggle: $("docsToggle"), send: $("sendBtn"),
  };

  const DB_NAME = "docchat-groq";
  const TOP_K = 5;
  const MAX_IMPORT_MESSAGES = 200;
  const MAX_IMPORT_CHARS = 20000;
  const K = { theme: "docchat:theme", active: "docchat:active", useDocs: "docchat:useDocs", model: "docchat:model" };

  let chats = [];            // [{id, title, created, updated, messages: [{role, content, sources?, searchQuery?, stopped?}]}]
  let activeId = null;
  let docs = [];             // [{id, name, pages, chars, created, chunks}]
  let pending = [];          // uploads in progress / failed (UI only)
  let searchIndex = null;
  let limits = { max_upload_mb: 3, max_docs: 10 };
  let useDocs = true;
  let persistent = true;
  let busy = false;
  let controller = null;
  let tempError = null;      // {text} shown after the last message, never saved

  // ---------- helpers ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    remove(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const esc = (s) => Markdown.escapeHtml(s);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  const num = (v) => (Number.isFinite(v) ? v : 0);

  let toastTimer = null;
  function toast(text) {
    let t = document.querySelector(".toast");
    if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = text;
    requestAnimationFrame(() => t.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  async function copyText(text, done) {
    try { await navigator.clipboard.writeText(text); toast(done || "Copied"); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast(done || "Copied"); } catch { toast("Could not copy"); }
      ta.remove();
    }
  }

  // ---------- IndexedDB (docs + chats) with in-memory fallback ----------
  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error("no idb")); return; }
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "id" });
        if (!db.objectStoreNames.contains("chats")) db.createObjectStore("chats", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("blocked"));
    });
    return dbPromise;
  }
  async function dbRun(storeName, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const r = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(r ? r.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async function dbAll(name) { try { return (await dbRun(name, "readonly", (s) => s.getAll())) || []; } catch { persistent = false; return []; } }
  async function dbPut(name, v) { if (persistent) try { await dbRun(name, "readwrite", (s) => s.put(v)); } catch { persistent = false; } }
  async function dbDel(name, id) { if (persistent) try { await dbRun(name, "readwrite", (s) => s.delete(id)); } catch { /* ignore */ } }
  async function dbClear(name) { if (persistent) try { await dbRun(name, "readwrite", (s) => s.clear()); } catch { /* ignore */ } }

  function rebuildIndex() {
    const flat = [];
    for (const d of docs) for (const c of d.chunks) flat.push({ docId: d.id, filename: d.name, page: c.page, chunk: c.chunk, text: c.text });
    searchIndex = Retrieval.buildIndex(flat);
  }

  // ---------- API ----------
  async function parseError(res) {
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    return new Error(data.error || `Request failed (${res.status}). Please try again.`);
  }
  async function api(path, options) {
    let res;
    try { res = await fetch(path, options); } catch (e) { if (e.name === "AbortError") throw e; throw new Error("Network error. Check your connection and try again."); }
    if (!res.ok) throw await parseError(res);
    return res.json();
  }
  const postJson = (path, body, signal) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });

  // ---------- chats ----------
  const active = () => chats.find((c) => c.id === activeId) || null;
  const saveChat = (c) => dbPut("chats", c);

  function makeChat() {
    const now = Date.now();
    return { id: uid(), title: "New chat", created: now, updated: now, messages: [] };
  }
  function selectChat(id) {
    if (busy) return;
    activeId = id; store.set(K.active, id);
    tempError = null;
    renderAll(); closeSidebar();
  }
  function newChat() {
    if (busy) return;
    const cur = active();
    if (cur && cur.messages.length === 0) { closeSidebar(); el.input.focus(); return; }
    const c = makeChat();
    chats.unshift(c); activeId = c.id; store.set(K.active, c.id);
    tempError = null;
    renderAll(); closeSidebar(); el.input.focus();
  }
  function deleteChat(id) {
    if (busy) return;
    const c = chats.find((x) => x.id === id);
    if (!c || !confirm(`Delete "${c.title}"?`)) return;
    chats = chats.filter((x) => x.id !== id);
    dbDel("chats", id);
    if (activeId === id) { activeId = chats.length ? chats[0].id : null; }
    if (!activeId) { const n = makeChat(); chats.unshift(n); activeId = n.id; }
    store.set(K.active, activeId);
    renderAll();
  }
  function renameChat(id) {
    const c = chats.find((x) => x.id === id);
    if (!c) return;
    const name = prompt("Rename chat", c.title);
    if (name && name.trim()) { c.title = name.trim().slice(0, 60); saveChat(c); renderChatList(); }
  }
  const titleFrom = (text) => { const t = text.replace(/\s+/g, " ").trim(); return t.length > 40 ? t.slice(0, 40).trim() + "…" : t || "New chat"; };

  function renderChatList() {
    el.chatList.textContent = "";
    const sorted = chats.slice().sort((a, b) => b.updated - a.updated);
    for (const c of sorted) {
      const row = document.createElement("div");
      row.className = "chat-item" + (c.id === activeId ? " active" : "");
      const title = document.createElement("button");
      title.type = "button"; title.className = "title"; title.textContent = c.title; title.title = c.title;
      title.addEventListener("click", () => selectChat(c.id));
      const ren = document.createElement("button");
      ren.type = "button"; ren.className = "mini"; ren.textContent = "✎"; ren.setAttribute("aria-label", "Rename chat"); ren.title = "Rename";
      ren.addEventListener("click", () => renameChat(c.id));
      const del = document.createElement("button");
      del.type = "button"; del.className = "mini del"; del.textContent = "🗑"; del.setAttribute("aria-label", "Delete chat"); del.title = "Delete";
      del.addEventListener("click", () => deleteChat(c.id));
      row.append(title, ren, del);
      el.chatList.appendChild(row);
    }
  }

  // ---------- message rendering ----------
  function nearBottom() { const c = el.chat; return c.scrollHeight - c.scrollTop - c.clientHeight < 120; }
  function scrollDown(force) { if (force || nearBottom()) el.chat.scrollTop = el.chat.scrollHeight; }

  // Turn [1] / [2, 3] into clickable chips, only in plain text (not inside code, tags or links).
  function withCitations(html, sources) {
    if (!sources || !sources.length) return html;
    const valid = new Set(sources.map((s) => s.n));
    return html.split(/(<pre>[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>|<a [\s\S]*?<\/a>|<[^>]+>)/).map((part) => {
      if (part.startsWith("<")) return part;
      return part.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (m, group) => {
        const nums = group.split(/\s*,\s*/).map(Number);
        if (!nums.every((n) => valid.has(n))) return m;
        return nums.map((n) => `<button type="button" class="cite" data-n="${n}" aria-label="Source ${n}">${n}</button>`).join("");
      });
    }).join("");
  }

  function sourcesBox(sources, msgEl) {
    const used = sources.filter((s) => s.cited);
    const shown = used.length ? used : [];
    if (!shown.length) return null;
    const box = document.createElement("details");
    box.className = "sources";
    const sum = document.createElement("summary");
    sum.textContent = `Sources (${shown.length})`;
    box.appendChild(sum);
    const list = document.createElement("ol");
    list.className = "src-list";
    for (const s of shown) {
      const li = document.createElement("li");
      li.className = "src"; li.dataset.n = s.n;
      li.innerHTML = `<span class="n">${s.n}</span><div class="body"><div class="title">${esc(s.filename)}</div>` +
        `<div class="where">${s.page ? "Page " + s.page : "Text file"} · section ${s.chunk + 1}</div>` +
        `<p class="snippet">${esc(s.snippet || "")}</p></div>`;
      list.appendChild(li);
    }
    box.appendChild(list);
    return box;
  }

  function fillBot(bubble, m, streaming) {
    bubble.textContent = "";
    if (m.searchQuery) {
      const p = document.createElement("p");
      p.className = "rewrite"; p.textContent = "Searched your documents for: " + m.searchQuery;
      bubble.appendChild(p);
    }
    const body = document.createElement("div");
    body.className = "md" + (streaming ? " cursor" : "");
    body.innerHTML = withCitations(Markdown.render(m.content || ""), m.sources);
    bubble.appendChild(body);
    if (m.stopped) { const n = document.createElement("div"); n.className = "stopped-note"; n.textContent = "Stopped"; bubble.appendChild(n); }
    if (!streaming && m.sources) { const box = sourcesBox(m.sources); if (box) bubble.appendChild(box); }
  }

  function toolsFor(m, isLast) {
    const tools = document.createElement("div");
    tools.className = "tools";
    const copy = document.createElement("button");
    copy.type = "button"; copy.className = "copy"; copy.textContent = "Copy";
    copy.addEventListener("click", () => copyText(m.content));
    tools.appendChild(copy);
    if (isLast) {
      const re = document.createElement("button");
      re.type = "button"; re.className = "retry regen"; re.textContent = "Regenerate";
      re.addEventListener("click", regenerate);
      tools.appendChild(re);
    }
    return tools;
  }

  function messageEl(m, isLast) {
    const row = document.createElement("div");
    if (m.role === "user") {
      row.className = "msg user";
      const b = document.createElement("div"); b.className = "bubble"; b.textContent = m.content;
      row.appendChild(b);
      return row;
    }
    row.className = "msg bot";
    const av = document.createElement("div"); av.className = "avatar"; av.textContent = "AI"; av.setAttribute("aria-hidden", "true");
    const b = document.createElement("div"); b.className = "bubble";
    fillBot(b, m, false);
    b.appendChild(toolsFor(m, isLast && !busy));
    row.append(av, b);
    return row;
  }

  function errorEl(text) {
    const row = document.createElement("div");
    row.className = "msg bot error";
    const b = document.createElement("div"); b.className = "bubble";
    const p = document.createElement("div"); p.textContent = text;
    const tools = document.createElement("div"); tools.className = "tools";
    const retry = document.createElement("button");
    retry.type = "button"; retry.className = "retry"; retry.textContent = "Try again";
    retry.addEventListener("click", () => { tempError = null; generate(); });
    tools.appendChild(retry);
    b.append(p, tools); row.appendChild(b);
    return row;
  }

  const SUGGESTIONS_GENERAL = [
    ["Explain a topic simply", "Explain how the internet works in simple words"],
    ["Write some code", "Write a Python function that checks if a string is a palindrome"],
    ["Plan something", "Make me a 3-day study plan to learn the basics of JavaScript"],
    ["Draft a message", "Write a polite email asking my teacher for a deadline extension"],
  ];
  const SUGGESTIONS_DOCS = [
    ["Summarize my document", "Summarize my uploaded document in 5 bullet points"],
    ["Find key details", "What are the most important dates, numbers and names in my documents?"],
  ];

  function welcomeEl() {
    const w = document.createElement("div");
    w.className = "welcome";
    w.innerHTML = '<div class="logo" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg></div>' +
      "<h2>How can I help you today?</h2>" +
      '<p class="subtle">Ask anything, or attach a PDF/TXT file and ask about it.</p>';
    const grid = document.createElement("div");
    grid.className = "suggestions";
    const list = (docs.length ? SUGGESTIONS_DOCS.concat(SUGGESTIONS_GENERAL.slice(0, 2)) : SUGGESTIONS_GENERAL);
    for (const [label, prompt_] of list) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "suggest";
      b.innerHTML = `${esc(label)}<small>${esc(prompt_)}</small>`;
      b.addEventListener("click", () => send(prompt_));
      grid.appendChild(b);
    }
    w.appendChild(grid);
    return w;
  }

  function renderMessages() {
    el.messages.textContent = "";
    const c = active();
    if (!c) return;
    if (c.messages.length === 0) { el.messages.appendChild(welcomeEl()); return; }
    c.messages.forEach((m, i) => el.messages.appendChild(messageEl(m, i === c.messages.length - 1 && m.role === "assistant")));
    if (tempError) el.messages.appendChild(errorEl(tempError));
    scrollDown(true);
  }
  function renderAll() { renderChatList(); renderMessages(); renderDocs(); updateSend(); }

  // citation chips and code copy (delegated)
  el.messages.addEventListener("click", (e) => {
    const copyBtn = e.target.closest(".code-copy");
    if (copyBtn) {
      const code = copyBtn.closest(".codeblock").querySelector("code");
      copyText(code.textContent, "Code copied");
      return;
    }
    const cite = e.target.closest(".cite");
    if (cite) {
      const bubble = cite.closest(".bubble");
      const box = bubble && bubble.querySelector(".sources");
      if (!box) return;
      box.open = true;
      const item = box.querySelector(`.src[data-n="${cite.dataset.n}"]`);
      if (item) { item.scrollIntoView({ block: "nearest", behavior: "smooth" }); item.classList.add("flash"); setTimeout(() => item.classList.remove("flash"), 1400); }
    }
  });

  // ---------- sending / streaming ----------
  function setBusy(v) { busy = v; updateSend(); }
  function updateSend() {
    const stop = busy;
    el.send.classList.toggle("stop", stop);
    el.send.disabled = !stop && el.input.value.trim() === "";
    el.send.setAttribute("aria-label", stop ? "Stop generating" : "Send message");
    el.input.disabled = false;
  }
  function autoResize() { el.input.style.height = "auto"; el.input.style.height = Math.min(el.input.scrollHeight, 200) + "px"; }

  function send(text) {
    const content = (text || "").trim();
    if (!content || busy) return;
    const c = active();
    if (!c) return;
    c.messages.push({ role: "user", content });
    if (c.messages.filter((m) => m.role === "user").length === 1) c.title = titleFrom(content);
    c.updated = Date.now();
    saveChat(c);
    tempError = null;
    el.input.value = ""; autoResize();
    closeSidebar();
    renderAll();
    generate();
  }

  function regenerate() {
    const c = active();
    if (busy || !c || !c.messages.length) return;
    if (c.messages[c.messages.length - 1].role === "assistant") c.messages.pop();
    saveChat(c); tempError = null;
    renderAll();
    generate();
  }

  async function generate() {
    const c = active();
    if (!c || busy || !c.messages.length) return;
    setBusy(true);
    controller = new AbortController();
    const signal = controller.signal;

    // live bubble
    const row = document.createElement("div");
    row.className = "msg bot";
    const av = document.createElement("div"); av.className = "avatar"; av.textContent = "AI";
    const bubble = document.createElement("div"); bubble.className = "bubble";
    bubble.innerHTML = '<div class="typing" aria-label="Thinking"><span></span><span></span><span></span></div>';
    row.append(av, bubble);
    el.messages.appendChild(row);
    scrollDown(true);

    const entry = { role: "assistant", content: "" };
    let gotText = false;
    try {
      const messages = c.messages.map((m) => ({ role: m.role, content: m.content }));
      const question = messages[messages.length - 1].content;

      let passages = [];
      if (useDocs && docs.length) {
        let query = question;
        if (messages.length > 1) {
          try { query = (await postJson("/api/rewrite", { messages }, signal)).query || question; }
          catch (e) { if (e.name === "AbortError") throw e; query = question; }
        }
        let hits = Retrieval.search(searchIndex, query, TOP_K);
        if (!hits.length && query !== question) hits = Retrieval.search(searchIndex, question, TOP_K);
        passages = hits.map((h) => ({ doc_id: h.docId, filename: h.filename, page: h.page, chunk: h.chunk, score: h.score, text: h.text }));
        if (passages.length && query !== question) entry.searchQuery = query;
      }

      const body = { messages, stream: true };
      if (passages.length) body.passages = passages;
      if (el.modelSelect.value) body.model = el.modelSelect.value;

      let res;
      try {
        res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
      } catch (e) {
        if (e.name === "AbortError") throw e;
        throw new Error("Network error. Check your connection and try again.");
      }
      if (!res.ok) throw await parseError(res);

      let frame = 0;
      const paint = () => { frame = 0; fillBot(bubble, entry, true); scrollDown(false); };
      const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };

      if ((res.headers.get("content-type") || "").includes("text/event-stream") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let finished = false;
        const handle = (raw) => {
          const line = raw.split("\n").find((l) => l.startsWith("data:"));
          if (!line) return;
          let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { return; }
          if (ev.type === "delta" && typeof ev.text === "string") { entry.content += ev.text; gotText = true; schedule(); }
          else if (ev.type === "done") { finished = true; if (Array.isArray(ev.sources) && ev.sources.length) entry.sources = ev.sources; }
          else if (ev.type === "error") { throw new Error(ev.error || ev.message || "The reply was interrupted."); }
        };
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 2); }
          }
          if (buf.trim()) handle(buf);
        } finally { if (frame) cancelAnimationFrame(frame); }
        if (!finished && !entry.content) throw new Error("The reply was empty or interrupted. Please try again.");
      } else {
        const data = await res.json();
        entry.content = data.reply || "";
        if (Array.isArray(data.sources) && data.sources.length) entry.sources = data.sources;
        if (!entry.content) throw new Error("The model returned an empty reply. Please try again.");
      }

      c.messages.push(entry);
    } catch (err) {
      if (err.name === "AbortError") {
        if (entry.content) { entry.stopped = true; c.messages.push(entry); }
        else tempError = "Generation stopped.";
      } else if (entry.content) {
        entry.stopped = true; c.messages.push(entry); // keep what arrived
        toast(err.message || "The reply was interrupted.");
      } else {
        tempError = err.message || "Something went wrong. Please try again.";
      }
    } finally {
      controller = null;
      c.updated = Date.now();
      saveChat(c);
      setBusy(false);
      if (activeId === c.id) renderAll(); else renderChatList();
      el.input.focus();
    }
  }

  // ---------- documents ----------
  function renderDocs() {
    el.docList.textContent = "";
    const total = docs.length;
    el.docCount.hidden = total === 0;
    el.docCount.textContent = String(total);
    el.clearBtn.hidden = total === 0;

    const addItem = (cls, ico, name, meta, onDelete) => {
      const li = document.createElement("li");
      li.className = "doc " + cls;
      const i = document.createElement("div"); i.className = "ico";
      if (ico === "spin") { const s = document.createElement("div"); s.className = "spinner"; i.appendChild(s); } else i.textContent = ico;
      const info = document.createElement("div"); info.className = "info";
      const n = document.createElement("div"); n.className = "name"; n.textContent = name; n.title = name;
      const m = document.createElement("div"); m.className = "meta"; m.textContent = meta;
      info.append(n, m); li.append(i, info);
      if (onDelete) {
        const d = document.createElement("button");
        d.type = "button"; d.className = "doc-del"; d.textContent = "✕"; d.setAttribute("aria-label", "Remove " + name);
        d.addEventListener("click", onDelete); li.appendChild(d);
      }
      el.docList.appendChild(li);
    };

    for (const d of docs) {
      const ext = /\.pdf$/i.test(d.name) ? "PDF" : "TXT";
      const meta = `${d.chunks.length} sections` + (d.pages ? ` · ${d.pages} page${d.pages === 1 ? "" : "s"}` : "");
      addItem("", ext, d.name, meta, () => removeDoc(d.id));
    }
    for (const p of pending) {
      if (p.error) addItem("failed", "!", p.name, p.error, () => { pending = pending.filter((x) => x !== p); renderDocs(); });
      else addItem("pending", "spin", p.name, "Reading…", null);
    }
    updateDocsToggle();
  }

  function updateDocsToggle() {
    const has = docs.length > 0;
    el.docsToggle.hidden = !has;
    el.docsToggle.setAttribute("aria-pressed", String(useDocs));
    el.docsToggle.textContent = useDocs ? `Using documents (${docs.length})` : "Documents off";
    el.docsToggle.title = useDocs ? "Answers use your uploaded documents. Click to turn off." : "Answers ignore your documents. Click to turn on.";
  }

  async function removeDoc(id) {
    docs = docs.filter((d) => d.id !== id);
    await dbDel("docs", id);
    rebuildIndex(); renderDocs();
    if (!active() || active().messages.length === 0) renderMessages();
  }

  function fileProblem(file) {
    if (!/\.(pdf|txt)$/i.test(file.name)) return "Only PDF and TXT files are supported.";
    if (file.size === 0) return "This file is empty.";
    if (file.size > limits.max_upload_mb * 1024 * 1024) return `Too large. Maximum is ${limits.max_upload_mb} MB.`;
    if (docs.some((d) => d.name === file.name)) return "A document with this name is already uploaded.";
    if (docs.length >= limits.max_docs) return `Document limit reached (${limits.max_docs}). Remove one first.`;
    return null;
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList);
    el.fileInput.value = "";
    const panel = $("docsPanel"); if (panel) panel.open = true;
    for (const file of files) {
      const problem = fileProblem(file);
      if (problem) { const p = { name: file.name, error: problem }; pending.push(p); renderDocs(); continue; }
      const p = { name: file.name };
      pending.push(p); renderDocs();
      try {
        const form = new FormData();
        form.append("file", file);
        const { document: x } = await api("/api/extract", { method: "POST", body: form });
        const doc = { id: uid(), name: x.name || file.name, pages: x.pages, chars: x.chars, created: Date.now(), chunks: x.chunks };
        docs.push(doc);
        await dbPut("docs", doc);
        pending = pending.filter((q) => q !== p);
        rebuildIndex();
        useDocs = true; store.set(K.useDocs, "1");
        toast(`Added ${doc.name}`);
      } catch (err) {
        p.error = err.message || "Upload failed.";
      }
      renderDocs();
    }
    if (active() && active().messages.length === 0) renderMessages();
  }

  el.attach.addEventListener("click", () => el.fileInput.click());
  el.dropzone.addEventListener("click", () => el.fileInput.click());
  el.dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.fileInput.click(); } });
  el.fileInput.addEventListener("change", () => { if (el.fileInput.files.length) uploadFiles(el.fileInput.files); });
  ["dragenter", "dragover"].forEach((t) => el.dropzone.addEventListener(t, (e) => { e.preventDefault(); el.dropzone.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((t) => el.dropzone.addEventListener(t, (e) => { e.preventDefault(); el.dropzone.classList.remove("drag"); }));
  el.dropzone.addEventListener("drop", (e) => { if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });
  // dropping a file anywhere on the page
  window.addEventListener("dragover", (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    if (e.target.closest && e.target.closest("#dropzone")) return;
    if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); uploadFiles(e.dataTransfer.files); }
  });
  el.clearBtn.addEventListener("click", async () => {
    if (!confirm("Delete all uploaded documents from this browser?")) return;
    docs = []; pending = [];
    await dbClear("docs");
    rebuildIndex(); renderDocs();
    if (active() && active().messages.length === 0) renderMessages();
  });
  el.docsToggle.addEventListener("click", () => {
    useDocs = !useDocs; store.set(K.useDocs, useDocs ? "1" : "0"); updateDocsToggle();
  });

  // ---------- chat files (save / load) ----------
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

  function exportChat(kind) {
    const c = active();
    if (!c || !c.messages.length) { toast("This chat is empty."); return; }
    if (kind === "json") {
      const data = { app: "docchat-groq", version: 2, title: c.title, exported: new Date().toISOString(), messages: c.messages };
      download(`chat-${stamp()}.json`, JSON.stringify(data, null, 2), "application/json");
    } else {
      const lines = [`${c.title}`, `Exported ${new Date().toLocaleString()}`, ""];
      for (const m of c.messages) {
        lines.push(`${m.role === "user" ? "You" : "Assistant"}:`, m.content);
        if (m.sources) {
          const used = m.sources.filter((s) => s.cited);
          if (used.length) lines.push("Sources: " + used.map((s) => `[${s.n}] ${s.filename}${s.page ? ", page " + s.page : ""}`).join("; "));
        }
        lines.push("");
      }
      download(`chat-${stamp()}.txt`, lines.join("\n"), "text/plain");
    }
  }

  function cleanImported(list) {
    const out = [];
    for (const m of (Array.isArray(list) ? list : []).slice(0, MAX_IMPORT_MESSAGES)) {
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
      const content = str(m.content, MAX_IMPORT_CHARS).trim();
      if (!content) continue;
      const item = { role: m.role, content };
      if (m.role === "assistant") {
        if (Array.isArray(m.sources)) {
          item.sources = m.sources.slice(0, 10).map((s, i) => ({
            n: Number.isInteger(s && s.n) ? s.n : i + 1,
            filename: str(s && s.filename, 120) || "document",
            page: num(s && s.page), chunk: num(s && s.chunk),
            snippet: str(s && s.snippet, 400), cited: !!(s && s.cited),
          }));
        }
        if (typeof m.searchQuery === "string") item.searchQuery = m.searchQuery.slice(0, 300);
        if (m.stopped) item.stopped = true;
      }
      out.push(item);
    }
    while (out.length && out[0].role !== "user") out.shift();
    return out;
  }

  el.saveJson.addEventListener("click", () => exportChat("json"));
  el.saveTxt.addEventListener("click", () => exportChat("txt"));
  el.load.addEventListener("click", () => el.historyInput.click());
  el.historyInput.addEventListener("change", async () => {
    const file = el.historyInput.files[0];
    el.historyInput.value = "";
    if (!file || busy) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("big");
      const data = JSON.parse(await file.text());
      const msgs = cleanImported(Array.isArray(data) ? data : data && data.messages);
      if (!msgs.length) throw new Error("empty");
      const c = makeChat();
      c.title = str(data && data.title, 60).trim() || titleFrom(msgs[0].content);
      c.messages = msgs;
      chats.unshift(c); activeId = c.id; store.set(K.active, c.id);
      await saveChat(c);
      tempError = null; renderAll(); closeSidebar();
      toast("Chat loaded");
    } catch {
      toast("That is not a valid chat file.");
    }
  });

  // ---------- UI chrome ----------
  function openSide() { el.sidebar.classList.add("open"); el.overlay.hidden = false; }
  function closeSidebar() { el.sidebar.classList.remove("open"); el.overlay.hidden = true; }
  el.openSidebar.addEventListener("click", openSide);
  el.closeSidebar.addEventListener("click", closeSidebar);
  el.overlay.addEventListener("click", closeSidebar);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSidebar(); });

  function applyTheme(t) {
    if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }
  el.theme.addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    applyTheme(next); store.set(K.theme, next);
  });

  el.newChat.addEventListener("click", newChat);
  el.form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) { if (controller) controller.abort(); return; }
    send(el.input.value);
  });
  el.input.addEventListener("input", () => { autoResize(); updateSend(); });
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) send(el.input.value); }
  });
  el.modelSelect.addEventListener("change", () => store.set(K.model, el.modelSelect.value));

  async function loadHealth() {
    try {
      const h = await api("/api/health");
      limits = Object.assign(limits, h.limits || {});
      el.limitsText.textContent = `PDF or TXT · max ${limits.max_upload_mb} MB · up to ${limits.max_docs} files`;
      const models = Array.isArray(h.models) && h.models.length ? h.models : [h.chat_model].filter(Boolean);
      el.modelSelect.textContent = "";
      for (const m of models) { const o = document.createElement("option"); o.value = m; o.textContent = m; el.modelSelect.appendChild(o); }
      const saved = store.get(K.model);
      el.modelSelect.value = models.includes(saved) ? saved : models[0] || "";
      el.modelInfo.textContent = h.groq_key_configured ? "Powered by Groq" : "⚠ Server setup incomplete: GROQ_API_KEY is missing";
    } catch {
      el.modelInfo.textContent = "Server unreachable";
    }
  }

  // ---------- init ----------
  (async function init() {
    applyTheme(store.get(K.theme));
    useDocs = store.get(K.useDocs) !== "0";
    // render something immediately, then load saved data
    const first = makeChat();
    chats = [first]; activeId = first.id;
    renderAll();
    loadHealth();

    const [savedChats, savedDocs] = await Promise.all([dbAll("chats"), dbAll("docs")]);
    docs = savedDocs.filter((d) => d && Array.isArray(d.chunks)).sort((a, b) => a.created - b.created);
    rebuildIndex();
    const valid = savedChats.filter((c) => c && Array.isArray(c.messages));
    if (valid.length) {
      chats = valid;
      const want = store.get(K.active);
      const empty = chats.find((c) => c.messages.length === 0);
      activeId = chats.some((c) => c.id === want) ? want : (empty || chats.slice().sort((a, b) => b.updated - a.updated)[0]).id;
    } else {
      chats = [first]; activeId = first.id;
    }
    renderAll();
    el.input.focus();
  })();
})();
