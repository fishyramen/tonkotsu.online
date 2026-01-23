/* tonkotsu.online — compact client (no gradients, no tutorial bot) */

const socket = io();
const $ = (id) => document.getElementById(id);

// Elements
const loginOverlay = $("loginOverlay");
const loading = $("loading");
const app = $("app");

const usernameEl = $("username");
const passwordEl = $("password");
const joinBtn = $("joinBtn");
const guestBtn = $("guestBtn");
const togglePass = $("togglePass");

const sideScroll = $("sideScroll");

const inboxBtn = $("inboxBtn");
const inboxPing = $("inboxPing");

const mePill = $("mePill");
const meName = $("meName");
const userDropdown = $("userDropdown");
const ddProfile = $("ddProfile");
const ddSettings = $("ddSettings");
const ddLogout = $("ddLogout");

const chatTitle = $("chatTitle");
const chatHint = $("chatHint");
const chatActionBtn = $("chatActionBtn");

const chatBox = $("chatBox");
const messageEl = $("message");
const sendBtn = $("sendBtn");

const cooldownRow = $("cooldownRow");
const cooldownText = $("cooldownText");
const cdFill = $("cdFill");

const modalBack = $("modalBack");
const modalTitle = $("modalTitle");
const modalBody = $("modalBody");
const modalClose = $("modalClose");
const modalFoot = $("modalFoot");

const toasts = $("toasts");

// Time
const now = () => Date.now();
const clamp = (n,a,b)=> Math.max(a, Math.min(b,n));

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function fmtTime(ts){
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return "";
  const h = String(d.getHours()).padStart(2,"0");
  const m = String(d.getMinutes()).padStart(2,"0");
  return `${h}:${m}`;
}

// State
let me = { username: null, guest: true, token: null, tutorialDone: false, isNew: false };
let settings = {
  // keep minimal; no themes requested now
  density: 0.18,             // compact default
  reduceMotion: false,
  cursorMode: "orb",         // off | orb | trail
  sounds: true,
  hideBlockedInGlobal: true, // if blocked users show "hidden"
  revealBlocked: false       // if reveal, show raw text
};

let social = { friends: [], incoming: [], outgoing: [], blocked: [] };
let onlineUsers = []; // [{user}]
let groups = [];      // [{id,name,owner,members}]
let dmUsers = new Set(); // list of users you've DM'd (client cache + from server events)
let currentView = { type: "global", id: null }; // global | dm | group
let currentDM = null;
let currentGroupId = null;

// inbox items: {type, text, ts}
let inboxItems = [];
let inboxCount = 0;

// XP display (guests have none)
let xp = null;

// Caches
let globalCache = [];
const dmCache = new Map();    // user -> msgs[]
const groupCache = new Map(); // gid -> msgs[]
const groupMeta = new Map();  // gid -> {id,name,owner,members}

// Cooldown
let cooldownUntil = 0;

// ---------- Toasts ----------
function toast(title, msg){
  // no tutorial toasts (tutorial uses modal only)
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
  setTimeout(()=>{ d.style.opacity="0"; d.style.transform="translateY(10px)"; }, 2800);
  setTimeout(()=> d.remove(), 3300);
}

// ---------- Modal (single close button, always closable) ----------
function openModal(title, html, footHtml = ""){
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  if (footHtml){
    modalFoot.style.display = "flex";
    modalFoot.innerHTML = footHtml;
  } else {
    modalFoot.style.display = "none";
    modalFoot.innerHTML = "";
  }
  modalBack.classList.add("show");
}
function closeModal(){
  modalBack.classList.remove("show");
  modalBody.innerHTML = "";
  modalFoot.innerHTML = "";
  modalFoot.style.display = "none";
}
modalClose.addEventListener("click", closeModal);
modalBack.addEventListener("click", (e)=>{ if(e.target === modalBack) closeModal(); });

// ---------- Loading ----------
function showLoading(text="syncing…"){
  $("loaderSub").textContent = text;
  loading.classList.add("show");
}
function hideLoading(){
  loading.classList.remove("show");
}

// ---------- Login overlay ----------
function showLogin(show=true){
  loginOverlay.classList.toggle("hidden", !show);
}

// ---------- Password eye ----------
togglePass.addEventListener("click", ()=>{
  const isPw = passwordEl.type === "password";
  passwordEl.type = isPw ? "text" : "password";
});

// ---------- Token save/resume ----------
const TOKEN_KEY = "tonkotsu_token";
function saveToken(t){
  if (!t) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, t);
  me.token = t || null;
}
function tryResume(){
  const t = localStorage.getItem(TOKEN_KEY);
  if (!t) return false;
  showLoading("resuming…");
  socket.emit("resume", { token: t });
  return true;
}

// ---------- Cursor modes ----------
let cursorEl = null;
let trailEls = [];
let lastTrail = { x: 0, y: 0 };
let cursorOn = false;

function ensureCursor(){
  if (cursorEl) return;

  cursorEl = document.createElement("div");
  cursorEl.style.position = "fixed";
  cursorEl.style.left = "0";
  cursorEl.style.top = "0";
  cursorEl.style.width = "10px";
  cursorEl.style.height = "10px";
  cursorEl.style.borderRadius = "999px";
  cursorEl.style.background = "rgba(233,238,245,.85)";
  cursorEl.style.boxShadow = "0 0 0 6px rgba(233,238,245,.08)";
  cursorEl.style.pointerEvents = "none";
  cursorEl.style.zIndex = "999";
  cursorEl.style.transform = "translate(-50%,-50%)";
  cursorEl.style.transition = "transform .05s linear";
  document.body.appendChild(cursorEl);

  // trail dots
  for (let i=0;i<8;i++){
    const t = document.createElement("div");
    t.style.position = "fixed";
    t.style.left = "0";
    t.style.top = "0";
    t.style.width = "8px";
    t.style.height = "8px";
    t.style.borderRadius = "999px";
    t.style.background = "rgba(233,238,245,.35)";
    t.style.pointerEvents = "none";
    t.style.zIndex = "998";
    t.style.transform = "translate(-50%,-50%)";
    t.style.opacity = "0";
    document.body.appendChild(t);
    trailEls.push(t);
  }
}

function setCursorMode(mode){
  settings.cursorMode = mode;

  const wants = mode !== "off";
  cursorOn = wants;
  document.body.classList.toggle("cursorOn", wants);
  document.body.classList.toggle("cursorOff", !wants);

  if (!wants){
    if (cursorEl) cursorEl.style.display = "none";
    trailEls.forEach(t=> t.style.display = "none");
    return;
  }
  ensureCursor();
  cursorEl.style.display = "block";
  trailEls.forEach(t=> t.style.display = (mode === "trail" ? "block" : "none"));
}

