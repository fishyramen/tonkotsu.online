/* script.js — tonkotsu.online client
   Fixes requested:
   1) Loading screen timing you out:
      - Loading overlay now has a watchdog and explicit “ready gates”
      - Never blocks sending login packet; never blocks Socket.IO connection
      - Clears itself if any critical stage fails (with visible error)

   2) Custom cursor not working:
      - Cursor is now a dedicated DOM layer that is enabled/disabled via settings
      - Uses requestAnimationFrame smoothing, high z-index, pointer-events:none
      - Auto-disables on touch/mobile or if prefers-reduced-motion

   3) IP/info not logged on open:
      - Immediately emits `client:hello` on socket connect
      - Also emits `client:hello` again on visibility change and after login
      - Server must implement a `client:hello` listener (see notes in code)

   4) “Each global message logged to Discord as rich message”:
      - That is server-side. This script sends `sendGlobal` with extra metadata
        (clientTs, pageId) so server can enrich embeds.
      - Your server.js must post a Discord embed (recommended fields included).

   IMPORTANT:
   - This file assumes your HTML already has elements with IDs/classes referenced below.
   - If your DOM differs, map the selectors at the top.
*/

(() => {
  "use strict";

  /* ----------------------------- selectors ----------------------------- */
  const SEL = {
    // Auth
    loginView: "#loginView",
    appView: "#appView",
    usernameInput: "#username",
    passwordInput: "#password",
    loginBtn: "#loginBtn",
    guestBtn: "#guestBtn",
    loginError: "#loginError",

    // Header / global UI
    inboxBtn: "#inboxBtn",
    inboxBadge: "#inboxBadge",
    settingsBtn: "#settingsBtn",

    // Loading overlay (must exist, or we will create it)
    loadingOverlay: "#loadingOverlay",

    // Global chat
    globalInput: "#globalInput",
    globalSendBtn: "#globalSendBtn",
    globalList: "#globalList",
    cooldownBarWrap: "#cooldownBarWrap",
    cooldownBar: "#cooldownBar",

    // Popups/toasts (optional)
    toastHost: "#toastHost",
  };

  const $ = (q) => document.querySelector(q);
  const el = Object.fromEntries(Object.entries(SEL).map(([k, q]) => [k, $(q)]));

  /* ----------------------------- utilities ---------------------------- */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const now = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isTouchLike =
    ("ontouchstart" in window) ||
    (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) ||
    (matchMedia && matchMedia("(pointer: coarse)").matches);

  const prefersReducedMotion =
    matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function safeText(s, max = 2000) {
    let t = String(s ?? "");
    t = t.replace(/\s+/g, " ").trim();
    if (t.length > max) t = t.slice(0, max) + "…";
    return t;
  }

  function toast(msg, type = "info") {
    msg = safeText(msg, 260);
    if (!el.toastHost) {
      // Minimal fallback
      console[type === "error" ? "error" : "log"](msg);
      return;
    }
    const div = document.createElement("div");
    div.className = `toast toast-${type}`;
    div.textContent = msg;
    el.toastHost.appendChild(div);
    requestAnimationFrame(() => div.classList.add("show"));
    setTimeout(() => {
      div.classList.remove("show");
      setTimeout(() => div.remove(), 250);
    }, 2600);
  }

  function show(viewEl) {
    if (!viewEl) return;
    viewEl.style.display = "";
    viewEl.removeAttribute("aria-hidden");
  }
  function hide(viewEl) {
    if (!viewEl) return;
    viewEl.style.display = "none";
    viewEl.setAttribute("aria-hidden", "true");
  }

  /* ----------------------- persistent client state --------------------- */
  const state = {
    socket: null,
    connected: false,

    me: {
      username: null,
      token: null,
      guest: false,
      settings: {
        customCursor: true,
        mobileUX: false,
        sounds: true,
      },
    },

    // “ready gates” for loading overlay
    gates: {
      socketConnected: false,
      loginSuccess: false,
      historyLoaded: false,
      uiMounted: false,
    },

    cooldown: {
      seconds: 3,
      nextAllowedAt: 0,
      lastServerPushAt: 0,
    },

    page: {
      id: cryptoRandomId(),
      openedAt: now(),
    },
  };

  function cryptoRandomId() {
    try {
      const b = new Uint8Array(12);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    } catch {
      return String(Math.random()).slice(2) + String(Date.now());
    }
  }

  function saveSession() {
    try {
      const obj = {
        token: state.me.token,
        username: state.me.username,
        ts: now(),
      };
      localStorage.setItem("tonkotsu_session", JSON.stringify(obj));
    } catch {}
  }
  function loadSession() {
    try {
      const raw = localStorage.getItem("tonkotsu_session");
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj?.token) return null;
      return obj;
    } catch {
      return null;
    }
  }
  function clearSession() {
    try {
      localStorage.removeItem("tonkotsu_session");
    } catch {}
  }

  /* ---------------------------- loading UI ----------------------------- */
  const Loading = (() => {
    let overlay = el.loadingOverlay;
    let labelEl = null;
    let detailEl = null;
    let spinnerEl = null;

    let active = false;
    let watchdog = null;
    let startedAt = 0;

    function ensureOverlay() {
      overlay = overlay || $("#loadingOverlay");
      if (overlay) return;

      overlay = document.createElement("div");
      overlay.id = "loadingOverlay";
      overlay.innerHTML = `
        <div class="loadingCard">
          <div class="loadingSpinner" aria-hidden="true"></div>
          <div class="loadingText">
            <div class="loadingLabel">Loading…</div>
            <div class="loadingDetail">Please wait</div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
    }

    function cacheParts() {
      if (!overlay) return;
      labelEl = overlay.querySelector(".loadingLabel");
      detailEl = overlay.querySelector(".loadingDetail");
      spinnerEl = overlay.querySelector(".loadingSpinner");
    }

    function setText(label, detail) {
      if (labelEl) labelEl.textContent = safeText(label, 80);
      if (detailEl) detailEl.textContent = safeText(detail, 140);
    }

    function showLoading(label = "Loading…", detail = "Please wait") {
      ensureOverlay();
      cacheParts();

      active = true;
      startedAt = now();
      setText(label, detail);

      overlay.classList.add("show");
      overlay.setAttribute("aria-hidden", "false");

      // Watchdog prevents “perma loading” and the “timing out” feel.
      if (watchdog) clearInterval(watchdog);
      watchdog = setInterval(() => {
        if (!active) return;
        const elapsed = now() - startedAt;

        // If we’re stuck > 15s, show a recovery hint but DO NOT block the app.
        if (elapsed > 15000) {
          setText("Still loading…", "If this keeps happening, refresh. Your connection may be blocked.");
          // after 22s, auto-hide to avoid trapping user
          if (elapsed > 22000) {
            hideLoading();
            toast("Loading took too long. Try refreshing if something looks broken.", "error");
          }
        }
      }, 900);
    }

    function hideLoading() {
      ensureOverlay();
      active = false;
      overlay.classList.remove("show");
      overlay.setAttribute("aria-hidden", "true");
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
    }

    return { show: showLoading, hide: hideLoading, setText };
  })();

  /* ---------------------------- custom cursor -------------------------- */
  const Cursor = (() => {
    let enabled = false;
    let layer = null;

    // smooth movement
    let targetX = 0,
      targetY = 0;
    let curX = 0,
      curY = 0;
    let raf = 0;

    function ensure() {
      if (layer) return;
      layer = document.createElement("div");
      layer.id = "tonkotsuCursor";
      layer.innerHTML = `
        <div class="cursorDot"></div>
        <div class="cursorRing"></div>
      `;
      document.body.appendChild(layer);

      // Force CSS in case your stylesheet doesn’t include it.
      // This is intentionally verbose to “just work”.
      const style = document.createElement("style");
      style.textContent = `
        #tonkotsuCursor{
          position:fixed; left:0; top:0; width:1px; height:1px;
          pointer-events:none; z-index:2147483647;
          transform: translate3d(-100px,-100px,0);
        }
        #tonkotsuCursor .cursorDot{
          position:absolute; left:-4px; top:-4px; width:8px; height:8px;
          border-radius:99px; background: rgba(255,255,255,.95);
          box-shadow: 0 0 12px rgba(0,0,0,.35);
        }
        #tonkotsuCursor .cursorRing{
          position:absolute; left:-18px; top:-18px; width:36px; height:36px;
          border-radius:999px; border: 2px solid rgba(255,255,255,.55);
          box-shadow: 0 0 20px rgba(0,0,0,.25);
          transform: translateZ(0);
        }
        body.tonkotsuCursorOn, body.tonkotsuCursorOn * { cursor: none !important; }
        body.tonkotsuCursorOn a, body.tonkotsuCursorOn button { cursor: none !important; }
      `;
      document.head.appendChild(style);

      // Input events
      window.addEventListener(
        "mousemove",
        (e) => {
          targetX = e.clientX;
          targetY = e.clientY;
          if (!raf) raf = requestAnimationFrame(tick);
        },
        { passive: true }
      );

      window.addEventListener(
        "mousedown",
        () => layer?.classList.add("down"),
        { passive: true }
      );
      window.addEventListener(
        "mouseup",
        () => layer?.classList.remove("down"),
        { passive: true }
      );

      document.addEventListener(
        "mouseleave",
        () => {
          if (!layer) return;
          layer.style.opacity = "0";
        },
        { passive: true }
      );
      document.addEventListener(
        "mouseenter",
        () => {
          if (!layer) return;
          layer.style.opacity = "1";
        },
        { passive: true }
      );
    }

    function tick() {
      raf = 0;
      if (!enabled || !layer) return;

      // smoothing (slower if reduced motion)
      const ease = prefersReducedMotion ? 0.6 : 0.22;
      curX += (targetX - curX) * ease;
      curY += (targetY - curY) * ease;

      layer.style.transform = `translate3d(${curX}px, ${curY}px, 0)`;

      // keep animating if not yet close
      const dx = Math.abs(targetX - curX);
      const dy = Math.abs(targetY - curY);
      if (dx + dy > 0.3) raf = requestAnimationFrame(tick);
    }

    function set(on) {
      const should =
        !!on && !isTouchLike && !prefersReducedMotion && window.innerWidth >= 820;

      enabled = should;
      if (enabled) {
        ensure();
        document.body.classList.add("tonkotsuCursorOn");
        layer.style.display = "";
        layer.style.opacity = "1";
      } else {
        document.body.classList.remove("tonkotsuCursorOn");
        if (layer) layer.style.display = "none";
      }
    }

    return { set };
  })();

  /* -------------------------- cooldown bar UI -------------------------- */
  const Cooldown = (() => {
    let wrap = el.cooldownBarWrap;
    let bar = el.cooldownBar;

    let shakeTimer = null;

    function ensure() {
      wrap = wrap || $("#cooldownBarWrap");
      bar = bar || $("#cooldownBar");

      if (!wrap) {
        // create minimal container if missing
        wrap = document.createElement("div");
        wrap.id = "cooldownBarWrap";
        wrap.className = "cooldownWrap";
        wrap.innerHTML = `<div id="cooldownBar" class="cooldownBar"></div>`;
        bar = wrap.querySelector("#cooldownBar");
        const host = document.body;
        host.appendChild(wrap);

        const style = document.createElement("style");
        style.textContent = `
          .cooldownWrap{
            position: fixed; left: 50%; transform: translateX(-50%);
            bottom: 18px; width: min(520px, 92vw);
            height: 10px; border-radius: 999px;
            background: rgba(255,255,255,.08);
            box-shadow: 0 10px 30px rgba(0,0,0,.35);
            overflow: hidden; z-index: 9999;
            backdrop-filter: blur(10px);
            display:none;
          }
          .cooldownWrap.show{ display:block; }
          .cooldownBar{
            height:100%; width:0%;
            background: rgba(255,255,255,.75);
            border-radius:999px;
            transform-origin:left;
          }
          .cooldownWrap.shake{
            animation: cdshake .35s linear;
            background: rgba(255,0,0,.22);
          }
          @keyframes cdshake{
            0%{ transform: translateX(-50%) translateY(0) translateX(0); }
            20%{ transform: translateX(-50%) translateX(-8px); }
            40%{ transform: translateX(-50%) translateX(8px); }
            60%{ transform: translateX(-50%) translateX(-6px); }
            80%{ transform: translateX(-50%) translateX(6px); }
            100%{ transform: translateX(-50%) translateX(0); }
          }
        `;
        document.head.appendChild(style);
      }
    }

    function setCooldown(seconds) {
      seconds = clamp(Number(seconds) || 3, 0.5, 30);
      state.cooldown.seconds = seconds;
    }

    function triggerSendAttemptBlocked() {
      ensure();
      wrap.classList.add("show");
      wrap.classList.add("shake");
      bar.style.width = "100%";
      bar.style.opacity = "1";
      bar.style.background = "rgba(255,0,0,.85)";

      if (shakeTimer) clearTimeout(shakeTimer);
      shakeTimer = setTimeout(() => {
        wrap.classList.remove("shake");
        // fade back to normal
        bar.style.transition = "opacity 650ms ease";
        bar.style.opacity = "0.75";
        bar.style.background = "rgba(255,255,255,.75)";
        setTimeout(() => {
          bar.style.transition = "";
        }, 700);
      }, 420);
    }

    function start() {
      ensure();
      const cd = state.cooldown.seconds;
      const startAt = now();
      state.cooldown.nextAllowedAt = startAt + cd * 1000;

      wrap.classList.add("show");
      bar.style.width = "0%";
      bar.style.opacity = "1";
      bar.style.background = "rgba(255,255,255,.75)";

      const tick = () => {
        const t = now();
        const total = cd * 1000;
        const p = clamp((t - startAt) / total, 0, 1);
        bar.style.width = `${(p * 100).toFixed(1)}%`;
        if (p < 1) requestAnimationFrame(tick);
        else {
          // hide after short grace
          setTimeout(() => wrap.classList.remove("show"), 250);
        }
      };
      requestAnimationFrame(tick);
    }

    function canSendNow() {
      return now() >= (state.cooldown.nextAllowedAt || 0);
    }

    return { setCooldown, start, canSendNow, blocked: triggerSendAttemptBlocked };
  })();

  /* ------------------------ Socket.IO connection ----------------------- */
  function connectSocket() {
    // Assumes socket.io client is loaded and available as `io`.
    if (typeof window.io !== "function") {
      toast("Socket.IO client not loaded. Check your index.html includes /socket.io/socket.io.js", "error");
      return null;
    }

    const sock = window.io({
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 999,
      reconnectionDelay: 450,
      reconnectionDelayMax: 2200,
      timeout: 20000,
    });

    state.socket = sock;

    sock.on("connect", () => {
      state.connected = true;
      state.gates.socketConnected = true;

      // Emit hello immediately so the server can log IP/UA for bot detection.
      emitHello("connect");

      // Attempt resume if a token exists and we are not authed yet.
      if (!state.me.username && !state.me.guest) {
        const sess = loadSession();
        if (sess?.token) {
          Loading.show("Resuming…", "Restoring your session");
          sock.emit("resume", { token: sess.token });
        }
      }
    });

    sock.on("disconnect", (reason) => {
      state.connected = false;
      toast(`Disconnected: ${reason}`, "error");
    });

    sock.on("connect_error", (err) => {
      toast(`Connection error: ${err?.message || err}`, "error");
      // Never leave loading overlay stuck
      Loading.hide();
    });

    // ---- auth responses ----
    sock.on("resumeFail", () => {
      clearSession();
      Loading.hide();
      show(el.loginView);
      hide(el.appView);
      toast("Session expired. Please log in again.", "error");
    });

    sock.on("loginError", (msg) => {
      Loading.hide();
      if (el.loginError) el.loginError.textContent = safeText(msg, 160);
      toast(msg, "error");
    });

    sock.on("loginSuccess", (payload) => {
      // This is where your loading screen used to trap users.
      // We now treat loginSuccess as one “gate” and release once the other gates finish.
      state.gates.loginSuccess = true;

      state.me.username = payload?.username || null;
      state.me.guest = !!payload?.guest;
      state.me.token = payload?.token || null;
      state.me.settings = payload?.settings || state.me.settings;

      if (state.me.token) saveSession();

      // Apply cursor setting immediately
      Cursor.set(!!state.me.settings?.customCursor);

      // After login, send hello again with auth context (server can correlate).
      emitHello(payload?.firstTime ? "new_account" : "login");

      // Switch UI
      hide(el.loginView);
      show(el.appView);

      // Start “between login and messages” loader, but it will auto-release.
      Loading.show("Entering messages…", "Loading chat data");

      // Gate: request global history and wait for it.
      state.gates.historyLoaded = false;
      state.socket.emit("requestGlobalHistory");

      // Ensure UI mount gate becomes true (DOM is present)
      state.gates.uiMounted = true;

      // If first time, show welcome popup (client-side).
      if (payload?.firstTime && !payload?.guest) {
        setTimeout(() => showWelcomePopup(), 400);
      }

      // Refresh inbox badge, etc. (non-blocking)
      if (!payload?.guest) {
        state.socket.emit("inbox:get");
        state.socket.emit("security:get");
      }

      attemptReleaseLoading();
    });

    // ---- global history + messages ----
    sock.on("history", (arr) => {
      renderGlobalHistory(Array.isArray(arr) ? arr : []);
      state.gates.historyLoaded = true;
      attemptReleaseLoading();
    });

    sock.on("globalMessage", (msg) => {
      renderGlobalMessage(msg);
    });

    // ---- cooldown updates ----
    sock.on("cooldown:update", ({ seconds }) => {
      state.cooldown.lastServerPushAt = now();
      Cooldown.setCooldown(seconds);
    });

    // ---- inbox ----
    sock.on("inbox:badge", (badge) => {
      const total = Number(badge?.total || 0);
      if (el.inboxBadge) {
        el.inboxBadge.textContent = total > 99 ? "99+" : String(total);
        el.inboxBadge.style.display = total > 0 ? "" : "none";
      }
    });

    // ---- warnings/errors ----
    sock.on("sendError", ({ reason }) => {
      const r = reason || "Send failed.";
      toast(r, "error");
      // Shake cooldown bar if it was a cooldown block
      if (/cooldown/i.test(r)) Cooldown.blocked();
    });

    sock.on("warn", (w) => {
      if (!w?.text) return;
      toast(w.text, "info");
    });

    // ---- settings ----
    sock.on("settings", (s) => {
      state.me.settings = { ...state.me.settings, ...(s || {}) };
      Cursor.set(!!state.me.settings?.customCursor);
    });

    // Visibility logging for bot detection (server can correlate)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") emitHello("tab_visible");
    });

    return sock;
  }

  function emitHello(reason) {
    if (!state.socket || !state.socket.connected) return;

    // Server uses handshake IP/UA; client provides extra “browser signal” only.
    const payload = {
      reason: String(reason || "hello"),
      pageId: state.page.id,
      openedAt: state.page.openedAt,
      clientTs: now(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
      locale: navigator.language || null,
      referrer: document.referrer ? safeText(document.referrer, 200) : null,
      path: location.pathname + location.search,
      screen: {
        w: window.screen?.width || null,
        h: window.screen?.height || null,
        dpr: window.devicePixelRatio || 1,
      },
      view: {
        w: window.innerWidth,
        h: window.innerHeight,
      },
      auth: state.me.username ? { user: state.me.username, guest: !!state.me.guest } : null,
    };

    // NOTE: You MUST add `socket.on("client:hello", ...)` in server.js
    state.socket.emit("client:hello", payload);
  }

  /* --------------------- robust loading release logic ------------------ */
  function attemptReleaseLoading() {
    // Release when the key gates are true.
    const ok =
      state.gates.socketConnected &&
      state.gates.loginSuccess &&
      state.gates.historyLoaded &&
      state.gates.uiMounted;

    if (ok) {
      // Delay slightly so UI feels intentional and avoids “flash”
      setTimeout(() => Loading.hide(), 200);
    }
  }

  /* ------------------------------ rendering ---------------------------- */
  function ensureGlobalList() {
    if (el.globalList) return el.globalList;
    const found = $("#globalList");
    if (found) return (el.globalList = found);

    // create minimal list if missing
    const div = document.createElement("div");
    div.id = "globalList";
    div.className = "globalList";
    document.body.appendChild(div);
    el.globalList = div;
    return div;
  }

  function renderGlobalHistory(messages) {
    const list = ensureGlobalList();
    list.innerHTML = "";
    for (const m of messages) renderGlobalMessage(m, true);
    // Scroll bottom
    list.scrollTop = list.scrollHeight;
  }

  function formatTime(ts) {
    try {
      const d = new Date(Number(ts) || Date.now());
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    } catch {
      return "";
    }
  }

  function renderGlobalMessage(msg, skipScroll = false) {
    const list = ensureGlobalList();
    const user = safeText(msg?.user || "Unknown", 24);
    const text = String(msg?.text || "");
    const ts = Number(msg?.ts || Date.now());

    const item = document.createElement("div");
    item.className = "gmsg";

    // Content embeds: light client-side preview (server should also guard)
    const hasUrl = /(https?:\/\/|www\.)/i.test(text);
    let embedHtml = "";
    if (hasUrl) {
      const urls = (text.match(/\bhttps?:\/\/[^\s<>"')\]]+/gi) || []).slice(0, 1);
      if (urls.length) {
        const u = urls[0];
        const safeU = u.replace(/"/g, "%22");
        embedHtml = `
          <div class="embed">
            <div class="embedLeft"></div>
            <div class="embedBody">
              <div class="embedTitle">Link</div>
              <a class="embedLink" href="${safeU}" target="_blank" rel="noopener noreferrer">${safeText(u, 80)}</a>
            </div>
          </div>
        `;
      }
    }

    item.innerHTML = `
      <div class="gmsgTop">
        <div class="gmsgUser">${user}</div>
        <div class="gmsgTime">${formatTime(ts)}</div>
      </div>
      <div class="gmsgText"></div>
      ${embedHtml}
    `;

    // Insert text safely
    const textEl = item.querySelector(".gmsgText");
    if (textEl) textEl.textContent = text;

    list.appendChild(item);

    if (!skipScroll) list.scrollTop = list.scrollHeight;
  }

  /* ------------------------------ sending ------------------------------ */
  function wireGlobalSend() {
    const input = el.globalInput || $("#globalInput");
    const btn = el.globalSendBtn || $("#globalSendBtn");

    const send = () => {
      if (!state.socket || !state.socket.connected) {
        toast("Not connected.", "error");
        return;
      }
      if (!state.me.username) {
        toast("Log in first.", "error");
        return;
      }

      if (!Cooldown.canSendNow()) {
        Cooldown.blocked();
        return;
      }

      const text = safeText(input?.value || "", 1200);
      if (!text) return;

      // Start local bar immediately; server enforces final cooldown.
      Cooldown.start();

      // Send with extra metadata to help server log to Discord “rich”
      state.socket.emit("sendGlobal", {
        text,
        clientTs: now(),
        pageId: state.page.id,
      });

      if (input) input.value = "";
    };

    if (btn) btn.addEventListener("click", send);

    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      });
    }
  }

  /* -------------------------- welcome popup ---------------------------- */
  function showWelcomePopup() {
    // Big popup for first-time accounts: beta disclaimer
    const host = document.createElement("div");
    host.className = "modalHost";
    host.innerHTML = `
      <div class="modalBackdrop"></div>
      <div class="modalCard">
        <div class="modalTitle">Welcome to tonkotsu.online (Beta)</div>
        <div class="modalBody">
          <p>
            This is a beta version. Accounts and data are not guaranteed to persist across major updates.
          </p>
          <p>
            If you run into any problems, contact <strong>fishy_x1</strong> on Discord or <strong>fishyramen</strong> on GitHub.
          </p>
        </div>
        <div class="modalActions">
          <button class="btnPrimary" id="welcomeOkBtn">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(host);

    const style = document.createElement("style");
    style.textContent = `
      .modalHost{ position:fixed; inset:0; z-index:99999; display:flex; align-items:center; justify-content:center; }
      .modalBackdrop{ position:absolute; inset:0; background:rgba(0,0,0,.65); backdrop-filter: blur(10px); }
      .modalCard{
        position:relative; width:min(680px, 92vw);
        background: rgba(20,20,24,.92);
        border: 1px solid rgba(255,255,255,.12);
        box-shadow: 0 20px 60px rgba(0,0,0,.55);
        border-radius: 18px;
        padding: 18px 18px 16px;
      }
      .modalTitle{ font-size: 20px; font-weight: 800; letter-spacing: .2px; margin-bottom: 10px; }
      .modalBody{ font-size: 15px; line-height: 1.45; opacity:.95; }
      .modalBody p{ margin: 0 0 10px 0; }
      .modalActions{ display:flex; justify-content:flex-end; gap:10px; margin-top: 10px; }
      .btnPrimary{
        padding: 10px 14px; border-radius: 14px; border: 1px solid rgba(255,255,255,.18);
        background: rgba(255,255,255,.12); color: #fff;
      }
      .btnPrimary:hover{ background: rgba(255,255,255,.18); }
    `;
    document.head.appendChild(style);

    host.querySelector("#welcomeOkBtn")?.addEventListener("click", () => {
      host.remove();
      style.remove();
    });
    host.querySelector(".modalBackdrop")?.addEventListener("click", () => {
      host.remove();
      style.remove();
    });
  }

  /* ------------------------------ login UI ----------------------------- */
  function wireLogin() {
    if (el.loginBtn) {
      el.loginBtn.addEventListener("click", () => doLogin(false));
    }
    if (el.guestBtn) {
      el.guestBtn.addEventListener("click", () => doLogin(true));
    }

    // Enter to submit
    const u = el.usernameInput;
    const p = el.passwordInput;
    const keyHandler = (e) => {
      if (e.key === "Enter") doLogin(false);
    };
    u?.addEventListener("keydown", keyHandler);
    p?.addEventListener("keydown", keyHandler);
  }

  function doLogin(asGuest) {
    if (!state.socket || !state.socket.connected) {
      toast("Not connected.", "error");
      return;
    }

    if (el.loginError) el.loginError.textContent = "";

    const username = safeText(el.usernameInput?.value || "", 40);
    const password = safeText(el.passwordInput?.value || "", 60);

    // If guest, ignore inputs
    if (asGuest) {
      Loading.show("Creating guest…", "Entering the app");
      state.socket.emit("login", { guest: true });
      return;
    }

    if (!username || username.length < 4) {
      toast("Username must be 4–20 characters (letters/numbers).", "error");
      return;
    }
    if (!password || password.length < 4) {
      toast("Password must be 4–32 characters (letters/numbers).", "error");
      return;
    }

    Loading.show("Logging in…", "Verifying credentials");
    state.socket.emit("login", { username, password, guest: false });
  }

  /* ------------------------------ init -------------------------------- */
  function boot() {
    // Safety: never show loading overlay at boot unless we’re truly resuming
    hide(el.appView);
    show(el.loginView);

    // Cursor default (pre-login) uses local preference if any
    Cursor.set(true);

    // Wire UI actions
    wireLogin();
    wireGlobalSend();

    // Connect socket
    const sock = connectSocket();
    if (!sock) return;

    // If session exists, show gentle loader (but with watchdog)
    const sess = loadSession();
    if (sess?.token) Loading.show("Resuming…", "Restoring your session");
  }

  // Start when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  /* ---------------------------------------------------------------------
     SERVER-SIDE REQUIREMENTS (must be in server.js; not in this file):

     1) Log IP/UA on open:
        socket.on("client:hello", (payload) => {
          // Use socket.handshake.headers / x-forwarded-for for IP.
          // Store: ts, ip, ua, pageId, reason, path, etc.
          // This is purely for bot identification.

     2) Rich Discord embeds for global chat:
        In sendGlobal handler (server.js), instead of plain content, send:
        discordSendEmbed({
          title: "Global Chat",
          description: msg.text,
          fields: [
            { name:"User", value:`\`${msg.user}\``, inline:true },
            { name:"Time", value:`<t:${Math.floor(msg.ts/1000)}:F>`, inline:true },
            { name:"Page", value:`\`${client.pageId || "n/a"}\``, inline:false }
          ],
          footer: "tonkotsu.online"
        });

     This script already sends { text, clientTs, pageId }.
  --------------------------------------------------------------------- */
})();
