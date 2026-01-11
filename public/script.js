const socket = io();
const $ = (id) => document.getElementById(id);

// UI
const loginOverlay = $("loginOverlay");
const loading = $("loading");
const app = $("app");

const usernameEl = $("username");
const passwordEl = $("password");
const joinBtn = $("joinBtn");
const guestBtn = $("guestBtn");
const togglePass = $("togglePass");

const mePill = $("mePill");
const meName = $("meName");

const tabGlobal = $("tabGlobal");
const tabMessages = $("tabMessages");
const tabInbox = $("tabInbox");
const msgPing = $("msgPing");
const inboxPing = $("inboxPing");
const sideSection = $("sideSection");

const chatTitle = $("chatTitle");
const chatHint = $("chatHint");
const backBtn = $("backBtn");

const chatBox = $("chatBox");
const messageEl = $("message");
const sendBtn = $("sendBtn");

const cooldownRow = $("cooldownRow");
const cooldownText = $("cooldownText");
const cdFill = $("cdFill");

const settingsBtn = $("settingsBtn");
const logoutBtn = $("logoutBtn");
const loginBtn = $("loginBtn");

const modalBack = $("modalBack");
const modalTitle = $("modalTitle");
const modalBody = $("modalBody");
const modalClose = $("modalClose");

const toasts = $("toasts");

// State
let me = null;
let isGuest = false;
let token = localStorage.getItem("tonkotsu_token") || null;

let onlineUsers = [];
let settings = {
  theme: "dark",
  density: 0.15,      // compact default
  sidebar: 0.20,      // narrow default
  hideMildProfanity: false,
  customCursor: true,
  pingSound: true,
  pingVolume: 0.45
};
let social = { friends: [], incoming: [], outgoing: [], blocked: [], groupInvites: [] };
let xp = null; // guests: null

let view = { type: "global", id: null }; // global | dm | group
let currentDM = null;
let currentGroupId = null;

let globalCache = [];
let dmCache = new Map();        // user -> msgs
let groupMeta = new Map();      // gid -> {id,name,owner,members[]}
let groupCache = new Map();     // gid -> msgs

let cooldownUntil = 0;

// Mute memory (client)
let muted = JSON.parse(localStorage.getItem("tonkotsu_muted") || "{}"); // { global:true, dm:{u:true}, group:{gid:true} }
if(!muted || typeof muted !== "object") muted = {};
muted.dm = muted.dm || {};
muted.group = muted.group || {};

// mild profanity list (allowed but optionally hidden client-side)
const MILD_WORDS = ["fuck","fucking","shit","shitty","asshole","bitch","bastard","dick","pussy"];
const MILD_RX = new RegExp(`\\b(${MILD_WORDS.map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|")})\\b`, "ig");

// Hard filter placeholder from server
function isServerHiddenText(t){
  return t === "__HIDDEN_BY_FILTER__";
}

// ---------- THEMES ----------
const THEMES = {
  dark:   { bg:"#0b0d10", panel:"rgba(255,255,255,.02)", stroke:"#1c232c", stroke2:"#242c36", text:"#e8edf3", muted:"#9aa7b3" },
  vortex: { bg:"#070913", panel:"rgba(120,140,255,.06)", stroke:"#1a2240", stroke2:"#28305c", text:"#eaf0ff", muted:"#9aa7d6" },
  abyss:  { bg:"#060a0b", panel:"rgba(80,255,220,.05)",  stroke:"#12312c", stroke2:"#1c3f37", text:"#e8fff9", muted:"#8abfb3" },
  carbon: { bg:"#0c0d0e", panel:"rgba(255,255,255,.035)", stroke:"#272a2e", stroke2:"#343840", text:"#f2f4f7", muted:"#a0a8b3" },
};

function applyTheme(name){
  const t = THEMES[name] || THEMES.dark;
  const r = document.documentElement.style;
  r.setProperty("--bg", t.bg);
  r.setProperty("--panel", t.panel);
  r.setProperty("--stroke", t.stroke);
  r.setProperty("--stroke2", t.stroke2);
  r.setProperty("--text", t.text);
  r.setProperty("--muted", t.muted);
}

function applyDensity(val){
  const v = Math.max(0, Math.min(1, Number(val)));
  // tighter and truly compact
  const pad = Math.round(8 + v * 12);     // 8..20
  const font = Math.round(11 + v * 3);    // 11..14
  const r = document.documentElement.style;
  r.setProperty("--pad", `${pad}px`);
  r.setProperty("--font", `${font}px`);
}

function applySidebarWidth(val){
  const v = Math.max(0, Math.min(1, Number(val)));
  const w = Math.round(240 + v * 140); // 240..380
  document.documentElement.style.setProperty("--sidebarW", `${w}px`);
}

function applyCursor(enabled){
  const on = !!enabled;
  document.body.classList.toggle("cursorOn", on);
}

// ---------- helpers ----------
function now(){ return Date.now(); }
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }

function escapeHtml(s){
  return String(s || "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function toast(title, msg){
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
  setTimeout(() => { d.style.opacity="0"; d.style.transform="translateY(10px)"; }, 2600);
  setTimeout(() => d.remove(), 3050);
}

function showLoading(text="syncing…"){
  $("loaderSub").textContent = text;
  loading.classList.add("show");
}
function hideLoading(){
  loading.classList.remove("show");
}

function openModal(title, html){
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modalBack.classList.add("show");
}
function closeModal(){
  modalBack.classList.remove("show");
}
modalClose.addEventListener("click", closeModal);
modalBack.addEventListener("click", (e)=>{ if(e.target===modalBack) closeModal(); });

document.getElementById("year").textContent = String(new Date().getFullYear());

// ---------- ping sound ----------
let audioCtx = null;
function beep(){
  if(!settings?.pingSound) return;
  const vol = Number(settings?.pingVolume ?? 0.45);
  if(!(vol > 0)) return;

  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioCtx;

    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    const g = ctx.createGain();

    // a nice soft "discord-ish" ping (two tones)
    o1.type = "sine";
    o2.type = "triangle";
    o1.frequency.value = 660;
    o2.frequency.value = 990;

    g.gain.value = 0.0001;
    g.gain.exponentialRampToValueAtTime(0.08 * vol, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.20);

    o1.connect(g); o2.connect(g);
    g.connect(ctx.destination);

    o1.start(); o2.start();
    o1.stop(ctx.currentTime + 0.21);
    o2.stop(ctx.currentTime + 0.21);
  }catch(_){}
}