window.addEventListener("mousemove", (e)=>{
  if (!cursorOn || !cursorEl) return;

  const x = e.clientX;
  const y = e.clientY;

  cursorEl.style.transform = `translate(${x}px, ${y}px)`;

  if (settings.cursorMode === "trail"){
    // fast short trail
    lastTrail.x = x;
    lastTrail.y = y;
  }
});

function trailTick(){
  if (cursorOn && settings.cursorMode === "trail" && trailEls.length){
    let x = lastTrail.x;
    let y = lastTrail.y;

    trailEls.forEach((t, i)=>{
      const p = 1 - (i / trailEls.length);
      const tx = (t._x ?? x);
      const ty = (t._y ?? y);

      // follow quickly
      const nx = tx + (x - tx) * 0.35;
      const ny = ty + (y - ty) * 0.35;

      t._x = nx; t._y = ny;
      t.style.transform = `translate(${nx}px, ${ny}px)`;
      t.style.opacity = String(0.12 + p*0.28);

      x = nx;
      y = ny;
    });
  }
  requestAnimationFrame(trailTick);
}
trailTick();

// ---------- Reduce motion ----------
function applyReduceMotion(on){
  settings.reduceMotion = !!on;
  document.body.classList.toggle("reduceMotion", settings.reduceMotion);
}

// ---------- Cooldown ----------
function cooldownSeconds(){
  return me.guest ? 5 : 3;
}
function canSend(){
  return now() >= cooldownUntil;
}
function startCooldown(){
  const secs = cooldownSeconds();
  cooldownUntil = now() + secs*1000;
  cooldownRow.style.display = "flex";
  cooldownRow.classList.remove("warn");
  updateCooldown();
}
function updateCooldown(){
  const msLeft = cooldownUntil - now();
  const total = cooldownSeconds() * 1000;
  const p = clamp(1 - msLeft/total, 0, 1);
  cdFill.style.width = `${p*100}%`;

  if (msLeft <= 0){
    cooldownRow.style.display = "none";
    cooldownRow.classList.remove("warn");
    return;
  }
  cooldownText.textContent = `${(msLeft/1000).toFixed(1)}s`;
  requestAnimationFrame(updateCooldown);
}
function cooldownWarn(){
  cooldownRow.style.display = "flex";
  cooldownRow.classList.add("warn","shake");
  setTimeout(()=> cooldownRow.classList.remove("shake"), 380);
  setTimeout(()=> cooldownRow.classList.remove("warn"), 900);
}

// ---------- Mentions parsing ----------
function extractMentions(text){
  // @username (letters/numbers/_/.)
  const rx = /@([A-Za-z0-9_.]{3,20})/g;
  const out = new Set();
  let m;
  while ((m = rx.exec(String(text))) !== null){
    out.add(m[1]);
  }
  return Array.from(out);
}

// ---------- Sidebar rendering ----------
function renderSidebar(){
  const onlineCount = onlineUsers.length;

  const dmList = Array.from(dmUsers).sort((a,b)=>a.localeCompare(b));
  const groupList = groups.slice().sort((a,b)=>String(a.name).localeCompare(String(b.name)));

  const messagesRows = `
    <div class="row" data-open="global" title="Right-click to mute">
      <div class="statusDot on"></div>
      <div class="rowCol">
        <div class="rowName">Global</div>
        <div class="rowSub">everyone online</div>
      </div>
    </div>

    <div class="row" data-open="leaderboard">
      <div class="statusDot"></div>
      <div class="rowCol">
        <div class="rowName">Leaderboard</div>
        <div class="rowSub">top XP</div>
      </div>
    </div>

    ${dmList.map(u=>`
      <div class="row" data-open="dm:${escapeHtml(u)}" title="Right-click to mute">
        <div class="statusDot ${onlineUsers.some(x=>x.user===u) ? "on" : ""}"></div>
        <div class="rowCol">
          <div class="rowName">${escapeHtml(u)}</div>
          <div class="rowSub">dm</div>
        </div>
      </div>
    `).join("")}

    ${groupList.map(g=>`
      <div class="row" data-open="group:${escapeHtml(g.id)}" title="Right-click to mute">
        <div class="statusDot on"></div>
        <div class="rowCol">
          <div class="rowName">${escapeHtml(g.name || "Unnamed Group")}</div>
          <div class="rowSub">group</div>
        </div>
      </div>
    `).join("")}
  `;

  const onlineRows = `
    ${onlineUsers.map(u=>`
      <div class="row" data-profile="${escapeHtml(u.user)}">
        <div class="statusDot on"></div>
        <div class="rowCol">
          <div class="rowName">${escapeHtml(u.user)}${u.user===me.username ? " (You)" : ""}</div>
          <div class="rowSub">click for profile</div>
        </div>
      </div>
    `).join("")}
  `;

  sideScroll.innerHTML = `
    <div class="sideBlock">
      <div class="blockHead">
        <b>Messages</b>
        <span>${(dmList.length + groupList.length + 2)} items</span>
      </div>
      <div class="list" id="msgList">${messagesRows}</div>
    </div>

    <div class="sideBlock">
      <div class="blockHead">
        <b>Online users</b>
        <span>${onlineCount}</span>
      </div>
      <div class="list" id="onlineList">${onlineRows}</div>
    </div>
  `;

  // open handlers
  sideScroll.querySelectorAll("[data-open]").forEach(el=>{
    el.addEventListener("click", ()=>{
      const key = el.getAttribute("data-open");
      if (key === "global") openGlobal(true);
      else if (key === "leaderboard") openLeaderboard();
      else if (key.startsWith("dm:")) openDM(key.slice(3));
      else if (key.startsWith("group:")) openGroup(key.slice(6));
    });

    // right-click mute
    el.addEventListener("contextmenu",(e)=>{
      e.preventDefault();
      const key = el.getAttribute("data-open");
      openMutePopup(key);
    });
  });

  // profile from online list
  sideScroll.querySelectorAll("[data-profile]").forEach(el=>{
    el.addEventListener("click", ()=>{
      const u = el.getAttribute("data-profile");
      openProfile(u);
    });
  });
}

