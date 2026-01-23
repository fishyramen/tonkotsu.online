/* public/script.js
   Compatible with your server.js (ESM) that you pasted.
   Implements:
   - Star background + compact centered UI
   - Login/resume refresh
   - Sidebar: Inbox button, Online list, Messages list (Global + DMs + Groups)
   - Inbox: mentions + group invites + friend requests (flat list)
   - Settings save + preview
   - Top-right user dropdown: Profile / Settings / Logout
   - Custom cursor modes (Off / Dot / Dot+Trail)
   - Global cooldown 3s logged-in, 5s guest, dynamic, shake+red on violation
   - Groups: invite-required creation and accept/decline
*/

const socket = io();
const $ = (id) => document.getElementById(id);

// -------------------- DOM --------------------
const loginOverlay = $("loginOverlay");
const loading = $("loading");
const loaderSub = $("loaderSub");

const usernameEl = $("username");
const passwordEl = $("password");
const joinBtn = $("joinBtn");
const guestBtn = $("guestBtn");
const togglePass = $("togglePass");

const app = $("app");
const chatTitle = $("chatTitle");
const chatHint = $("chatHint");
const chatBox = $("chatBox");
const messageEl = $("message");
const sendBtn = $("sendBtn");

const cooldownRow = $("cooldownRow");
const cooldownText = $("cooldownText");
const cdFill = $("cdFill");
const cooldownLabel = $("cooldownLabel");

const mePill = $("mePill");
const meName = $("meName");
const meSub = $("meSub");

const inboxBtn = $("inboxBtn");
const inboxPing = $("inboxPing");
const msgPing = $("msgPing");

const onlineCount = $("onlineCount");
const onlineList = $("onlineList");
const msgList = $("msgList");
const createGroupBtn = $("createGroupBtn");

const modalBack = $("modalBack");
const modalTitle = $("modalTitle");
const modalBody = $("modalBody");
const modalClose = $("modalClose");

const toasts = $("toasts");
const yearEl = $("year");
if (yearEl) yearEl.textContent = String(new Date().getFullYear());

const cursorDot = $("cursorDot");
const cursorRing = $("cursorRing");

// -------------------- State --------------------
let me = null;
let isGuest = false;
let token = localStorage.getItem("tonkotsu_token") || null;

let settings = null; // {theme,density,sidebar,hideMildProfanity,cursor,sounds}
let social = null;   // {friends,incoming,outgoing,blocked}
let xp = null;

let view = { type: "global", id: null }; // global|dm|group
let currentDM = null;
let currentGroupId = null;

let onlineUsers = []; // [{user}]
let globalCache = [];
let dmCache = new Map(); // user -> msgs
let groupMeta = new Map(); // gid -> meta
let groupCache = new Map(); // gid -> msgs

let unreadDM = new Map();
let unreadGroup = new Map();

let groupInvitesCache = []; // from inbox:data

// Mentions stored locally (server doesn’t have mention events)
let mentions = []; // {from, ts, text}

// Cooldown
let cooldownUntil = 0;

// Cursor
let cursorMode = "trail"; // off | dot | trail
let reduceAnims = false;

// -------------------- Helpers --------------------
function now(){ return Date.now(); }
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function isGuestUser(u){ return /^Guest\d{4,5}$/.test(String(u)); }

function showLoading(text="syncing…"){
  if (loaderSub) loaderSub.textContent = text;
  if (loading) loading.classList.add("show");
}
function hideLoading(){
  if (loading) loading.classList.remove("show");
}
function toast(title, msg){
  if (!toasts) return;
  const d = document.createElement("div");
  d.className = "toast";
  d.innerHTML = `
    <div class="toastDot"></div>
    <div>
      <div class="toastTitle">${escapeHtml(title)}</div>
      <div class="toastMsg">${escapeHtml(msg)}</div>
    </div>
  `;
  toasts.appendChild(d);
  const dur = reduceAnims ? 1600 : 2600;
  setTimeout(()=>{ d.style.opacity="0"; d.style.transform="translateY(10px)"; }, dur);
  setTimeout(()=> d.remove(), dur + 350);
}

function openModal(title, html){
  if (!modalBack || !modalTitle || !modalBody) return;
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modalBack.classList.add("show");
}
function closeModal(){
  if (!modalBack) return;
  modalBack.classList.remove("show");
  if (modalBody) modalBody.innerHTML = "";
}
if (modalClose) modalClose.addEventListener("click", closeModal);
if (modalBack) modalBack.addEventListener("click",(e)=>{ if(e.target===modalBack) closeModal(); });

function fmtTime(ts){
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return "";
  const h = String(d.getHours()).padStart(2,"0");
  const m = String(d.getMinutes()).padStart(2,"0");
  return `${h}:${m}`;
}