// ---------- password eye ----------
togglePass.addEventListener("click", () => {
  const isPw = passwordEl.type === "password";
  passwordEl.type = isPw ? "text" : "password";
  togglePass.textContent = isPw ? "🙈" : "👁";
});

// ---------- cooldown ----------
function cooldownSeconds(){ return isGuest ? 5 : 3; }
function canSend(){ return now() >= cooldownUntil; }

function startCooldown(){
  const secs = cooldownSeconds();
  cooldownUntil = now() + secs*1000;
  cooldownRow.style.display = "flex";
  updateCooldown();
}
function updateCooldown(){
  const msLeft = cooldownUntil - now();
  const total = cooldownSeconds()*1000;
  const p = clamp(1 - msLeft/total, 0, 1);
  cdFill.style.width = (p*100)+"%";

  if(msLeft <= 0){
    cooldownRow.style.display="none";
    cooldownRow.classList.remove("warn");
    return;
  }
  cooldownText.textContent = (msLeft/1000).toFixed(1)+"s";
  requestAnimationFrame(updateCooldown);
}
function cooldownWarn(){
  cooldownRow.style.display="flex";
  cooldownRow.classList.add("warn","shake");
  setTimeout(()=>cooldownRow.classList.remove("shake"), 380);
  setTimeout(()=>cooldownRow.classList.remove("warn"), 900);
}

// ---------- view switching ----------
function setView(type, id=null){
  view = { type, id };
  socket.emit("view:set", view);

  if(type==="global"){
    chatTitle.textContent="Global chat";
    chatHint.textContent="shared with everyone online";
    backBtn.style.display="none";
  } else if(type==="dm"){
    chatTitle.textContent=`DM — ${id}`;
    chatHint.textContent="private messages";
    backBtn.style.display="inline-flex";
  } else if(type==="group"){
    const meta = groupMeta.get(id);
    chatTitle.textContent = meta ? `Group — ${meta.name}` : "Group";
    chatHint.textContent="group chat";
    backBtn.style.display="inline-flex";
  }
}

backBtn.addEventListener("click", ()=> openGlobal(true));

// ---------- filtering ----------
function maybeHideMild(text){
  if (!settings?.hideMildProfanity) return text;
  return String(text).replace(MILD_RX, "•••");
}

function isBlockedUser(u){
  return !!social?.blocked?.includes(u);
}

function renderBodyText(scope, who, text){
  // Hard filter placeholder
  if(isServerHiddenText(text)) return "Message hidden (filtered).";

  // Block behavior (global + dm + group)
  if(isBlockedUser(who)) return "Message hidden (blocked user).";

  // Mild filter optional
  return maybeHideMild(text);
}

// ---------- message rendering ----------
function fmtTime(ts){
  const d = new Date(ts);
  if(!Number.isFinite(d.getTime())) return null;
  const h = String(d.getHours()).padStart(2,"0");
  const m = String(d.getMinutes()).padStart(2,"0");
  return `${h}:${m}`;
}

