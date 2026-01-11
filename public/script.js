/* tonkotsu.online — client */
const socket = io();

const el = (id) => document.getElementById(id);

const sidebar = el("sidebar");
const panel = el("panel");
const chatBox = el("chatBox");
const chatTitle = el("chatTitle");
const chatSubtitle = el("chatSubtitle");

const loginOverlay = el("loginOverlay");
const loginCard = el("loginCard");
const loading = el("loading");

const usernameInput = el("username");
const passwordInput = el("password");
const loginBtn = el("loginBtn");
const guestBtn = el("guestBtn");

const messageInput = el("messageInput");
const sendBtn = el("sendBtn");
const emojiToggle = el("emojiToggle");
const emojiPicker = el("emojiPicker");

const meLabel = el("meLabel");
const statusLabel = el("statusLabel");

const threadsList = el("threadsList");
const onlineList = el("onlineList");
const onlineCount = el("onlineCount");

const settingsBtn = el("settingsBtn");
const settingsBg = el("settingsBg");
const settingsClose = el("settingsClose");
const settingsSave = el("settingsSave");
const settingsGrid = el("settingsGrid");

const inboxBtn = el("inboxBtn");
const inboxBg = el("inboxBg");
const inboxClose = el("inboxClose");
const inboxBody = el("inboxBody");
const inboxBadge = el("inboxBadge");

const authBtn = el("authBtn");
el("year").textContent = new Date().getFullYear();

let me = null;
let isGuest = false;
let myColor = "#fff";
let state = null;

let view = { kind: "global", target: null }; // global | dm | group
let lastSendAt = 0;
const COOLDOWN_MS = 3000;

// Local UI mutes (stored in account settings server-side; for guest keep local)
let settings = {
  sound: true,
  volume: 0.18,
  muteAll: false,
  muteGlobal: true,
  toast: true,
  reduceMotion: false,
  showTimestamps: true,
  autoscroll: true,
  enterToSend: true,
  customCursor: true,
  dmProfanityFilter: false,
};

// Inbox items
let inbox = { incoming: [], outgoing: [] };
let unreadMap = {}; // { userOrGroupId: count }

// ------- small helpers -------
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function fmtTime(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function toast(type, msg) {
  if (!settings.toast) return;
  const box = el("toasts");
  const t = document.createElement("div");
  t.className = "toast";
  const title =
    type === "ok" ? "Done" :
    type === "info" ? "Info" :
    type === "warn" ? "Warning" : "Notice";
  t.innerHTML = `<div class="t">${title}</div><div class="m">${msg}</div>`;
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; }, 2400);
  setTimeout(() => { t.remove(); }, 2800);
}

function showLoading(on) {
  loading.classList.toggle("show", !!on);
}

function showLogin(on) {
  loginOverlay.style.display = on ? "flex" : "none";
  if (on) requestAnimationFrame(() => loginCard.classList.add("show"));
  else loginCard.classList.remove("show");
}

function showApp(on) {
  sidebar.classList.toggle("show", !!on);
  panel.classList.toggle("show", !!on);
}