function openMutePopup(key){
  if (me.guest) {
    toast("Mute", "Guests can’t mute.");
    return;
  }
  const label =
    key === "global" ? "Global" :
    key.startsWith("dm:") ? `DM: ${key.slice(3)}` :
    key.startsWith("group:") ? `Group` :
    key;

  openModal("Mute", `
    <div style="font-weight:950">${escapeHtml(label)}</div>
    <div style="margin-top:8px;color:rgba(233,238,245,.62);font-weight:900;font-size:12px;line-height:1.45">
      Mute stops notification pings for this chat.
    </div>
  `, `
    <button class="btn" id="mCancel">Cancel</button>
    <button class="btn primary" id="mToggle">Toggle mute</button>
  `);

  $("mCancel").onclick = closeModal;
  $("mToggle").onclick = ()=>{
    closeModal();
    socket.emit("mute:toggle", { key });
    toast("Mute", "Updated.");
  };
}

// ---------- Views ----------
function setChatHeader(title, hint){
  chatTitle.textContent = title;
  chatHint.textContent = hint;
}

function clearChat(){
  chatBox.innerHTML = "";
}

function addMessageToUI(m, scope){
  const t = fmtTime(m.ts);
  const who = m.user;

  let text = String(m.text ?? "");
  // server can send "__HIDDEN_BY_FILTER__"
  const hardHidden = text === "__HIDDEN_BY_FILTER__";
  const blocked = !me.guest && social.blocked.includes(who);

  let shown = text;

  if (hardHidden) {
    shown = "Message hidden (filtered).";
  } else if (blocked && settings.hideBlockedInGlobal && scope === "global" && !settings.revealBlocked) {
    shown = "Message hidden (blocked user).";
  }

  const row = document.createElement("div");
  row.className = "msg";
  row.innerHTML = `
    <div class="meta">
      <div class="u" data-user="${escapeHtml(who)}">${escapeHtml(who)}</div>
      <div class="t">${escapeHtml(t)}</div>
    </div>
    <div class="body ${hardHidden || (blocked && scope==="global" && settings.hideBlockedInGlobal && !settings.revealBlocked) ? "hiddenMsg" : ""}">
      ${escapeHtml(shown)}
    </div>
  `;

  row.querySelector(".u").addEventListener("click", ()=>{
    openProfile(who);
  });

  chatBox.appendChild(row);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function openGlobal(force){
  currentView = { type: "global", id: null };
  currentDM = null;
  currentGroupId = null;

  setChatHeader("Global", "shared with everyone online");
  chatActionBtn.style.display = "none";

  if (force){
    clearChat();
    globalCache.forEach(m=> addMessageToUI(m, "global"));
  }
  socket.emit("requestGlobalHistory");
}

function openDM(user){
  if (me.guest){
    toast("DMs", "Guests can’t DM.");
    return;
  }
  currentView = { type: "dm", id: user };
  currentDM = user;
  currentGroupId = null;

  dmUsers.add(user);
  renderSidebar();

  setChatHeader(`DM — ${user}`, "private messages");
  chatActionBtn.style.display = "none";

  clearChat();
  socket.emit("dm:history", { withUser: user });
}

function openGroup(gid){
  if (me.guest) return;

  currentView = { type: "group", id: gid };
  currentGroupId = gid;
  currentDM = null;

  const meta = groupMeta.get(gid);
  setChatHeader(`Group — ${meta?.name || "Unnamed Group"}`, "group chat");

  // manage button
  chatActionBtn.style.display = "inline-flex";
  chatActionBtn.textContent = "Manage";
  chatActionBtn.onclick = ()=> openGroupManage(gid);

  clearChat();
  socket.emit("group:history", { groupId: gid });
}

// ---------- Leaderboard ----------
function openLeaderboard(){
  if (me.guest){
    openModal("Leaderboard", `
      <div style="font-weight:950">Leaderboard</div>
      <div style="margin-top:8px;color:rgba(233,238,245,.62);font-weight:900;font-size:12px;line-height:1.45">
        Log in to view XP leaderboard.
      </div>
    `);
    return;
  }
  showLoading("loading leaderboard…");
  socket.emit("leaderboard:get");
}

// ---------- Inbox ----------
function updateInboxBadge(){
  if (inboxCount > 0){
    inboxPing.textContent = String(inboxCount);
    inboxPing.classList.add("show");
  } else {
    inboxPing.classList.remove("show");
  }
}

inboxBtn.addEventListener("click", ()=>{
  openInbox();
});

function openInbox(){
  if (me.guest){
    openModal("Inbox", `
      <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px;line-height:1.45">
        Guests don’t have an inbox.
      </div>
    `);
    return;
  }
  showLoading("loading inbox…");
  socket.emit("inbox:get");
}

// ---------- Profile ----------
function openProfile(user){
  if (!user) return;

  // guest profile: just name
  if (/^Guest\d{4,5}$/.test(String(user))){
    openModal("Profile", `
      <div style="font-weight:950;font-size:14px">${escapeHtml(user)}</div>
      <div style="margin-top:8px;color:rgba(233,238,245,.62);font-weight:900;font-size:12px">
        Guest user
      </div>
    `);
    return;
  }

  openModal("Profile", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div style="min-width:0">
          <div style="font-weight:950;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(user)}</div>
          <div style="margin-top:6px;color:rgba(233,238,245,.62);font-weight:900;font-size:12px" id="profSub">loading…</div>
        </div>
      </div>

      <div style="border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px">Bio</div>
        <div id="profBio" style="margin-top:6px;color:rgba(233,238,245,.70);font-weight:900;font-size:12px;line-height:1.45">—</div>
      </div>

      <div style="border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px">XP</div>
        <div id="profXpBar" style="margin-top:8px"></div>
      </div>

      <div id="profActions" style="display:flex;gap:10px;flex-wrap:wrap"></div>
    </div>
  `);

  socket.emit("profile:get", { user });
  modalBody._profileUser = user;
}

// ---------- Group manage ----------
function openGroupManage(gid){
  const meta = groupMeta.get(gid);
  if (!meta) return;

  const isOwner = meta.owner === me.username;
  const members = meta.members || [];

  openModal("Group settings", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950">${escapeHtml(meta.name || "Unnamed Group")}</div>
        <div style="margin-top:6px;color:rgba(233,238,245,.62);font-weight:900;font-size:12px">${escapeHtml(meta.id)}</div>
      </div>

      <div style="border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px">Members</div>
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
          ${members.map(u=>`
            <div class="row" style="cursor:default" data-member="${escapeHtml(u)}">
              <div class="statusDot ${onlineUsers.some(x=>x.user===u)?"on":""}"></div>
              <div class="rowCol">
                <div class="rowName">${escapeHtml(u)}${u===meta.owner ? " (Owner)" : ""}${u===me.username ? " (You)" : ""}</div>
                <div class="rowSub">member</div>
              </div>
              ${isOwner && u!==meta.owner ? `<button class="btn small" data-remove="${escapeHtml(u)}">Remove</button>` : ``}
            </div>
          `).join("")}
        </div>
        <div style="margin-top:10px;color:rgba(233,238,245,.55);font-weight:900;font-size:11px">
          Tip: Right-click your own name in the members list to leave.
        </div>
      </div>

      ${isOwner ? `
        <div style="border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:12px;background:rgba(255,255,255,.02)">
          <div style="font-weight:950;font-size:12px">Owner controls</div>

          <div style="margin-top:10px;display:flex;gap:10px">
            <input id="addMemberUser" class="field" placeholder="Invite/add username" style="flex:1" />
            <button class="btn small primary" id="addMemberBtn">Add</button>
          </div>

          <div style="margin-top:10px;display:flex;gap:10px">
            <input id="renameGroupName" class="field" placeholder="Rename group" style="flex:1" />
            <button class="btn small" id="renameGroupBtn">Rename</button>
          </div>

          <div style="margin-top:10px;display:flex;gap:10px">
            <input id="transferUser" class="field" placeholder="Transfer ownership to…" style="flex:1" />
            <button class="btn small" id="transferBtn">Transfer</button>
          </div>

          <button class="btn danger" id="deleteGroupBtn" style="margin-top:10px">Delete group</button>
        </div>
      ` : `
        <button class="btn danger" id="leaveGroupBtn">Leave group</button>
      `}
    </div>
  `);

  // remove member
  modalBody.querySelectorAll("[data-remove]").forEach(btn=>{
    btn.addEventListener("click",(e)=>{
      e.stopPropagation();
      const u = btn.getAttribute("data-remove");
      socket.emit("group:removeMember", { groupId: gid, user: u });
      toast("Group", `Removing ${u}…`);
    });
  });

  // right click your own name to leave
  modalBody.querySelectorAll("[data-member]").forEach(row=>{
    row.addEventListener("contextmenu",(e)=>{
      e.preventDefault();
      const u = row.getAttribute("data-member");
      if (u !== me.username) return;

      openModal("Leave group?", `
        <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px;line-height:1.45">
          Leave <b>${escapeHtml(meta.name || "Unnamed Group")}</b>?
        </div>
      `, `
        <button class="btn" id="leaveCancel">Cancel</button>
        <button class="btn primary" id="leaveConfirm">Leave</button>
      `);

      $("leaveCancel").onclick = ()=> openGroupManage(gid);
      $("leaveConfirm").onclick = ()=>{
        closeModal();
        socket.emit("group:leave", { groupId: gid });
        toast("Group", "Leaving…");
      };
    });
  });

  if (isOwner){
    $("addMemberBtn").onclick = ()=>{
      const u = $("addMemberUser").value.trim();
      if (!u) return;
      socket.emit("group:addMember", { groupId: gid, user: u });
      toast("Group", `Adding ${u}…`);
    };
    $("renameGroupBtn").onclick = ()=>{
      const n = $("renameGroupName").value.trim();
      if (!n) return;
      socket.emit("group:rename", { groupId: gid, name: n });
      toast("Group", "Renaming…");
    };
    $("transferBtn").onclick = ()=>{
      const u = $("transferUser").value.trim();
      if (!u) return;
      socket.emit("group:transferOwner", { groupId: gid, newOwner: u });
      toast("Group", `Transferring…`);
    };
    $("deleteGroupBtn").onclick = ()=>{
      openModal("Delete group?", `
        <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px;line-height:1.45">
          Delete <b>${escapeHtml(meta.name || "Unnamed Group")}</b>? This can’t be undone.
        </div>
      `, `
        <button class="btn" id="delCancel">Cancel</button>
        <button class="btn primary" id="delConfirm">Delete</button>
      `);
      $("delCancel").onclick = ()=> openGroupManage(gid);
      $("delConfirm").onclick = ()=>{
        closeModal();
        socket.emit("group:delete", { groupId: gid });
        toast("Group", "Deleting…");
      };
    };
  } else {
    const b = $("leaveGroupBtn");
    if (b){
      b.onclick = ()=>{
        closeModal();
        socket.emit("group:leave", { groupId: gid });
        toast("Group", "Leaving…");
      };
    }
  }
}

// ---------- Settings ----------
function openSettings(){
  if (me.guest){
    openModal("Settings", `
      <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px;line-height:1.45">
        Guests can’t save settings. Log in to save cursor + motion preferences.
      </div>
    `);
    return;
  }

  const cursorMode = settings.cursorMode;
  const reduceMotion = !!settings.reduceMotion;
  const sounds = !!settings.sounds;
  const hideBlocked = !!settings.hideBlockedInGlobal;
  const revealBlocked = !!settings.revealBlocked;

  openModal("Settings", `
    <div style="display:flex;flex-direction:column;gap:12px">

      <div style="border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px">Cursor</div>
        <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn small ${cursorMode==="off"?"primary":""}" id="curOff">System</button>
          <button class="btn small ${cursorMode==="orb"?"primary":""}" id="curOrb">Orb</button>
          <button class="btn small ${cursorMode==="trail"?"primary":""}" id="curTrail">Orb + Trail</button>
        </div>
      </div>

      <div style="border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px">Motion</div>
        <div style="margin-top:10px;display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px">Reduce animations</div>
          <button class="btn small ${reduceMotion?"primary":""}" id="toggleMotion">${reduceMotion ? "On" : "Off"}</button>
        </div>
      </div>

      <div style="border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px">Sounds</div>
        <div style="margin-top:10px;display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px">Notification sounds</div>
          <button class="btn small ${sounds?"primary":""}" id="toggleSounds">${sounds ? "On" : "Off"}</button>
        </div>
      </div>

      <div style="border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px">Blocked users</div>
        <div style="margin-top:10px;display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px">Hide blocked messages (Global)</div>
          <button class="btn small ${hideBlocked?"primary":""}" id="toggleHideBlocked">${hideBlocked ? "On" : "Off"}</button>
        </div>
        <div style="margin-top:10px;display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px">Allow unblur/reveal</div>
          <button class="btn small ${revealBlocked?"primary":""}" id="toggleReveal">${revealBlocked ? "On" : "Off"}</button>
        </div>

        <div style="margin-top:12px;color:rgba(233,238,245,.55);font-weight:900;font-size:11px">Blocked list</div>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px">
          ${(social.blocked || []).length ? (social.blocked || []).map(u=>`
            <div class="row" style="cursor:default">
              <div class="statusDot"></div>
              <div class="rowCol">
                <div class="rowName">${escapeHtml(u)}</div>
                <div class="rowSub">blocked</div>
              </div>
              <button class="btn small" data-unblock="${escapeHtml(u)}">Unblock</button>
            </div>
          `).join("") : `
            <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px">No blocked users.</div>
          `}
        </div>
      </div>

      <div style="border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px">Tutorial</div>
        <div style="margin-top:10px;color:rgba(233,238,245,.62);font-weight:900;font-size:12px;line-height:1.45">
          You can re-run the tutorial anytime.
        </div>
        <button class="btn small" id="rerunTut" style="margin-top:10px">Run tutorial</button>
      </div>

    </div>
  `, `
    <button class="btn" id="sClose">Close</button>
    <button class="btn primary" id="sSave">Save</button>
  `);

  $("sClose").onclick = closeModal;

  // cursor buttons
  $("curOff").onclick = ()=>{ settings.cursorMode = "off"; setCursorMode("off"); highlightSettingsCursor(); };
  $("curOrb").onclick = ()=>{ settings.cursorMode = "orb"; setCursorMode("orb"); highlightSettingsCursor(); };
  $("curTrail").onclick = ()=>{ settings.cursorMode = "trail"; setCursorMode("trail"); highlightSettingsCursor(); };

  function highlightSettingsCursor(){
    ["curOff","curOrb","curTrail"].forEach(id=> $(id).classList.remove("primary"));
    if (settings.cursorMode==="off") $("curOff").classList.add("primary");
    if (settings.cursorMode==="orb") $("curOrb").classList.add("primary");
    if (settings.cursorMode==="trail") $("curTrail").classList.add("primary");
  }

  $("toggleMotion").onclick = ()=>{
    settings.reduceMotion = !settings.reduceMotion;
    applyReduceMotion(settings.reduceMotion);
    $("toggleMotion").textContent = settings.reduceMotion ? "On" : "Off";
    $("toggleMotion").classList.toggle("primary", settings.reduceMotion);
  };

  $("toggleSounds").onclick = ()=>{
    settings.sounds = !settings.sounds;
    $("toggleSounds").textContent = settings.sounds ? "On" : "Off";
    $("toggleSounds").classList.toggle("primary", settings.sounds);
  };

  $("toggleHideBlocked").onclick = ()=>{
    settings.hideBlockedInGlobal = !settings.hideBlockedInGlobal;
    $("toggleHideBlocked").textContent = settings.hideBlockedInGlobal ? "On" : "Off";
    $("toggleHideBlocked").classList.toggle("primary", settings.hideBlockedInGlobal);
  };

  $("toggleReveal").onclick = ()=>{
    settings.revealBlocked = !settings.revealBlocked;
    $("toggleReveal").textContent = settings.revealBlocked ? "On" : "Off";
    $("toggleReveal").classList.toggle("primary", settings.revealBlocked);
  };

  modalBody.querySelectorAll("[data-unblock]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const u = btn.getAttribute("data-unblock");
      socket.emit("user:unblock", { user: u });
      toast("Blocked", `Unblocked ${u}.`);
      closeModal();
    });
  });

  $("rerunTut").onclick = ()=>{
    closeModal();
    startTutorial(true);
  };

  $("sSave").onclick = ()=>{
    socket.emit("settings:update", {
      // server expects these keys from your server.js
      theme: "dark",
      density: settings.density ?? 0.18,
      sidebar: 0.22,
      hideMildProfanity: false,
      cursor: settings.cursorMode !== "off",
      sounds: settings.sounds !== false,
      reduceMotion: settings.reduceMotion,
      cursorMode: settings.cursorMode,
      hideBlockedInGlobal: settings.hideBlockedInGlobal,
      revealBlocked: settings.revealBlocked
    });
    toast("Settings", "Saved.");
    closeModal();
  };
}

