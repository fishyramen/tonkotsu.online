/* public/script.js — tonkotsu.online
   Front-end controller:
   - Black theme enforced via CSS (already in index.html)
   - Login/Create account (first login creates) + Guest
   - Quick loading screen after auth
   - Custom cursor enabled by default (bigger + dynamic hover/click)
   - Buttons work (tabs, send, logout, reconnect, status)
   - Socket.IO real-time chat (global + basic inbox stub + settings stub)
*/

/* global io */

(() => {
  "use strict";

  // =========================
  // Small utilities
  // =========================
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const nowISO = () => new Date().toISOString();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function safeJsonParse(str, fallback = null) {
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }

  function randomId(prefix = "id") {
    return (
      prefix +
      "_" +
      Math.random().toString(36).slice(2) +
      "_" +
      Date.now().toString(36)
    );
  }

  function normalizeUsername(u) {
    const s = (u || "").trim();
    // allow letters/numbers/_/-
    const cleaned = s.replace(/[^\w-]/g, "");
    return cleaned.slice(0, 20);
  }

  function validateUsername(u) {
    const s = normalizeUsername(u);
    if (s.length < 4 || s.length > 20) return { ok: false, msg: "Username must be 4–20 letters/numbers." };
    if (!/^[A-Za-z0-9_-]+$/.test(s)) return { ok: false, msg: "Username may only contain letters/numbers/_/-." };
    return { ok: true, value: s };
  }

  function validatePassword(pw) {
    const s = (pw || "").toString();
    if (s.length < 4) return { ok: false, msg: "Password must be at least 4 characters." };
    if (s.length > 72) return { ok: false, msg: "Password is too long." };
    return { ok: true, value: s };
  }

  // =========================
  // Toast system (non-blocking)
  // =========================
  const Toasts = (() => {
    const wrap = $("#toastWrap");
    if (!wrap) return { show: () => {} };

    function show(msg, ttl = 2400) {
      const el = document.createElement("div");
      el.className = "toast";
      el.textContent = msg;
      wrap.appendChild(el);
      setTimeout(() => {
        try {
          el.remove();
        } catch {}
      }, ttl);
    }

    return { show };
  })();

  // =========================
  // Loading screen controller
  // =========================
  const Loading = (() => {
    const view = $("#loadingView");
    const bar = $("#loadBar");
    const title = $("#loadTitle");
    const sub = $("#loadSub");

    let t0 = 0;
    let raf = 0;
    let target = 0;

    function setText(t, s) {
      if (title) title.textContent = t || "Loading…";
      if (sub) sub.textContent = s || "Preparing…";
    }

    function setProgress(pct) {
      const p = clamp(pct, 0, 100);
      target = p;
    }

    function tick() {
      if (!bar) return;
      const cur = parseFloat(bar.style.width || "0") || 0;
      const next = cur + (target - cur) * 0.14; // easing
      bar.style.width = `${next.toFixed(2)}%`;
      raf = requestAnimationFrame(tick);
    }

    function show({ title: t, sub: s, initial = 3 } = {}) {
      t0 = performance.now();
      setText(t, s);
      setProgress(initial);
      if (view) view.classList.add("show");
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    }

    function hide() {
      cancelAnimationFrame(raf);
      if (view) view.classList.remove("show");
      if (bar) bar.style.width = "0%";
      target = 0;
      t0 = 0;
    }

    async function runQuickSequence() {
      // A quick, smooth sequence that still looks “real”
      show({
        title: "Signing you in…",
        sub: "Establishing a secure session and connecting to chat servers.",
        initial: 8,
      });
      setProgress(25);
      await sleep(180);
      setText("Syncing…", "Loading rooms, messages, and online presence.");
      setProgress(55);
      await sleep(180);
      setText("Almost ready…", "Finalizing UI and restoring your last view.");
      setProgress(82);
      await sleep(180);
      setProgress(100);
      await sleep(120);
      hide();
    }

    return { show, hide, setProgress, setText, runQuickSequence };
  })();

  // =========================
  // Custom cursor (default ON)
  // - bigger base size already in CSS
  // - dynamic reactions to hover/click/typing
  // =========================
  const Cursor = (() => {
    const cur = $("#cursor");
    const dot = $("#cursorDot");

    // If elements are missing, quietly no-op
    if (!cur || !dot) return { init: () => {} };

    const state = {
      x: window.innerWidth * 0.5,
      y: window.innerHeight * 0.5,
      tx: window.innerWidth * 0.5,
      ty: window.innerHeight * 0.5,
      dx: 0,
      dy: 0,
      speed: 0,
      hovering: false,
      down: false,
      typing: false,
      raf: 0,
      enabled: true,
    };

    function setScale(el, s) {
      el.style.transform = `translate(-50%, -50%) scale(${s})`;
    }

    function apply() {
      // Smooth follow
      const ax = 0.22;
      const ay = 0.22;
      state.x += (state.tx - state.x) * ax;
      state.y += (state.ty - state.y) * ay;

      // Velocity approx
      const vx = state.tx - state.x;
      const vy = state.ty - state.y;
      state.speed = Math.sqrt(vx * vx + vy * vy);

      // Position
      cur.style.left = `${state.x}px`;
      cur.style.top = `${state.y}px`;
      dot.style.left = `${state.tx}px`;
      dot.style.top = `${state.ty}px`;

      // Dynamics: scale based on hover/click/speed/typing
      let base = 1.0;
      if (state.hovering) base = 1.35;
      if (state.typing) base = 1.15;
      if (state.down) base = 0.9;

      // Speed adds subtle “stretch”
      const sp = clamp(state.speed / 25, 0, 1);
      const scale = base + sp * 0.15;

      setScale(cur, scale);
      setScale(dot, 1.0 + (state.down ? -0.2 : 0) + (state.hovering ? 0.1 : 0));

      // Glow intensity
      const glow = 0.12 + (state.hovering ? 0.20 : 0) + sp * 0.10;
      cur.style.boxShadow = `0 0 ${18 + sp * 14}px rgba(122, 92, 255, ${glow})`;

      state.raf = requestAnimationFrame(apply);
    }

    function onMove(e) {
      state.tx = e.clientX;
      state.ty = e.clientY;
    }

    function onDown() {
      state.down = true;
      setTimeout(() => (state.down = false), 120);
    }

    function bindHoverTargets() {
      // Buttons + links + clickable elements
      const hoverSelectors = [
        "button",
        "a",
        "[role='button']",
        ".tabBtn",
        ".btn",
        ".sendBtn",
        ".smallBtn",
        ".smallLink",
        "input",
        "textarea",
        "select",
      ];

      // Use event delegation for efficiency
      document.addEventListener(
        "mouseover",
        (e) => {
          const t = e.target;
          if (!t || !(t instanceof Element)) return;
          state.hovering = hoverSelectors.some((s) => t.matches(s) || t.closest(s));
        },
        true
      );
      document.addEventListener(
        "mouseout",
        () => {
          state.hovering = false;
        },
        true
      );

      document.addEventListener(
        "focusin",
        (e) => {
          const t = e.target;
          if (!t || !(t instanceof Element)) return;
          if (t.matches("input,textarea")) state.typing = true;
        },
        true
      );
      document.addEventListener(
        "focusout",
        (e) => {
          const t = e.target;
          if (!t || !(t instanceof Element)) return;
          if (t.matches("input,textarea")) state.typing = false;
        },
        true
      );
    }

    function init() {
      // Enabled by default (body already has cursor-on in index.html)
      state.enabled = true;

      window.addEventListener("mousemove", onMove, { passive: true });
      window.addEventListener("mousedown", onDown, { passive: true });

      // touch devices: let system cursor
      const isTouch = matchMedia("(pointer: coarse)").matches;
      if (isTouch) {
        document.body.classList.remove("cursor-on");
        cur.style.display = "none";
        dot.style.display = "none";
        return;
      }

      bindHoverTargets();
      cancelAnimationFrame(state.raf);
      state.raf = requestAnimationFrame(apply);
    }

    return { init };
  })();

  // =========================
  // API Client (REST)
  // You can back this with:
  // POST /api/auth/login {username,password} -> {ok, token, me}
  // POST /api/auth/guest {username?} -> {ok, token, me}
  // POST /api/auth/logout -> {ok}
  // GET  /api/me -> {ok, me}
  // =========================
  const Api = (() => {
    const base = ""; // same origin
    const LS_TOKEN = "tk_token_v1";
    const LS_ME = "tk_me_v1";

    function getToken() {
      return localStorage.getItem(LS_TOKEN) || "";
    }
    function setToken(t) {
      if (t) localStorage.setItem(LS_TOKEN, t);
      else localStorage.removeItem(LS_TOKEN);
    }
    function setMe(me) {
      if (me) localStorage.setItem(LS_ME, JSON.stringify(me));
      else localStorage.removeItem(LS_ME);
    }
    function getMe() {
      return safeJsonParse(localStorage.getItem(LS_ME) || "", null);
    }

    async function req(path, { method = "GET", body = null, token = getToken() } = {}) {
      const headers = {
        "Content-Type": "application/json",
      };
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(base + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : null,
      });

      const text = await res.text();
      const json = safeJsonParse(text, null);

      // If server returns non-json, still surface it.
      if (!json) {
        return { ok: false, status: res.status, raw: text || "", error: "Invalid server response." };
      }
      return { status: res.status, ...json };
    }

    async function loginOrCreate(username, password) {
      return req("/api/auth/login", { method: "POST", body: { username, password } });
    }

    async function guest(username) {
      return req("/api/auth/guest", { method: "POST", body: { username } });
    }

    async function logout() {
      return req("/api/auth/logout", { method: "POST" });
    }

    async function me() {
      return req("/api/me", { method: "GET" });
    }

    return {
      getToken,
      setToken,
      getMe,
      setMe,
      loginOrCreate,
      guest,
      logout,
      me,
      req,
    };
  })();

  // =========================
  // Socket client + protocol
  // Expected events (server):
  // - connect / disconnect
  // - "presence" { online }
  // - "room:history" { room, messages[] }
  // - "room:msg" { room, msg }
  //
  // Client emits:
  // - "auth" { token } -> ack { ok, me }
  // - "room:join" { room } -> ack { ok, history? }
  // - "room:send" { room, text, clientId } -> ack { ok, msg }
  // =========================
  const Realtime = (() => {
    let socket = null;
    let authed = false;
    let me = null;

    const listeners = new Map(); // event -> Set(fn)
    function on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return () => listeners.get(evt)?.delete(fn);
    }
    function emitLocal(evt, payload) {
      const set = listeners.get(evt);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(payload);
        } catch (e) {
          console.error(e);
        }
      }
    }

    function ensureSocket() {
      if (socket) return socket;

      if (typeof io !== "function") {
        emitLocal("error", { message: "Socket.IO not loaded. Is the server running?" });
        return null;
      }

      socket = io({
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 400,
        reconnectionDelayMax: 2400,
        timeout: 8000,
      });

      socket.on("connect", () => emitLocal("connect", {}));
      socket.on("disconnect", (reason) => {
        authed = false;
        emitLocal("disconnect", { reason });
      });

      socket.on("presence", (p) => emitLocal("presence", p));
      socket.on("room:history", (p) => emitLocal("room:history", p));
      socket.on("room:msg", (p) => emitLocal("room:msg", p));
      socket.on("server:toast", (p) => emitLocal("server:toast", p));

      socket.on("connect_error", (err) => {
        emitLocal("error", { message: err?.message || "Connection error." });
      });

      return socket;
    }

    async function authWithToken(token) {
      const s = ensureSocket();
      if (!s) return { ok: false, error: "Socket not available." };

      return new Promise((resolve) => {
        const payload = { token: token || "" };
        s.emit("auth", payload, (ack) => {
          if (ack && ack.ok) {
            authed = true;
            me = ack.me || null;
            resolve({ ok: true, me });
          } else {
            authed = false;
            me = null;
            resolve({ ok: false, error: ack?.error || "Auth failed." });
          }
        });
      });
    }

    async function join(room) {
      const s = ensureSocket();
      if (!s) return { ok: false, error: "Socket not available." };
      return new Promise((resolve) => {
        s.emit("room:join", { room }, (ack) => {
          if (ack && ack.ok) resolve({ ok: true, history: ack.history || [] });
          else resolve({ ok: false, error: ack?.error || "Join failed." });
        });
      });
    }

    async function send(room, text, clientId) {
      const s = ensureSocket();
      if (!s) return { ok: false, error: "Socket not available." };
      return new Promise((resolve) => {
        s.emit("room:send", { room, text, clientId }, (ack) => {
          if (ack && ack.ok) resolve({ ok: true, msg: ack.msg || null });
          else resolve({ ok: false, error: ack?.error || "Send failed." });
        });
      });
    }

    function disconnect() {
      if (!socket) return;
      try {
        socket.disconnect();
      } catch {}
      socket = null;
      authed = false;
      me = null;
    }

    function isAuthed() {
      return authed;
    }

    function getMe() {
      return me;
    }

    return {
      on,
      authWithToken,
      join,
      send,
      disconnect,
      isAuthed,
      getMe,
    };
  })();

  // =========================
  // UI Controller + State Machine
  // =========================
  const App = (() => {
    // Views
    const authView = $("#authView");
    const shell = $("#shell");
    const feed = $("#feed");

    // Auth fields
    const inpUser = $("#username");
    const inpPass = $("#password");
    const btnLogin = $("#btnLogin");
    const btnGuest = $("#btnGuest");
    const btnStatus = $("#btnStatus");
    const authMsg = $("#authMsg");

    // Shell elements
    const meName = $("#meName");
    const meMeta = $("#meMeta");
    const roomTitle = $("#roomTitle");
    const roomMeta = $("#roomMeta");
    const onlinePill = $("#onlinePill");
    const globalCount = $("#globalCount");
    const inboxCount = $("#inboxCount");

    const tabGlobal = $("#tabGlobal");
    const tabInbox = $("#tabInbox");
    const tabSettings = $("#tabSettings");

    const btnLogout = $("#btnLogout");
    const btnPing = $("#btnPing");

    // Composer
    const composer = $("#composer");
    const btnSend = $("#btnSend");

    // State
    const state = {
      authed: false,
      me: null,
      room: "global",
      online: 0,
      rooms: {
        global: { messages: [], unread: 0, joined: false },
        inbox: { messages: [], unread: 0, joined: false }, // stub room for now
      },
      ui: {
        lastActive: "global",
      },
      sendLocks: new Map(), // clientId -> timestamp
    };

    function setAuthError(msg) {
      if (!authMsg) return;
      authMsg.className = "err";
      authMsg.textContent = msg || "";
    }
    function setAuthOk(msg) {
      if (!authMsg) return;
      authMsg.className = "ok";
      authMsg.textContent = msg || "";
    }

    function showAuth() {
      if (shell) shell.classList.remove("show");
      if (authView) authView.style.display = "grid";
      state.authed = false;
      state.me = null;
      if (roomTitle) roomTitle.textContent = "Global";
    }

    function showShell() {
      if (authView) authView.style.display = "none";
      if (shell) shell.classList.add("show");
    }

    function setMeUI(me) {
      const name = me?.username || "Guest";
      if (meName) meName.textContent = name;
      const lvl = me?.level ?? 1;
      const tag = me?.tag ? ` • ${me.tag}` : "";
      if (meMeta) meMeta.textContent = `LEVEL ${lvl}${tag}`;
    }

    function setOnline(n) {
      state.online = Number(n || 0);
      if (onlinePill) onlinePill.textContent = `ONLINE ${state.online}`;
      // also update meta line
      if (meMeta && state.me) {
        const lvl = state.me.level ?? 1;
        const tag = state.me.tag ? ` • ${state.me.tag}` : "";
        meMeta.textContent = `LEVEL ${lvl} • ONLINE ${state.online}${tag ? "" : ""}`.replace("• ONLINE", "• ONLINE");
      }
    }

    function setRoom(room) {
      state.room = room;
      state.ui.lastActive = room;

      // visual tabs
      [tabGlobal, tabInbox, tabSettings].forEach((b) => b && b.classList.remove("active"));

      if (room === "global") {
        tabGlobal && tabGlobal.classList.add("active");
        roomTitle && (roomTitle.textContent = "Global");
        roomMeta && (roomMeta.textContent = "Public room • Be respectful");
        renderRoom("global");
        // clear unread
        state.rooms.global.unread = 0;
        updateBadges();
      } else if (room === "inbox") {
        tabInbox && tabInbox.classList.add("active");
        roomTitle && (roomTitle.textContent = "Inbox");
        roomMeta && (roomMeta.textContent = "Private messages • (stub until server adds DM rooms)");
        renderRoom("inbox");
        state.rooms.inbox.unread = 0;
        updateBadges();
      } else if (room === "settings") {
        tabSettings && tabSettings.classList.add("active");
        roomTitle && (roomTitle.textContent = "Settings");
        roomMeta && (roomMeta.textContent = "Client preferences • Cursor is enabled by default");
        renderSettings();
      }
    }

    function updateBadges() {
      if (globalCount) {
        const c = state.rooms.global.messages.length;
        globalCount.textContent = c > 999 ? "999+" : String(c);
      }
      if (inboxCount) {
        const u = state.rooms.inbox.unread || 0;
        inboxCount.textContent = u > 99 ? "99+" : String(u);
      }
    }

    function mkMsgEl(msg, opts = {}) {
      const el = document.createElement("div");
      el.className = "msg" + (opts.system ? " sys" : "");

      const top = document.createElement("div");
      top.className = "msgTop";

      const u = document.createElement("div");
      u.className = "msgUser";
      u.textContent = opts.system ? "System" : (msg?.user || "Unknown");

      const t = document.createElement("div");
      t.className = "msgTime";
      t.textContent = msg?.ts ? formatTime(msg.ts) : formatTime(nowISO());

      top.appendChild(u);
      top.appendChild(t);

      const body = document.createElement("div");
      body.className = "msgText";
      body.textContent = (msg?.text || "").toString();

      el.appendChild(top);
      el.appendChild(body);
      return el;
    }

    function formatTime(ts) {
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return "";
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    }

    function renderRoom(room) {
      if (!feed) return;
      feed.innerHTML = "";
      const list = state.rooms[room]?.messages || [];

      if (!list.length) {
        const empty = mkMsgEl({ user: "System", ts: nowISO(), text: room === "inbox"
          ? "No messages yet. (Server needs DM rooms to fully enable Inbox.)"
          : "No messages yet. Say something in Global to start." }, { system: true });
        feed.appendChild(empty);
        return;
      }

      for (const m of list) {
        feed.appendChild(mkMsgEl(m, { system: m.system }));
      }
      // scroll down
      feed.scrollTop = feed.scrollHeight + 9999;
    }

    function renderSettings() {
      if (!feed) return;
      feed.innerHTML = "";

      const items = [
        {
          title: "Cursor",
          text:
            "Custom cursor is enabled by default. If you want a toggle later, add a button here and flip body.cursor-on.",
        },
        {
          title: "Theme",
          text: "Black-only theme enforced at the document level.",
        },
        {
          title: "Network",
          text:
            "Use Reconnect if messages stop. If Socket.IO is missing, start the server and reload.",
        },
      ];

      for (const it of items) {
        const el = mkMsgEl(
          {
            user: "System",
            ts: nowISO(),
            text: `${it.title}\n${it.text}`,
          },
          { system: true }
        );
        feed.appendChild(el);
      }
      feed.scrollTop = 0;
    }

    function addMessage(room, msg) {
      const r = state.rooms[room];
      if (!r) return;

      // Prevent duplicates (by id or clientId)
      const id = msg?.id || msg?.clientId || null;
      if (id) {
        const exists = r.messages.some((m) => (m.id && m.id === msg.id) || (m.clientId && m.clientId === msg.clientId));
        if (exists) return;
      }

      r.messages.push(msg);

      // cap messages for client memory
      if (r.messages.length > 400) r.messages.splice(0, r.messages.length - 400);

      // unread if not active
      if (state.room !== room && room !== "settings") {
        r.unread = (r.unread || 0) + 1;
      }

      updateBadges();

      // render if visible room
      if (state.room === room) {
        // if placeholder exists and first real message arrives, rerender
        if (feed && feed.children.length === 1 && feed.children[0].classList.contains("sys") && r.messages.length === 1) {
          renderRoom(room);
          return;
        }
        feed && feed.appendChild(mkMsgEl(msg, { system: msg.system }));
        if (feed) feed.scrollTop = feed.scrollHeight + 9999;
      }
    }

    function system(room, text) {
      addMessage(room, {
        id: randomId("sys"),
        user: "System",
        ts: nowISO(),
        text,
        system: true,
      });
    }

    // =========================
    // Auth + boot
    // =========================
    async function tryResume() {
      const token = Api.getToken();
      if (!token) return false;

      // Try /api/me first (fast check)
      let me = null;
      try {
        const r = await Api.me();
        if (r && r.ok) {
          me = r.me;
        }
      } catch {}

      // If /api/me fails, still try socket auth (some servers only do socket auth)
      Loading.show({ title: "Resuming session…", sub: "Reconnecting using your saved session.", initial: 10 });
      Loading.setProgress(35);

      const authRes = await Realtime.authWithToken(token);
      if (!authRes.ok) {
        Loading.hide();
        Api.setToken("");
        Api.setMe(null);
        return false;
      }

      me = me || authRes.me || Api.getMe() || null;
      if (me) Api.setMe(me);

      await Loading.runQuickSequence();
      await enterApp(me);
      return true;
    }

    async function enterApp(me) {
      state.authed = true;
      state.me = me || { username: "Guest", level: 1 };
      setMeUI(state.me);
      showShell();

      // Join global (and inbox stub)
      await ensureJoined("global");

      // initial render
      setRoom("global");

      Toasts.show("Connected.");
    }

    async function ensureJoined(room) {
      const r = state.rooms[room];
      if (!r) return;
      if (r.joined) return;

      const jr = await Realtime.join(room);
      if (jr.ok) {
        r.joined = true;
        // history can be provided via ack or via room:history event
        if (Array.isArray(jr.history) && jr.history.length) {
          for (const m of jr.history) addMessage(room, m);
        } else {
          system(room, room === "inbox"
            ? "Inbox connected. (Waiting for DM support on server.)"
            : "Joined Global.");
        }
      } else {
        system(room, `Could not join ${room}: ${jr.error || "unknown error"}`);
      }
    }

    async function doLoginCreate() {
      const u0 = inpUser?.value || "";
      const p0 = inpPass?.value || "";

      const u = validateUsername(u0);
      if (!u.ok) return setAuthError(u.msg);

      const p = validatePassword(p0);
      if (!p.ok) return setAuthError(p.msg);

      setAuthError("");
      Loading.show({ title: "Signing you in…", sub: "Creating your account if it does not exist.", initial: 10 });
      Loading.setProgress(22);

      let r;
      try {
        r = await Api.loginOrCreate(u.value, p.value);
      } catch (e) {
        Loading.hide();
        return setAuthError("Server not reachable. Start your backend and reload.");
      }

      if (!r || !r.ok) {
        Loading.hide();
        return setAuthError(r?.error || "Login failed.");
      }

      const token = r.token || "";
      const me = r.me || { username: u.value, level: 1 };

      if (!token) {
        Loading.hide();
        return setAuthError("Server did not return a session token.");
      }

      Api.setToken(token);
      Api.setMe(me);

      // Socket auth
      Loading.setProgress(48);
      const authRes = await Realtime.authWithToken(token);
      if (!authRes.ok) {
        Loading.hide();
        Api.setToken("");
        Api.setMe(null);
        return setAuthError(authRes.error || "Realtime auth failed.");
      }

      await Loading.runQuickSequence();
      await enterApp(authRes.me || me);
    }

    async function doGuest() {
      const u0 = normalizeUsername(inpUser?.value || "");
      const desired = u0.length >= 4 ? u0 : `guest${Math.floor(Math.random() * 9000 + 1000)}`;

      setAuthError("");
      Loading.show({ title: "Signing you in…", sub: "Creating a guest session.", initial: 10 });
      Loading.setProgress(20);

      let r;
      try {
        r = await Api.guest(desired);
      } catch {
        // If REST is not available, still allow “offline guest” for UI dev
        Loading.hide();
        setAuthOk("Guest mode (offline). Server endpoints missing — UI still loads.");
        Api.setToken("");
        Api.setMe({ username: desired, level: 1, tag: "GUEST" });
        // Enter app without socket
        showShell();
        state.authed = true;
        state.me = Api.getMe();
        setMeUI(state.me);
        system("global", "Offline guest mode. Start your backend to enable real-time chat.");
        setRoom("global");
        return;
      }

      if (!r || !r.ok) {
        Loading.hide();
        return setAuthError(r?.error || "Guest login failed.");
      }

      const token = r.token || "";
      const me = r.me || { username: desired, level: 1, tag: "GUEST" };

      Api.setToken(token);
      Api.setMe(me);

      Loading.setProgress(50);
      const authRes = await Realtime.authWithToken(token);
      if (!authRes.ok) {
        Loading.hide();
        Api.setToken("");
        Api.setMe(null);
        return setAuthError(authRes.error || "Realtime auth failed.");
      }

      await Loading.runQuickSequence();
      await enterApp(authRes.me || me);
    }

    async function doLogout() {
      Toasts.show("Logging out…");
      try {
        await Api.logout();
      } catch {}

      Api.setToken("");
      Api.setMe(null);

      // reset local room data
      state.rooms.global = { messages: [], unread: 0, joined: false };
      state.rooms.inbox = { messages: [], unread: 0, joined: false };
      state.room = "global";
      updateBadges();

      try {
        Realtime.disconnect();
      } catch {}

      showAuth();
      setAuthOk("Logged out.");
    }

    async function doReconnect() {
      Toasts.show("Reconnecting…");
      const token = Api.getToken();
      if (!token) {
        Toasts.show("No session token. Log in again.");
        return;
      }

      // Force re-auth
      const res = await Realtime.authWithToken(token);
      if (!res.ok) {
        Toasts.show("Reconnect failed. Log in again.");
        Api.setToken("");
        Api.setMe(null);
        showAuth();
        setAuthError("Session expired. Please log in again.");
        return;
      }

      // rejoin
      state.rooms.global.joined = false;
      state.rooms.inbox.joined = false;
      await ensureJoined("global");
      if (state.room === "inbox") await ensureJoined("inbox");

      Toasts.show("Reconnected.");
    }

    // =========================
    // Send message
    // =========================
    async function sendCurrent() {
      if (!state.authed) {
        Toasts.show("Log in first.");
        return;
      }
      if (!composer) return;
      const text = (composer.value || "").trim();
      if (!text) return;

      if (state.room === "settings") {
        Toasts.show("Settings is not a chat room.");
        return;
      }

      const room = state.room;

      // optimistic message
      const clientId = randomId("c");
      state.sendLocks.set(clientId, Date.now());

      const optimistic = {
        id: null,
        clientId,
        user: state.me?.username || "Me",
        ts: nowISO(),
        text,
      };

      addMessage(room, optimistic);
      composer.value = "";

      // if socket is not authed (offline guest), stop here
      if (!Realtime.isAuthed()) {
        system(room, "Message queued locally (offline). Start backend to enable realtime sending.");
        return;
      }

      const r = await Realtime.send(room, text, clientId);
      if (!r.ok) {
        system(room, `Send failed: ${r.error || "unknown error"}`);
        return;
      }

      // server-ack message may arrive via ack or via room:msg event
      if (r.msg) {
        // Replace optimistic (same clientId)
        const list = state.rooms[room].messages;
        const idx = list.findIndex((m) => m.clientId === clientId);
        if (idx >= 0) list[idx] = r.msg;
        renderRoom(room);
      }
    }

    // =========================
    // Wire realtime events -> UI
    // =========================
    function bindRealtime() {
      Realtime.on("connect", () => {
        Toasts.show("Socket connected.");
      });

      Realtime.on("disconnect", (p) => {
        Toasts.show(`Disconnected: ${p?.reason || "unknown"}`);
      });

      Realtime.on("presence", (p) => {
        if (typeof p?.online === "number") setOnline(p.online);
      });

      Realtime.on("room:history", (p) => {
        const room = p?.room;
        const msgs = p?.messages;
        if (!room || !Array.isArray(msgs)) return;
        for (const m of msgs) addMessage(room, m);
        if (state.room === room) renderRoom(room);
      });

      Realtime.on("room:msg", (p) => {
        const room = p?.room;
        const msg = p?.msg;
        if (!room || !msg) return;

        // If this message matches an optimistic one, replace it
        if (msg.clientId) {
          const list = state.rooms[room]?.messages || [];
          const idx = list.findIndex((m) => m.clientId && m.clientId === msg.clientId);
          if (idx >= 0) {
            list[idx] = msg;
            if (state.room === room) renderRoom(room);
            updateBadges();
            return;
          }
        }

        addMessage(room, msg);
      });

      Realtime.on("server:toast", (p) => {
        const m = p?.message || p?.msg;
        if (m) Toasts.show(String(m));
      });

      Realtime.on("error", (p) => {
        Toasts.show(p?.message || "Error.");
      });
    }

    // =========================
    // DOM events
    // =========================
    function bindDom() {
      // Auth: Enter key submits login
      const onKey = (e) => {
        if (e.key === "Enter") doLoginCreate();
      };
      inpUser && inpUser.addEventListener("keydown", onKey);
      inpPass && inpPass.addEventListener("keydown", onKey);

      btnLogin && btnLogin.addEventListener("click", doLoginCreate);
      btnGuest && btnGuest.addEventListener("click", doGuest);

      btnStatus &&
        btnStatus.addEventListener("click", async () => {
          // quick status ping
          try {
            const r = await Api.req("/api/status");
            if (r && r.ok) Toasts.show(r.message || "Server OK.");
            else Toasts.show(r?.error || "Status endpoint not available.");
          } catch {
            Toasts.show("Server not reachable.");
          }
        });

      tabGlobal && tabGlobal.addEventListener("click", async () => {
        await ensureJoined("global");
        setRoom("global");
      });

      tabInbox && tabInbox.addEventListener("click", async () => {
        await ensureJoined("inbox");
        setRoom("inbox");
      });

      tabSettings && tabSettings.addEventListener("click", () => {
        setRoom("settings");
      });

      btnLogout && btnLogout.addEventListener("click", doLogout);
      btnPing && btnPing.addEventListener("click", doReconnect);

      btnSend && btnSend.addEventListener("click", sendCurrent);
      composer &&
        composer.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendCurrent();
          }
        });
    }

    // =========================
    // Boot
    // =========================
    async function init() {
      bindRealtime();
      bindDom();

      // Start cursor
      Cursor.init();

      // Default room counts
      updateBadges();
      setOnline(0);

      // Try resume from saved token
      const resumed = await tryResume();
      if (!resumed) {
        showAuth();
        // helpful hint
        setAuthOk("Tip: First login creates your account. After that, the password must match.");
      }
    }

    return { init };
  })();

  // Start
  document.addEventListener("DOMContentLoaded", () => {
    App.init().catch((e) => {
      console.error(e);
      Toasts.show("Client init error. Check console.");
    });
  });
})();