function clearChat() {
  chatBox.innerHTML = "";
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function renderMsg({ user, text, ts, color, you }) {
  const wrap = document.createElement("div");
  wrap.className = "msg" + (you ? " you" : "");
  const u = escapeHTML(user);
  const t = escapeHTML(text);
  const time = settings.showTimestamps ? fmtTime(ts) : "";
  const timeHtml = settings.showTimestamps ? `<span class="time">${time}</span>` : "";

  wrap.innerHTML = `
    <div class="meta">
      <span class="user" style="color:${color || "#fff"}">${u}${you ? " (You)" : ""}</span>
      ${timeHtml}
    </div>
    <div class="text">${t}</div>
  `;
  chatBox.appendChild(wrap);
  if (settings.autoscroll) chatBox.scrollTop = chatBox.scrollHeight;
}

function ping() {
  if (!settings.sound || settings.muteAll) return;
  try {
    // simple “discord-ish” short ping using WebAudio
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.value = clamp(settings.volume, 0, 0.8);
    o.connect(g); g.connect(ctx.destination);
    o.start();
    o.frequency.setValueAtTime(660, ctx.currentTime + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.14);
    o.stop(ctx.currentTime + 0.15);
    setTimeout(() => ctx.close(), 180);
  } catch {}
}

// ------- emoji picker -------
const EMOJIS = "😀 😁 😂 🤣 😅 😊 🙂 😉 😎 🤝 👍 👀 🔥 💀 💯 ❤️ 🖤 🤍 ⭐️ ✨ ✅ ❌ ⚠️ 🎉 😭 😤 😈 🤔 🙏".split(" ");
function buildEmojiPicker() {
  emojiPicker.innerHTML = "";
  EMOJIS.forEach(e => {
    const b = document.createElement("div");
    b.className = "emo";
    b.textContent = e;
    b.onclick = () => {
      messageInput.value += e;
      messageInput.focus();
    };
    emojiPicker.appendChild(b);
  });
}
buildEmojiPicker();

emojiToggle.addEventListener("click", () => {
  emojiPicker.classList.toggle("show");
});
document.addEventListener("click", (ev) => {
  if (!emojiPicker.contains(ev.target) && ev.target !== emojiToggle) {
    emojiPicker.classList.remove("show");
  }
});

// ------- custom cursor + faster short trail -------
const cursorDot = el("cursorDot");
const cursorTrail = el("cursorTrail");
let cursorOn = true;

let mx = 0, my = 0;
let tx = 0, ty = 0;

function applyCursor() {
  cursorOn = !!settings.customCursor && !settings.reduceMotion;
  cursorDot.style.display = cursorOn ? "block" : "none";
  cursorTrail.style.display = cursorOn ? "block" : "none";
  document.body.style.cursor = cursorOn ? "none" : "auto";
}
applyCursor();

window.addEventListener("mousemove", (e) => {
  mx = e.clientX; my = e.clientY;
  if (cursorOn) {
    cursorDot.style.transform = `translate(${mx}px, ${my}px) translate(-50%,-50%)`;
  }
});

function trailLoop() {
  if (cursorOn) {
    // faster + shorter trail
    tx += (mx - tx) * 0.35;
    ty += (my - ty) * 0.35;
    cursorTrail.style.transform = `translate(${tx}px, ${ty}px) translate(-50%,-50%)`;
  }
  requestAnimationFrame(trailLoop);
}
trailLoop();

// ------- settings UI -------
const SETTINGS_SPEC = [
  { key:"sound", label:"Sound", type:"toggle", hint:"Play pings for messages & inbox events." },
  { key:"volume", label:"Volume", type:"range", min:0, max:0.6, step:0.01, hint:"Controls ping loudness." },
  { key:"muteAll", label:"Mute all", type:"toggle", hint:"Disables all pings." },
  { key:"muteGlobal", label:"Mute global pings", type:"toggle", hint:"Global chat pings off by default." },
  { key:"toast", label:"Pop-up notifications", type:"toggle", hint:"Nice toasts like “logged in” etc." },
  { key:"reduceMotion", label:"Reduce animations", type:"toggle", hint:"Cuts motion & disables cursor trail." },
  { key:"showTimestamps", label:"Show timestamps", type:"toggle", hint:"Show time next to messages." },
  { key:"autoscroll", label:"Auto-scroll", type:"toggle", hint:"Always scroll to latest message." },
  { key:"enterToSend", label:"Enter to send", type:"toggle", hint:"Enter sends; Shift+Enter for newline." },
  { key:"customCursor", label:"Custom cursor", type:"toggle", hint:"Hide cursor + subtle fast trail." },
  { key:"dmProfanityFilter", label:"Hide bad words in DMs", type:"toggle", hint:"DMs are less strict, but you can hide content." },
];

function renderSettings() {
  settingsGrid.innerHTML = "";
  SETTINGS_SPEC.forEach(s => {
    const box = document.createElement("div");
    box.className = "set";
    if (s.type === "toggle") {
      const on = !!settings[s.key];
      box.innerHTML = `
        <div class="label">${s.label}</div>
        <div class="toggleRow">
          <div class="pill">${on ? "On" : "Off"}</div>
          <div class="toggle ${on ? "on" : ""}" data-key="${s.key}">
            <div class="knob"></div>
          </div>
        </div>
        <div class="hint">${s.hint}</div>
      `;
    } else if (s.type === "range") {
      box.innerHTML = `
        <div class="label">${s.label}</div>
        <input class="range" type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${settings[s.key]}"/>
        <div class="hint">${s.hint}</div>
      `;
      const r = box.querySelector(".range");
      r.addEventListener("input", () => {
        settings[s.key] = parseFloat(r.value);
      });
    }
    settingsGrid.appendChild(box);
  });

  settingsGrid.querySelectorAll(".toggle").forEach(t => {
    t.addEventListener("click", () => {
      const key = t.getAttribute("data-key");
      settings[key] = !settings[key];
      applyCursor();
      renderSettings();
    });
  });
}

settingsBtn.addEventListener("click", () => {
  renderSettings();
  settingsBg.classList.add("show");
});
settingsClose.addEventListener("click", () => settingsBg.classList.remove("show"));
settingsBg.addEventListener("click", (e) => { if (e.target === settingsBg) settingsBg.classList.remove("show"); });

settingsSave.addEventListener("click", () => {
  applyCursor();
  if (!me || isGuest) {
    toast("info", "Guests have limited settings. Log in to save.");
    settingsBg.classList.remove("show");
    return;
  }
  socket.emit("updateSettings", settings);
  settingsBg.classList.remove("show");
});

// ------- inbox -------
function setInboxBadge(n) {
  if (n > 0) {
    inboxBadge.style.display = "inline-flex";
    inboxBadge.textContent = String(n);
  } else {
    inboxBadge.style.display = "none";
  }
}

function renderInbox() {
  inboxBody.innerHTML = "";
  let count = 0;

  if (!me || isGuest) {
    inboxBody.innerHTML = `<div class="set"><div class="label">Inbox</div><div class="hint">Log in to receive friend requests & group activity.</div></div>`;
    setInboxBadge(0);
    return;
  }

  // Friend requests
  const incoming = state?.incoming || [];
  if (incoming.length) {
    const box = document.createElement("div");
    box.className = "set";
    box.innerHTML = `<div class="label">Friend requests</div>`;
    incoming.forEach(u => {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.gap = "8px";
      row.style.marginTop = "8px";
      row.innerHTML = `
        <div style="flex:1;font-weight:900;">${escapeHTML(u)}</div>
        <button class="miniBtn" data-a="accept" data-u="${escapeHTML(u)}">Accept</button>
        <button class="miniBtn" data-a="decline" data-u="${escapeHTML(u)}">Decline</button>
      `;
      box.appendChild(row);
      count++;
    });
    inboxBody.appendChild(box);
  }

  // Other notifications placeholder
  const info = document.createElement("div");
  info.className = "set";
  info.innerHTML = `<div class="label">Tips</div><div class="hint">Group invites are handled inside groups. More inbox items can be added later.</div>`;
  inboxBody.appendChild(info);

  setInboxBadge(count);
}

inboxBtn.addEventListener("click", () => {
  renderInbox();
  inboxBg.classList.add("show");
});
inboxClose.addEventListener("click", () => inboxBg.classList.remove("show"));
inboxBg.addEventListener("click", (e) => { if (e.target === inboxBg) inboxBg.classList.remove("show"); });

inboxBody.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const a = btn.getAttribute("data-a");
  const u = btn.getAttribute("data-u");
  if (!a || !u) return;
  if (a === "accept") socket.emit("acceptFriend", { user: u });
  if (a === "decline") socket.emit("declineFriend", { user: u });
});