// ---------- Tutorial (NO BOT, NO TOASTS) ----------
let tutorialActive = false;
let tutorialStep = 0;
const tutorialSteps = [
  { t:"Tutorial (1/5)", b:`<div style="font-weight:950">User menu</div><div style="margin-top:8px;color:rgba(233,238,245,.62);font-weight:900;font-size:12px;line-height:1.45">Click your name (top right). Dropdown: Profile / Settings / Log out.</div>` },
  { t:"Tutorial (2/5)", b:`<div style="font-weight:950">Inbox</div><div style="margin-top:8px;color:rgba(233,238,245,.62);font-weight:900;font-size:12px;line-height:1.45">Inbox shows mentions, group invites, and friend requests. Ping appears only if count &gt; 0.</div>` },
  { t:"Tutorial (3/5)", b:`<div style="font-weight:950">XP</div><div style="margin-top:8px;color:rgba(233,238,245,.62);font-weight:900;font-size:12px;line-height:1.45">Send messages to gain XP. Level-up gives a toast.</div>` },
  { t:"Tutorial (4/5)", b:`<div style="font-weight:950">Profiles</div><div style="margin-top:8px;color:rgba(233,238,245,.62);font-weight:900;font-size:12px;line-height:1.45">Click usernames in chat or online users to view bio, stats, and actions.</div>` },
  { t:"Tutorial (5/5)", b:`<div style="font-weight:950">Groups</div><div style="margin-top:8px;color:rgba(233,238,245,.62);font-weight:900;font-size:12px;line-height:1.45">Groups require invites. Accept/decline invites in Inbox. Owners can manage members and rename.</div>` },
];