// Mild profanity masking (optional)
const MILD_WORDS = ["fuck","fucking","shit","shitty","asshole","bitch","bastard","dick","pussy"];
const MILD_RX = new RegExp(`\\b(${MILD_WORDS.map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|")})\\b`, "ig");
function maybeHideMild(text){
  if (!settings?.hideMildProfanity) return text;
  return String(text).replace(MILD_RX, "•••");
}
function isBlockedUser(u){
  return !!social?.blocked?.includes(u);
}

// -------------------- Cursor (3 modes) --------------------
let mouseX = window.innerWidth/2, mouseY = window.innerHeight/2;
let dotX = mouseX, dotY = mouseY, ringX = mouseX, ringY = mouseY;
const trail = [];
const TRAIL_MAX = 10;

function setCursorMode(mode){
  cursorMode = mode; // off|dot|trail
  const off = (mode === "off");
  document.body.style.cursor = off ? "auto" : "none";

  // Ensure elements don’t show default cursor
  const forced = off ? "" : "none";
  const styleElId = "__cursor_force__";
  let styleEl = document.getElementById(styleElId);
  if (!styleEl){
    styleEl = document.createElement("style");
    styleEl.id = styleElId;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = off
    ? `a,button,input,textarea,.row,.btn,.pill{cursor:auto!important}`
    : `a,button,input,textarea,.row,.btn,.pill{cursor:none!important}`;

  if (cursorDot) cursorDot.style.display = off ? "none" : "block";
  if (cursorRing) cursorRing.style.display = off ? "none" : "block";
  // Clear trail nodes
  document.querySelectorAll(".cursorTrail").forEach(n=>n.remove());
  trail.length = 0;
}

window.addEventListener("mousemove",(e)=>{
  mouseX = e.clientX;
  mouseY = e.clientY;
  if (cursorMode === "trail" && !reduceAnims){
    trail.unshift({x:mouseX, y:mouseY, t: now()});
    if (trail.length > TRAIL_MAX) trail.pop();
  }
});

function cursorTick(){
  // Smooth follow
  const dotLerp = reduceAnims ? 1 : 0.35;
  const ringLerp = reduceAnims ? 1 : 0.18;

  dotX += (mouseX - dotX) * dotLerp;
  dotY += (mouseY - dotY) * dotLerp;
  ringX += (mouseX - ringX) * ringLerp;
  ringY += (mouseY - ringY) * ringLerp;

  if (cursorDot) cursorDot.style.transform = `translate(${dotX}px, ${dotY}px) translate(-50%,-50%)`;
  if (cursorRing) cursorRing.style.transform = `translate(${ringX}px, ${ringY}px) translate(-50%,-50%)`;

  if (cursorMode === "trail" && !reduceAnims){
    // render short trail
    // remove old nodes
    document.querySelectorAll(".cursorTrail").forEach(n=>n.remove());
    const nowT = now();
    trail.forEach((p,i)=>{
      const age = nowT - p.t;
      const op = clamp(1 - age / 250, 0, 1) * (1 - i/(TRAIL_MAX+2));
      if (op <= 0.02) return;
      const n = document.createElement("div");
      n.className = "cursorTrail";
      n.style.opacity = String(op);
      n.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%,-50%)`;
      n.style.width = (10 - i*0.5) + "px";
      n.style.height = (10 - i*0.5) + "px";
      document.body.appendChild(n);
    });
  }
  requestAnimationFrame(cursorTick);
}

// -------------------- Cooldown --------------------
function cooldownSeconds(){ return isGuest ? 5 : 3; }
function canSend(){ return now() >= cooldownUntil; }

function startCooldown(){
  const secs = cooldownSeconds();
  cooldownUntil = now() + secs * 1000;
  if (cooldownLabel) cooldownLabel.textContent = `Cooldown: ${secs}s`;
  if (cooldownRow) cooldownRow.style.display = "flex";
  updateCooldown();
}
function updateCooldown(){
  const msLeft = cooldownUntil - now();
  const total = cooldownSeconds() * 1000;
  const p = clamp(1 - msLeft / total, 0, 1);
  if (cdFill) cdFill.style.width = (p * 100) + "%";

  if (msLeft <= 0){
    if (cooldownRow){
      cooldownRow.style.display = "none";
      cooldownRow.classList.remove("warn","shake");
    }
    return;
  }
  if (cooldownText) cooldownText.textContent = (msLeft/1000).toFixed(1)+"s";
  requestAnimationFrame(updateCooldown);
}
function cooldownWarn(){
  if (!cooldownRow) return;
  cooldownRow.style.display = "flex";
  cooldownRow.classList.add("warn","shake");
  setTimeout(()=> cooldownRow.classList.remove("shake"), 350);
  setTimeout(()=> cooldownRow.classList.remove("warn"), 900);
}

// -------------------- View + Rendering --------------------
function setView(type, id=null){
  view = { type, id };
  currentDM = (type==="dm") ? id : null;
  currentGroupId = (type==="group") ? id : null;

  if (!chatTitle || !chatHint) return;

  if (type === "global"){
    chatTitle.textContent = "Global chat";
    chatHint.textContent = "shared with everyone";
  } else if (type === "dm"){
    chatTitle.textContent = `DM — ${id}`;
    chatHint.textContent = "private messages";
  } else if (type === "group"){
    const meta = groupMeta.get(id);
    chatTitle.textContent = meta ? `Group — ${meta.name}` : "Group chat";
    chatHint.textContent = "group messages";
  }
}

function clearChat(){
  if (chatBox) chatBox.innerHTML = "";
}

function renderTextWithMentions(text){
  if (!me) return escapeHtml(text);
  const safe = escapeHtml(text);
  const rx = new RegExp(`(@${me.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")})`, "ig");
  return safe.replace(rx, `<span style="color:var(--warn);font-weight:950">$1</span>`);
}

function addMessageToUI({ user, text, ts }, scope){
  if (!chatBox) return;
  const time = fmtTime(ts);

  let who = user;
  let bodyText = String(text ?? "");
  if (bodyText === "__HIDDEN_BY_FILTER__") bodyText = "Message hidden (filtered).";

  if (scope === "global" && who && isBlockedUser(who)){
    bodyText = "Message hidden (blocked user).";
  } else {
    bodyText = maybeHideMild(bodyText);
  }

  const row = document.createElement("div");
  row.className = "msg";
  row.innerHTML = `
    <div class="bubble">
      <div class="meta">
        <div class="u" data-user="${escapeHtml(who)}">${escapeHtml(who)}${(who===me?" (You)":"")}</div>
        <div class="t">${escapeHtml(time)}</div>
      </div>
      <div class="body">${renderTextWithMentions(bodyText)}</div>
    </div>
  `;

  const uEl = row.querySelector(".u");
  if (uEl){
    uEl.addEventListener("click", ()=>{
      const u = uEl.getAttribute("data-user");
      openProfile(u);
    });
  }

  chatBox.appendChild(row);
  chatBox.scrollTop = chatBox.scrollHeight;

  // Local mentions -> Inbox
  if (scope === "global" && me && who && who !== me && !isGuest){
    const raw = String(text ?? "");
    if (raw.toLowerCase().includes(`@${me.toLowerCase()}`)){
      mentions.unshift({ from: who, ts: ts || now(), text: raw.slice(0, 140) });
      mentions = mentions.slice(0, 80);
      updateBadges();
    }
  }
}

// -------------------- Sidebar: Online + Messages --------------------
function renderOnline(){
  if (!onlineList) return;
  if (onlineCount) onlineCount.textContent = String(onlineUsers.length);

  onlineList.innerHTML = onlineUsers.map(u=>{
    const name = u.user;
    return `
      <div class="row" data-open-profile="${escapeHtml(name)}">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">${escapeHtml(name)}${name===me?" (You)":""}</div>
            <div class="rowSub">click for profile</div>
          </div>
        </div>
      </div>
    `;
  }).join("");

  onlineList.querySelectorAll("[data-open-profile]").forEach(el=>{
    el.addEventListener("click", ()=>{
      openProfile(el.getAttribute("data-open-profile"));
    });
  });
}

function totalMessagePings(){
  let n = 0;
  for (const v of unreadDM.values()) n += v;
  for (const v of unreadGroup.values()) n += v;
  return n;
}

function updateBadges(){
  // Messages: DM + Group only (no global)
  const m = totalMessagePings();
  if (msgPing){
    msgPing.textContent = String(m);
    msgPing.classList.toggle("show", m > 0);
  }

  // Inbox: mentions + invites + friend requests
  const friendCount = Array.isArray(social?.incoming) ? social.incoming.length : 0;
  const inviteCount = Array.isArray(groupInvitesCache) ? groupInvitesCache.length : 0;
  const mentionCount = mentions.length;
  const total = friendCount + inviteCount + mentionCount;

  if (inboxPing){
    inboxPing.textContent = String(total);
    inboxPing.classList.toggle("show", total > 0);
  }
}

function renderMessagesList(){
  if (!msgList) return;

  const dmUsers = Array.from(dmCache.keys()).sort((a,b)=>a.localeCompare(b));
  const groups = Array.from(groupMeta.values()).sort((a,b)=>String(a.name).localeCompare(String(b.name)));

  msgList.innerHTML = `
    <div class="row" data-open="global">
      <div class="rowLeft">
        <div class="statusDot on"></div>
        <div class="nameCol">
          <div class="rowName">Global chat</div>
          <div class="rowSub">shared</div>
        </div>
      </div>
    </div>

    ${dmUsers.map(u=>{
      const c = unreadDM.get(u) || 0;
      return `
        <div class="row" data-open="dm" data-id="${escapeHtml(u)}">
          <div class="rowLeft">
            <div class="statusDot ${onlineUsers.some(x=>x.user===u)?"on":""}"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(u)}</div>
              <div class="rowSub">dm</div>
            </div>
          </div>
          <div class="badge ${c>0?"show":""}" style="display:${c>0?"flex":"none"}">${c}</div>
        </div>
      `;
    }).join("")}

    ${groups.map(g=>{
      const c = unreadGroup.get(g.id) || 0;
      return `
        <div class="row" data-open="group" data-id="${escapeHtml(g.id)}">
          <div class="rowLeft">
            <div class="statusDot on"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(g.name)}</div>
              <div class="rowSub">${escapeHtml(g.id)}</div>
            </div>
          </div>
          <div class="badge ${c>0?"show":""}" style="display:${c>0?"flex":"none"}">${c}</div>
        </div>
      `;
    }).join("")
  `;

  msgList.querySelectorAll("[data-open]").forEach(el=>{
    el.addEventListener("click", ()=>{
      const t = el.getAttribute("data-open");
      const id = el.getAttribute("data-id");
      if (t === "global") openGlobal();
      if (t === "dm") openDM(id);
      if (t === "group") openGroup(id);
    });

    // Right click mute UI placeholder
    el.addEventListener("contextmenu",(e)=>{
      e.preventDefault();
      openModal("Mute", `
        <div class="muted" style="line-height:1.45">
          Mute is UI-only unless you add server-side mute support.
        </div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <button class="btn primary" id="muteOk">OK</button>
        </div>
      `);
      const ok = $("muteOk");
      if (ok) ok.onclick = closeModal;
    });
  });

  updateBadges();
}

// -------------------- Openers --------------------
function openGlobal(){
  setView("global");
  clearChat();
  globalCache.forEach(m=> addMessageToUI(m, "global"));
  socket.emit("requestGlobalHistory");
}

function openDM(user){
  if (isGuest){
    toast("Guests", "Guests can’t use DMs. Log in to DM.");
    return;
  }
  if (!user) return;
  unreadDM.set(user, 0);
  updateBadges();

  setView("dm", user);
  clearChat();
  socket.emit("dm:history", { withUser: user });
}

function openGroup(gid){
  if (isGuest) return;
  if (!gid) return;
  unreadGroup.set(gid, 0);
  updateBadges();

  setView("group", gid);
  clearChat();
  socket.emit("group:history", { groupId: gid });
}

// -------------------- Inbox (flat list) --------------------
function openInbox(){
  if (isGuest){
    openModal("Inbox", `<div class="muted">Guest mode has no inbox.</div>`);
    return;
  }

  socket.emit("inbox:get");

  const items = [];

  // Mentions
  for (const m of mentions){
    items.push({
      type: "mention",
      label: `${m.from} mentioned you in Global chat`,
      sub: new Date(m.ts).toLocaleString(),
      action: "mention"
    });
  }

  // Friend requests
  const incoming = Array.isArray(social?.incoming) ? social.incoming : [];
  for (const u of incoming){
    items.push({
      type: "friend",
      label: `${u} sent a friend request`,
      sub: "Tap to accept",
      action: "friendAccept",
      payload: u
    });
  }

  // Group invites
  for (const inv of groupInvitesCache){
    items.push({
      type: "invite",
      label: `${inv.from} invited you to “${inv.name}”`,
      sub: "Tap to accept",
      action: "inviteAccept",
      payload: inv
    });
  }

  const html = `
    <div style="display:flex;flex-direction:column;gap:10px">
      ${items.length ? items.map((it, idx)=>`
        <div class="row" data-inbox-idx="${idx}">
          <div class="rowLeft">
            <div class="statusDot on"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(it.label)}</div>
              <div class="rowSub">${escapeHtml(it.sub)}</div>
            </div>
          </div>
          <button class="btn small primary" data-act="${escapeHtml(it.action)}" data-idx="${idx}">Open</button>
        </div>
      `).join("") : `<div class="muted">Nothing here right now.</div>`}
    </div>
  `;

  openModal("Inbox", html);

  modalBody.querySelectorAll("[data-act]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const idx = Number(btn.getAttribute("data-idx"));
      const act = btn.getAttribute("data-act");
      const it = items[idx];
      if (!it) return;

      if (act === "mention"){
        mentions = [];
        updateBadges();
        closeModal();
        openGlobal();
        toast("Mention", "Opened global chat.");
        return;
      }
      if (act === "friendAccept"){
        socket.emit("friend:accept", { from: it.payload });
        social.incoming = (social.incoming||[]).filter(x=>x!==it.payload);
        updateBadges();
        toast("Friends", `Accepted ${it.payload}.`);
        closeModal();
        return;
      }
      if (act === "inviteAccept"){
        socket.emit("groupInvite:accept", { id: it.payload.id });
        groupInvitesCache = groupInvitesCache.filter(x=>x.id!==it.payload.id);
        updateBadges();
        toast("Group", "Invite accepted.");
        closeModal();
        return;
      }
    });
  });
}