function addMessageToUI({ user, text, ts }, { scope="global", from=null } = {}){
  const t = fmtTime(ts);
  if(!t) return;

  const who = scope==="dm" ? from : user;
  const bodyText = renderBodyText(scope, who, text);

  const row = document.createElement("div");
  row.className="msg";
  row.innerHTML = `
    <div class="bubble">
      <div class="meta">
        <div class="u" data-user="${escapeHtml(who)}">${escapeHtml(who)}${(who===me?" (You)":"")}</div>
        <div class="t">${t}</div>
      </div>
      <div class="body">${escapeHtml(bodyText)}</div>
    </div>
  `;

  // click username -> profile popup
  row.querySelector(".u").addEventListener("click", (e)=>{
    const u = e.target.getAttribute("data-user");
    openProfile(u);
  });

  chatBox.appendChild(row);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function clearChat(){ chatBox.innerHTML=""; }

// ---------- mute helpers ----------
function saveMuted(){
  localStorage.setItem("tonkotsu_muted", JSON.stringify(muted));
}
function isMutedGlobal(){ return !!muted.global; }
function isMutedDM(u){ return !!muted.dm?.[u]; }
function isMutedGroup(gid){ return !!muted.group?.[gid]; }

function toggleMute(kind, key){
  if(kind==="global"){
    muted.global = !muted.global;
    toast("Mute", muted.global ? "Muted Global." : "Unmuted Global.");
  } else if(kind==="dm"){
    muted.dm[key] = !muted.dm[key];
    toast("Mute", muted.dm[key] ? `Muted DM with ${key}.` : `Unmuted DM with ${key}.`);
  } else if(kind==="group"){
    muted.group[key] = !muted.group[key];
    toast("Mute", muted.group[key] ? "Muted Group." : "Unmuted Group.");
  }
  saveMuted();
  // rerender current sidebar view
  if(tabMessages.classList.contains("primary")) renderSidebarMessages();
  if(tabGlobal.classList.contains("primary")) renderSidebarGlobal();
}

// ---------- sidebars ----------
function renderSidebarGlobal(){
  sideSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:950;font-size:12px;color:#dbe6f1">Online</div>
      <div style="font-size:11px;color:var(--muted)">${onlineUsers.length}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${onlineUsers.map(u => `
        <div class="row" data-profile="${escapeHtml(u.user)}">
          <div class="rowLeft">
            <div class="statusDot on"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(u.user)}${u.user===me ? " (You)" : ""}</div>
              <div class="rowSub">click for profile</div>
            </div>
          </div>
        </div>
      `).join("")}
    </div>
  `;
  sideSection.querySelectorAll("[data-profile]").forEach(el=>{
    el.addEventListener("click", ()=> openProfile(el.getAttribute("data-profile")));
  });
}

function renderSidebarMessages(){
  // global row must exist here too
  const dmUsers = Array.from(new Set(Array.from(dmCache.keys()))).sort((a,b)=>a.localeCompare(b));
  const groups = Array.from(groupMeta.values()).sort((a,b)=>a.name.localeCompare(b.name));

  sideSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:950;font-size:12px;color:#dbe6f1">Messages</div>
      <button class="btn small" id="createGroupBtn">Create group</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px" id="msgList"></div>
  `;

  const list = $("msgList");

  // Global row (no red pings here)
  const globalRow = document.createElement("div");
  globalRow.className = `row ${isMutedGlobal() ? "muted":""}`;
  globalRow.innerHTML = `
    <div class="rowLeft">
      <div class="statusDot on"></div>
      <div class="nameCol">
        <div class="rowName">Global</div>
        <div class="rowSub">everyone</div>
      </div>
    </div>
  `;
  globalRow.addEventListener("click", ()=> openGlobal(true));
  globalRow.addEventListener("contextmenu",(e)=>{
    e.preventDefault();
    toggleMute("global");
  });
  list.appendChild(globalRow);

  // DMs
  dmUsers.forEach(u=>{
    const row = document.createElement("div");
    row.className = `row ${isMutedDM(u) ? "muted":""}`;
    row.innerHTML = `
      <div class="rowLeft">
        <div class="statusDot ${onlineUsers.some(x=>x.user===u) ? "on":""}"></div>
        <div class="nameCol">
          <div class="rowName">${escapeHtml(u)}</div>
          <div class="rowSub">dm</div>
        </div>
      </div>
    `;
    row.addEventListener("click", ()=> openDM(u));
    row.addEventListener("contextmenu",(e)=>{
      e.preventDefault();
      toggleMute("dm", u);
    });
    list.appendChild(row);
  });

  // Groups
  groups.forEach(g=>{
    const row = document.createElement("div");
    row.className = `row ${isMutedGroup(g.id) ? "muted":""}`;
    row.innerHTML = `
      <div class="rowLeft">
        <div class="statusDot on"></div>
        <div class="nameCol">
          <div class="rowName">${escapeHtml(g.name)}</div>
          <div class="rowSub">group</div>
        </div>
      </div>
    `;
    row.addEventListener("click", ()=> openGroup(g.id));
    row.addEventListener("contextmenu",(e)=>{
      e.preventDefault();
      toggleMute("group", g.id);
    });
    list.appendChild(row);
  });

  $("createGroupBtn").onclick = () => {
    if(isGuest){
      toast("Guests", "Guests can’t create groups. Log in to use groups.");
      return;
    }
    openGroupCreate();
  };
}

function renderSidebarInbox(){
  if(isGuest){
    sideSection.innerHTML = `
      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);color:var(--muted);font-size:12px;line-height:1.45">
        Guest mode has no inbox.
        <br><br>
        Log in to get friend requests and group invites.
      </div>
    `;
    return;
  }

  const incomingFriends = social?.incoming || [];
  const groupInvites = social?.groupInvites || [];

  sideSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:950;font-size:12px;color:#dbe6f1">Inbox</div>
      <div style="font-size:11px;color:var(--muted)">${incomingFriends.length + groupInvites.length}</div>
    </div>

    <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px">
      ${groupInvites.length ? groupInvites.map(inv=>`
        <div class="row" data-ginv="${escapeHtml(inv.groupId)}">
          <div class="rowLeft">
            <div class="statusDot on"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(inv.groupName || "Unnamed Group")}</div>
              <div class="rowSub">group invite from ${escapeHtml(inv.from)}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn small primary" data-gaccept="${escapeHtml(inv.groupId)}">Join</button>
            <button class="btn small" data-gdecline="${escapeHtml(inv.groupId)}">Ignore</button>
          </div>
        </div>
      `).join("") : ""}

      ${incomingFriends.length ? incomingFriends.map(u=>`
        <div class="row" data-freq="${escapeHtml(u)}">
          <div class="rowLeft">
            <div class="statusDot ${onlineUsers.some(x=>x.user===u)?"on":""}"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(u)}</div>
              <div class="rowSub">friend request</div>
            </div>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn small primary" data-accept="${escapeHtml(u)}">Accept</button>
            <button class="btn small" data-decline="${escapeHtml(u)}">Ignore</button>
          </div>
        </div>
      `).join("") : ""}

      ${(!groupInvites.length && !incomingFriends.length) ? `
        <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);color:var(--muted);font-size:12px">
          Nothing here right now.
        </div>
      ` : ""}
    </div>
  `;

  sideSection.querySelectorAll("[data-accept]").forEach(b=>{
    b.addEventListener("click", (e)=>{
      e.stopPropagation();
      socket.emit("friend:accept", { from: b.getAttribute("data-accept") });
      toast("Friends", "Accepted.");
    });
  });
  sideSection.querySelectorAll("[data-decline]").forEach(b=>{
    b.addEventListener("click", (e)=>{
      e.stopPropagation();
      socket.emit("friend:decline", { from: b.getAttribute("data-decline") });
      toast("Friends", "Ignored.");
    });
  });

  sideSection.querySelectorAll("[data-gaccept]").forEach(b=>{
    b.addEventListener("click",(e)=>{
      e.stopPropagation();
      socket.emit("group:invite:accept", { groupId: b.getAttribute("data-gaccept") });
      toast("Groups", "Joining…");
    });
  });
  sideSection.querySelectorAll("[data-gdecline]").forEach(b=>{
    b.addEventListener("click",(e)=>{
      e.stopPropagation();
      socket.emit("group:invite:decline", { groupId: b.getAttribute("data-gdecline") });
      toast("Groups", "Ignored.");
    });
  });
}

// ---------- open global/dm/group ----------
function openGlobal(force){
  currentDM = null;
  currentGroupId = null;
  setView("global");

  tabGlobal.classList.add("primary");
  tabMessages.classList.remove("primary");
  tabInbox.classList.remove("primary");

  if(force){
    clearChat();
    globalCache.forEach(m=> addMessageToUI(m, { scope:"global" }));
  }
  socket.emit("requestGlobalHistory");
  renderSidebarGlobal();
}

function openDM(user){
  if(isGuest){
    toast("Guests", "Guests can’t DM. Log in to use DMs.");
    return;
  }
  currentDM = user;
  currentGroupId = null;
  setView("dm", user);

  tabGlobal.classList.remove("primary");
  tabMessages.classList.add("primary");
  tabInbox.classList.remove("primary");

  clearChat();
  socket.emit("dm:history", { withUser: user });
  renderSidebarMessages();
}

function openGroup(gid){
  if(isGuest){
    toast("Guests", "Guests can’t join groups.");
    return;
  }
  currentGroupId = gid;
  currentDM = null;
  setView("group", gid);

  tabGlobal.classList.remove("primary");
  tabMessages.classList.add("primary");
  tabInbox.classList.remove("primary");

  clearChat();
  socket.emit("group:history", { groupId: gid });
  renderSidebarMessages();
}

// ---------- group creation flow (invite required) ----------
function openGroupCreate(){
  const friends = (social?.friends || []).slice().sort((a,b)=>a.localeCompare(b));
  const onlineSet = new Set((onlineUsers||[]).map(x=>x.user));

  openModal("Create group", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="color:var(--muted);font-size:12px;line-height:1.45">
        Pick <b>at least 2 people</b> to invite. The group is created only when invites are sent.
      </div>

      <div style="display:flex;flex-direction:column;gap:8px">
        <div style="font-weight:900;font-size:12px">Group name</div>
        <input id="gcName" class="field" placeholder="Unnamed Group" value="Unnamed Group" maxlength="40" />
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="font-weight:900;font-size:12px">Invite people</div>
          <div style="font-size:11px;color:var(--muted)" id="gcCount">0 selected</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px;max-height:240px;overflow:auto" id="gcInviteList">
          ${
            friends.length
              ? friends.map(u=>`
                  <label class="row" style="cursor:pointer" data-invite="${escapeHtml(u)}">
                    <div class="rowLeft">
                      <div class="statusDot ${onlineSet.has(u) ? "on":""}"></div>
                      <div class="nameCol">
                        <div class="rowName">${escapeHtml(u)}</div>
                        <div class="rowSub">${onlineSet.has(u) ? "online" : "offline"}</div>
                      </div>
                    </div>
                    <input type="checkbox" data-check="${escapeHtml(u)}" />
                  </label>
                `).join("")
              : `<div style="color:var(--muted);font-size:12px">Add friends first to invite them.</div>`
          }
        </div>
      </div>

      <div style="display:flex;gap:10px">
        <button class="btn primary" id="gcCreateBtn" disabled>Create</button>
        <button class="btn" id="gcCancelBtn">Cancel</button>
      </div>
    </div>
  `);

  const selected = new Set();
  const updateBtn = ()=>{
    $("gcCount").textContent = `${selected.size} selected`;
    $("gcCreateBtn").disabled = selected.size < 2;
  };
  updateBtn();

  modalBody.querySelectorAll("[data-check]").forEach(cb=>{
    cb.addEventListener("change", ()=>{
      const u = cb.getAttribute("data-check");
      if(cb.checked) selected.add(u); else selected.delete(u);
      updateBtn();
    });
  });

  $("gcCancelBtn").onclick = closeModal;
  $("gcCreateBtn").onclick = ()=>{
    const name = ($("gcName").value || "").trim() || "Unnamed Group";
    const invites = Array.from(selected);
    if(invites.length < 2) return;
    closeModal();
    socket.emit("group:createWithInvites", { name, invites });
    toast("Group", "Invites sent.");
  };
}