function renderTutorial(){
  const step = tutorialSteps[tutorialStep];
  const isFirst = tutorialStep === 0;
  const isLast = tutorialStep === tutorialSteps.length - 1;

  openModal(step.t, step.b, `
    <button class="btn" id="tBack" ${isFirst ? 'style="opacity:.5;pointer-events:none"' : ""}>Back</button>
    <button class="btn primary" id="tNext">${isLast ? "Finish" : "Next"}</button>
    <button class="btn danger" id="tSkip">Skip</button>
  `);

  $("tBack").onclick = ()=>{ tutorialStep = Math.max(0, tutorialStep-1); renderTutorial(); };
  $("tNext").onclick = ()=>{
    if (isLast) finishTutorial(true);
    else { tutorialStep += 1; renderTutorial(); }
  };
  $("tSkip").onclick = ()=> finishTutorial(false);
}

function startTutorial(force=false){
  if (me.guest) return;
  if (tutorialActive && !force) return;
  tutorialActive = true;
  tutorialStep = 0;
  renderTutorial();
}

function finishTutorial(completed){
  closeModal();
  tutorialActive = false;
  socket.emit("tutorial:setDone", { done: !!completed });
}

// ---------- Dropdown menu ----------
function showDropdown(show){
  userDropdown.classList.toggle("show", !!show);
}
function toggleDropdown(){
  showDropdown(!userDropdown.classList.contains("show"));
}