// -------------------- Settings + Menu --------------------
function openMenu(){
  if (!me) return;

  const guestNote = isGuest ? `<div class="muted">Guest mode: settings aren’t saved.</div>` : ``;

  openModal("Account", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="row" id="menuProfile">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">Profile</div>
            <div class="rowSub">view your profile</div>
          </div>
        </div>
      </div>

      <div class="row" id="menuSettings">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">Settings</div>
            <div class="rowSub">cursor, sounds, filters</div>
          </div>
        </div>
      </div>

      <div class="row" id="menuLogout" style="border-color:rgba(255,82,82,.35)">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">Log out</div>
            <div class="rowSub">end session</div>
          </div>
        </div>
      </div>

      ${guestNote}
    </div>
  `);

  const p = $("menuProfile");
  const s = $("menuSettings");
  const l = $("menuLogout");

  if (p) p.onclick = ()=>{ closeModal(); openProfile(me); };
  if (s) s.onclick = ()=>{ closeModal(); openSettings(); };
  if (l) l.onclick = ()=>{ logout(); };
}

function openSettings(){
  const cur = settings || {
    theme:"dark",
    density:0.15,
    sidebar:0.22,
    hideMildProfanity:false,
    cursor:true,
    sounds:true
  };

  // draft for preview
  const draft = {
    hideMildProfanity: !!cur.hideMildProfanity,
    cursorEnabled: cur.cursor !== false,
    cursorMode: cursorMode, // off|dot|trail
    reduceAnims: reduceAnims
  };

  openModal("Settings", `
    <div style="display:flex;flex-direction:column;gap:12px">

      <div class="row" id="setCursor">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">Custom cursor</div>
            <div class="rowSub">Off / Dot / Dot + trail</div>
          </div>
        </div>
        <button class="btn small" id="cursorCycle">Cycle</button>
      </div>

      <div class="row" id="setReduce">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">Reduce animations</div>
            <div class="rowSub">less motion, fewer effects</div>
          </div>
        </div>
        <button class="btn small" id="reduceToggle">${draft.reduceAnims ? "On" : "Off"}</button>
      </div>

      <div class="row" id="setFilter">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">Hide mild profanity</div>
            <div class="rowSub">mask common swears as •••</div>
          </div>
        </div>
        <button class="btn small" id="filterToggle">${draft.hideMildProfanity ? "On" : "Off"}</button>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn primary" id="saveSettings">Save</button>
        <button class="btn" id="closeSettings">Close</button>
      </div>

      <div class="muted" style="line-height:1.45">
        Note: only logged-in users save settings.
      </div>
    </div>
  `);

  const cursorCycle = $("cursorCycle");
  const reduceToggle = $("reduceToggle");
  const filterToggle = $("filterToggle");
  const saveBtn = $("saveSettings");
  const closeBtn = $("closeSettings");

  function cycleCursor(){
    const order = ["off","dot","trail"];
    const i = Math.max(0, order.indexOf(draft.cursorMode));
    draft.cursorMode = order[(i+1)%order.length];
    // preview
    if (draft.cursorMode === "off"){
      draft.cursorEnabled = false;
      setCursorMode("off");
    } else {
      draft.cursorEnabled = true;
      setCursorMode(draft.cursorMode);
    }
    toast("Cursor", `Mode: ${draft.cursorMode}`);
  }

  if (cursorCycle) cursorCycle.onclick = cycleCursor;

  if (reduceToggle) reduceToggle.onclick = ()=>{
    draft.reduceAnims = !draft.reduceAnims;
    reduceToggle.textContent = draft.reduceAnims ? "On" : "Off";
    // preview
    reduceAnims = draft.reduceAnims;
  };

  if (filterToggle) filterToggle.onclick = ()=>{
    draft.hideMildProfanity = !draft.hideMildProfanity;
    filterToggle.textContent = draft.hideMildProfanity ? "On" : "Off";
  };

  if (closeBtn) closeBtn.onclick = ()=>{
    // revert preview to current
    reduceAnims = !!window.__savedReduceAnims;
    setCursorMode(window.__savedCursorMode || "trail");
    closeModal();
  };

  if (saveBtn) saveBtn.onclick = ()=>{
    // persist locally (reduce + cursor mode) and server settings
    window.__savedReduceAnims = draft.reduceAnims;
    window.__savedCursorMode = draft.cursorMode;

    reduceAnims = draft.reduceAnims;
    setCursorMode(draft.cursorMode);

    // update server settings only if logged in
    if (!isGuest){
      settings = settings || {};
      settings.hideMildProfanity = draft.hideMildProfanity;
      settings.cursor = draft.cursorMode !== "off";
      // keep theme as-is (server defaults already dark minimal)
      socket.emit("settings:update", settings);
    }

    toast("Settings", isGuest ? "Applied (guest)" : "Saved");
    closeModal();
  };
}

function logout(){
  showLoading("logging out…");
  setTimeout(()=>{
    localStorage.removeItem("tonkotsu_token");
    location.reload();
  }, reduceAnims ? 220 : 420);
}

// -------------------- Profile --------------------
function openProfile(user){
  if (!user) return;

  const guest = isGuestUser(user);

  openModal("Profile", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div style="min-width:0">
          <div style="font-weight:950;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(user)}</div>
          <div class="muted" id="profSub">${guest ? "Guest user" : "loading…"}</div>
        </div>
        <button class="btn small" id="profClose">Close</button>
      </div>

      ${guest ? "" : `
        <div style="border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);padding:12px">
          <div style="font-weight:950;font-size:12px;margin-bottom:8px">Account</div>
          <div id="profStats" class="muted" style="display:flex;flex-direction:column;gap:6px">loading…</div>
        </div>

        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${user !== me && !isGuest ? `<button class="btn" id="profDM">DM</button>` : ``}
          ${user !== me && !isGuest ? `<button class="btn" id="profAdd">Add friend</button>` : ``}
          ${user !== me && !isGuest ? `<button class="btn" id="profBlock">Block</button>` : ``}
        </div>
      `}
    </div>
  `);

  const pc = $("profClose");
  if (pc) pc.onclick = closeModal;

  if (!guest){
    modalBody._profileUser = user;
    socket.emit("profile:get", { user });

    setTimeout(()=>{
      const dmBtn = $("profDM");
      const addBtn = $("profAdd");
      const blkBtn = $("profBlock");

      if (dmBtn) dmBtn.onclick = ()=>{ closeModal(); openDM(user); };
      if (addBtn) addBtn.onclick = ()=>{ socket.emit("friend:request", { to:user }); toast("Friends","Request sent."); };
      if (blkBtn) blkBtn.onclick = ()=>{ socket.emit("user:block", { user }); toast("Blocked", `${user} blocked.`); closeModal(); };
    }, 0);
  }
}