// ---------- group management popup (single close button only) ----------
function openGroupManage(gid){
  const meta = groupMeta.get(gid);
  if(!meta) return;

  const isOwner = meta.owner === me;

  const membersHtml = (meta.members || []).map(u => `
    <div class="row" data-member="${escapeHtml(u)}" title="${u===me ? "Right-click to leave" : ""}">
      <div class="rowLeft">
        <div class="statusDot ${onlineUsers.some(x=>x.user===u)?"on":""}"></div>
        <div class="nameCol">
          <div class="rowName">${escapeHtml(u)}${u===meta.owner ? " (Owner)" : ""}${u===me ? " (You)" : ""}</div>
          <div class="rowSub">member</div>
        </div>
      </div>
      ${isOwner && u!==meta.owner ? `<button class="btn small" data-remove="${escapeHtml(u)}">Remove</button>` : ``}
    </div>
  `).join("");

  openModal("Group settings", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div style="min-width:0">
          <div style="font-weight:950">${escapeHtml(meta.name)}</div>
          <div style="font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(meta.id)}</div>
        </div>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Members</div>
        <div style="display:flex;flex-direction:column;gap:8px" id="membersList">${membersHtml}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:10px">
          Tip: Right-click your own name to leave.
        </div>
      </div>

      ${isOwner ? `
        <div style="display:flex;flex-direction:column;gap:10px">
          <div style="font-weight:900;font-size:12px">Owner controls</div>
          <div style="display:flex;gap:10px">
            <input id="addUser" class="field" placeholder="Add member (username)" />
            <button class="btn small primary" id="addBtn">Add</button>
          </div>

          <div style="display:flex;gap:10px">
            <input id="renameGroup" class="field" placeholder="Rename group" />
            <button class="btn small" id="renameBtn">Rename</button>
          </div>

          <div style="display:flex;gap:10px">
            <input id="transferUser" class="field" placeholder="Transfer ownership to…" />
            <button class="btn small" id="transferBtn">Transfer</button>
          </div>

          <button class="btn danger" id="deleteBtn">Delete group</button>
        </div>
      ` : `
        <button class="btn danger" id="leaveBtn">Leave group</button>
      `}
    </div>
  `);

  // Remove member (owner)
  modalBody.querySelectorAll("[data-remove]").forEach(btn=>{
    btn.addEventListener("click",(e)=>{
      e.stopPropagation();
      const u = btn.getAttribute("data-remove");
      socket.emit("group:removeMember", { groupId: gid, user: u });
      toast("Group", `Removing ${u}…`);
    });
  });

  // Right click your own name -> leave
  modalBody.querySelectorAll("[data-member]").forEach(row=>{
    row.addEventListener("contextmenu",(e)=>{
      e.preventDefault();
      const u = row.getAttribute("data-member");
      if(u !== me) return;

      openModal("Leave group?", `
        <div style="color:var(--muted);font-size:12px;line-height:1.45">
          Leave <b>${escapeHtml(meta.name)}</b>?
        </div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <button class="btn" id="cancelLeave">Cancel</button>
          <button class="btn primary" id="confirmLeave">Leave</button>
        </div>
      `);
      $("cancelLeave").onclick = ()=> openGroupManage(gid);
      $("confirmLeave").onclick = ()=>{
        closeModal();
        socket.emit("group:leave", { groupId: gid });
        toast("Group", "Leaving…");
      };
    });
  });

  if(isOwner){
    $("addBtn").onclick = ()=>{
      const u = ($("addUser").value || "").trim();
      if(!u) return;
      socket.emit("group:addMember", { groupId: gid, user: u });
      toast("Group", `Adding ${u}…`);
    };

    $("renameBtn").onclick = ()=>{
      const name = ($("renameGroup").value || "").trim();
      if(!name) return;
      socket.emit("group:rename", { groupId: gid, name });
      toast("Group", "Renaming…");
    };

    $("transferBtn").onclick = ()=>{
      const u = ($("transferUser").value || "").trim();
      if(!u) return;
      socket.emit("group:transferOwner", { groupId: gid, newOwner: u });
      toast("Group", `Transferring to ${u}…`);
    };

    $("deleteBtn").onclick = ()=>{
      openModal("Delete group?", `
        <div style="color:var(--muted);font-size:12px;line-height:1.45">
          Delete <b>${escapeHtml(meta.name)}</b>? This can’t be undone.
        </div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <button class="btn" id="cancelDel">Cancel</button>
          <button class="btn primary" id="confirmDel">Delete</button>
        </div>
      `);
      $("cancelDel").onclick = ()=> openGroupManage(gid);
      $("confirmDel").onclick = ()=>{
        closeModal();
        socket.emit("group:delete", { groupId: gid });
        toast("Group", "Deleting…");
      };
    };
  } else {
    $("leaveBtn").onclick = ()=>{
      socket.emit("group:leave", { groupId: gid });
      closeModal();
      toast("Group", "Leaving…");
    };
  }
}

// ---------- profile popup (guests show name only) ----------
function isGuestUser(u){ return /^Guest\d{4,5}$/.test(String(u)); }

function openProfile(user){
  if(!user) return;

  // guest profile = name only
  const guestish = isGuestUser(user) || (user === me && isGuest);

  if(guestish){
    openModal("Profile", `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-weight:950;font-size:16px">${escapeHtml(user)}</div>
        <div style="font-size:12px;color:var(--muted)">Guest users have no stats.</div>
      </div>
    `);
    return;
  }

  openModal("Profile", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div style="min-width:0">
          <div style="font-weight:950;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(user)}</div>
          <div style="font-size:12px;color:var(--muted)" id="profSub">loading…</div>
        </div>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap" id="profActions"></div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Stats</div>
        <div id="profStats" style="display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:12px"></div>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${(!isGuest && user !== me) ? `<button class="btn" id="dmBtn">DM</button>` : ``}
        ${(!isGuest && user !== me) ? `<button class="btn" id="friendBtn">Add friend</button>` : ``}
        ${(!isGuest && user !== me) ? `<button class="btn danger" id="blockBtn">Block</button>` : ``}
        ${(!isGuest && user !== me) ? `<button class="btn" id="removeFriendBtn" style="display:none">Remove friend</button>` : ``}
      </div>
    </div>
  `);

  socket.emit("profile:get", { user });
  modalBody._profileUser = user;
}