mePill.addEventListener("click", (e)=>{
  e.stopPropagation();
  toggleDropdown();
});
window.addEventListener("mousedown",(e)=>{
  if (!userDropdown.classList.contains("show")) return;
  if (userDropdown.contains(e.target) || mePill.contains(e.target)) return;
  showDropdown(false);
});

ddProfile.onclick = ()=>{
  showDropdown(false);
  openProfile(me.username);
};
ddSettings.onclick = ()=>{
  showDropdown(false);
  openSettings();
};
ddLogout.onclick = ()=>{
  showDropdown(false);
  showLoading("logging out…");
  saveToken(null);
  socket.emit("logout");
  setTimeout(()=>{
    hideLoading();
    me = { username: null, guest: true, token: null, tutorialDone:false, isNew:false };
    xp = null;
    social = { friends: [], incoming: [], outgoing: [], blocked: [] };
    inboxItems = [];
    inboxCount = 0;
    updateInboxBadge();

    app.classList.remove("show");
    showLogin(true);
    toast("Logged out", "Session cleared.");
  }, 450);
};

// ---------- Send ----------
sendBtn.addEventListener("click", sendCurrent);
messageEl.addEventListener("keydown",(e)=>{
  if (e.key === "Enter" && !e.shiftKey){
    e.preventDefault();
    sendCurrent();
  }
});

function sendCurrent(){
  if (!me.username) return;
  if (!canSend()){ cooldownWarn(); return; }

  const text = messageEl.value.trim();
  if (!text) return;

  startCooldown();
  messageEl.value = "";

  if (currentView.type === "global"){
    socket.emit("sendGlobal", { text, ts: now() });
  } else if (currentView.type === "dm"){
    socket.emit("dm:send", { to: currentDM, text });
  } else if (currentView.type === "group"){
    socket.emit("group:send", { groupId: currentGroupId, text });
  }

  // mentions -> server should also do this, but we also request inbox refresh on mention for snappiness
  if (!me.guest && (currentView.type === "global" || currentView.type === "group")){
    const mentions = extractMentions(text);
    if (mentions.length) socket.emit("mentions:sent", { mentions, scope: currentView.type, id: currentView.id });
  }
}

// ---------- Sounds ----------
let pingAudio = null;
function ensurePingAudio(){
  if (pingAudio) return;
  // a short, soft ping (WebAudio)
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  pingAudio = {
    ctx,
    play(){
      try{
        if (!settings.sounds || settings.reduceMotion) return;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = 880;
        g.gain.value = 0.0001;
        o.connect(g); g.connect(ctx.destination);
        o.start();
        g.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.10);
        o.stop(ctx.currentTime + 0.12);
      }catch{}
    }
  };
}
function ping(){
  ensurePingAudio();
  if (pingAudio) pingAudio.play();
}

// ---------- Socket events ----------
socket.on("connect", ()=>{
  $("year").textContent = String(new Date().getFullYear());
  // attempt resume first
  if (!tryResume()){
    // show login
    showLogin(true);
  }
});

socket.on("resumeFail", ()=>{
  saveToken(null);
  hideLoading();
  showLogin(true);
});

socket.on("loginSuccess", (data)=>{
  hideLoading();

  me.username = data.username;
  me.guest = !!data.guest;
  me.token = data.token || null;
  me.isNew = !!data.isNew;
  me.tutorialDone = !!data.tutorialDone;

  if (!me.guest && data.token) saveToken(data.token);

  // settings from server if present
  if (data.settings){
    // map into our settings without adding themes
    settings.sounds = data.settings.sounds !== false;
    settings.reduceMotion = !!data.settings.reduceMotion;
    // cursor preference may be stored custom; otherwise keep default
    if (typeof data.settings.cursorMode === "string") settings.cursorMode = data.settings.cursorMode;
  }

  applyReduceMotion(settings.reduceMotion);
  setCursorMode(settings.cursorMode || (me.guest ? "off" : "orb"));

  social = data.social || social;
  xp = data.xp || null;

  meName.textContent = me.username;
  $("brandSub").textContent = me.guest ? "guest mode" : "connected";
  showLogin(false);

  app.classList.add("show");

  // sidebar initial
  renderSidebar();

  // default open global
  openGlobal(true);

  // show tutorial choice for brand new users only
  if (!me.guest && me.isNew){
    openModal("Welcome", `
      <div style="font-weight:950">New account</div>
      <div style="margin-top:8px;color:rgba(233,238,245,.62);font-weight:900;font-size:12px;line-height:1.45">
        Want a quick tutorial?
      </div>
    `, `
      <button class="btn" id="tSkipNow">Skip</button>
      <button class="btn primary" id="tStartNow">Start</button>
    `);

    $("tSkipNow").onclick = ()=>{
      closeModal();
      socket.emit("tutorial:setDone", { done: false });
    };
    $("tStartNow").onclick = ()=>{
      closeModal();
      startTutorial(true);
    };
  } else if (!me.guest && !me.tutorialDone){
    // optional: do nothing unless they manually run tutorial
  }

  toast("Welcome", me.guest ? `Joined as ${me.username}` : `Logged in as ${me.username}`);
});

socket.on("loginError",(msg)=>{
  hideLoading();
  toast("Login failed", msg || "Try again.");
});

// Settings pushed back from server
socket.on("settings",(s)=>{
  // apply only what we use
  settings.sounds = s?.sounds !== false;
  settings.reduceMotion = !!s?.reduceMotion;
  if (typeof s?.cursorMode === "string") settings.cursorMode = s.cursorMode;
  applyReduceMotion(settings.reduceMotion);
  setCursorMode(settings.cursorMode);
});

// Social update
socket.on("social:update",(s)=>{
  social = s || social;
});

// Online users
socket.on("onlineUsers",(list)=>{
  onlineUsers = Array.isArray(list) ? list : [];
  renderSidebar();
});

// Groups list
socket.on("groups:list",(list)=>{
  groups = Array.isArray(list) ? list : [];
  // update meta map
  groupMeta.clear();
  groups.forEach(g=>{
    groupMeta.set(g.id, { id:g.id, name:g.name, owner:g.owner, members:g.members || [] });
  });
  renderSidebar();
});