// -------------------- Group creation --------------------
function openCreateGroup(){
  if (isGuest){
    toast("Guests","Guests can’t create groups.");
    return;
  }

  openModal("Create group", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="muted">Group name</div>
      <input class="field" id="gcName" placeholder="Unnamed Group" />
      <div class="muted">Invite at least 1 user (comma separated)</div>
      <input class="field" id="gcInv" placeholder="user1, user2" />
      <button class="btn primary" id="gcGo">Send invites</button>
      <div class="muted" style="line-height:1.45">
        Group becomes active after someone accepts.
      </div>
    </div>
  `);

  const go = $("gcGo");
  if (go) go.onclick = ()=>{
    const name = ($("gcName")?.value || "").trim();
    const invitesRaw = ($("gcInv")?.value || "").trim();
    const invites = invitesRaw.split(",").map(s=>s.trim()).filter(Boolean);

    closeModal();
    socket.emit("group:createRequest", { name, invites });
    toast("Group","Invites sent.");
  };
}

// -------------------- Sending --------------------
function sendCurrent(){
  if (!me) return;
  const text = (messageEl?.value || "").trim();
  if (!text) return;

  if (!canSend()){
    cooldownWarn();
    return;
  }

  startCooldown();
  messageEl.value = "";

  if (view.type === "global"){
    socket.emit("sendGlobal", { text, ts: now() });
  } else if (view.type === "dm"){
    socket.emit("dm:send", { to: currentDM, text });
  } else if (view.type === "group"){
    socket.emit("group:send", { groupId: currentGroupId, text });
  }
}

if (sendBtn) sendBtn.addEventListener("click", sendCurrent);
if (messageEl){
  messageEl.addEventListener("keydown",(e)=>{
    if (e.key === "Enter" && !e.shiftKey){
      e.preventDefault();
      sendCurrent();
    }
  });
}

// -------------------- Login --------------------
if (togglePass && passwordEl){
  togglePass.addEventListener("click", ()=>{
    const isPw = passwordEl.type === "password";
    passwordEl.type = isPw ? "text" : "password";
    togglePass.textContent = isPw ? "◎" : "◉";
  });
}

function tryResume(){
  if (token){
    showLoading("resuming session…");
    socket.emit("resume", { token });
  }
}

if (joinBtn){
  joinBtn.addEventListener("click", ()=>{
    const u = (usernameEl?.value || "").trim();
    const p = (passwordEl?.value || "");
    if (!u || !p){
      $("loginCard")?.classList.add("shake");
      setTimeout(()=> $("loginCard")?.classList.remove("shake"), 350);
      return;
    }
    showLoading("logging in…");
    socket.emit("login", { username:u, password:p, guest:false });
  });
}

if (guestBtn){
  guestBtn.addEventListener("click", ()=>{
    showLoading("joining as guest…");
    socket.emit("login", { guest:true });
  });
}

if (passwordEl && joinBtn){
  passwordEl.addEventListener("keydown",(e)=>{
    if (e.key === "Enter") joinBtn.click();
  });
}

// -------------------- UI binds --------------------
if (inboxBtn) inboxBtn.addEventListener("click", openInbox);
if (createGroupBtn) createGroupBtn.addEventListener("click", openCreateGroup);
if (mePill) mePill.addEventListener("click", openMenu);

// -------------------- Socket events --------------------
socket.on("resumeFail", ()=>{
  localStorage.removeItem("tonkotsu_token");
  token = null;
  hideLoading();
});

socket.on("loginError",(msg)=>{
  hideLoading();
  $("loginCard")?.classList.add("shake");
  setTimeout(()=> $("loginCard")?.classList.remove("shake"), 350);
  toast("Login failed", msg || "Try again.");
});

socket.on("loginSuccess",(data)=>{
  hideLoading();

  me = data.username;
  isGuest = !!data.guest;

  settings = data.settings || settings || { theme:"dark", density:0.15, sidebar:0.22, hideMildProfanity:false, cursor:true, sounds:true };
  social = data.social || social || { friends:[], incoming:[], outgoing:[], blocked:[] };
  xp = data.xp ?? null;

  if (!isGuest && data.token){
    localStorage.setItem("tonkotsu_token", data.token);
    token = data.token;
  }

  // show app
  if (loginOverlay) loginOverlay.classList.add("hidden");
  if (mePill) mePill.style.display = "flex";
  if (meName) meName.textContent = me;
  if (meSub) meSub.textContent = isGuest ? "Guest" : "click for menu";

  // Cursor from settings
  // Default: trail, but if user saved off -> off
  const savedMode = window.__savedCursorMode || (settings.cursor === false ? "off" : "trail");
  setCursorMode(savedMode);

  // Reduce anims persisted locally
  reduceAnims = !!window.__savedReduceAnims;

  if (cooldownLabel) cooldownLabel.textContent = `Cooldown: ${cooldownSeconds()}s`;

  toast("Welcome", isGuest ? "Joined as guest" : `Logged in as ${me}`);

  // request initial
  openGlobal();
  socket.emit("requestGlobalHistory");
  if (!isGuest){
    socket.emit("social:sync");
    socket.emit("groups:list");
    socket.emit("inbox:get");
  }

  renderMessagesList();
});

socket.on("settings",(s)=>{
  settings = s || settings;
  // cursor setting only indicates enabled; mode is local
  if (settings?.cursor === false){
    setCursorMode("off");
    window.__savedCursorMode = "off";
  }
});

socket.on("social:update",(s)=>{
  social = s || social;
  updateBadges();
});

socket.on("inbox:update", ()=>{
  // counts-only event; we still rely on inbox:data for full lists
  updateBadges();
});

socket.on("inbox:data",(data)=>{
  groupInvitesCache = Array.isArray(data?.groupInvites) ? data.groupInvites : [];
  if (social && Array.isArray(data?.friendRequests)){
    social.incoming = data.friendRequests;
  }
  updateBadges();
});

socket.on("onlineUsers",(list)=>{
  onlineUsers = Array.isArray(list) ? list : [];
  renderOnline();
  renderMessagesList();
});

socket.on("history",(msgs)=>{
  globalCache = Array.isArray(msgs) ? msgs : [];
  if (view.type === "global"){
    clearChat();
    globalCache.forEach(m=> addMessageToUI(m,"global"));
  }
});

socket.on("globalMessage",(msg)=>{
  if (!msg) return;
  globalCache.push(msg);
  if (globalCache.length > 300) globalCache.shift();
  if (view.type === "global") addMessageToUI(msg,"global");
});

socket.on("dm:history",({ withUser, msgs }={})=>{
  const other = withUser;
  const list = Array.isArray(msgs) ? msgs : [];
  dmCache.set(other, list);

  if (view.type === "dm" && currentDM === other){
    clearChat();
    list.forEach(m=> addMessageToUI({user: other, text:m.text, ts:m.ts},"dm"));
  }
  renderMessagesList();
});

socket.on("dm:message",({ from, msg }={})=>{
  if (!from || !msg) return;
  if (!dmCache.has(from)) dmCache.set(from, []);
  dmCache.get(from).push(msg);
  if (dmCache.get(from).length > 250) dmCache.get(from).shift();

  if (!(view.type==="dm" && currentDM===from)){
    unreadDM.set(from, (unreadDM.get(from)||0) + 1);
    updateBadges();
  } else {
    addMessageToUI({user: from, text: msg.text, ts: msg.ts},"dm");
  }
  renderMessagesList();
});

socket.on("groups:list",(list)=>{
  groupMeta.clear();
  (Array.isArray(list)?list:[]).forEach(g=>{
    groupMeta.set(g.id, { id:g.id, name:g.name, owner:g.owner, members:g.members||[] });
  });
  renderMessagesList();
});

socket.on("group:history",({ groupId, meta, msgs }={})=>{
  if (!groupId) return;
  if (meta) groupMeta.set(groupId, meta);
  groupCache.set(groupId, Array.isArray(msgs)?msgs:[]);

  setView("group", groupId);
  clearChat();
  (msgs||[]).forEach(m=> addMessageToUI(m,"group"));
  renderMessagesList();
});

socket.on("group:message",({ groupId, msg }={})=>{
  if (!groupId || !msg) return;
  if (!groupCache.has(groupId)) groupCache.set(groupId, []);
  groupCache.get(groupId).push(msg);

  if (!(view.type==="group" && currentGroupId===groupId)){
    unreadGroup.set(groupId, (unreadGroup.get(groupId)||0) + 1);
    updateBadges();
  } else {
    addMessageToUI(msg,"group");
  }
  renderMessagesList();
});

socket.on("group:meta",({ groupId, meta, name, owner, members }={})=>{
  if (!groupId) return;
  const incoming = meta || { id:groupId, name, owner, members };
  const m = groupMeta.get(groupId) || { id:groupId, name:"Unnamed Group", owner:"—", members:[] };
  if (incoming.name) m.name = incoming.name;
  if (incoming.owner) m.owner = incoming.owner;
  if (Array.isArray(incoming.members)) m.members = incoming.members;
  groupMeta.set(groupId, m);

  if (view.type==="group" && currentGroupId===groupId){
    chatTitle.textContent = `Group — ${m.name}`;
  }
  renderMessagesList();
});

socket.on("group:left",({ groupId }={})=>{
  toast("Group","Left group.");
  unreadGroup.delete(groupId);
  groupMeta.delete(groupId);
  groupCache.delete(groupId);
  updateBadges();
  openGlobal();
  socket.emit("groups:list");
});

socket.on("group:deleted",({ groupId }={})=>{
  toast("Group","Group deleted.");
  unreadGroup.delete(groupId);
  groupMeta.delete(groupId);
  groupCache.delete(groupId);
  updateBadges();
  openGlobal();
  socket.emit("groups:list");
});

socket.on("profile:data",(p)=>{
  const target = modalBody?._profileUser;
  if (!target || !p || p.user !== target) return;

  const sub = $("profSub");
  const stats = $("profStats");
  if (p.guest){
    if (sub) sub.textContent = "Guest user";
    if (stats) stats.innerHTML = "";
    return;
  }

  const created = p.createdAt ? new Date(p.createdAt).toLocaleString() : "—";
  const level = Number.isFinite(p.level) ? p.level : 1;
  const xpNow = Number.isFinite(p.xp) ? p.xp : 0;
  const xpNext = Number.isFinite(p.next) ? p.next : 120;
  const msgs = Number.isFinite(p.messages) ? p.messages : 0;

  if (sub) sub.textContent = `Level ${level} • ${msgs} messages`;

  const pct = xpNext > 0 ? clamp(xpNow/xpNext, 0, 1) : 0;

  if (stats){
    stats.innerHTML = `
      <div><b style="color:var(--text)">Created:</b> ${escapeHtml(created)}</div>
      <div><b style="color:var(--text)">Messages:</b> ${msgs}</div>
      <div style="margin-top:8px">
        <div style="display:flex;justify-content:space-between;gap:10px">
          <div>XP</div><div>${xpNow}/${xpNext}</div>
        </div>
        <div style="margin-top:6px;height:10px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);overflow:hidden">
          <div style="height:100%;width:${Math.round(pct*100)}%;background:rgba(255,255,255,.18)"></div>
        </div>
      </div>
    `;
  }
});

// -------------------- Init --------------------
setCursorMode("trail");
requestAnimationFrame(cursorTick);
tryResume();

// Default global on load (before login, just UI state)
setView("global");
renderOnline();
renderMessagesList();

// App start hidden behind overlay; server will show once loginSuccess fires
