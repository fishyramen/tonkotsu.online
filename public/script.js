(() => {
  "use strict";

  // Prevent double-load (fix duplicate messages/UI)
  if (window.__TONKOTSU_LOADED__) return;
  window.__TONKOTSU_LOADED__ = true;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const now = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const safe = (v) => (typeof v === "string" ? v : "");
  const esc = (s) =>
    safe(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  function uid(prefix = "id") {
    return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
  }

  function localGet(k, fb = null) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? fb : JSON.parse(v);
    } catch {
      return fb;
    }
  }
  function localSet(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  }

  // DOM
  const dom = {
    loginWrap: $("#loginWrap"),
    loginUser: $("#loginUser"),
    loginPass: $("#loginPass"),
    loginMsg: $("#loginMsg"),
    btnLogin: $("#btnLogin"),
    btnGuest: $("#btnGuest"),

    loading: $("#loading"),
    loadMsg: $("#loadMsg"),
    loadTag: $("#loadTag"),

    app: $("#app"),
    btnUser: $("#btnUser"),
    btnLogout: $("#btnLogout"),

    threadList: $("#threadList"),
    searchThreads: $("#searchThreads"),
    btnAddFriend: $("#btnAddFriend"),
    btnNewGroup: $("#btnNewGroup"),

    centerH: $("#centerH"),
    centerS: $("#centerS"),
    centerBody: $("#centerBody"),

    composer: $("#composer"),
    msgInput: $("#msgInput"),
    btnSend: $("#btnSend"),
    typingText: $("#typingText"),
    cooldownBar: $("#cooldownBar"),
    cooldownText: $("#cooldownText"),

    onlineUsers: $("#onlineUsers"),
    onlineCount: $("#onlineCount"),
    presenceDot: $("#presenceDot"),
    presenceLabel: $("#presenceLabel"),
    btnPresenceOnline: $("#btnPresenceOnline"),
    btnPresenceIdle: $("#btnPresenceIdle"),
    btnPresenceDnd: $("#btnPresenceDnd"),
    btnPresenceInv: $("#btnPresenceInv"),
    btnSettings: $("#btnSettings"),

    backdrop: $("#backdrop"),
    modalTitle: $("#modalTitle"),
    modalBody: $("#modalBody"),
    modalFoot: $("#modalFoot"),
    modalClose: $("#modalClose"),

    ctx: $("#ctx"),
    cursor: $("#cursor"),
  };

  // API
  async function api(path, { method = "GET", body = null } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (state.session.token) headers.Authorization = `Bearer ${state.session.token}`;
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : null });
    const ct = res.headers.get("content-type") || "";
    const isJson = ct.includes("application/json");
    const data = isJson ? await res.json().catch(() => ({})) : await res.text().catch(() => "");
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // Toasts
  const toast = (() => {
    let wrap = null;
    function ensure() {
      if (wrap) return wrap;
      wrap = document.createElement("div");
      wrap.style.position = "fixed";
      wrap.style.right = "14px";
      wrap.style.bottom = "14px";
      wrap.style.display = "flex";
      wrap.style.flexDirection = "column";
      wrap.style.gap = "10px";
      wrap.style.zIndex = "9998";
      document.body.appendChild(wrap);
      return wrap;
    }
    function show(msg, kind = "info", ttl = 2200) {
      ensure();
      const el = document.createElement("div");
      el.style.padding = "10px 12px";
      el.style.borderRadius = "14px";
      el.style.border = "1px solid rgba(130,140,170,.22)";
      el.style.background = "rgba(10,12,16,.92)";
      el.style.color = "rgba(235,240,255,.92)";
      el.style.maxWidth = "320px";
      el.style.boxShadow = "0 10px 30px rgba(0,0,0,.45)";
      if (kind === "err") el.style.borderColor = "rgba(255,92,122,.35)";
      if (kind === "ok") el.style.borderColor = "rgba(120,255,190,.25)";
      if (kind === "warn") el.style.borderColor = "rgba(255,210,120,.25)";
      el.innerHTML = `<div>${esc(msg)}</div>`;
      wrap.appendChild(el);

      const kill = () => {
        el.style.opacity = "0";
        el.style.transform = "translateY(8px)";
        setTimeout(() => el.remove(), 180);
      };

      el.style.transition = "all 180ms ease";
      el.style.opacity = "0";
      el.style.transform = "translateY(8px)";
      requestAnimationFrame(() => {
        el.style.opacity = "1";
        el.style.transform = "translateY(0)";
      });

      const id = setTimeout(kill, ttl);
      el.onclick = () => {
        clearTimeout(id);
        kill();
      };
    }
    return { show };
  })();

  // State
  const state = {
    session: {
      token: localGet("tk_token", null),
      user: localGet("tk_user", null),
    },
    ui: {
      activeThread: "global", // "global" | "dm:<peerId>" | "group:<groupId>"
      sendingLock: false,
      cooldown: { until: 0, durationMs: 0 },
      onlineUsers: [],
      settings: localGet("tk_settings", {
        cursor: { enabled: true, size: 1.0, dynamic: true }, // smaller
      }),
      firstJoinShown: !!localGet("tk_firstJoinShown", false),
      ctx: { open: false, threadKey: null, msgId: null },
      sendDedupe: new Map(), // clientId->ts
    },
    data: {
      me: null,
      threads: {}, // key -> { kind,name,id?, messages:[] }
      friends: [],
      groups: [],
    },
    socket: null,
  };

  // cleanup old dedupe
  setInterval(() => {
    const cutoff = now() - 60_000;
    for (const [k, t] of state.ui.sendDedupe.entries()) if (t < cutoff) state.ui.sendDedupe.delete(k);
  }, 10_000);

  function showLoading(msg = "Loading…", tag = "boot") {
    if (dom.loadMsg) dom.loadMsg.textContent = msg;
    if (dom.loadTag) dom.loadTag.textContent = tag;
    dom.loading?.classList.add("show");
  }
  function hideLoading() {
    dom.loading?.classList.remove("show");
  }

  // Modal (single close button only)
  function closeModal() {
    dom.backdrop?.classList.remove("show");
    if (dom.modalTitle) dom.modalTitle.textContent = "";
    if (dom.modalBody) dom.modalBody.innerHTML = "";
    if (dom.modalFoot) dom.modalFoot.innerHTML = "";
  }
  function openModal(title, bodyHtml, buttons = []) {
    if (dom.modalTitle) dom.modalTitle.textContent = title;
    if (dom.modalBody) dom.modalBody.innerHTML = bodyHtml;
    if (dom.modalFoot) dom.modalFoot.innerHTML = "";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.className = `btn ${b.kind || ""}`.trim();
      btn.textContent = b.label;
      btn.onclick = () => b.onClick?.();
      dom.modalFoot.appendChild(btn);
    }
    dom.backdrop?.classList.add("show");
  }
  dom.modalClose?.addEventListener("click", closeModal);
  dom.backdrop?.addEventListener("click", (e) => {
    if (e.target === dom.backdrop) closeModal();
  });

  // Context menu
  function closeCtx() {
    state.ui.ctx.open = false;
    dom.ctx.classList.remove("show");
    dom.ctx.innerHTML = "";
  }
  document.addEventListener("click", () => state.ui.ctx.open && closeCtx());
  window.addEventListener("resize", () => state.ui.ctx.open && closeCtx());

  // Cursor (NO TRAIL)
  function applyCursorMode() {
    const enabled = !!(state?.ui?.settings?.cursor?.enabled);
    if (enabled) {
      document.documentElement.setAttribute("data-cursor", "custom");
      if (dom.cursor) dom.cursor.style.display = "block";
    } else {
      document.documentElement.removeAttribute("data-cursor");
      if (dom.cursor) dom.cursor.style.display = "none";
    }
    localSet("tk_settings", state.ui.settings);
  }
  applyCursorMode();

  const cur = { x: innerWidth / 2, y: innerHeight / 2, tx: innerWidth / 2, ty: innerHeight / 2, vx: 0, vy: 0, over: false, down: false, last: now() };
  addEventListener("mousemove", (e) => { cur.tx = e.clientX; cur.ty = e.clientY; cur.last = now(); });
  addEventListener("mousedown", () => (cur.down = true));
  addEventListener("mouseup", () => (cur.down = false));
  addEventListener("mouseover", (e) => {
    const t = e.target;
    cur.over = !!(t && (t.closest("button") || t.closest("a") || t.closest("input") || t.closest("textarea") || t.closest("[role='button']") || t.closest(".thread") || t.closest(".msg")));
  }, true);

  function cursorTick() {
    if (!state.ui.settings.cursor?.enabled) return requestAnimationFrame(cursorTick);

    const dynamic = !!state.ui.settings.cursor?.dynamic;
    const base = Math.max(0.75, Math.min(1.35, state.ui.settings.cursor?.size || 1.0)); // smaller range

    const dx = cur.tx - cur.x, dy = cur.ty - cur.y;
    cur.vx = (cur.vx + dx * 0.18) * 0.62;
    cur.vy = (cur.vy + dy * 0.18) * 0.62;
    cur.x += cur.vx; cur.y += cur.vy;

    let scale = base;
    if (dynamic) {
      if (cur.over) scale *= 1.18;
      if (cur.down) scale *= 0.86;
      const idle = Math.min(1, (now() - cur.last) / 2200);
      scale *= (1 + idle * 0.06 * Math.sin(now() / 360));
    }

    if (dom.cursor) dom.cursor.style.transform = `translate(${cur.x}px,${cur.y}px) translate(-50%,-50%) scale(${scale})`;
    requestAnimationFrame(cursorTick);
  }
  requestAnimationFrame(cursorTick);

  // Cooldown UI
  function setCooldown(untilTs, durationMs = 0) {
    state.ui.cooldown.until = untilTs || 0;
    if (durationMs) state.ui.cooldown.durationMs = durationMs;
  }
  function inCooldown() {
    return state.ui.cooldown.until && now() < state.ui.cooldown.until;
  }
  function flashCooldownViolation() {
    dom.composer?.classList.remove("cd-red", "cd-shake");
    void dom.composer?.offsetWidth;
    dom.composer?.classList.add("cd-red", "cd-shake");
    setTimeout(() => dom.composer?.classList.remove("cd-red"), 520);
    setTimeout(() => dom.composer?.classList.remove("cd-shake"), 620);
  }
  function updateCooldownUi() {
    const until = state.ui.cooldown.until || 0;
    const active = until && now() < until;

    if (!active) {
      if (dom.cooldownText) dom.cooldownText.textContent = "";
      if (dom.cooldownBar) { dom.cooldownBar.style.width = "0%"; dom.cooldownBar.style.opacity = "0"; }
      return;
    }

    const left = until - now();
    if (dom.cooldownText) dom.cooldownText.textContent = `cooldown: ${Math.ceil(left / 1000)}s`;

    const dur = state.ui.cooldown.durationMs || 2500;
    const start = until - dur;
    const pct = Math.max(0, Math.min(100, ((now() - start) / dur) * 100));
    if (dom.cooldownBar) { dom.cooldownBar.style.opacity = "1"; dom.cooldownBar.style.width = `${pct}%`; }
  }
  setInterval(updateCooldownUi, 120);

  // Presence UI
  function setPresenceUi(mode) {
    mode = mode || "online";
    dom.presenceDot?.classList.remove("idle", "dnd", "inv");
    if (mode === "idle") dom.presenceDot?.classList.add("idle");
    else if (mode === "dnd") dom.presenceDot?.classList.add("dnd");
    else if (mode === "invisible") dom.presenceDot?.classList.add("inv");
    if (dom.presenceLabel) dom.presenceLabel.textContent = mode;
  }

  async function setPresence(mode) {
    try {
      await api("/api/presence", { method: "POST", body: { mode } });
      setPresenceUi(mode);
      toast.show(`presence: ${mode}`, "ok", 1200);
    } catch (e) {
      toast.show(e.message || "presence failed", "err");
    }
  }

  dom.btnPresenceOnline?.addEventListener("click", () => setPresence("online"));
  dom.btnPresenceIdle?.addEventListener("click", () => setPresence("idle"));
  dom.btnPresenceDnd?.addEventListener("click", () => setPresence("dnd"));
  dom.btnPresenceInv?.addEventListener("click", () => setPresence("invisible"));

  // Login screen
  function setLoginMsg(msg, err = false) {
    if (!dom.loginMsg) return;
    dom.loginMsg.textContent = msg;
    dom.loginMsg.style.color = err ? "rgba(255,92,122,.95)" : "";
  }

  function showLogin() {
    dom.app.style.display = "none";
    dom.loginWrap.style.display = "flex";
    hideLoading();
    applyCursorMode();

    if (!state.ui.firstJoinShown) {
      state.ui.firstJoinShown = true;
      localSet("tk_firstJoinShown", true);

      openModal(
        "Welcome to tonkotsu.online (beta)",
        `<div style="color:rgba(154,163,183,.86);font-size:13px;line-height:1.55">
          This is a beta build. Features may change and bugs can happen.<br><br>
          If the server assigns it, you’ll see an <b>Early Access</b> badge on your account.
        </div>`,
        []
      );
    }
  }

  function showApp() {
    dom.loginWrap.style.display = "none";
    dom.app.style.display = "block";
    applyCursorMode();
  }

  async function doLogin(username, password) {
    setLoginMsg("Signing in…");
    try {
      const r = await api("/api/auth/login", { method: "POST", body: { username, password } });
      if (!r?.ok || !r.token) throw new Error(r?.error || "Login failed");
      state.session.token = r.token;
      state.session.user = r.user;
      localSet("tk_token", r.token);
      localSet("tk_user", r.user);
      await afterAuth();
    } catch (e) {
      setLoginMsg(e.message || "Login failed", true);
      toast.show("Sign-in failed.", "err");
    }
  }

  async function doGuest() {
    setLoginMsg("Starting guest…");
    try {
      const r = await api("/api/auth/guest", { method: "POST", body: {} });
      if (!r?.ok || !r.token) throw new Error(r?.error || "Guest failed");
      state.session.token = r.token;
      state.session.user = r.user;
      localSet("tk_token", r.token);
      localSet("tk_user", r.user);
      await afterAuth();
    } catch (e) {
      setLoginMsg(e.message || "Guest failed", true);
      toast.show("Guest sign-in failed.", "err");
    }
  }

  async function doLogout() {
    try { await api("/api/auth/logout", { method: "POST" }).catch(() => {}); } finally {
      try { state.socket?.removeAllListeners?.(); state.socket?.disconnect?.(); } catch {}
      state.socket = null;

      state.session.token = null;
      state.session.user = null;
      localSet("tk_token", null);
      localSet("tk_user", null);

      state.data.me = null;
      state.data.threads = {};
      state.data.friends = [];
      state.data.groups = [];
      state.ui.activeThread = "global";
      state.ui.cooldown = { until: 0, durationMs: 0 };
      state.ui.onlineUsers = [];

      showLogin();
    }
  }

  dom.btnLogin?.addEventListener("click", () => doLogin(dom.loginUser.value.trim(), dom.loginPass.value));
  dom.btnGuest?.addEventListener("click", () => doGuest());
  dom.loginPass?.addEventListener("keydown", (e) => { if (e.key === "Enter") dom.btnLogin.click(); });
  dom.btnLogout?.addEventListener("click", doLogout);

  // Threads
  function ensureThread(threadKey, meta) {
    if (!state.data.threads[threadKey]) state.data.threads[threadKey] = { ...meta, messages: [], cursor: null, hasMore: true };
    return state.data.threads[threadKey];
  }

  function formatThreadName(t) {
    if (t.kind === "global") return "Global";
    if (t.kind === "dm") return `@${t.name}`;
    if (t.kind === "group") return `#${t.name}`;
    return t.name || "Thread";
  }

  function lastMsgPreview(thread) {
    const m = thread.messages?.[thread.messages.length - 1];
    return m ? safe(m.text).slice(0, 80) : "No messages yet.";
  }

  function renderThreadList() {
    const q = dom.searchThreads?.value.trim().toLowerCase() || "";
    const keys = Object.keys(state.data.threads);

    const sorted = keys.sort((a, b) => {
      const A = state.data.threads[a], B = state.data.threads[b];
      const pr = (t) => (t.kind === "global" ? 0 : t.kind === "dm" ? 1 : 2);
      const pa = pr(A) - pr(B);
      if (pa) return pa;
      return formatThreadName(A).localeCompare(formatThreadName(B));
    });

    const frag = document.createDocumentFragment();
    for (const k of sorted) {
      const t = state.data.threads[k];
      const name = formatThreadName(t);
      if (q && !name.toLowerCase().includes(q)) continue;

      const el = document.createElement("div");
      el.className = "thread" + (state.ui.activeThread === k ? " active" : "");
      el.innerHTML = `
        <div class="threadTop">
          <div class="threadName">${esc(name)}</div>
          <div class="threadMeta">${esc(t.kind)}</div>
        </div>
        <div class="threadLast">${esc(lastMsgPreview(t))}</div>
      `;
      el.addEventListener("click", () => {
        state.ui.activeThread = k;
        renderThreadList();
        renderMessages(k);
      });
      frag.appendChild(el);
    }
    dom.threadList.innerHTML = "";
    dom.threadList.appendChild(frag);
  }

  function setCenterHeaderFromThread(threadKey) {
    const t = state.data.threads[threadKey];
    if (!t) return;
    dom.centerH.textContent = formatThreadName(t);
    dom.centerS.textContent = t.kind === "global" ? "Public chat" : (t.kind === "dm" ? "Direct message" : "Group chat");
  }

  function openProfile(user) {
    if (!user) return;
    const created = user.createdAt ? new Date(user.createdAt).toLocaleString() : "—";
    const lastSeen = user.lastSeen ? new Date(user.lastSeen).toLocaleString() : "—";
    const bio = user.bio ? esc(user.bio) : `<span style="color:rgba(154,163,183,.75)">No bio.</span>`;
    openModal(
      user.username || "Profile",
      `<div style="display:flex;flex-direction:column;gap:12px">
        <div>
          <div style="font-weight:900;margin-bottom:6px">Bio</div>
          <div style="color:rgba(235,240,255,.92);line-height:1.5">${bio}</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div style="border:1px solid rgba(140,160,200,.18);border-radius:14px;padding:10px;background:rgba(12,14,20,.55)">
            <div style="font-weight:900;font-size:12px;color:rgba(235,240,255,.92)">Created</div>
            <div style="margin-top:6px;color:rgba(154,163,183,.86);font-size:12px">${esc(created)}</div>
          </div>
          <div style="border:1px solid rgba(140,160,200,.18);border-radius:14px;padding:10px;background:rgba(12,14,20,.55)">
            <div style="font-weight:900;font-size:12px;color:rgba(235,240,255,.92)">Last seen</div>
            <div style="margin-top:6px;color:rgba(154,163,183,.86);font-size:12px">${esc(lastSeen)}</div>
          </div>
        </div>
      </div>`,
      []
    );
  }
  dom.btnUser?.addEventListener("click", () => openProfile(state.session.user));

  // Messages render + context menu
  function openMessageContextMenu(x, y, threadKey, m) {
    closeCtx();

    const mine =
      (m.user?.id && state.session.user?.id && m.user.id === state.session.user.id) ||
      (m.user?.username && state.session.user?.username && m.user.username === state.session.user.username);

    const age = now() - (m.ts || 0);
    const canEdit = mine && age <= 60_000;

    const items = [];
    if (canEdit) {
      items.push({ label: "Edit (1 min)", danger: false, onClick: () => { closeCtx(); promptEdit(m); } });
      items.push({ label: "Delete (1 min)", danger: true, onClick: () => { closeCtx(); promptDelete(m); } });
    }
    items.push({ label: "Report", danger: true, onClick: () => { closeCtx(); promptReport(m); } });

    dom.ctx.innerHTML = items.map((it, i) => `
      <div class="ctxItem ${it.danger ? "danger" : ""}" data-i="${i}">
        <span>${esc(it.label)}</span>
        <small>${it.danger ? "!" : ""}</small>
      </div>
    `).join("");

    $$(".ctxItem", dom.ctx).forEach((node) => {
      const i = Number(node.dataset.i);
      node.addEventListener("click", () => items[i].onClick());
    });

    const vw = innerWidth, vh = innerHeight;
    const w = 240, h = items.length * 44;
    const px = Math.max(10, Math.min(vw - w - 10, x));
    const py = Math.max(10, Math.min(vh - h - 10, y));
    dom.ctx.style.left = px + "px";
    dom.ctx.style.top = py + "px";
    dom.ctx.classList.add("show");
    state.ui.ctx.open = true;
    state.ui.ctx.threadKey = threadKey;
    state.ui.ctx.msgId = m.id;
  }

  function renderMessages(threadKey) {
    const t = state.data.threads[threadKey];
    if (!t) return;

    setCenterHeaderFromThread(threadKey);
    dom.centerBody.innerHTML = "";

    if (!t.messages.length) {
      dom.centerBody.innerHTML = `<div class="msg"><div class="msgBody">No messages. Send the first message.</div></div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    for (const m of t.messages) {
      const el = document.createElement("div");
      el.className = "msg";
      el.dataset.id = m.id;

      const uname = esc(m.user?.username || "user");
      const time = (() => {
        try {
          const d = new Date(m.ts || now());
          return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        } catch { return "--:--"; }
      })();

      const chips = [];
      if (m.kind === "announcement") chips.push(`<span class="chip ann">ANNOUNCEMENT</span>`);
      if (m.pending) chips.push(`<span class="chip">sending</span>`);
      if (m.failed) chips.push(`<span class="chip err">failed</span>`);
      if (m.editedAt) chips.push(`<span class="chip">edited</span>`);

      const color = m.user?.color || "#dfe6ff";

      el.innerHTML = `
        <div class="msgTop">
          <div class="msgUser" style="color:${esc(color)}">${uname}</div>
          <div class="msgTime">${esc(time)}</div>
        </div>
        <div class="msgBody">${esc(m.text)}</div>
        <div class="chips">${chips.join("")}</div>
      `;

      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openMessageContextMenu(e.clientX, e.clientY, threadKey, m);
      });

      el.addEventListener("click", () => openProfile(m.user));
      frag.appendChild(el);
    }

    dom.centerBody.appendChild(frag);
    dom.centerBody.scrollTop = dom.centerBody.scrollHeight;
  }

  // Edit/Delete/Report modals
  function promptEdit(m) {
    openModal(
      "Edit message",
      `<div style="color:rgba(154,163,183,.86);font-size:13px;margin-bottom:10px">Edits allowed within 1 minute.</div>
       <textarea id="editText" class="input" rows="4">${esc(m.text || "")}</textarea>`,
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Save", kind: "primary", onClick: async () => {
          const text = ($("#editText")?.value || "").trim();
          if (!text) return;
          await editMessage(m.id, text);
          closeModal();
        }},
      ]
    );
  }

  function promptDelete(m) {
    openModal(
      "Delete message",
      `<div style="color:rgba(154,163,183,.86);font-size:13px">Delete this message? (1 minute window)</div>`,
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Delete", kind: "danger", onClick: async () => {
          await deleteMessage(m.id);
          closeModal();
        }},
      ]
    );
  }

  function promptReport(m) {
    openModal(
      "Report message",
      `<div style="color:rgba(154,163,183,.86);font-size:13px;margin-bottom:10px">
        This sends a report to the moderation bot.
       </div>
       <input id="reportReason" class="input" placeholder="Reason (optional)" />`,
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Report", kind: "danger", onClick: async () => {
          const reason = ($("#reportReason")?.value || "").trim();
          await reportMessage(m.id, reason);
          closeModal();
        }},
      ]
    );
  }

  // Thread key helpers
  function activeThreadInfo() {
    const key = state.ui.activeThread;
    if (key === "global") return { kind: "global", id: null };
    if (key.startsWith("dm:")) return { kind: "dm", id: key.slice(3) };
    if (key.startsWith("group:")) return { kind: "group", id: key.slice(6) };
    return { kind: "global", id: null };
  }

  // Sending (idempotent + cooldown)
  async function sendMessage() {
    const text = (dom.msgInput?.value || "").trim();
    if (!text) return;

    if (inCooldown()) {
      flashCooldownViolation();
      toast.show("Cooldown active.", "warn", 1200);
      return;
    }
    if (state.ui.sendingLock) return;
    state.ui.sendingLock = true;

    const { kind, id } = activeThreadInfo();
    const clientId = uid("c");
    state.ui.sendDedupe.set(clientId, now());

    const t = state.data.threads[state.ui.activeThread];
    const localId = uid("m");
    t.messages.push({ id: localId, ts: now(), text, user: state.session.user, pending: true });
    dom.msgInput.value = "";
    renderMessages(state.ui.activeThread);

    const attempt = async (n) => {
      try {
        const r = await api("/api/messages/send", {
          method: "POST",
          body: { scope: kind, targetId: id, text, clientId },
        });

        if (r?.cooldownUntil) setCooldown(r.cooldownUntil, r.cooldownMs || 0);

        // deduped means server already got it; just mark local as sent
        if (r?.deduped) {
          const msg = t.messages.find(x => x.id === localId);
                    if (msg) {
            msg.pending = false;
            msg.failed = false;
          }
          state.ui.sendingLock = false;
          renderMessages(state.ui.activeThread);
          return true;
        }

        if (r?.ok && r.message) {
          // Replace optimistic local message with real one
          const idx = t.messages.findIndex((x) => x.id === localId);
          if (idx >= 0) t.messages[idx] = r.message;
          else t.messages.push(r.message);
          state.ui.sendingLock = false;
          renderMessages(state.ui.activeThread);
          return true;
        }

        throw new Error(r?.error || "Send failed");
      } catch (e) {
        const status = e?.status || 0;
        const transient = status === 0 || status === 502 || status === 503 || status === 504;

        if (status === 429 && e?.data?.cooldownUntil) {
          setCooldown(e.data.cooldownUntil, e.data.cooldownMs || 0);
          flashCooldownViolation();
          toast.show("Cooldown active.", "warn", 1200);
        }

        if (transient && n < 2) {
          await sleep(300 * (n + 1));
          return attempt(n + 1);
        }

        // mark failed
        const msg = t.messages.find((x) => x.id === localId);
        if (msg) {
          msg.pending = false;
          msg.failed = true;
        }
        toast.show(e.message || "Message failed.", "err", 1800);
        state.ui.sendingLock = false;
        renderMessages(state.ui.activeThread);
        return false;
      }
    };

    await attempt(0);
  }

  dom.btnSend?.addEventListener("click", sendMessage);
  dom.msgInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // -----------------------------
  // Edit/Delete/Report API calls
  // -----------------------------
  async function editMessage(messageId, text) {
    try {
      const r = await api("/api/messages/edit", { method: "POST", body: { messageId, text } });
      if (!r?.ok || !r.message) throw new Error(r?.error || "Edit failed");
      // update locally everywhere
      for (const th of Object.values(state.data.threads)) {
        const idx = th.messages.findIndex((m) => m.id === messageId);
        if (idx >= 0) th.messages[idx] = r.message;
      }
      renderMessages(state.ui.activeThread);
      toast.show("Edited.", "ok", 1000);
    } catch (e) {
      toast.show(e.message || "Edit failed.", "err", 1600);
    }
  }

  async function deleteMessage(messageId) {
    try {
      const r = await api("/api/messages/delete", { method: "POST", body: { messageId } });
      if (!r?.ok) throw new Error(r?.error || "Delete failed");
      // remove locally everywhere
      for (const th of Object.values(state.data.threads)) {
        const idx = th.messages.findIndex((m) => m.id === messageId);
        if (idx >= 0) th.messages.splice(idx, 1);
      }
      renderMessages(state.ui.activeThread);
      toast.show("Deleted.", "ok", 1000);
    } catch (e) {
      toast.show(e.message || "Delete failed.", "err", 1600);
    }
  }

  async function reportMessage(messageId, reason) {
    try {
      const r = await api("/api/messages/report", { method: "POST", body: { messageId, reason } });
      if (!r?.ok) throw new Error(r?.error || "Report failed");
      toast.show("Reported.", "ok", 1200);
    } catch (e) {
      toast.show(e.message || "Report failed.", "err", 1600);
    }
  }

  // -----------------------------
  // Friends + Groups UI actions
  // -----------------------------
  async function addFriendFlow() {
    openModal(
      "Add friend",
      `<div style="color:rgba(154,163,183,.86);font-size:13px;margin-bottom:10px">Type a username to add.</div>
       <input id="addFriendName" class="input" placeholder="username" />`,
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Add", kind: "primary", onClick: async () => {
          const username = ($("#addFriendName")?.value || "").trim();
          if (!username) return;
          try {
            const r = await api("/api/friends/add", { method: "POST", body: { username } });
            if (!r?.ok) throw new Error(r?.error || "Add failed");
            toast.show("Friend added.", "ok", 1200);
            closeModal();
            await bootstrap();
          } catch (e) {
            toast.show(e.message || "Add friend failed.", "err", 1600);
          }
        }},
      ]
    );
  }

  async function createGroupFlow() {
    openModal(
      "Create group chat",
      `<div style="display:flex;flex-direction:column;gap:10px">
        <div style="color:rgba(154,163,183,.86);font-size:13px">Create a new group and invite people later.</div>
        <input id="groupName" class="input" placeholder="Group name" />
        <input id="groupCd" class="input" placeholder="Cooldown seconds (default 3)" />
      </div>`,
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Create", kind: "primary", onClick: async () => {
          const name = ($("#groupName")?.value || "").trim();
          const cd = Number(($("#groupCd")?.value || "3").trim() || 3);
          if (!name) return;
          try {
            const r = await api("/api/groups/create", { method: "POST", body: { name, cooldownSeconds: cd } });
            if (!r?.ok || !r.group) throw new Error(r?.error || "Create failed");
            toast.show("Group created.", "ok", 1200);
            closeModal();
            await bootstrap();
          } catch (e) {
            toast.show(e.message || "Create group failed.", "err", 1600);
          }
        }},
      ]
    );
  }

  dom.btnAddFriend?.addEventListener("click", addFriendFlow);
  dom.btnNewGroup?.addEventListener("click", createGroupFlow);

  // -----------------------------
  // Online users panel (compact)
  // -----------------------------
  function renderOnlinePanel() {
    const users = state.ui.onlineUsers || [];
    if (dom.onlineCount) dom.onlineCount.textContent = String(users.length);

    // compact list (no repeating headers)
    const rows = users.slice(0, 60).map(u => {
      const mode = u.mode || "online";
      const dot = mode === "idle" ? "idle" : mode === "dnd" ? "dnd" : mode === "invisible" ? "inv" : "on";
      return `
        <div class="ouRow">
          <span class="pDot ${dot}"></span>
          <span class="ouName">${esc(u.username || "user")}</span>
        </div>
      `;
    }).join("");

    dom.onlineUsers.innerHTML = rows || `<div class="ouEmpty">No users online.</div>`;
  }

  // -----------------------------
  // Bootstrap + socket wiring
  // -----------------------------
  async function bootstrap() {
    showLoading("Loading…", "bootstrap");
    const r = await api("/api/state/bootstrap", { method: "GET" });

    if (!r?.ok) throw new Error(r?.error || "bootstrap failed");

    state.data.me = r.me;
    state.session.user = r.me;
    localSet("tk_user", r.me);

    // threads reset
    state.data.threads = {};

    // global
    ensureThread("global", { kind: "global", name: "Global", id: null });
    state.data.threads.global.messages = Array.isArray(r.global?.messages) ? r.global.messages : [];

    // friends -> DM threads
    state.data.friends = Array.isArray(r.friends) ? r.friends : [];
    for (const f of state.data.friends) {
      ensureThread(`dm:${f.id}`, { kind: "dm", name: f.username, id: f.id });
      // messages empty initially, will be live via socket
    }

    // groups -> group threads
    state.data.groups = Array.isArray(r.groups) ? r.groups : [];
    for (const g of state.data.groups) {
      const key = `group:${g.id}`;
      ensureThread(key, { kind: "group", name: g.name, id: g.id, cooldownSeconds: g.cooldownSeconds || 3 });
      state.data.threads[key].messages = Array.isArray(g.messages) ? g.messages : [];
    }

    // ensure active thread exists
    if (!state.data.threads[state.ui.activeThread]) state.ui.activeThread = "global";

    renderThreadList();
    renderMessages(state.ui.activeThread);

    // presence UI
    setPresenceUi(state.session.user?.mode || "online");

    hideLoading();
  }

  async function afterAuth() {
    showApp();
    await bootstrap();
    connectSocket();
  }

  function connectSocket() {
    if (!window.io) {
      toast.show("socket.io missing", "err");
      return;
    }
    if (state.socket) {
      try { state.socket.disconnect(); } catch {}
    }

    const sock = window.io({
      transports: ["websocket", "polling"],
      auth: { token: state.session.token },
    });
    state.socket = sock;

    sock.on("connect", () => {
      toast.show("Connected.", "ok", 800);
    });

    sock.on("disconnect", () => {
      toast.show("Disconnected.", "warn", 1200);
    });

    // new message
    sock.on("message:new", (msg) => {
      if (!msg) return;

      // ensure thread exists
      if (msg.scope === "global") {
        const t = state.data.threads.global;
        if (!t) return;
        t.messages.push(msg);
        t.messages = t.messages.slice(-500);
        if (state.ui.activeThread === "global") renderMessages("global");
        renderThreadList();
        return;
      }

      if (msg.scope === "dm") {
        const peerId = msg.targetId;
        // dm messages arrive with targetId = peerId for sender, but for receiver it may be sender id; handle both:
        const meId = state.session.user?.id;
        const otherId = msg.user?.id === meId ? peerId : msg.user?.id;
        const key = `dm:${otherId}`;
        ensureThread(key, { kind: "dm", name: msg.user?.username || "DM", id: otherId });
        const t = state.data.threads[key];
        t.messages.push(msg);
        t.messages = t.messages.slice(-500);
        if (state.ui.activeThread === key) renderMessages(key);
        renderThreadList();
        return;
      }

      if (msg.scope === "group") {
        const key = `group:${msg.targetId}`;
        const t = state.data.threads[key];
        if (!t) return;
        t.messages.push(msg);
        t.messages = t.messages.slice(-700);
        if (state.ui.activeThread === key) renderMessages(key);
        renderThreadList();
      }
    });

    sock.on("message:edit", (msg) => {
      if (!msg?.id) return;
      for (const th of Object.values(state.data.threads)) {
        const idx = th.messages.findIndex((m) => m.id === msg.id);
        if (idx >= 0) th.messages[idx] = msg;
      }
      renderMessages(state.ui.activeThread);
      renderThreadList();
    });

    sock.on("message:delete", (payload) => {
      const mid = payload?.messageId;
      if (!mid) return;
      for (const th of Object.values(state.data.threads)) {
        const idx = th.messages.findIndex((m) => m.id === mid);
        if (idx >= 0) th.messages.splice(idx, 1);
      }
      renderMessages(state.ui.activeThread);
      renderThreadList();
    });

    sock.on("users:online", (payload) => {
      const list = Array.isArray(payload?.users) ? payload.users : [];
      state.ui.onlineUsers = list;
      renderOnlinePanel();
    });

    sock.on("groups:update", (payload) => {
      // simplest: re-bootstrap to sync groups
      bootstrap().catch(() => {});
    });

    sock.on("report:new", () => {
      // admins only would care; still toast for you
      toast.show("New report received.", "warn", 1400);
    });
  }

  // -----------------------------
  // Initial start
  // -----------------------------
  (async () => {
    // if token exists, try auto-boot, else show login
    if (state.session.token) {
      try {
        showApp();
        await bootstrap();
        connectSocket();
        return;
      } catch (e) {
        // token bad; reset
        state.session.token = null;
        state.session.user = null;
        localSet("tk_token", null);
        localSet("tk_user", null);
        showLogin();
        return;
      }
    }
    showLogin();
  })();
})();