// Global history
socket.on("history",(msgs)=>{
  globalCache = (Array.isArray(msgs)?msgs:[]).slice(-200);
  if (currentView.type === "global"){
    clearChat();
    globalCache.forEach(m=> addMessageToUI(m, "global"));
  }
});

// Global message
socket.on("globalMessage",(m)=>{
  if (!m) return;
  globalCache.push(m);
  if (globalCache.length > 250) globalCache.shift();
  if (currentView.type === "global"){
    addMessageToUI(m, "global");
  }
  // mention notification is server side via inbox; but we can ping if user is mentioned locally
  if (!me.guest && typeof m.text === "string" && m.text.includes("@"+me.username)){
    ping();
  }
});

// DM history
socket.on("dm:history", ({ withUser, msgs } = {})=>{
  const u = withUser;
  const arr = Array.isArray(msgs) ? msgs : [];
  dmCache.set(u, arr);
  dmUsers.add(u);
  renderSidebar();

  if (currentView.type === "dm" && currentDM === u){
    clearChat();
    arr.forEach(m=> addMessageToUI(m, "dm"));
  }
});

// DM message
socket.on("dm:message", ({ from, msg } = {})=>{
  if (!from || !msg) return;
  dmUsers.add(from);
  const list = dmCache.get(from) || [];
  list.push(msg);
  if (list.length > 250) list.shift();
  dmCache.set(from, list);
  renderSidebar();

  // ping + inbox badge? (you asked inbox is mentions + requests, so DM ping can be optional)
  // we'll do a soft ping only if you're not currently in that DM
  if (!(currentView.type==="dm" && currentDM === from)){
    ping();
  }

  if (currentView.type === "dm" && currentDM === from){
    addMessageToUI(msg, "dm");
  }
});

// Group history
socket.on("group:history", ({ groupId, meta, msgs } = {})=>{
  if (!groupId) return;
  if (meta) groupMeta.set(groupId, meta);
  groupCache.set(groupId, Array.isArray(msgs)?msgs:[]);
  renderSidebar();

  if (currentView.type === "group" && currentGroupId === groupId){
    setChatHeader(`Group — ${meta?.name || "Unnamed Group"}`, "group chat");
    clearChat();
    (msgs || []).forEach(m=> addMessageToUI(m, "group"));
  }
});

// Group message
socket.on("group:message", ({ groupId, msg } = {})=>{
  if (!groupId || !msg) return;
  const list = groupCache.get(groupId) || [];
  list.push(msg);
  if (list.length > 350) list.shift();
  groupCache.set(groupId, list);

  if (!(currentView.type==="group" && currentGroupId === groupId)){
    ping();
  }

  if (currentView.type === "group" && currentGroupId === groupId){
    addMessageToUI(msg, "group");
  }
});

// Group meta update
socket.on("group:meta", ({ groupId, meta } = {})=>{
  if (!groupId || !meta) return;
  groupMeta.set(groupId, meta);

  // keep groups list fresh
  socket.emit("groups:list");

  if (currentView.type==="group" && currentGroupId===groupId){
    setChatHeader(`Group — ${meta.name || "Unnamed Group"}`, "group chat");
  }
});

// Group left/deleted
socket.on("group:left", ({ groupId } = {})=>{
  toast("Group", "You left the group.");
  if (currentView.type==="group" && currentGroupId===groupId){
    openGlobal(true);
  }
  socket.emit("groups:list");
});
socket.on("group:deleted", ({ groupId } = {})=>{
  toast("Group", "Group was deleted.");
  if (currentView.type==="group" && currentGroupId===groupId){
    openGlobal(true);
  }
  socket.emit("groups:list");
});

// Inbox data
socket.on("inbox:data", (data)=>{
  hideLoading();
  const friendRequests = Array.isArray(data?.friendRequests) ? data.friendRequests : [];
  const groupInvites = Array.isArray(data?.groupInvites) ? data.groupInvites : [];

  // Build a single list (NO SECTIONS)
  const items = [];

  // mentions items can come from server via another event; we keep existing mention items too
  // For now: server is expected to store mentions; if you add it later, it will drop into this same list.

  friendRequests.forEach(u=>{
    items.push({ type:"friend", text:`Friend request from ${u}`, user:u, ts: now() });
  });
  groupInvites.forEach(g=>{
    items.push({ type:"group", text:`Group invite: ${g.name} (from ${g.from})`, groupId:g.id, from:g.from, ts: g.ts || now() });
  });

  inboxItems = items;

  // show inbox
  openModal("Inbox", `
    <div style="display:flex;flex-direction:column;gap:8px">
      ${inboxItems.length ? inboxItems.map((it, idx)=>{
        if (it.type === "friend"){
          return `
            <div class="row" style="cursor:default">
              <div class="statusDot"></div>
              <div class="rowCol">
                <div class="rowName">${escapeHtml(it.text)}</div>
                <div class="rowSub">request</div>
              </div>
              <button class="btn small primary" data-accept-f="${escapeHtml(it.user)}">Accept</button>
              <button class="btn small" data-decline-f="${escapeHtml(it.user)}">Decline</button>
            </div>
          `;
        }
        if (it.type === "group"){
          return `
            <div class="row" style="cursor:default">
              <div class="statusDot on"></div>
              <div class="rowCol">
                <div class="rowName">${escapeHtml(it.text)}</div>
                <div class="rowSub">invite</div>
              </div>
              <button class="btn small primary" data-accept-g="${escapeHtml(it.groupId)}">Accept</button>
              <button class="btn small" data-decline-g="${escapeHtml(it.groupId)}">Decline</button>
            </div>
          `;
        }
        // mentions placeholder
        return `
          <div class="row" style="cursor:default">
            <div class="statusDot"></div>
            <div class="rowCol">
              <div class="rowName">${escapeHtml(it.text)}</div>
              <div class="rowSub">mention</div>
            </div>
          </div>
        `;
      }).join("") : `
        <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px;line-height:1.45">
          No notifications.
        </div>
      `}
    </div>
  `);

  // accept/decline handlers
  modalBody.querySelectorAll("[data-accept-f]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const u = btn.getAttribute("data-accept-f");
      socket.emit("friend:accept", { from: u });
      toast("Friends", "Accepted.");
      closeModal();
      socket.emit("inbox:get");
    });
  });
  modalBody.querySelectorAll("[data-decline-f]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const u = btn.getAttribute("data-decline-f");
      socket.emit("friend:decline", { from: u });
      toast("Friends", "Declined.");
      closeModal();
      socket.emit("inbox:get");
    });
  });
  modalBody.querySelectorAll("[data-accept-g]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.getAttribute("data-accept-g");
      socket.emit("groupInvite:accept", { id });
      toast("Group", "Joined.");
      closeModal();
      socket.emit("inbox:get");
      socket.emit("groups:list");
    });
  });
  modalBody.querySelectorAll("[data-decline-g]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.getAttribute("data-decline-g");
      socket.emit("groupInvite:decline", { id });
      toast("Group", "Declined.");
      closeModal();
      socket.emit("inbox:get");
    });
  });

  // clear ping count after opening
  inboxCount = 0;
  updateInboxBadge();
});

