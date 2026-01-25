/* script.js — tonkotsu.online (client)
   - Fixes loading screen trapping login (hard failsafes + non-blocking overlay)
   - Reliable custom cursor (desktop only, auto-disables on touch/mobile)
   - Sends “hello” telemetry on page open (for bot detection / IP logging on server)
   - Global chat UX: cooldown progress bar + shake/red fade on premature send
   - Client-side anti-spam: 1 link per 5 minutes (server should also enforce)
   - Settings: Blocked Users modal + Unblock, Mobile UX Mode, Security Analytics
   - UI alignment, bigger text already handled in index.html
   - Group Manage UI shell wiring (server enforcement in server.js)
*/
(() => {
  "use strict";

  /* ----------------------------- Config / State ----------------------------- */

  const APP = {
    version: "beta",
    apiBase: "",
    storageKeys: {
      token: "tonkotsu_token",
      username: "tonkotsu_username",
      cursor: "tonkotsu_cursor_enabled",
      mobileUX: "tonkotsu_mobileux",
      lastLinkAt: "tonkotsu_lastLinkAt",
      welcomeSeen: "tonkotsu_welcome_seen:", // + username
    },
    cooldown: {
      active: false,
      msTotal: 0,
      msLeft: 0,
      startedAt: 0,
      timer: null,
    },
    linkLimitMs: 5 * 60 * 1000, // 5 minutes
    maxMessageLen: 1200,
    socket: null,
    auth: {
      token: null,
      user: null, // { username, id, ... }
    },
    chatCtx: {
      type: "global", // global | group | dm
      id: "global",
      name: "Global Chat",
      isOwner: false,
    },
    ui: {
      lastScrollAt: 0,
      isAtBottom: true,
    },
    feature: {
      customCursorEnabled: false,
      mobileUXEnabled: false,
      hasTouch: false,
    },
  };

  /* ------------------------------ DOM Helpers ------------------------------ */

  const $ = (id) => document.getElementById(id);
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const dom = {
    loginView: $("loginView"),
    appView: $("appView"),

    username: $("username"),
    password: $("password"),
    loginBtn: $("loginBtn"),
    guestBtn: $("guestBtn"),
    loginError: $("loginError"),

    inboxBtn: $("inboxBtn"),
    inboxBadge: $("inboxBadge"),
    settingsBtn: $("settingsBtn"),

    profileName: $("profileName"),
    profileMeta: $("profileMeta"),
    profileBadges: $("profileBadges"),
    statCreated: $("statCreated"),
    statLastSeen: $("statLastSeen"),
    statLevel: $("statLevel"),

    navGlobalBtn: $("navGlobalBtn"),
    navGroupsBtn: $("navGroupsBtn"),
    navDMsBtn: $("navDMsBtn"),

    manageBtn: $("manageBtn"),

    globalList: $("globalList"),
    globalInput: $("globalInput"),
    globalSendBtn: $("globalSendBtn"),
    globalOnlinePill: $("globalOnlinePill"),

    cooldownWrap: $("cooldownBarWrap"),
    cooldownBar: $("cooldownBar"),

    toastHost: $("toastHost"),
    loadingOverlay: $("loadingOverlay"),

    settingsModal: $("settingsModal"),
    blockedModal: $("blockedModal"),
    securityModal: $("securityModal"),
    manageModal: $("manageModal"),

    toggleCursorBtn: $("toggleCursorBtn"),
    toggleMobileUXBtn: $("toggleMobileUXBtn"),
    blockedUsersBtn: $("blockedUsersBtn"),
    securityBtn: $("securityBtn"),
    changePasswordBtn: $("changePasswordBtn"),
    changeUsernameBtn: $("changeUsernameBtn"),
    logoutBtn: $("logoutBtn"),

    blockedList: $("blockedList"),
    loginHistory: $("loginHistory"),
    sessionList: $("sessionList"),
    securityEvents: $("securityEvents"),

    limitSlider: $("limitSlider"),
    limitValue: $("limitValue"),
    saveLimitBtn: $("saveLimitBtn"),
    addMemberInput: $("addMemberInput"),
    addMemberBtn: $("addMemberBtn"),
    memberList: $("memberList"),
    transferOwnerBtn: $("transferOwnerBtn"),
    deleteGroupBtn: $("deleteGroupBtn"),
  };

  /* ------------------------------ Time Helpers ----------------------------- */

  const now = () => Date.now();

  function fmtTime(ts) {
    try {
      const d = new Date(ts);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    } catch {
      return "—";
    }
  }

  function fmtDate(ts) {
    try {
      const d = new Date(ts);
      return d.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
      });
    } catch {
      return "—";
    }
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  /* ------------------------------- UI: Toast ------------------------------- */

  function toast(msg, kind = "info", ttl = 3200) {
    const el = document.createElement("div");
    el.className = `toast toast-${kind === "error" ? "error" : "info"}`;
    el.textContent = String(msg || "");
    dom.toastHost.appendChild(el);

    // Animate in
    requestAnimationFrame(() => el.classList.add("show"));

    // Remove
    window.setTimeout(() => {
      el.classList.remove("show");
      window.setTimeout(() => el.remove(), 220);
    }, ttl);
  }

  /* ---------------------------- UI: Loading Overlay ------------------------- */

  // Critical: do NOT trap the user. Overlay is strictly informational.
  // We always have a failsafe auto-hide.
  let loadingFailsafeTimer = null;

  function showLoading(label = "Loading…", detail = "Please wait", hardTimeoutMs = 7000) {
    const overlay = dom.loadingOverlay;
    if (!overlay) return;

    const card = overlay.querySelector(".loadingCard");
    const labelEl = overlay.querySelector(".loadingLabel");
    const detailEl = overlay.querySelector(".loadingDetail");
    if (labelEl) labelEl.textContent = label;
    if (detailEl) detailEl.textContent = detail;

    overlay.classList.add("show");
    overlay.setAttribute("aria-hidden", "false");

    // IMPORTANT: never block pointer events; allow clicking UI behind if needed.
    // Overlay is on top; so we keep it only briefly and auto-hide always.
    if (loadingFailsafeTimer) clearTimeout(loadingFailsafeTimer);
    loadingFailsafeTimer = setTimeout(() => {
      hideLoading(true);
    }, clamp(hardTimeoutMs, 2500, 20000));

    // Extra safety: pressing Escape hides it immediately.
    const onKey = (e) => {
      if (e.key === "Escape") {
        hideLoading(true);
        document.removeEventListener("keydown", onKey);
      }
    };
    document.addEventListener("keydown", onKey);
  }

  function hideLoading(isFailsafe = false) {
    const overlay = dom.loadingOverlay;
    if (!overlay) return;
    overlay.classList.remove("show");
    overlay.setAttribute("aria-hidden", "true");
    if (loadingFailsafeTimer) {
      clearTimeout(loadingFailsafeTimer);
      loadingFailsafeTimer = null;
    }
    if (isFailsafe) {
      // Keep it quiet; do not spam.
    }
  }

  /* ------------------------------ UI: Modals ------------------------------- */

  function openModal(host) {
    if (!host) return;
    host.classList.add("show");
    host.setAttribute("aria-hidden", "false");
  }
  function closeModal(host) {
    if (!host) return;
    host.classList.remove("show");
    host.setAttribute("aria-hidden", "true");
  }

  function wireBackdropClose() {
    document.addEventListener(
      "click",
      (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        const key = t.getAttribute("data-close");
        if (!key) return;
        if (key === "settings") closeModal(dom.settingsModal);
        if (key === "blocked") closeModal(dom.blockedModal);
        if (key === "security") closeModal(dom.securityModal);
        if (key === "manage") closeModal(dom.manageModal);
      },
      { passive: true }
    );
  }

  /* -------------------------- Custom Cursor (Fixed) ------------------------- */

  let cursorEl = null;
  let cursorEnabled = false;
  let cursorRAF = 0;
  let cursorPos = { x: 0, y: 0 };
  let cursorTarget = { x: 0, y: 0 };

  function detectTouch() {
    APP.feature.hasTouch =
      "ontouchstart" in window ||
      (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) ||
      (navigator.msMaxTouchPoints && navigator.msMaxTouchPoints > 0);
  }

  function ensureCursorStylesInjected() {
    if (document.getElementById("tonkotsu-cursor-style")) return;
    const style = document.createElement("style");
    style.id = "tonkotsu-cursor-style";
    style.textContent = `
      body.cursorOn, body.cursorOn * { cursor: none !important; }
      #tonkotsuCursor {
        position: fixed;
        left: 0; top: 0;
        width: 14px; height: 14px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,.35);
        background: rgba(255,255,255,.12);
        box-shadow: 0 12px 30px rgba(0,0,0,.45);
        transform: translate3d(-999px,-999px,0);
        pointer-events: none;
        z-index: 100000;
        backdrop-filter: blur(6px);
      }
      #tonkotsuCursor::after {
        content: "";
        position: absolute;
        left: 50%; top: 50%;
        width: 4px; height: 4px;
        border-radius: 999px;
        background: rgba(255,255,255,.7);
        transform: translate(-50%,-50%);
      }
      body.cursorOn #tonkotsuCursor { display:block; }
    `;
    document.head.appendChild(style);
  }

  function cursorLoop() {
    // Smooth follow
    cursorPos.x += (cursorTarget.x - cursorPos.x) * 0.22;
    cursorPos.y += (cursorTarget.y - cursorPos.y) * 0.22;
    if (cursorEl) cursorEl.style.transform = `translate3d(${cursorPos.x - 7}px, ${cursorPos.y - 7}px, 0)`;
    cursorRAF = requestAnimationFrame(cursorLoop);
  }

  function enableCursor() {
    if (APP.feature.hasTouch) {
      toast("Custom cursor disabled on touch devices.", "info", 2600);
      disableCursor();
      return;
    }
    ensureCursorStylesInjected();
    if (!cursorEl) {
      cursorEl = document.createElement("div");
      cursorEl.id = "tonkotsuCursor";
      document.body.appendChild(cursorEl);
    }
    document.body.classList.add("cursorOn");
    cursorEnabled = true;
    APP.feature.customCursorEnabled = true;
    localStorage.setItem(APP.storageKeys.cursor, "1");

    // Start loop once
    if (!cursorRAF) cursorRAF = requestAnimationFrame(cursorLoop);

    toast("Custom cursor enabled.", "info", 1600);
  }

  function disableCursor() {
    document.body.classList.remove("cursorOn");
    cursorEnabled = false;
    APP.feature.customCursorEnabled = false;
    localStorage.setItem(APP.storageKeys.cursor, "0");

    if (cursorRAF) {
      cancelAnimationFrame(cursorRAF);
      cursorRAF = 0;
    }
    if (cursorEl) {
      cursorEl.remove();
      cursorEl = null;
    }
    toast("Custom cursor disabled.", "info", 1600);
  }

  function wireCursorEvents() {
    document.addEventListener(
      "mousemove",
      (e) => {
        cursorTarget.x = e.clientX;
        cursorTarget.y = e.clientY;
      },
      { passive: true }
    );
  }

  function initCursorFromPrefs() {
    detectTouch();
    const pref = localStorage.getItem(APP.storageKeys.cursor);
    if (pref === "1" && !APP.feature.hasTouch) enableCursor();
  }

  /* ----------------------------- Mobile UX Mode ----------------------------- */

  function setMobileUX(enabled) {
    APP.feature.mobileUXEnabled = !!enabled;
    if (enabled) document.body.classList.add("mobileUX");
    else document.body.classList.remove("mobileUX");
    localStorage.setItem(APP.storageKeys.mobileUX, enabled ? "1" : "0");
  }

  function initMobileUXFromPrefs() {
    const pref = localStorage.getItem(APP.storageKeys.mobileUX);
    if (pref === "1") setMobileUX(true);
  }

  /* ------------------------------ Network Helpers --------------------------- */

  function authHeaders(extra = {}) {
    const h = { "Content-Type": "application/json", ...extra };
    if (APP.auth.token) h["Authorization"] = `Bearer ${APP.auth.token}`;
    return h;
  }

  async function api(path, { method = "GET", body = null, headers = {} } = {}) {
    const opts = { method, headers: authHeaders(headers) };
    if (body !== null) opts.body = typeof body === "string" ? body : JSON.stringify(body);
    const res = await fetch(APP.apiBase + path, opts);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = (json && (json.error || json.message)) || `Request failed (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return json;
  }

  /* -------------------------- Bot Detection Telemetry ------------------------ */

  async function sendPageHello() {
    // The server should record IP from request. We only include lightweight client hints.
    const hints = {
      t: now(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
      lang: navigator.language || null,
      ua: navigator.userAgent || null,
      platform: navigator.platform || null,
      screen: {
        w: window.screen ? window.screen.width : null,
        h: window.screen ? window.screen.height : null,
        dpr: window.devicePixelRatio || null,
      },
      vis: document.visibilityState,
      ref: document.referrer || null,
    };

    try {
      // Non-blocking: never prevent user interaction if it fails.
      await fetch(APP.apiBase + "/api/telemetry/hello", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hints),
        keepalive: true,
      });
    } catch {
      // Silent.
    }
  }

  /* ------------------------------ Auth / Session ----------------------------- */

  function loadSavedAuth() {
    const token = localStorage.getItem(APP.storageKeys.token);
    const username = localStorage.getItem(APP.storageKeys.username);
    if (token && username) {
      APP.auth.token = token;
      APP.auth.user = { username };
      return true;
    }
    return false;
  }

  function clearAuth() {
    APP.auth.token = null;
    APP.auth.user = null;
    localStorage.removeItem(APP.storageKeys.token);
    localStorage.removeItem(APP.storageKeys.username);
  }

  function setLoginError(msg) {
    if (!dom.loginError) return;
    dom.loginError.textContent = msg ? String(msg) : "";
  }

  /* ----------------------------- Socket Handling ----------------------------- */

  function disconnectSocket() {
    try {
      if (APP.socket) {
        APP.socket.off();
        APP.socket.disconnect();
        APP.socket = null;
      }
    } catch {
      APP.socket = null;
    }
  }

  function connectSocket() {
    if (typeof io !== "function") {
      toast("Socket client missing. Check /socket.io/socket.io.js", "error", 4500);
      return;
    }
    disconnectSocket();

    APP.socket = io({
      transports: ["websocket", "polling"],
      auth: {
        token: APP.auth.token || null,
      },
      reconnection: true,
      reconnectionDelay: 300,
      reconnectionDelayMax: 2500,
      timeout: 8000,
    });

    const s = APP.socket;

    s.on("connect", () => {
      // Also send a connect hello for audit/bot detection
      try {
        s.emit("hello", {
          t: now(),
          user: APP.auth.user ? APP.auth.user.username : null,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
          ua: navigator.userAgent || null,
          lang: navigator.language || null,
        });
      } catch {}
    });

    s.on("connect_error", (err) => {
      // Avoid spam
      toast(`Connection issue: ${err && err.message ? err.message : "unknown"}`, "error", 3800);
    });

    // Server-driven UI updates
    s.on("online:update", (payload) => {
      if (!dom.globalOnlinePill) return;
      const n = payload && typeof payload.online === "number" ? payload.online : null;
      dom.globalOnlinePill.textContent = `online: ${n === null ? "—" : n}`;
    });

    s.on("notify:count", (payload) => {
      // Inbox badge count (no clear button)
      const n = payload && typeof payload.count === "number" ? payload.count : 0;
      renderInboxBadge(n);
    });

    s.on("global:msg", (msg) => {
      // Incoming global message
      if (APP.chatCtx.type !== "global") return;
      appendGlobalMessage(msg, { incoming: true });
    });

    s.on("global:history", (payload) => {
      if (APP.chatCtx.type !== "global") return;
      const items = payload && Array.isArray(payload.items) ? payload.items : [];
      renderGlobalHistory(items);
    });

    s.on("auth:revoked", () => {
      toast("Session revoked. Please log in again.", "error", 4200);
      logoutToLogin();
    });

    s.on("shadow:notice", (payload) => {
      // Server can optionally inform user of shadow mute status (we won’t show unless explicitly sent)
      // We keep it subtle.
      if (payload && payload.hint) toast(String(payload.hint), "info", 2200);
    });
  }

  /* ---------------------------- View Transitions ---------------------------- */

  function showLoginView() {
    dom.loginView.style.display = "";
    dom.loginView.setAttribute("aria-hidden", "false");
    dom.appView.style.display = "none";
    dom.appView.setAttribute("aria-hidden", "true");
    dom.manageBtn.style.display = "none";
    hideLoading(true);
  }

  function showAppView() {
    dom.loginView.style.display = "none";
    dom.loginView.setAttribute("aria-hidden", "true");
    dom.appView.style.display = "";
    dom.appView.setAttribute("aria-hidden", "false");
    hideLoading(true);
  }

  function logoutToLogin() {
    disconnectSocket();
    clearAuth();
    showLoginView();
    setLoginError("");
    toast("Logged out.", "info", 1700);
  }

  /* ------------------------------- Profile UI ------------------------------ */

  function renderInboxBadge(n) {
    const badge = dom.inboxBadge;
    if (!badge) return;
    const count = Math.max(0, n | 0);
    if (count <= 0) {
      badge.style.display = "none";
      badge.textContent = "0";
      return;
    }
    badge.style.display = "inline-flex";
    badge.textContent = String(count > 99 ? "99+" : count);
  }

  function clearBadges() {
    if (!dom.profileBadges) return;
    dom.profileBadges.innerHTML = "";
  }

  function addBadge(text) {
    const el = document.createElement("span");
    el.className = "badge";
    el.textContent = text;
    dom.profileBadges.appendChild(el);
  }

  function renderProfile(user) {
    const uname = (user && user.username) || (APP.auth.user && APP.auth.user.username) || "—";
    dom.profileName.textContent = uname;

    // meta line can include id/role/flags
    const role = user && user.role ? user.role : "user";
    dom.profileMeta.textContent = `${role} • ${APP.version}`;

    // stats
    const createdAt = user && user.createdAt ? user.createdAt : null;
    const lastSeen = user && user.lastSeen ? user.lastSeen : null;
    const level = user && typeof user.level === "number" ? user.level : null;

    dom.statCreated.textContent = `Created: ${createdAt ? fmtDate(createdAt) : "—"}`;
    dom.statLastSeen.textContent = `Last seen: ${lastSeen ? fmtTime(lastSeen) : "—"}`;
    dom.statLevel.textContent = `Level: ${level !== null ? level : "—"}`;

    // badges
    clearBadges();
    addBadge("BETA");

    const badges = (user && Array.isArray(user.badges) ? user.badges : []) || [];
    for (const b of badges) addBadge(String(b));

    // milestone badges (client-side fallback if server doesn’t provide)
    if (typeof level === "number") {
      if (level >= 10) addBadge("LV 10");
      if (level >= 25) addBadge("LV 25");
      if (level >= 50) addBadge("LV 50");
    }

    // Early user badge if betaJoinAt exists
    if (user && user.betaJoinAt) addBadge("EARLY USER");
  }

  /* ------------------------- Global Chat Rendering -------------------------- */

  function isNearBottom(el, px = 80) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= px;
  }

  function scrollToBottom(el) {
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function sanitizeText(s) {
    // We render textContent so this is extra safety; keep it simple.
    return String(s || "").slice(0, APP.maxMessageLen);
  }

  function extractFirstUrl(text) {
    // Basic URL detection; server should validate.
    const m = String(text || "").match(/\bhttps?:\/\/[^\s<>"']+/i);
    return m ? m[0] : null;
  }

  function makeMsgEl(msg) {
    const wrap = document.createElement("div");
    wrap.className = "gmsg";

    const top = document.createElement("div");
    top.className = "gmsgTop";

    const user = document.createElement("div");
    user.className = "gmsgUser";
    user.textContent = msg && msg.user ? String(msg.user) : "unknown";

    const time = document.createElement("div");
    time.className = "gmsgTime";
    time.textContent = msg && msg.ts ? fmtTime(msg.ts) : "—";

    top.appendChild(user);
    top.appendChild(time);

    const body = document.createElement("div");
    body.className = "gmsgText";
    body.textContent = sanitizeText(msg && msg.text ? msg.text : "");

    wrap.appendChild(top);
    wrap.appendChild(body);

    // Link embed shell (small, fits style)
    const url = msg && msg.url ? String(msg.url) : extractFirstUrl(msg && msg.text ? msg.text : "");
    if (url) {
      const embed = document.createElement("div");
      embed.className = "embed";

      const left = document.createElement("div");
      left.className = "embedLeft";

      const eb = document.createElement("div");
      eb.className = "embedBody";

      const t = document.createElement("div");
      t.className = "embedTitle";
      t.textContent = "Link";

      const a = document.createElement("a");
      a.className = "embedLink";
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = url.length > 64 ? url.slice(0, 61) + "…" : url;

      eb.appendChild(t);
      eb.appendChild(a);

      embed.appendChild(left);
      embed.appendChild(eb);
      wrap.appendChild(embed);
    }

    // Shadow muted local marker (subtle)
    if (msg && msg._shadowLocal) {
      wrap.style.opacity = "0.72";
    }

    return wrap;
  }

  function appendGlobalMessage(msg, { incoming = false } = {}) {
    const list = dom.globalList;
    if (!list) return;

    const wasBottom = isNearBottom(list);
    const el = makeMsgEl(msg);
    list.appendChild(el);

    // Keep last 500 to avoid memory bloat
    if (list.children.length > 520) {
      for (let i = 0; i < 40; i++) {
        if (list.firstChild) list.removeChild(list.firstChild);
      }
    }

    if (wasBottom || !incoming) scrollToBottom(list);
  }

  function renderGlobalHistory(items) {
    const list = dom.globalList;
    if (!list) return;
    list.innerHTML = "";
    for (const it of items) appendGlobalMessage(it, { incoming: true });
    scrollToBottom(list);
  }

  /* ----------------------- Cooldown Bar (Dynamic + Shake) ------------------- */

  function showCooldownBar() {
    dom.cooldownWrap.classList.add("show");
    dom.cooldownWrap.setAttribute("aria-hidden", "false");
  }

  function hideCooldownBar() {
    dom.cooldownWrap.classList.remove("show");
    dom.cooldownWrap.setAttribute("aria-hidden", "true");
    dom.cooldownBar.style.width = "0%";
  }

  function startCooldown(ms) {
    const total = Math.max(0, ms | 0);
    if (total <= 0) return;

    APP.cooldown.active = true;
    APP.cooldown.msTotal = total;
    APP.cooldown.msLeft = total;
    APP.cooldown.startedAt = now();

    showCooldownBar();

    if (APP.cooldown.timer) clearInterval(APP.cooldown.timer);
    APP.cooldown.timer = setInterval(() => {
      const elapsed = now() - APP.cooldown.startedAt;
      const left = Math.max(0, APP.cooldown.msTotal - elapsed);
      APP.cooldown.msLeft = left;

      const pct = APP.cooldown.msTotal ? ((APP.cooldown.msTotal - left) / APP.cooldown.msTotal) * 100 : 100;
      dom.cooldownBar.style.width = `${clamp(pct, 0, 100)}%`;

      if (left <= 0) {
        stopCooldown();
      }
    }, 50);
  }

  function stopCooldown() {
    APP.cooldown.active = false;
    APP.cooldown.msLeft = 0;
    APP.cooldown.msTotal = 0;
    APP.cooldown.startedAt = 0;
    if (APP.cooldown.timer) clearInterval(APP.cooldown.timer);
    APP.cooldown.timer = null;

    // Fade out the bar cleanly
    dom.cooldownBar.style.width = "100%";
    setTimeout(() => hideCooldownBar(), 180);
  }

  function shakeCooldownBar() {
    const wrap = dom.cooldownWrap;
    if (!wrap) return;

    // Ensure it is visible so shake is noticeable
    showCooldownBar();
    wrap.classList.add("shake");

    // Remove shake class and fade the red back to normal
    setTimeout(() => {
      wrap.classList.remove("shake");
      // If cooldown is not active, hide it shortly after feedback
      if (!APP.cooldown.active) setTimeout(() => hideCooldownBar(), 350);
    }, 420);
  }

  /* ----------------------------- Login / Welcome ---------------------------- */

  function markWelcomeSeen(username) {
    if (!username) return;
    localStorage.setItem(APP.storageKeys.welcomeSeen + username, "1");
  }

  function hasWelcomeSeen(username) {
    if (!username) return false;
    return localStorage.getItem(APP.storageKeys.welcomeSeen + username) === "1";
  }

  function showWelcomePopupIfNeeded(isNew, username) {
    if (!isNew) return;
    if (hasWelcomeSeen(username)) return;

    // Use the existing modal style but create a temporary modal host
    const host = document.createElement("div");
    host.className = "modalHost show";
    host.setAttribute("aria-hidden", "false");

    host.innerHTML = `
      <div class="modalBackdrop"></div>
      <div class="modalCard" role="dialog" aria-modal="true" aria-label="Welcome">
        <div class="modalHead">
          <div class="modalTitle">Welcome to tonkotsu.online (BETA)</div>
          <div class="spacer"></div>
          <button class="btn btnGhost btnSmall" type="button" data-close-temp="1">Close</button>
        </div>
        <div class="modalBody">
          <div class="subCard">
            <div class="subTitle">Beta warning</div>
            <div class="subText">
              This is a beta version. Your account and data are not guaranteed to be saved after major updates.
              If you notice issues, report them to <strong>fishy_x1</strong> on Discord or <strong>fishyramen</strong> on GitHub.
            </div>
          </div>
          <div class="subCard">
            <div class="subTitle">Quick tips</div>
            <div class="subText">
              Global chat has cooldown and anti-spam rules. Links are rate-limited. In Settings you can review blocked users and security analytics.
            </div>
          </div>
          <div class="row gap10" style="justify-content:flex-end; flex-wrap:wrap;">
            <button class="btn btnPrimary" type="button" data-close-temp="1">Got it</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(host);

    const close = () => {
      host.classList.remove("show");
      host.setAttribute("aria-hidden", "true");
      setTimeout(() => host.remove(), 180);
      markWelcomeSeen(username);
    };

    host.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.classList.contains("modalBackdrop")) close();
      if (t.getAttribute("data-close-temp") === "1") close();
    });

    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") close();
      },
      { once: true }
    );
  }

  async function doLogin({ username, password, isGuest }) {
    setLoginError("");

    // Prevent the loading screen from trapping: short timeout and always hide on error.
    showLoading("Signing in…", "Verifying credentials", 5500);

    try {
      const payload = await api("/api/auth/login", {
        method: "POST",
        body: {
          username: username || "",
          password: password || "",
          guest: !!isGuest,
          client: {
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
            ua: navigator.userAgent || null,
            lang: navigator.language || null,
          },
        },
      });

      if (!payload || !payload.ok || !payload.token) {
        throw new Error((payload && payload.error) || "Login failed");
      }

      APP.auth.token = payload.token;
      APP.auth.user = payload.user || { username };
      localStorage.setItem(APP.storageKeys.token, APP.auth.token);
      localStorage.setItem(APP.storageKeys.username, APP.auth.user.username);

      // Switch to app view quickly; do not keep loading overlay.
      hideLoading();

      showAppView();
      renderProfile(APP.auth.user);

      // Connect sockets after auth so server can attach session correctly
      connectSocket();

      // Pull initial app data
      await bootstrapApp();

      // New-user welcome
      showWelcomePopupIfNeeded(!!payload.isNew, APP.auth.user.username);

      toast("Logged in.", "info", 1600);
    } catch (err) {
      hideLoading(true);
      setLoginError(err && err.message ? err.message : "Login failed");
      toast(err && err.message ? err.message : "Login failed", "error", 4200);
    }
  }

  /* ----------------------------- Bootstrap App ------------------------------ */

  async function bootstrapApp() {
    // Everything here must be resilient: no hard failures that break the app.
    // Show a short loading overlay, then hide no matter what.
    showLoading("Loading…", "Preparing your chats", 5000);

    try {
      // 1) Fetch user profile (badges/stats/levels)
      const me = await api("/api/me");
      if (me && me.user) {
        APP.auth.user = me.user;
        renderProfile(me.user);
      }

      // 2) Load global history
      await loadGlobalHistory();

      // 3) Load inbox count
      try {
        const n = await api("/api/inbox/count");
        renderInboxBadge(n && typeof n.count === "number" ? n.count : 0);
      } catch {
        renderInboxBadge(0);
      }

      // 4) Ask online count
      try {
        if (APP.socket && APP.socket.connected) APP.socket.emit("online:get");
      } catch {}

    } finally {
      hideLoading(true);
    }
  }

  async function loadGlobalHistory() {
    // Prefer socket history (fast), fallback to REST.
    if (APP.socket && APP.socket.connected) {
      return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(async () => {
          if (done) return;
          done = true;
          try {
            const hist = await api("/api/global/history?limit=80");
            renderGlobalHistory(hist && Array.isArray(hist.items) ? hist.items : []);
          } catch {
            renderGlobalHistory([]);
          }
          resolve();
        }, 900);

        APP.socket.emit("global:history", { limit: 80 }, (ack) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const items = ack && Array.isArray(ack.items) ? ack.items : [];
          renderGlobalHistory(items);
          resolve();
        });
      });
    }

    try {
      const hist = await api("/api/global/history?limit=80");
      renderGlobalHistory(hist && Array.isArray(hist.items) ? hist.items : []);
    } catch {
      renderGlobalHistory([]);
    }
  }

  /* -------------------------- Sending Global Messages ------------------------ */

  function getLastLinkAt() {
    const v = localStorage.getItem(APP.storageKeys.lastLinkAt);
    const n = v ? Number(v) : 0;
    return Number.isFinite(n) ? n : 0;
  }

  function setLastLinkAt(ts) {
    localStorage.setItem(APP.storageKeys.lastLinkAt, String(ts));
  }

  function canSendLinkNow() {
    const last = getLastLinkAt();
    if (!last) return true;
    return now() - last >= APP.linkLimitMs;
  }

  function linkTimeLeftMs() {
    const last = getLastLinkAt();
    if (!last) return 0;
    return Math.max(0, APP.linkLimitMs - (now() - last));
  }

  function isCooldownActive() {
    return APP.cooldown.active && APP.cooldown.msLeft > 0;
  }

  async function sendGlobalMessage(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return;

    if (trimmed.length > APP.maxMessageLen) {
      toast(`Message too long (max ${APP.maxMessageLen}).`, "error", 3200);
      return;
    }

    // Local cooldown enforcement (server should enforce too)
    if (isCooldownActive()) {
      shakeCooldownBar();
      toast("Slow down. Cooldown active.", "error", 2200);
      return;
    }

    // Client-side link rate limit
    const url = extractFirstUrl(trimmed);
    if (url) {
      if (!canSendLinkNow()) {
        const left = linkTimeLeftMs();
        shakeCooldownBar();
        toast(`Link cooldown: ${Math.ceil(left / 1000)}s left.`, "error", 3200);
        return;
      }
    }

    // Optimistic local render
    const optimistic = {
      user: APP.auth.user ? APP.auth.user.username : "me",
      text: trimmed,
      ts: now(),
      url: url || null,
      _optimistic: true,
    };

    // If server shadow-mutes, we still display locally; mark subtle after ack.
    appendGlobalMessage(optimistic, { incoming: false });

    // Begin cooldown immediately for smooth UX (server can override)
    // Default to 3.5s if server does not return.
    startCooldown(3500);

    // Send to server (socket preferred; fallback to REST)
    try {
      let ack = null;

      if (APP.socket && APP.socket.connected) {
        ack = await new Promise((resolve, reject) => {
          APP.socket.emit(
            "global:send",
            { text: trimmed },
            (resp) => {
              if (!resp) return resolve(null);
              if (resp.ok) return resolve(resp);
              reject(new Error(resp.error || "Send failed"));
            }
          );
        });
      } else {
        ack = await api("/api/global/send", { method: "POST", body: { text: trimmed } });
      }

      // Link limit tracking
      if (url) setLastLinkAt(now());

      // Server cooldown override
      if (ack && typeof ack.cooldownMs === "number") {
        startCooldown(clamp(ack.cooldownMs, 250, 300000));
      } else {
        // Keep the previously started cooldown, but ensure it is not infinite.
        if (APP.cooldown.msTotal > 15000) startCooldown(3500);
      }

      // Shadow mute: server may say {shadow:true}; we don’t announce loudly.
      if (ack && ack.shadow === true) {
        // Mark the last optimistic element subtle if possible
        const last = dom.globalList && dom.globalList.lastElementChild;
        if (last && last.classList.contains("gmsg")) {
          last.style.opacity = "0.72";
        }
      }

      // If server returns canonical message id/timestamp, do nothing (server will broadcast or not).
      // We already rendered optimistic; server broadcast will append another.
      // To avoid duplicates, server.js should include message ids and the client can dedupe later if needed.

    } catch (err) {
      // Stop cooldown if send fails
      stopCooldown();
      shakeCooldownBar();
      toast(err && err.message ? err.message : "Send failed", "error", 4200);
    }
  }

  /* ------------------------------ Settings: Blocks --------------------------- */

  function renderBlockedList(items) {
    dom.blockedList.innerHTML = "";
    const arr = Array.isArray(items) ? items : [];

    if (arr.length === 0) {
      const empty = document.createElement("div");
      empty.className = "subText";
      empty.textContent = "No blocked users.";
      dom.blockedList.appendChild(empty);
      return;
    }

    for (const it of arr) {
      const row = document.createElement("div");
      row.className = "subCard";
      row.style.padding = "10px 12px";

      const top = document.createElement("div");
      top.className = "row gap10";

      const name = document.createElement("div");
      name.className = "subTitle";
      name.textContent = it && it.username ? String(it.username) : "unknown";

      const spacer = document.createElement("div");
      spacer.className = "spacer";

      const btn = document.createElement("button");
      btn.className = "btn btnPrimary btnSmall";
      btn.type = "button";
      btn.textContent = "Unblock";

      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api("/api/blocks/unblock", { method: "POST", body: { username: name.textContent } });
          toast(`Unblocked ${name.textContent}`, "info", 2200);
          await loadBlockedUsers();
        } catch (e) {
          toast(e && e.message ? e.message : "Failed to unblock", "error", 3500);
          btn.disabled = false;
        }
      });

      top.appendChild(name);
      top.appendChild(spacer);
      top.appendChild(btn);

      const meta = document.createElement("div");
      meta.className = "subText";
      meta.textContent = `Blocked on: ${it && it.blockedAt ? fmtDate(it.blockedAt) : "—"}`;

      row.appendChild(top);
      row.appendChild(meta);

      dom.blockedList.appendChild(row);
    }
  }

  async function loadBlockedUsers() {
    try {
      const data = await api("/api/blocks");
      renderBlockedList(data && Array.isArray(data.items) ? data.items : []);
    } catch (e) {
      renderBlockedList([]);
      toast(e && e.message ? e.message : "Failed to load blocked users", "error", 3800);
    }
  }

  /* ------------------------- Settings: Security Analytics -------------------- */

  function renderSecurityOverview(data) {
    const history = (data && Array.isArray(data.loginHistory) ? data.loginHistory : []) || [];
    const sessions = (data && Array.isArray(data.sessions) ? data.sessions : []) || [];
    const events = (data && Array.isArray(data.events) ? data.events : []) || [];

    dom.loginHistory.innerHTML = "";
    dom.sessionList.innerHTML = "";
    dom.securityEvents.innerHTML = "";

    const mkLine = (t1, t2) => {
      const line = document.createElement("div");
      line.className = "subCard";
      line.style.padding = "10px 12px";
      const a = document.createElement("div");
      a.className = "subTitle";
      a.textContent = t1;
      const b = document.createElement("div");
      b.className = "subText";
      b.textContent = t2;
      line.appendChild(a);
      line.appendChild(b);
      return line;
    };

    if (!history.length) dom.loginHistory.appendChild(mkLine("No login history", "—"));
    for (const h of history.slice(0, 12)) {
      dom.loginHistory.appendChild(
        mkLine(
          `${h.when ? fmtDate(h.when) : "—"} • ${h.ip || "—"}`,
          `${(h.ua || "").slice(0, 120) || "—"}`
        )
      );
    }

    if (!sessions.length) dom.sessionList.appendChild(mkLine("No sessions", "—"));
    for (const s of sessions.slice(0, 10)) {
      const row = document.createElement("div");
      row.className = "subCard";
      row.style.padding = "10px 12px";

      const top = document.createElement("div");
      top.className = "row gap10";
      const title = document.createElement("div");
      title.className = "subTitle";
      title.textContent = s.current ? "Current session" : "Session";
      const spacer = document.createElement("div");
      spacer.className = "spacer";

      const revoke = document.createElement("button");
      revoke.className = "btn btnGhost btnSmall";
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.disabled = !!s.current;

      revoke.addEventListener("click", async () => {
        revoke.disabled = true;
        try {
          await api("/api/security/revoke-session", { method: "POST", body: { sessionId: s.id } });
          toast("Session revoked.", "info", 2200);
          await loadSecurityOverview();
        } catch (e) {
          toast(e && e.message ? e.message : "Failed to revoke", "error", 3800);
          revoke.disabled = false;
        }
      });

      top.appendChild(title);
      top.appendChild(spacer);
      top.appendChild(revoke);

      const meta = document.createElement("div");
      meta.className = "subText";
      meta.textContent = `IP: ${s.ip || "—"} • Last: ${s.lastSeen ? fmtTime(s.lastSeen) : "—"}`;

      row.appendChild(top);
      row.appendChild(meta);
      dom.sessionList.appendChild(row);
    }

    if (!events.length) dom.securityEvents.appendChild(mkLine("No security events", "—"));
    for (const ev of events.slice(0, 12)) {
      dom.securityEvents.appendChild(
        mkLine(
          `${ev.type || "event"} • ${ev.when ? fmtDate(ev.when) : "—"}`,
          `${ev.detail || "—"}`
        )
      );
    }
  }

  async function loadSecurityOverview() {
    showLoading("Loading…", "Fetching security analytics", 4500);
    try {
      const data = await api("/api/security/overview");
      renderSecurityOverview(data || {});
    } catch (e) {
      toast(e && e.message ? e.message : "Failed to load security analytics", "error", 4200);
    } finally {
      hideLoading(true);
    }
  }

  /* -------------------------- Group Manage (UI only) ------------------------- */

  function setManageVisibility() {
    // Requested: Manage button next to group chat name.
    // Only show it when in group context.
    if (APP.chatCtx.type === "group") dom.manageBtn.style.display = "";
    else dom.manageBtn.style.display = "none";
  }

  function updateLimitPill() {
    if (!dom.limitSlider || !dom.limitValue) return;
    dom.limitValue.textContent = String(dom.limitSlider.value);
  }

  async function saveGroupLimit() {
    if (APP.chatCtx.type !== "group") return;
    if (!APP.chatCtx.isOwner) {
      toast("Only the group owner can change the limit.", "error", 3200);
      return;
    }
    const limit = Number(dom.limitSlider.value || 0);
    dom.saveLimitBtn.disabled = true;
    try {
      await api(`/api/groups/${encodeURIComponent(APP.chatCtx.id)}/limit`, {
        method: "POST",
        body: { limit },
      });
      toast("Limit updated.", "info", 2200);
    } catch (e) {
      toast(e && e.message ? e.message : "Failed to update limit", "error", 4200);
    } finally {
      dom.saveLimitBtn.disabled = false;
    }
  }

  async function addGroupMember() {
    if (APP.chatCtx.type !== "group") return;
    if (!APP.chatCtx.isOwner) {
      toast("Only the group owner can add members.", "error", 3200);
      return;
    }
    const u = String(dom.addMemberInput.value || "").trim();
    if (!u) return;
    dom.addMemberBtn.disabled = true;
    try {
      await api(`/api/groups/${encodeURIComponent(APP.chatCtx.id)}/members/add`, {
        method: "POST",
        body: { username: u },
      });
      dom.addMemberInput.value = "";
      toast(`Added ${u}`, "info", 2200);
      await loadGroupMembers();
    } catch (e) {
      toast(e && e.message ? e.message : "Failed to add member", "error", 4200);
    } finally {
      dom.addMemberBtn.disabled = false;
    }
  }

  function renderMemberRow(m) {
    const row = document.createElement("div");
    row.className = "subCard";
    row.style.padding = "10px 12px";

    const top = document.createElement("div");
    top.className = "row gap10";

    const name = document.createElement("div");
    name.className = "subTitle";
    name.textContent = m.username || "unknown";

    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = m.role || "member";

    const spacer = document.createElement("div");
    spacer.className = "spacer";

    const muteBtn = document.createElement("button");
    muteBtn.className = "btn btnGhost btnSmall";
    muteBtn.type = "button";
    muteBtn.textContent = m.muted ? "Unmute" : "Mute";

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn btnDanger btnSmall";
    removeBtn.type = "button";
    removeBtn.textContent = "Remove";

    const doMute = async () => {
      if (!APP.chatCtx.isOwner) return toast("Owner only.", "error", 2500);
      muteBtn.disabled = true;
      try {
        await api(`/api/groups/${encodeURIComponent(APP.chatCtx.id)}/members/mute`, {
          method: "POST",
          body: { username: m.username, muted: !m.muted },
        });
        await loadGroupMembers();
      } catch (e) {
        toast(e && e.message ? e.message : "Failed", "error", 3500);
      } finally {
        muteBtn.disabled = false;
      }
    };

    const doRemove = async () => {
      if (!APP.chatCtx.isOwner) return toast("Owner only.", "error", 2500);
      if (!confirm(`Remove ${m.username} from the group?`)) return;
      removeBtn.disabled = true;
      try {
        await api(`/api/groups/${encodeURIComponent(APP.chatCtx.id)}/members/remove`, {
          method: "POST",
          body: { username: m.username },
        });
        await loadGroupMembers();
      } catch (e) {
        toast(e && e.message ? e.message : "Failed", "error", 3500);
      } finally {
        removeBtn.disabled = false;
      }
    };

    muteBtn.addEventListener("click", doMute);
    removeBtn.addEventListener("click", doRemove);

    top.appendChild(name);
    top.appendChild(pill);
    top.appendChild(spacer);
    top.appendChild(muteBtn);
    top.appendChild(removeBtn);

    row.appendChild(top);

    return row;
  }

  async function loadGroupMembers() {
    if (APP.chatCtx.type !== "group") return;
    dom.memberList.innerHTML = "";
    try {
      const data = await api(`/api/groups/${encodeURIComponent(APP.chatCtx.id)}`);
      const members = data && Array.isArray(data.members) ? data.members : [];
      APP.chatCtx.isOwner = !!(data && data.isOwner);
      setManageVisibility();

      // Update slider if server provides limit
      if (data && typeof data.limit === "number") {
        dom.limitSlider.value = String(clamp(data.limit, 2, 50));
        updateLimitPill();
      }

      if (!members.length) {
        const empty = document.createElement("div");
        empty.className = "subText";
        empty.textContent = "No members found.";
        dom.memberList.appendChild(empty);
        return;
      }
      for (const m of members) dom.memberList.appendChild(renderMemberRow(m));
    } catch (e) {
      toast(e && e.message ? e.message : "Failed to load group", "error", 4200);
      const empty = document.createElement("div");
      empty.className = "subText";
      empty.textContent = "Failed to load members.";
      dom.memberList.appendChild(empty);
    }
  }

  /* ------------------------------ Event Wiring ------------------------------ */

  function wireLoginEvents() {
    dom.loginBtn.addEventListener("click", () => {
      const u = String(dom.username.value || "").trim();
      const p = String(dom.password.value || "");
      if (!u) return setLoginError("Enter a username.");
      if (!p) return setLoginError("Enter a password.");
      doLogin({ username: u, password: p, isGuest: false });
    });

    dom.guestBtn.addEventListener("click", () => {
      const u = String(dom.username.value || "").trim() || `guest_${Math.random().toString(16).slice(2, 8)}`;
      doLogin({ username: u, password: "guest", isGuest: true });
    });

    // Enter to submit
    [dom.username, dom.password].forEach((el) => {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") dom.loginBtn.click();
      });
    });
  }

  function wireTopbarEvents() {
    dom.settingsBtn.addEventListener("click", () => openModal(dom.settingsModal));
    dom.inboxBtn.addEventListener("click", async () => {
      // Placeholder: you can implement inbox view later.
      toast("Inbox view coming soon.", "info", 2200);
    });
  }

  function wireNavEvents() {
    dom.navGlobalBtn.addEventListener("click", async () => {
      APP.chatCtx = { type: "global", id: "global", name: "Global Chat", isOwner: false };
      setManageVisibility();
      toast("Global chat.", "info", 1200);
      await loadGlobalHistory();
    });

    dom.navGroupsBtn.addEventListener("click", () => {
      toast("Groups UI is in progress. Use Manage inside a group chat.", "info", 2800);
    });

    dom.navDMsBtn.addEventListener("click", () => {
      toast("DMs UI is in progress.", "info", 2200);
    });
  }

  function wireChatEvents() {
    dom.globalSendBtn.addEventListener("click", () => {
      const text = dom.globalInput.value;
      dom.globalInput.value = "";
      sendGlobalMessage(text);
    });

    dom.globalInput.addEventListener("keydown", (e) => {
      // Enter to send, Shift+Enter for newline
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        dom.globalSendBtn.click();
      }
    });

    dom.globalList.addEventListener(
      "scroll",
      () => {
        APP.ui.isAtBottom = isNearBottom(dom.globalList);
        APP.ui.lastScrollAt = now();
      },
      { passive: true }
    );
  }

  function wireSettingsEvents() {
    dom.toggleCursorBtn.addEventListener("click", () => {
      if (cursorEnabled) disableCursor();
      else enableCursor();
      dom.toggleCursorBtn.textContent = cursorEnabled ? "Custom Cursor: ON" : "Custom Cursor";
    });

    dom.toggleMobileUXBtn.addEventListener("click", () => {
      setMobileUX(!APP.feature.mobileUXEnabled);
      dom.toggleMobileUXBtn.textContent = APP.feature.mobileUXEnabled ? "Mobile UX Mode: ON" : "Mobile UX Mode";
    });

    dom.blockedUsersBtn.addEventListener("click", async () => {
      openModal(dom.blockedModal);
      await loadBlockedUsers();
    });

    dom.securityBtn.addEventListener("click", async () => {
      openModal(dom.securityModal);
      await loadSecurityOverview();
    });

    dom.changePasswordBtn.addEventListener("click", async () => {
      const pw = prompt("Enter a new password:");
      if (!pw) return;
      showLoading("Updating…", "Changing password", 5000);
      try {
        await api("/api/security/change-password", { method: "POST", body: { password: pw } });
        toast("Password updated.", "info", 2200);
      } catch (e) {
        toast(e && e.message ? e.message : "Failed to change password", "error", 4200);
      } finally {
        hideLoading(true);
      }
    });

    dom.changeUsernameBtn.addEventListener("click", async () => {
      const nu = prompt("Enter a new username:");
      if (!nu) return;
      showLoading("Updating…", "Changing username", 5000);
      try {
        const res = await api("/api/security/change-username", { method: "POST", body: { username: nu } });
        // Update locally
        if (res && res.user) {
          APP.auth.user = res.user;
          localStorage.setItem(APP.storageKeys.username, res.user.username);
          renderProfile(res.user);
        }
        toast("Username updated.", "info", 2200);
      } catch (e) {
        toast(e && e.message ? e.message : "Failed to change username", "error", 4200);
      } finally {
        hideLoading(true);
      }
    });

    dom.logoutBtn.addEventListener("click", () => logoutToLogin());
  }

  function wireManageEvents() {
    dom.manageBtn.addEventListener("click", async () => {
      if (APP.chatCtx.type !== "group") {
        toast("Manage is available inside a group chat.", "info", 2400);
        return;
      }
      openModal(dom.manageModal);
      await loadGroupMembers();
    });

    dom.limitSlider.addEventListener("input", updateLimitPill);
    dom.saveLimitBtn.addEventListener("click", saveGroupLimit);
    dom.addMemberBtn.addEventListener("click", addGroupMember);

    dom.transferOwnerBtn.addEventListener("click", async () => {
      if (APP.chatCtx.type !== "group") return;
      if (!APP.chatCtx.isOwner) return toast("Owner only.", "error", 2500);
      const u = prompt("Transfer ownership to which username?");
      if (!u) return;
      showLoading("Updating…", "Transferring ownership", 6000);
      try {
        await api(`/api/groups/${encodeURIComponent(APP.chatCtx.id)}/transfer`, {
          method: "POST",
          body: { username: u },
        });
        toast("Ownership transferred.", "info", 2600);
        await loadGroupMembers();
      } catch (e) {
        toast(e && e.message ? e.message : "Failed", "error", 4200);
      } finally {
        hideLoading(true);
      }
    });

    dom.deleteGroupBtn.addEventListener("click", async () => {
      if (APP.chatCtx.type !== "group") return;
      if (!APP.chatCtx.isOwner) return toast("Owner only.", "error", 2500);
      if (!confirm("Delete this group chat? This cannot be undone.")) return;
      showLoading("Deleting…", "Removing group chat", 7000);
      try {
        await api(`/api/groups/${encodeURIComponent(APP.chatCtx.id)}`, { method: "DELETE" });
        toast("Group deleted.", "info", 2600);
        closeModal(dom.manageModal);
        APP.chatCtx = { type: "global", id: "global", name: "Global Chat", isOwner: false };
        setManageVisibility();
        await loadGlobalHistory();
      } catch (e) {
        toast(e && e.message ? e.message : "Failed", "error", 4200);
      } finally {
        hideLoading(true);
      }
    });
  }

  /* ------------------------------ Startup / Auto-login ----------------------- */

  async function attemptAutoLogin() {
    if (!loadSavedAuth()) return;

    // We do not show a long loading overlay here; keep it minimal.
    showLoading("Restoring session…", "Signing you back in", 5000);

    try {
      // Validate token quickly
      const me = await api("/api/me");
      if (!me || !me.user) throw new Error("Session invalid");
      APP.auth.user = me.user;

      showAppView();
      renderProfile(me.user);
      connectSocket();
      await bootstrapApp();
      toast("Session restored.", "info", 1600);
    } catch {
      hideLoading(true);
      clearAuth();
      showLoginView();
    }
  }

  /* --------------------------------- Init ---------------------------------- */

  function initUIState() {
    // Defaults
    renderInboxBadge(0);
    setManageVisibility();
    updateLimitPill();

    // Button labels reflecting prefs
    dom.toggleCursorBtn.textContent = cursorEnabled ? "Custom Cursor: ON" : "Custom Cursor";
    dom.toggleMobileUXBtn.textContent = APP.feature.mobileUXEnabled ? "Mobile UX Mode: ON" : "Mobile UX Mode";
  }

  function hardOverlayFailsafe() {
    // Absolute safety: if overlay is visible for too long, hide it.
    setInterval(() => {
      if (!dom.loadingOverlay) return;
      if (dom.loadingOverlay.classList.contains("show")) {
        // If it has been visible beyond our failsafe, hide it.
        // We don’t store time; just ensure user can’t be trapped.
        hideLoading(true);
      }
    }, 15000);
  }

  async function init() {
    wireBackdropClose();
    wireCursorEvents();
    initCursorFromPrefs();
    initMobileUXFromPrefs();

    wireLoginEvents();
    wireTopbarEvents();
    wireNavEvents();
    wireChatEvents();
    wireSettingsEvents();
    wireManageEvents();

    initUIState();
    hardOverlayFailsafe();

    // Always send page hello for bot identification (server logs IP)
    sendPageHello();

    // Auto login if token exists
    await attemptAutoLogin();

    // If not logged in, ensure we are in login view.
    if (!APP.auth.token) showLoginView();

    // Reduce accidental stuck states
    hideLoading(true);
  }

  // Start after DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