// ---------- settings popup (preview-only until Save) ----------
function openSettings(){
  const original = JSON.parse(JSON.stringify(settings));

  const themeKeys = ["dark","vortex","abyss","carbon"];
  const curTheme = settings.theme || "dark";
  const curDensity = Number.isFinite(settings.density) ? settings.density : 0.15;
  const curSidebar = Number.isFinite(settings.sidebar) ? settings.sidebar : 0.20;

  openModal("Settings", `
    <div style="display:flex;flex-direction:column;gap:10px">

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Theme</div>
        <input id="themeSlider" type="range" min="0" max="3" step="1" value="${themeKeys.indexOf(curTheme)}" style="width:100%">
        <div style="font-size:12px;color:var(--muted);margin-top:6px">Current: <b id="themeName">${escapeHtml(curTheme)}</b></div>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Layout</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Compact ↔ Cozy</div>
        <input id="densitySlider" type="range" min="0" max="1" step="0.01" value="${curDensity}" style="width:100%">

        <div style="font-size:11px;color:var(--muted);margin:10px 0 8px">Sidebar width</div>
        <input id="sidebarSlider" type="range" min="0" max="1" step="0.01" value="${curSidebar}" style="width:100%">
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div>
          <div style="font-weight:900;font-size:12px">Custom cursor</div>
          <div style="font-size:11px;color:var(--muted)">Turn it off if you don’t like it.</div>
        </div>
        <button class="btn small" id="toggleCursor">${settings.customCursor ? "On" : "Off"}</button>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div>
          <div style="font-weight:900;font-size:12px">Ping sound</div>
          <div style="font-size:11px;color:var(--muted)">For DMs/inbox only.</div>
        </div>
        <button class="btn small" id="togglePing">${settings.pingSound ? "On" : "Off"}</button>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Ping volume</div>
        <input id="pingVol" type="range" min="0" max="1" step="0.01" value="${Number(settings.pingVolume ?? 0.45)}" style="width:100%">
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div>
          <div style="font-weight:900;font-size:12px">Hide mild profanity</div>
          <div style="font-size:11px;color:var(--muted)">F/S/A words etc get masked as •••.</div>
        </div>
        <button class="btn small" id="toggleMild">${settings.hideMildProfanity ? "On" : "Off"}</button>
      </div>

      <div style="display:flex;gap:10px">
        <button class="btn primary" id="saveS">Save</button>
        <button class="btn" id="closeS">Close</button>
      </div>

      ${isGuest ? `
        <div style="color:var(--muted);font-size:11px;line-height:1.45">
          Guest settings aren’t saved.
        </div>
      ` : ``}
    </div>
  `);

  // preview changes live
  $("themeSlider").addEventListener("input", ()=>{
    const k = themeKeys[Number($("themeSlider").value)];
    $("themeName").textContent = k;
    applyTheme(k);
    settings.theme = k;
  });
  $("densitySlider").addEventListener("input", ()=>{
    const v = Number($("densitySlider").value);
    applyDensity(v);
    settings.density = v;
  });
  $("sidebarSlider").addEventListener("input", ()=>{
    const v = Number($("sidebarSlider").value);
    applySidebarWidth(v);
    settings.sidebar = v;
  });

  $("toggleMild").onclick = ()=>{
    settings.hideMildProfanity = !settings.hideMildProfanity;
    $("toggleMild").textContent = settings.hideMildProfanity ? "On" : "Off";
  };

  $("toggleCursor").onclick = ()=>{
    settings.customCursor = !settings.customCursor;
    $("toggleCursor").textContent = settings.customCursor ? "On" : "Off";
    applyCursor(settings.customCursor);
  };

  $("togglePing").onclick = ()=>{
    settings.pingSound = !settings.pingSound;
    $("togglePing").textContent = settings.pingSound ? "On" : "Off";
    beep();
  };

  $("pingVol").addEventListener("input", ()=>{
    settings.pingVolume = Number($("pingVol").value);
  });

  // CLOSE without save: revert preview
  $("closeS").onclick = ()=>{
    settings = original;
    applyTheme(settings.theme || "dark");
    applyDensity(settings.density ?? 0.15);
    applySidebarWidth(settings.sidebar ?? 0.20);
    applyCursor(settings.customCursor !== false);
    closeModal();
  };

  // SAVE: persist for accounts only
  $("saveS").onclick = ()=>{
    if(isGuest){
      toast("Settings", "Guest settings are preview-only.");
      closeModal();
      return;
    }
    socket.emit("settings:update", settings);
    toast("Settings", "Saved.");
    closeModal();
  };
}