// Inbox count update (friend requests + group invites + mentions)
socket.on("inbox:update", (c)=>{
  // server sends counts
  const fr = Number(c?.friendRequests || 0);
  const gi = Number(c?.groupInvites || 0);
  const men = Number(c?.mentions || 0);
  inboxCount = Math.max(0, fr + gi + men);
  updateInboxBadge();
  if (inboxCount > 0) ping();
});

// XP update + level up toast
let lastLevel = 1;
socket.on("xp:update",(x)=>{
  xp = x || null;
  if (!xp) return;
  const lvl = xp.level || 1;
  if (lvl > lastLevel){
    toast("Level up", `You reached level ${lvl}.`);
  }
  lastLevel = lvl;
});

// Leaderboard data
socket.on("leaderboard:data",(list)=>{
  hideLoading();
  const arr = Array.isArray(list) ? list : [];
  openModal("Leaderboard", `
    <div style="display:flex;flex-direction:column;gap:8px">
      ${arr.length ? arr.slice(0,25).map((u, i)=>`
        <div class="row" style="cursor:default">
          <div class="statusDot ${i<3?"on":""}"></div>
          <div class="rowCol">
            <div class="rowName">#${i+1} ${escapeHtml(u.user)}</div>
            <div class="rowSub">level ${escapeHtml(String(u.level ?? 1))}</div>
          </div>
        </div>
      `).join("") : `
        <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px">No data.</div>
      `}
    </div>
  `);
});

// Profile data
socket.on("profile:data",(p)=>{
  const user = modalBody._profileUser;
  if (!user || p?.user !== user) return;

  if (p.missing){
    const sub = document.getElementById("profSub");
    if (sub) sub.textContent = "User not found.";
    return;
  }

  const sub = document.getElementById("profSub");
  if (sub){
    if (p.guest) sub.textContent = "Guest user";
    else sub.textContent = `Created: ${new Date(p.createdAt).toLocaleDateString()}`;
  }

  const bioEl = document.getElementById("profBio");
  if (bioEl){
    bioEl.textContent = p.bio ? String(p.bio).slice(0, 180) : "—";
  }

  // XP bar
  const xpWrap = document.getElementById("profXpBar");
  if (xpWrap){
    if (p.guest){
      xpWrap.innerHTML = `<div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px">—</div>`;
    } else {
      const level = p.level ?? 1;
      const cur = p.xp ?? 0;
      const next = p.next ?? 1;
      const pct = clamp(next ? (cur/next) : 0, 0, 1);

      xpWrap.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="font-weight:950;font-size:12px">Level ${escapeHtml(String(level))}</div>
          <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:11px">${escapeHtml(String(cur))}/${escapeHtml(String(next))} XP</div>
        </div>
        <div style="margin-top:8px;height:10px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);overflow:hidden">
          <div style="height:100%;width:${(pct*100).toFixed(1)}%;background:rgba(233,238,245,.18)"></div>
        </div>
      `;
    }
  }

  // Actions
  const actions = document.getElementById("profActions");
  if (actions){
    actions.innerHTML = "";

    // your own profile: edit bio
    if (!me.guest && p.user === me.username){
      const btn = document.createElement("button");
      btn.className = "btn small";
      btn.textContent = "Edit bio";
      btn.onclick = ()=>{
        openModal("Edit bio", `
          <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px;margin-bottom:10px">Max 180 chars.</div>
          <textarea id="bioEdit" rows="4" placeholder="Write something…"></textarea>
        `, `
          <button class="btn" id="bioCancel">Cancel</button>
          <button class="btn primary" id="bioSave">Save</button>
        `);
        $("bioCancel").onclick = closeModal;
        $("bioSave").onclick = ()=>{
          const text = ($("bioEdit").value || "").trim().slice(0,180);
          socket.emit("bio:set", { text });
          toast("Profile", "Bio saved.");
          closeModal();
        };
      };
      actions.appendChild(btn);
      return;
    }

    // guest target: no actions
    if (p.guest) return;

    if (!me.guest && p.user !== me.username){
      const dmBtn = document.createElement("button");
      dmBtn.className = "btn small primary";
      dmBtn.textContent = "DM";
      dmBtn.onclick = ()=>{
        closeModal();
        openDM(p.user);
      };
      actions.appendChild(dmBtn);

      const friendBtn = document.createElement("button");
      friendBtn.className = "btn small";
      friendBtn.textContent = "Add friend";
      friendBtn.onclick = ()=>{
        socket.emit("friend:request", { to: p.user });
        toast("Friends", "Request sent.");
      };
      actions.appendChild(friendBtn);

      const blockBtn = document.createElement("button");
      blockBtn.className = "btn small danger";
      blockBtn.textContent = "Block";
      blockBtn.onclick = ()=>{
        socket.emit("user:block", { user: p.user });
        toast("Blocked", `${p.user} blocked.`);
        closeModal();
      };
      actions.appendChild(blockBtn);
    }
  }
});

// send error
socket.on("sendError",(e)=>{
  toast("Blocked", e?.reason || "Action blocked.");
});

// ---------- Login buttons ----------
function shakeLogin(){
  const card = document.getElementById("loginCard");
  card.classList.add("shake");
  setTimeout(()=> card.classList.remove("shake"), 380);
}

joinBtn.addEventListener("click", ()=>{
  const u = usernameEl.value.trim();
  const p = passwordEl.value;

  if (!u || !p){
    shakeLogin();
    return;
  }
  showLoading("logging in…");
  socket.emit("login", { username: u, password: p, guest:false });
});

guestBtn.addEventListener("click", ()=>{
  showLoading("joining as guest…");
  socket.emit("login", { guest:true });
});

passwordEl.addEventListener("keydown",(e)=>{
  if (e.key === "Enter") joinBtn.click();
});

// ---------- Init ----------
(function init(){
  $("year").textContent = String(new Date().getFullYear());
  // default cursor while logged out: system
  setCursorMode("off");
  applyReduceMotion(false);
})();

