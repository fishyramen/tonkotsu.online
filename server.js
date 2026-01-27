"use strict";

(() => {
  if (window.__TONKOTSU_LOADED__) return;
  window.__TONKOTSU_LOADED__ = true;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const now = () => Date.now();
  const esc = (s) =>
    String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");

  const dom = {
    loginWrap: $("#loginWrap"),
    loginUser: $("#loginUser"),
    loginPass: $("#loginPass"),
    loginMsg: $("#loginMsg"),
    btnLogin: $("#btnLogin"),
    btnGuest: $("#btnGuest"),

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

    msgInput: $("#msgInput"),
    btnSend: $("#btnSend"),

    onlineUsers: $("#onlineUsers"),
    onlineCount: $("#onlineCount"),

    backdrop: $("#backdrop"),
    modalTitle: $("#modalTitle"),
    modalBody: $("#modalBody"),
    modalFoot: $("#modalFoot"),
    modalClose: $("#modalClose"),

    cursor: $("#cursor"),
  };

  const state = {
    token: localStorage.getItem("tk_token"),
    user: JSON.parse(localStorage.getItem("tk_user") || "null"),
    socket: null,
    threads: {},
    active: "global",
    dedupe: new Set(),
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : null,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "API error");
    return data;
  }

  function showLogin() {
    dom.app.style.display = "none";
    dom.loginWrap.style.display = "flex";
  }

  function showApp() {
    dom.loginWrap.style.display = "none";
    dom.app.style.display = "block";
  }

  async function afterAuth() {
    const boot = await api("/api/state/bootstrap");
    state.user = boot.me;
    localStorage.setItem("tk_user", JSON.stringify(boot.me));

    state.threads = { global: { name: "Global", messages: boot.global.messages } };
    renderThreads();
    renderMessages("global");

    connectSocket();
    showApp();
  }

  async function doLogin() {
    dom.loginMsg.textContent = "Signing in...";
    try {
      const r = await api("/api/auth/login", {
        method: "POST",
        body: {
          username: dom.loginUser.value.trim(),
          password: dom.loginPass.value,
        },
      });
      state.token = r.token;
      state.user = r.user;
      localStorage.setItem("tk_token", r.token);
      localStorage.setItem("tk_user", JSON.stringify(r.user));
      await afterAuth();
    } catch (e) {
      dom.loginMsg.textContent = e.message;
    }
  }

  async function doGuest() {
    dom.loginMsg.textContent = "Joining as guest...";
    try {
      const r = await api("/api/auth/guest", { method: "POST" });
      state.token = r.token;
      state.user = r.user;
      localStorage.setItem("tk_token", r.token);
      localStorage.setItem("tk_user", JSON.stringify(r.user));
      await afterAuth();
    } catch (e) {
      dom.loginMsg.textContent = e.message;
    }
  }

  async function doLogout() {
    await api("/api/auth/logout").catch(() => {});
    localStorage.removeItem("tk_token");
    localStorage.removeItem("tk_user");
    location.reload();
  }

  dom.btnLogin.onclick = doLogin;
  dom.btnGuest.onclick = doGuest;
  dom.btnLogout.onclick = doLogout;

  function connectSocket() {
    state.socket = io({
      auth: { token: state.token },
    });

    state.socket.on("message:new", (m) => {
      if (state.dedupe.has(m.id)) return;
      state.dedupe.add(m.id);
      if (!state.threads[m.scope]) {
        state.threads[m.scope] = { name: m.scope, messages: [] };
      }
      state.threads[m.scope].messages.push(m);
      if (state.active === m.scope) renderMessages(m.scope);
      renderThreads();
    });

    state.socket.on("users:online", ({ users, count }) => {
      dom.onlineCount.textContent = count;
      renderOnline(users);
    });
  }

  function renderThreads() {
    dom.threadList.innerHTML = "";
    for (const [k, t] of Object.entries(state.threads)) {
      const el = document.createElement("div");
      el.className = "thread" + (state.active === k ? " active" : "");
      el.innerHTML = `
        <div class="threadName">${esc(t.name || k)}</div>
        <div class="threadLast">${esc(t.messages.at(-1)?.text || "")}</div>
        <div class="pingDot"></div>
      `;
      el.onclick = () => {
        state.active = k;
        renderThreads();
        renderMessages(k);
      };
      dom.threadList.appendChild(el);
    }
  }

  function renderMessages(k) {
    dom.centerBody.innerHTML = "";
    const t = state.threads[k];
    if (!t) return;

    for (const m of t.messages) {
      const el = document.createElement("div");
      el.className = "msg";
      el.innerHTML = `
        <div class="msgTop">
          <div class="msgUser">${esc(m.user.username)}</div>
          <div class="msgTime">${new Date(m.ts).toLocaleTimeString()}</div>
        </div>
        <div class="msgBody">${esc(m.text)}</div>
      `;
      dom.centerBody.appendChild(el);
    }
    dom.centerBody.scrollTop = dom.centerBody.scrollHeight;
  }

  dom.btnSend.onclick = async () => {
    const text = dom.msgInput.value.trim();
    if (!text) return;

    dom.msgInput.value = "";
    const r = await api("/api/messages/send", {
      method: "POST",
      body: { scope: "global", text, clientId: crypto.randomUUID() },
    }).catch(() => null);
  };

  function renderOnline(users) {
    dom.onlineUsers.innerHTML = "";
    for (const u of users) {
      const el = document.createElement("div");
      el.className = "userRow";
      el.innerHTML = `
        <div class="userTop">
          <div class="who">
            <div class="dot ${u.mode || ""}"></div>
            <div class="nameCol">
              <div class="uname">${esc(u.username)}</div>
              <div class="uStatus">${esc(u.statusText || "")}</div>
            </div>
          </div>
          <div class="badges">
            ${(u.badges || [])
              .map((b) => `<span class="badge ${b}">${b}</span>`)
              .join("")}
          </div>
        </div>
      `;
      dom.onlineUsers.appendChild(el);
    }
  }

  if (state.token) {
    afterAuth().catch(showLogin);
  } else {
    showLogin();
  }
})();