// ---------- tabs ----------
tabGlobal.addEventListener("click", ()=> openGlobal(true));
tabMessages.addEventListener("click", ()=>{
  tabGlobal.classList.remove("primary");
  tabMessages.classList.add("primary");
  tabInbox.classList.remove("primary");
  renderSidebarMessages();
});
tabInbox.addEventListener("click", ()=>{
  tabGlobal.classList.remove("primary");
  tabMessages.classList.remove("primary");
  tabInbox.classList.add("primary");
  socket.emit("social:sync"); // refresh inbox
  renderSidebarInbox();
});

// ---------- composer send ----------
sendBtn.addEventListener("click", sendCurrent);
messageEl.addEventListener("keydown", (e)=>{
  if(e.key==="Enter" && !e.shiftKey){
    e.preventDefault();
    sendCurrent();
  }
});

function sendCurrent(){
  if(!me) return;
  if(!canSend()){ cooldownWarn(); return; }

  const text = messageEl.value.trim();
  if(!text) return;

  startCooldown();
  messageEl.value = "";

  if(view.type==="global"){
    socket.emit("sendGlobal", { text, ts: now() });
  } else if(view.type==="dm"){
    socket.emit("dm:send", { to: currentDM, text });
  } else if(view.type==="group"){
    socket.emit("group:send", { groupId: currentGroupId, text });
  }
}

// ---------- auth buttons ----------
settingsBtn.addEventListener("click", openSettings);

logoutBtn.addEventListener("click", ()=>{
  showLoading("logging out…");
  setTimeout(()=>{
    localStorage.removeItem("tonkotsu_token");
    location.reload();
  }, 650);
});

loginBtn.addEventListener("click", ()=>{
  loginOverlay.classList.remove("hidden");
});

// ---------- join buttons ----------
function shakeLogin(){
  const card = document.querySelector(".loginCard");
  card.classList.add("shake");
  setTimeout(()=> card.classList.remove("shake"), 380);
}

function makeGuestName(){
  // 4 digits (or 5 sometimes) max
  const n = Math.floor(1000 + Math.random()*9000); // 1000..9999
  return `Guest${n}`;
}