// ------- threads list (global + dms + groups) -------
function setView(kind, target) {
  view = { kind, target };

  clearChat();
  emojiPicker.classList.remove("show");

  if (kind === "global") {
    chatTitle.textContent = "Global Chat";
    chatSubtitle.textContent = "Everyone online can see this";
  } else if (kind === "dm") {
    chatTitle.textContent = `DM with ${target}`;
    chatSubtitle.textContent = "Private messages";
    socket.emit("openDM", { withUser: target });
  } else if (kind === "group") {
    const g = (state?.groups || []).find(x => x.id === target);
    chatTitle.textContent = g ? `Group: ${g.name}` : "Group";
    chatSubtitle.textContent = "Group chat";
    socket.emit("openGroup", { groupId: target });
  }

  renderThreads();
}

function renderThreads() {
  threadsList.innerHTML = "";

  // Global always first
  const g = document.createElement("div");
  g.className = "item";
  g.innerHTML = `
    <div class="leftRow">
      <div class="dot"></div>
      <div class="name">Global Chat</div>
    </div>
    ${(!settings.muteGlobal && unreadMap["global"] ? `<span class="badge">${unreadMap["global"]}</span>` : "")}
  `;
  g.onclick = () => setView("global", null);
  threadsList.appendChild(g);

  // If guest: hide DMs/groups creation
  if (!me || isGuest) return;

  // Groups
  const groups = state?.groups || [];
  groups.forEach(gr => {
    const item = document.createElement("div");
    item.className = "item";
    const unread = unreadMap[gr.id] || 0;
    item.innerHTML = `
      <div class="leftRow">
        <div class="dot"></div>
        <div class="name">${escapeHTML(gr.name)}</div>
      </div>
      ${unread ? `<span class="badge">${unread}</span>` : ""}
    `;
    item.onclick = () => setView("group", gr.id);
    threadsList.appendChild(item);
  });

  // DMs (friends + anyone you have unread with)
  const entries = Object.entries(state?.unread || {});
  const dmUsers = new Set(entries.map(([u]) => u));
  (state?.friends || []).forEach(u => dmUsers.add(u));

  [...dmUsers].sort((a,b)=>a.localeCompare(b)).forEach(u => {
    const unread = state?.unread?.[u] || 0;
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <div class="leftRow">
        <div class="dot"></div>
        <div class="name">${escapeHTML(u)}</div>
      </div>
      ${unread ? `<span class="badge">${unread}</span>` : ""}
    `;
    item.onclick = () => setView("dm", u);
    threadsList.appendChild(item);
  });

  // Create group button
  const create = document.createElement("div");
  create.className = "item";
  create.innerHTML = `
    <div class="leftRow">
      <div class="dot off"></div>
      <div class="name">Create group…</div>
    </div>
    <div class="rowBtns"><span class="pill">Owner only</span></div>
  `;
  create.onclick = () => {
    // simple inline flow using toasts
    const name = prompt("Group name?");
    if (!name) return;
    const members = prompt("Add friends (comma separated usernames)?") || "";
    const list = members.split(",").map(s => s.trim()).filter(Boolean);
    socket.emit("createGroup", { name, members: list });
  };
  threadsList.appendChild(create);
}

// ------- online list -------
function renderOnline(list) {
  onlineList.innerHTML = "";
  onlineCount.textContent = String(list.length);

  list.forEach(u => {
    const item = document.createElement("div");
    item.className = "item";

    const isMe = (me && u.user === me);
    item.innerHTML = `
      <div class="leftRow">
        <div class="dot"></div>
        <div class="name" style="color:${u.color}">${escapeHTML(u.user)}${isMe ? " (You)" : ""}</div>
      </div>
      ${
        (!me || isGuest)
          ? ""
          : `<div class="rowBtns">
              <button class="miniBtn" data-action="friend" data-user="${escapeHTML(u.user)}">Add</button>
            </div>`
      }
    `;

    // click opens DM if already friend (nice flow)
    item.addEventListener("click", (ev) => {
      if (ev.target.closest("button")) return;
      if (!me || isGuest) return;
      const isFriend = (state?.friends || []).includes(u.user);
      if (isFriend) setView("dm", u.user);
    });

    // add friend button
    const btn = item.querySelector("button");
    if (btn) {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const target = btn.getAttribute("data-user");
        if (!target || target === me) return;
        socket.emit("sendFriendRequest", { user: target });
      });
    }

    onlineList.appendChild(item);
  });
}

// ------- send message (cooldown) -------
function canSendNow() {
  const now = Date.now();
  if (now - lastSendAt < COOLDOWN_MS) {
    toast("warn", "Slow down — 3 second cooldown.");
    return false;
  }
  lastSendAt = now;
  return true;
}

function sendCurrent() {
  const text = messageInput.value.trim();
  if (!text) return;

  if (!canSendNow()) return;

  if (view.kind === "global") {
    socket.emit("sendGlobal", { text });
  } else if (view.kind === "dm") {
    socket.emit("sendDM", { to: view.target, text });
  } else if (view.kind === "group") {
    socket.emit("sendGroup", { groupId: view.target, text });
  }

  messageInput.value = "";
  messageInput.focus();
}

sendBtn.addEventListener("click", sendCurrent);

messageInput.addEventListener("keydown", (e) => {
  if (!settings.enterToSend) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendCurrent();
  }
});

// ------- auth button behavior -------
function setAuthButton() {
  if (!me) {
    authBtn.textContent = "Log in";
    return;
  }
  if (isGuest) authBtn.textContent = "Log in";
  else authBtn.textContent = "Log out";
}
authBtn.addEventListener("click", () => {
  if (!me || isGuest) {
    // show login overlay
    showLogin(true);
    return;
  }
  // logout transition
  showLoading(true);
  setTimeout(() => {
    socket.emit("logout");
    window.location.reload();
  }, settings.reduceMotion ? 200 : 550);
});

// ------- login flow -------
function doLogin(user, pass) {
  showLogin(false);
  showLoading(true);
  socket.emit("login", { user, pass });
}

loginBtn.addEventListener("click", () => {
  const u = usernameInput.value.trim();
  const p = passwordInput.value;
  doLogin(u, p);
});
guestBtn.addEventListener("click", () => doLogin("", ""));

showLogin(true);
requestAnimationFrame(() => loginCard.classList.add("show"));

// ------- socket events -------
socket.on("loginError", (msg) => {
  showLoading(false);
  showLogin(true);
  toast("warn", msg);
});

socket.on("loginSuccess", (data) => {
  showLoading(false);

  me = data.user;
  isGuest = !!data.guest;
  myColor = data.color;

  state = data.state || null;
  if (state?.settings) settings = { ...settings, ...state.settings };

  applyCursor();

  // UI labels
  meLabel.textContent = me;
  statusLabel.textContent = isGuest ? "Guest mode (Global chat only)" : "Logged in";

  // Hide or show guest limitations
  settingsBtn.style.display = isGuest ? "none" : "inline-block";
  inboxBtn.style.display = isGuest ? "none" : "inline-flex";

  // Show app panels with transition
  showApp(true);

  // default view
  setView("global", null);

  setAuthButton();
  toast("ok", isGuest ? "Joined as Guest." : "Logged in.");
});

socket.on("state", (s) => {
  state = s;
  if (state?.settings) {
    settings = { ...settings, ...state.settings };
    applyCursor();
  }
  renderInbox();
  renderThreads();
});

socket.on("toast", ({ type, msg }) => toast(type, msg));

socket.on("onlineUsers", (list) => {
  // green dots only for online list (everyone in this list is online)
  renderOnline(list);
});

socket.on("actionError", ({ scope, msg }) => {
  toast("warn", msg || "Action failed.");
});

// Global history/messages
socket.on("globalHistory", (msgs) => {
  // only render if we are on global
  if (view.kind !== "global") return;
  clearChat();
  (msgs || []).forEach(m => {
    if (!Number.isFinite(m.ts)) return; // already sanitized server-side, double safe
    renderMsg({ user: m.user, text: m.text, ts: m.ts, color: m.color, you: (m.user === me) });
  });
});
socket.on("globalMsg", (m) => {
  if (view.kind === "global") {
    renderMsg({ user: m.user, text: m.text, ts: m.ts, color: m.color, you: (m.user === me) });
  } else {
    // unread for global only if not muted
    if (!settings.muteAll && !settings.muteGlobal) {
      unreadMap["global"] = (unreadMap["global"] || 0) + 1;
      ping();
      renderThreads();
    }
  }
});

// DM history/messages
socket.on("dmError", (msg) => toast("warn", msg));
socket.on("dmHistory", ({ withUser, msgs, colors }) => {
  if (view.kind !== "dm" || view.target !== withUser) return;
  clearChat();
  (msgs || []).forEach(m => {
    renderMsg({
      user: m.from,
      text: settings.dmProfanityFilter ? mildFilter(m.text) : m.text,
      ts: m.ts,
      color: colors?.[m.from] || "#fff",
      you: (m.from === me),
    });
  });
});
socket.on("dmMsg", (m) => {
  const other = (m.from === me) ? m.to : m.from;

  // if currently open
  if (view.kind === "dm" && view.target === other) {
    renderMsg({
      user: m.from,
      text: settings.dmProfanityFilter ? mildFilter(m.text) : m.text,
      ts: m.ts,
      color: (m.from === me ? myColor : "#fff"),
      you: (m.from === me),
    });
    return;
  }

  // update unread in UI; server also tracks unread in state
  if (!settings.muteAll) {
    ping();
  }
});

// Group history/messages
socket.on("groupError", (msg) => toast("warn", msg));
socket.on("groupHistory", ({ group, msgs }) => {
  if (view.kind !== "group" || view.target !== group.id) return;
  clearChat();
  (msgs || []).forEach(m => {
    renderMsg({
      user: m.from,
      text: m.text,
      ts: m.ts,
      color: m.color || "#fff",
      you: (m.from === me),
    });
  });
});
socket.on("groupMsg", (m) => {
  if (view.kind === "group" && view.target === m.groupId) {
    renderMsg({
      user: m.from,
      text: m.text,
      ts: m.ts,
      color: m.color || "#fff",
      you: (m.from === me),
    });
  } else {
    // increment local unread
    unreadMap[m.groupId] = (unreadMap[m.groupId] || 0) + 1;
    if (!settings.muteAll) ping();
    renderThreads();
  }
});

// ------- DM mild filter (client-side, less strict than global) -------
function mildFilter(text) {
  // replaces common offensive words with **** without trying to be perfect
  const t = String(text || "");
  const patterns = [
    /n[\W_]*i[\W_]*g[\W_]*g[\W_]*e[\W_]*r/ig,
    /n[\W_]*i[\W_]*g[\W_]*g[\W_]*a/ig,
  ];
  let out = t;
  for (const re of patterns) out = out.replace(re, "****");
  return out;
}