joinBtn.addEventListener("click", ()=>{
  const u = usernameEl.value.trim();
  const p = passwordEl.value;

  if(!u || !p){
    shakeLogin();
    return;
  }

  showLoading("logging in…");
  socket.emit("login", { username: u, password: p, guest:false });
});

guestBtn.addEventListener("click", ()=>{
  showLoading("joining as guest…");
  socket.emit("login", { guest:true, guestName: makeGuestName() });
});

passwordEl.addEventListener("keydown",(e)=>{
  if(e.key==="Enter") joinBtn.click();
});

// ---------- pings ----------
function setPing(el, n){
  const v = Number(n) || 0;
  if(v > 0){
    el.textContent = String(v);
    el.classList.add("show");
  } else {
    el.classList.remove("show");
  }
}

// Friend + group invites => inbox ping
function computeInboxPing(){
  if(isGuest) return 0;
  const a = (social?.incoming?.length || 0);
  const b = (social?.groupInvites?.length || 0);
  return a + b;
}

let lastInboxCount = 0;
function updatePings(){
  const inboxCount = computeInboxPing();
  setPing(inboxPing, inboxCount);

  // Messages ping: server can send counts; fallback: if inbox has stuff, show it on Messages too
  // (still not for Global)
  const msgCount = Number(social?._msgPing || 0); // server can set this
  setPing(msgPing, msgCount);

  if(inboxCount > lastInboxCount && (settings?.pingSound && !isGuest)){
    beep();
  }
  lastInboxCount = inboxCount;
}

// ---------- socket events ----------
socket.on("loginSuccess",(data)=>{
  hideLoading();

  me = data.username;
  isGuest = !!data.guest;

  // guests: no xp/stats
  xp = (!isGuest ? (data.xp || xp) : null);

  // set settings but APPLY defaults properly:
  // - account settings apply now
  // - guest uses compact defaults and doesn't persist
  if(!isGuest && data.settings){
    settings = { ...settings, ...data.settings };
  }

  social = data.social ? data.social : social;

  // Apply theme/layout/cursor now
  applyTheme(settings?.theme || "dark");
  applyDensity(settings?.density ?? 0.15);
  applySidebarWidth(settings?.sidebar ?? 0.20);
  applyCursor(settings?.customCursor !== false);

  // show app
  loginOverlay.classList.add("hidden");
  app.classList.add("show");
  mePill.style.display = "flex";
  meName.textContent = me;

  if(!isGuest && data.token){
    localStorage.setItem("tonkotsu_token", data.token);
    token = data.token;
  }

  if(isGuest){
    settingsBtn.style.display="inline-flex"; // allow preview settings
    logoutBtn.style.display="none";
    loginBtn.style.display="inline-flex";
  } else {
    settingsBtn.style.display="inline-flex";
    logoutBtn.style.display="inline-flex";
    loginBtn.style.display="none";
  }

  updatePings();
  toast("Welcome", isGuest ? "Joined as Guest" : `Logged in as ${me}`);

  openGlobal(true);

  // request initial lists
  if(!isGuest){
    socket.emit("groups:list");
    socket.emit("social:sync");
  }
});

socket.on("resumeFail", ()=>{
  localStorage.removeItem("tonkotsu_token");
  token = null;
});

socket.on("loginError",(msg)=>{
  hideLoading();
  shakeLogin();
  toast("Login failed", msg || "Try again.");
});

socket.on("settings",(s)=>{
  // server confirms saved settings
  if(isGuest) return;
  settings = { ...settings, ...s };
  applyTheme(settings?.theme || "dark");
  applyDensity(settings?.density ?? 0.15);
  applySidebarWidth(settings?.sidebar ?? 0.20);
  applyCursor(settings?.customCursor !== false);
});

socket.on("social:update",(s)=>{
  social = { ...social, ...s };
  updatePings();
  if(tabInbox.classList.contains("primary")) renderSidebarInbox();
});

socket.on("ping:update",(p)=>{
  // optional server side pings
  if(p && typeof p === "object"){
    if(Number.isFinite(p.messages)) social._msgPing = p.messages;
  }
  updatePings();
});

socket.on("xp:update",(x)=>{
  if(isGuest) return;
  xp = x;
});

socket.on("onlineUsers",(list)=>{
  onlineUsers = Array.isArray(list) ? list : [];
  if(view.type==="global" && tabGlobal.classList.contains("primary")) renderSidebarGlobal();
  if(tabMessages.classList.contains("primary")) renderSidebarMessages();
});

socket.on("history",(msgs)=>{
  globalCache = (Array.isArray(msgs)?msgs:[])
    .filter(m => Number.isFinite(new Date(m.ts).getTime()));
  if(view.type==="global"){
    clearChat();
    globalCache.forEach(m=> addMessageToUI(m, { scope:"global" }));
  }
});

socket.on("globalMessage",(m)=>{
  if(!m || !Number.isFinite(new Date(m.ts).getTime())) return;
  globalCache.push(m);
  if(globalCache.length > 250) globalCache.shift();
  if(view.type==="global"){
    addMessageToUI(m, { scope:"global" });
  }
  // no red pings for global
});

socket.on("sendError",(e)=>{
  toast("Action blocked", e?.reason || "Blocked.");
});

// DMs
socket.on("dm:history", ({ withUser, msgs }={})=>{
  if(!withUser) return;
  dmCache.set(withUser, Array.isArray(msgs) ? msgs : []);
  if(view.type==="dm" && currentDM===withUser){
    clearChat();
    (dmCache.get(withUser) || []).forEach(m=> addMessageToUI(m, { scope:"dm", from: m.user === me ? withUser : m.user }));
  }
});

socket.on("dm:message", ({ from, msg }={})=>{
  if(!from || !msg) return;
  if(!dmCache.has(from)) dmCache.set(from, []);
  dmCache.get(from).push(msg);
  if(dmCache.get(from).length > 250) dmCache.get(from).shift();

  if(view.type==="dm" && currentDM===from){
    addMessageToUI(msg, { scope:"dm", from: from });
  } else {
    // message ping if not muted
    if(!isMutedDM(from) && settings?.pingSound && !isGuest) beep();
  }
});

// Groups list/meta/history/messages
socket.on("groups:list",(list)=>{
  if(isGuest) return;
  groupMeta.clear();
  (Array.isArray(list)?list:[]).forEach(g=>{
    groupMeta.set(g.id, { id:g.id, name:g.name, owner:g.owner, members:g.members || [] });
  });

  if(tabMessages.classList.contains("primary")) renderSidebarMessages();
});

socket.on("group:created",(g)=>{
  if(!g) return;
  groupMeta.set(g.id, { id:g.id, name:g.name, owner:g.owner, members:g.members || [] });
  toast("Group", `Created “${g.name}”`);
  socket.emit("groups:list");
});

socket.on("group:history",({ groupId, meta, msgs }={})=>{
  if(!groupId || !meta) return;
  groupMeta.set(groupId, meta);
  groupCache.set(groupId, Array.isArray(msgs) ? msgs : []);
  currentGroupId = groupId;

  setView("group", groupId);

  clearChat();
  (msgs || []).forEach(m=> addMessageToUI(m, { scope:"group" }));

  chatHint.innerHTML = `members: <b style="color:var(--text)">${(meta.members||[]).length}</b> • <span style="text-decoration:underline;cursor:pointer" id="manageGroupLink">manage</span>`;
  setTimeout(()=>{
    const link = document.getElementById("manageGroupLink");
    if(link) link.onclick = ()=> openGroupManage(groupId);
  }, 0);
});

socket.on("group:message",({ groupId, msg }={})=>{
  if(!groupId || !msg) return;
  if(!groupCache.has(groupId)) groupCache.set(groupId, []);
  groupCache.get(groupId).push(msg);
  if(groupCache.get(groupId).length > 250) groupCache.get(groupId).shift();

  if(view.type==="group" && currentGroupId===groupId){
    addMessageToUI(msg, { scope:"group" });
  } else {
    if(!isMutedGroup(groupId) && settings?.pingSound && !isGuest) beep();
  }
});

socket.on("group:meta",({ groupId, meta }={})=>{
  if(!groupId || !meta) return;
  groupMeta.set(groupId, meta);
  if(view.type==="group" && currentGroupId===groupId){
    chatTitle.textContent = `Group — ${meta.name}`;
  }
  if(tabMessages.classList.contains("primary")) renderSidebarMessages();
});

socket.on("group:left",({ groupId }={})=>{
  toast("Group", "Left group.");
  if(currentGroupId===groupId){
    openGlobal(true);
  }
  socket.emit("groups:list");
});

socket.on("group:deleted",({ groupId }={})=>{
  toast("Group", "Group deleted.");
  if(currentGroupId===groupId){
    openGlobal(true);
  }
  socket.emit("groups:list");
});

// Profile response
socket.on("profile:data",(data)=>{
  const user = modalBody?._profileUser;
  if(!user || !data || data.user !== user) return;

  const profSub = document.getElementById("profSub");
  const profStats = document.getElementById("profStats");

  if(!profSub || !profStats) return;

  profSub.textContent = `Level ${data.level} • created ${new Date(data.createdAt).toLocaleDateString()}`;

  profStats.innerHTML = `
    <div>Messages: <b style="color:var(--text)">${escapeHtml(data.messages)}</b></div>
    <div>Friends: <b style="color:var(--text)">${escapeHtml(data.friendsCount)}</b></div>
    <div>XP: <b style="color:var(--text)">${escapeHtml(data.xp)}</b> / ${escapeHtml(data.next)}</div>
  `;

  // actions
  const isFriend = (social?.friends || []).includes(user);
  const removeBtn = document.getElementById("removeFriendBtn");
  if(removeBtn) removeBtn.style.display = isFriend ? "inline-flex" : "none";

  const dmBtn = document.getElementById("dmBtn");
  if(dmBtn) dmBtn.onclick = ()=> { closeModal(); openDM(user); };

  const friendBtn = document.getElementById("friendBtn");
  if(friendBtn) friendBtn.onclick = ()=> { socket.emit("friend:request", { to: user }); toast("Friends", "Request sent."); };

  if(removeBtn) removeBtn.onclick = ()=> { socket.emit("friend:remove", { user }); toast("Friends", "Removed."); };

  const blockBtn = document.getElementById("blockBtn");
  if(blockBtn) blockBtn.onclick = ()=> {
    socket.emit("user:block", { user });
    toast("Block", "Blocked user.");
    closeModal();
  };
});

// ---------- startup resume ----------
(function boot(){
  // compact defaults applied immediately to avoid “wide” look before login
  applyTheme(settings.theme);
  applyDensity(settings.density);
  applySidebarWidth(settings.sidebar);
  applyCursor(settings.customCursor);

  // resume if token exists
  if(token){
    showLoading("resuming…");
    socket.emit("resume", { token });
    setTimeout(()=> hideLoading(), 2000);
  }

  // right-click mute on main nav buttons too
  tabGlobal.addEventListener("contextmenu", (e)=>{ e.preventDefault(); toggleMute("global"); });
})();

// ---------- remove emoji feature ----------
/* nothing to do because no emoji UI exists */

// ---------- ensure inbox/messages are correct ping sources ----------
function syncUIAfterTab(){
  updatePings();
  if(tabInbox.classList.contains("primary")) renderSidebarInbox();
  if(tabMessages.classList.contains("primary")) renderSidebarMessages();
}

// just in case some servers send social late
setInterval(()=> {
  if(!me) return;
  updatePings();
}, 2000);
