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
let settings = null;
let social = null;
let xp = null; // server sends; guests get null

let view = { type: "global", id: null }; // global | dm | group
let currentDM = null;
let currentGroupId = null;

let globalCache = [];
let dmCache = new Map();        // user -> msgs
let groupMeta = new Map();      // gid -> {id,name,owner,members[],active}
let groupCache = new Map();     // gid -> msgs

let cooldownUntil = 0;

// ---------- local prefs ----------
const mutedKey = "tonkotsu_muted";
const uiKey = "tonkotsu_ui_local";
const muted = new Set(JSON.parse(localStorage.getItem(mutedKey) || "[]"));
let uiLocal = JSON.parse(localStorage.getItem(uiKey) || "{}"); // { cursorOn: true/false, reducedMotion: false/true }

function saveMuted(){
  localStorage.setItem(mutedKey, JSON.stringify(Array.from(muted)));
}
function isMuted(scopeKey){ return muted.has(scopeKey); }
function toggleMuted(scopeKey){
  if(muted.has(scopeKey)) muted.delete(scopeKey); else muted.add(scopeKey);
  saveMuted();
  toast("Muted", muted.has(scopeKey) ? "Muted." : "Unmuted.");
}
function saveUILocal(){
  localStorage.setItem(uiKey, JSON.stringify(uiLocal));
}

// ---------- profanity (mild optional hide) ----------
const MILD_WORDS = ["fuck","fucking","shit","shitty","asshole","bitch","bastard","dick","pussy"];
const MILD_RX = new RegExp(`\\b(${MILD_WORDS.map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|")})\\b`, "ig");

// Hard filter marker sent by server:
const HIDDEN_MARK = "__HIDDEN_BY_FILTER__";

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
  // more compact at low end
  const pad = Math.round(8 + v * 10);   // 8..18
  const font = Math.round(11 + v * 3);  // 11..14
  const r = document.documentElement.style;
  r.setProperty("--pad", `${pad}px`);
  r.setProperty("--font", `${font}px`);
}

function applySidebarWidth(val){
  const v = Math.max(0, Math.min(1, Number(val)));
  // compact default ~0.25 => ~270px
  const w = Math.round(250 + v * 140); // 250..390
  document.documentElement.style.setProperty("--sidebarW", `${w}px`);
}

function applyCursor(on){
  const body = document.body;
  if(on) body.classList.add("cursorOn"); else body.classList.remove("cursorOn");
}

function applyReduceMotion(on){
  const body = document.body;
  if(on) body.classList.add("reduceMotion"); else body.classList.remove("reduceMotion");
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

// ---------- Toast ----------
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
  setTimeout(() => d.remove(), 3100);
}

// ---------- Ping sound ----------
let audioCtx = null;
function pingSound(){
  if(!audioCtx){
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  const t0 = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();

  // soft pleasant "tick"
  o.type = "sine";
  o.frequency.setValueAtTime(880, t0);
  o.frequency.exponentialRampToValueAtTime(660, t0 + 0.07);

  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);

  o.connect(g);
  g.connect(audioCtx.destination);
  o.start(t0);
  o.stop(t0 + 0.12);
}

// ---------- Loading ----------
function showLoading(text="syncing…"){
  $("loaderSub").textContent = text;
  loading.classList.add("show");
}
function hideLoading(){ loading.classList.remove("show"); }

// ---------- Modal ----------
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
    chatHint.textContent = meta?.active ? "group chat" : "pending invite (needs 2 members)";
    backBtn.style.display="inline-flex";
  }
}
backBtn.addEventListener("click", ()=> openGlobal(true));

// ---------- message rendering ----------
function fmtTime(ts){
  const d = new Date(ts);
  if(!Number.isFinite(d.getTime())) return null;
  const h = String(d.getHours()).padStart(2,"0");
  const m = String(d.getMinutes()).padStart(2,"0");
  return `${h}:${m}`;
}

function maybeHideMild(text){
  if (!settings?.hideMildProfanity) return text;
  return String(text).replace(MILD_RX, "•••");
}

function isGuestUser(u){ return /^Guest\d{4,5}$/.test(String(u)); }

function isBlockedUser(u){
  return !!social?.blocked?.includes(u);
}

function addMessageToUI({ user, text, ts }, { scope="global", from=null } = {}){
  const t = fmtTime(ts);
  if(!t) return;

  const who = scope==="dm" ? from : user;

  let bodyText = String(text ?? "");
  if(bodyText === HIDDEN_MARK){
    bodyText = "Message hidden (filtered).";
  }

  if(scope==="global"){
    if(isBlockedUser(who)){
      bodyText = "Message hidden (blocked user).";
    } else {
      bodyText = maybeHideMild(bodyText);
    }
  } else {
    bodyText = maybeHideMild(bodyText);
  }

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

  row.querySelector(".u").addEventListener("click", (e)=>{
    const u = e.target.getAttribute("data-user");
    openProfile(u);
  });

  chatBox.appendChild(row);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function clearChat(){ chatBox.innerHTML=""; }

// ---------- pings ----------
let unread = {
  dm: new Map(),       // user -> count
  group: new Map(),    // gid -> count
  inbox: 0
};

function setPing(el, n){
  if(n > 0){
    el.textContent = String(n);
    el.classList.add("show");
  } else {
    el.classList.remove("show");
  }
}
function recomputePings(){
  let msgCount = 0;
  for(const v of unread.dm.values()) msgCount += v;
  for(const v of unread.group.values()) msgCount += v;
  setPing(msgPing, msgCount);
  setPing(inboxPing, unread.inbox);
}

// ---------- sidebars ----------
function rowWithMuteHandlers(row, scopeKey){
  row.addEventListener("contextmenu",(e)=>{
    e.preventDefault();
    toggleMuted(scopeKey);
    renderSidebarMessages(); // refresh little muted hint
    renderSidebarGlobal();
  });
}

function mutedLabel(scopeKey){
  return muted.has(scopeKey) ? "• muted" : "";
}

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
            <div class="statusDot ${u.user===me ? "on" : (onlineUsers.some(x=>x.user===u.user) ? "on" : "")}"></div>
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
  // Global should be here too (you asked)
  const dmUsers = Array.from(new Set(Array.from(dmCache.keys()))).sort((a,b)=>a.localeCompare(b));
  const groups = Array.from(groupMeta.values()).sort((a,b)=>a.name.localeCompare(b.name));

  sideSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:950;font-size:12px;color:#dbe6f1">Chats</div>
      <button class="btn small" id="createGroupBtn">New group</button>
    </div>

    <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px">
      <div class="row" id="globalRow">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">Global</div>
            <div class="rowSub">right-click to mute ${mutedLabel("global")}</div>
          </div>
        </div>
      </div>

      ${dmUsers.map(u => `
        <div class="row" data-dm="${escapeHtml(u)}">
          <div class="rowLeft">
            <div class="statusDot ${onlineUsers.some(x=>x.user===u) ? "on":""}"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(u)}</div>
              <div class="rowSub">dm ${mutedLabel("dm:"+u)}</div>
            </div>
          </div>
          ${unread.dm.get(u) ? `<div class="ping show">${unread.dm.get(u)}</div>` : ``}
        </div>
      `).join("")}

      ${groups.map(g => `
        <div class="row" data-group="${escapeHtml(g.id)}">
          <div class="rowLeft">
            <div class="statusDot on"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(g.name)}${g.active ? "" : " (pending)"}</div>
              <div class="rowSub">${g.active ? "group" : "invite"} ${mutedLabel("group:"+g.id)}</div>
            </div>
          </div>
          ${unread.group.get(g.id) ? `<div class="ping show">${unread.group.get(g.id)}</div>` : ``}
        </div>
      `).join("")}
    </div>
  `;

  // Global row handlers
  const globalRow = $("globalRow");
  globalRow.addEventListener("click", ()=> openGlobal(true));
  rowWithMuteHandlers(globalRow, "global");

  // DMs
  sideSection.querySelectorAll("[data-dm]").forEach(el=>{
    const u = el.getAttribute("data-dm");
    el.addEventListener("click", ()=> openDM(u));
    rowWithMuteHandlers(el, "dm:"+u);
  });

  // Groups
  sideSection.querySelectorAll("[data-group]").forEach(el=>{
    const gid = el.getAttribute("data-group");
    el.addEventListener("click", ()=> openGroup(gid));
    rowWithMuteHandlers(el, "group:"+gid);
  });

  // Create group = invite-based, default name Unnamed Group
  $("createGroupBtn").onclick = () => {
    if(isGuest){
      toast("Guests", "Guests can’t create groups. Log in to use groups.");
      return;
    }
    openModal("Create group", `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:12px;color:var(--muted);line-height:1.4">
          Groups start as <b>pending</b>. Invite at least <b>1 person</b> to activate it.
        </div>

        <div style="font-size:12px;color:var(--muted)">Group name</div>
        <input id="gcName" class="field" value="Unnamed Group" />

        <div style="font-size:12px;color:var(--muted)">Invite user (username)</div>
        <input id="gcInvite" class="field" placeholder="e.g. fishy_x1" />

        <div style="display:flex;gap:10px">
          <button class="btn primary" id="gcCreate">Create + Invite</button>
          <button class="btn" id="gcCancel">Cancel</button>
        </div>
      </div>
    `);

    $("gcCancel").onclick = closeModal;
    setTimeout(()=> $("gcInvite")?.focus(), 40);

    $("gcCreate").onclick = () => {
      const name = $("gcName").value.trim() || "Unnamed Group";
      const invite = $("gcInvite").value.trim();
      closeModal();
      socket.emit("group:create", { name, invite });
      toast("Group", "Creating invite…");
    };
  };
}

function renderSidebarInbox(){
  if(isGuest){
    sideSection.innerHTML = `
      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);color:var(--muted);font-size:12px;line-height:1.45">
        Guest mode has no inbox.
        <br><br>
        Log in to get friend + group invites.
      </div>
    `;
    return;
  }

  const incomingFriends = social?.incoming || [];
  const incomingGroups = social?.groupInvites || []; // [{groupId,name,from}]
  const total = incomingFriends.length + incomingGroups.length;
  unread.inbox = total;
  recomputePings();

  sideSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:950;font-size:12px;color:#dbe6f1">Inbox</div>
      <div style="font-size:11px;color:var(--muted)">${total} requests</div>
    </div>

    <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
      ${incomingGroups.length ? incomingGroups.map(g=>`
        <div class="row">
          <div class="rowLeft">
            <div class="statusDot on"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(g.name)}</div>
              <div class="rowSub">group invite • from ${escapeHtml(g.from)}</div>
            </div>
          </div>
          <button class="btn small primary" data-gaccept="${escapeHtml(g.groupId)}">Join</button>
          <button class="btn small" data-gdecline="${escapeHtml(g.groupId)}">Decline</button>
        </div>
      `).join("") : ""}

      ${incomingFriends.length ? incomingFriends.map(u=>`
        <div class="row">
          <div class="rowLeft">
            <div class="statusDot ${onlineUsers.some(x=>x.user===u)?"on":""}"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(u)}</div>
              <div class="rowSub">friend request</div>
            </div>
          </div>
          <button class="btn small primary" data-faccept="${escapeHtml(u)}">Accept</button>
          <button class="btn small" data-fdecline="${escapeHtml(u)}">Decline</button>
        </div>
      `).join("") : ""}

      ${!incomingGroups.length && !incomingFriends.length ? `
        <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);color:var(--muted);font-size:12px">
          Nothing here right now.
        </div>
      ` : ``}
    </div>
  `;

  // Group invite actions
  sideSection.querySelectorAll("[data-gaccept]").forEach(b=>{
    b.addEventListener("click",(e)=>{
      e.stopPropagation();
      socket.emit("group:inviteAccept", { groupId: b.getAttribute("data-gaccept") });
      toast("Group", "Joining…");
    });
  });
  sideSection.querySelectorAll("[data-gdecline]").forEach(b=>{
    b.addEventListener("click",(e)=>{
      e.stopPropagation();
      socket.emit("group:inviteDecline", { groupId: b.getAttribute("data-gdecline") });
      toast("Group", "Declined.");
    });
  });

  // Friend actions
  sideSection.querySelectorAll("[data-faccept]").forEach(b=>{
    b.addEventListener("click",(e)=>{
      e.stopPropagation();
      socket.emit("friend:accept", { from: b.getAttribute("data-faccept") });
      toast("Friends", "Accepted.");
    });
  });
  sideSection.querySelectorAll("[data-fdecline]").forEach(b=>{
    b.addEventListener("click",(e)=>{
      e.stopPropagation();
      socket.emit("friend:decline", { from: b.getAttribute("data-fdecline") });
      toast("Friends", "Declined.");
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

  unread.dm.set(user, 0);
  recomputePings();

  clearChat();
  socket.emit("dm:history", { withUser: user });
  renderSidebarMessages();
}

function openGroup(gid){
  if(isGuest){
    toast("Guests", "Guests can’t use groups. Log in.");
    return;
  }
  currentGroupId = gid;
  currentDM = null;
  setView("group", gid);

  unread.group.set(gid, 0);
  recomputePings();

  clearChat();
  socket.emit("group:history", { groupId: gid });
  renderSidebarMessages();
}

// ---------- group manage ----------
function openGroupManage(gid){
  const meta = groupMeta.get(gid);
  if(!meta) return;

  const isOwner = meta.owner === me;

  const membersHtml = meta.members.map(u => `
    <div class="row" data-member="${escapeHtml(u)}" title="Right-click your own name to leave">
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
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;flex-direction:column;gap:4px">
        <div style="font-weight:950">${escapeHtml(meta.name)} ${meta.active ? "" : "(pending)"}</div>
        <div style="font-size:12px;color:var(--muted)">ID: ${escapeHtml(meta.id)} • members: ${meta.members.length}</div>
      </div>

      ${isOwner ? `
        <div style="display:flex;gap:10px;align-items:center">
          <input id="renameG" class="field" value="${escapeHtml(meta.name)}" />
          <button class="btn small primary" id="renameBtn">Rename</button>
        </div>
      ` : ``}

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Members</div>
        <div style="display:flex;flex-direction:column;gap:8px" id="membersList">${membersHtml}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:10px">
          Tip: Right-click your own name to leave the group.
        </div>
      </div>

      ${isOwner ? `
        <div style="display:flex;flex-direction:column;gap:10px">
          <div style="font-weight:900;font-size:12px">Invite</div>
          <div style="display:flex;gap:10px border-box">
            <input id="inviteUser" class="field" placeholder="Invite username" />
            <button class="btn small primary" id="inviteBtn">Invite</button>
          </div>
          <button class="btn" id="deleteBtn" style="border-color:rgba(255,77,77,.35)">Delete group</button>
        </div>
      ` : `
        <button class="btn" id="leaveBtn" style="border-color:rgba(255,77,77,.35)">Leave group</button>
      `}
    </div>
  `);

  // remove (owner)
  modalBody.querySelectorAll("[data-remove]").forEach(btn=>{
    btn.addEventListener("click",(e)=>{
      e.stopPropagation();
      const u = btn.getAttribute("data-remove");
      socket.emit("group:removeMember", { groupId: gid, user: u });
      toast("Group", `Removing ${u}…`);
    });
  });

  // right click to leave
  modalBody.querySelectorAll("[data-member]").forEach(row=>{
    row.addEventListener("contextmenu",(e)=>{
      e.preventDefault();
      const u = row.getAttribute("data-member");
      if(u !== me) return;

      openModal("Leave group?", `
        <div style="color:var(--muted);font-size:12px;line-height:1.45">
          Leave <b>${escapeHtml(meta.name)}</b>? You can be re-invited by the owner.
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
    $("renameBtn")?.addEventListener("click", ()=>{
      const name = $("renameG").value.trim();
      if(!name) return;
      socket.emit("group:rename", { groupId: gid, name });
      toast("Group", "Renaming…");
    });

    $("inviteBtn")?.addEventListener("click", ()=>{
      const u = $("inviteUser").value.trim();
      if(!u) return;
      socket.emit("group:invite", { groupId: gid, user: u });
      toast("Group", `Inviting ${u}…`);
    });

    $("deleteBtn")?.addEventListener("click", ()=>{
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
    });
  } else {
    $("leaveBtn")?.addEventListener("click", ()=>{
      closeModal();
      socket.emit("group:leave", { groupId: gid });
      toast("Group", "Leaving…");
    });
  }
}

// ---------- profile popup ----------
function openProfile(user){
  if(!user) return;

  const guest = isGuestUser(user);

  openModal("Profile", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div>
        <div style="font-weight:950;font-size:16px">${escapeHtml(user)}</div>
        <div style="font-size:12px;color:var(--muted)" id="profSub">${guest ? "Guest account" : "Loading…"}</div>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Stats</div>
        <div id="profStats" style="display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:12px">
          ${guest ? `<div>Guests have no saved stats.</div>` : `<div>Loading…</div>`}
        </div>
      </div>

      ${(!isGuest && !guest && user !== me) ? `
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" id="dmBtn">DM</button>
          <button class="btn" id="friendBtn">Add friend</button>
          <button class="btn" id="blockBtn">Block</button>
        </div>
      ` : ``}
    </div>
  `);

  if(guest) return;

  socket.emit("profile:get", { user });
  modalBody._profileUser = user;

  // buttons
  setTimeout(()=>{
    const dmBtn = $("dmBtn");
    const friendBtn = $("friendBtn");
    const blockBtn = $("blockBtn");

    if(dmBtn) dmBtn.onclick = ()=> { closeModal(); openDM(user); };
    if(friendBtn) friendBtn.onclick = ()=> { socket.emit("friend:request", { to: user }); toast("Friends", "Request sent."); };
    if(blockBtn) blockBtn.onclick = ()=> { socket.emit("user:block", { user }); toast("Blocked", "User blocked."); closeModal(); };
  }, 0);
}

// ---------- settings popup (no apply unless Save) ----------
function openSettings(){
  if(isGuest){
    openModal("Settings (Guest)", `
      <div style="color:var(--muted);font-size:12px;line-height:1.45">
        Guest settings aren’t saved.
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);margin-top:10px">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">UI</div>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div>
            <div style="font-weight:900;font-size:12px">Custom cursor</div>
            <div style="font-size:11px;color:var(--muted)">Shows a stylized cursor.</div>
          </div>
          <button class="btn small" id="cursorToggle">${uiLocal.cursorOn === false ? "Off" : "On"}</button>
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px">
          <div>
            <div style="font-weight:900;font-size:12px">Reduce motion</div>
            <div style="font-size:11px;color:var(--muted)">Disables animations.</div>
          </div>
          <button class="btn small" id="motionToggle">${uiLocal.reducedMotion ? "On" : "Off"}</button>
        </div>
      </div>

      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="btn primary" id="closeS">Close</button>
      </div>
    `);

    $("cursorToggle").onclick = ()=>{
      uiLocal.cursorOn = !(uiLocal.cursorOn === true);
      // toggle state
      uiLocal.cursorOn = !uiLocal.cursorOn ? false : true;
      $("cursorToggle").textContent = uiLocal.cursorOn ? "On" : "Off";
      applyCursor(uiLocal.cursorOn);
      saveUILocal();
    };

    $("motionToggle").onclick = ()=>{
      uiLocal.reducedMotion = !uiLocal.reducedMotion;
      $("motionToggle").textContent = uiLocal.reducedMotion ? "On" : "Off";
      applyReduceMotion(uiLocal.reducedMotion);
      saveUILocal();
    };

    $("closeS").onclick = closeModal;
    return;
  }

  const s = settings || { theme:"dark", density:0.25, sidebar:0.25, hideMildProfanity:false, cursorOn:true, reducedMotion:false };
  const themeKeys = ["dark","vortex","abyss","carbon"];

  // draft (preview only)
  const draft = {
    theme: s.theme || "dark",
    density: Number.isFinite(s.density) ? s.density : 0.25,
    sidebar: Number.isFinite(s.sidebar) ? s.sidebar : 0.25,
    hideMildProfanity: !!s.hideMildProfanity,
    cursorOn: s.cursorOn !== false,
    reducedMotion: !!s.reducedMotion
  };

  openModal("Settings", `
    <div style="display:flex;flex-direction:column;gap:10px">

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Theme</div>
        <input id="themeSlider" type="range" min="0" max="${themeKeys.length-1}" step="1" value="${themeKeys.indexOf(draft.theme)}" style="width:100%">
        <div style="font-size:12px;color:var(--muted);margin-top:6px">Current: <b id="themeName">${escapeHtml(draft.theme)}</b> (preview)</div>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Layout density</div>
        <input id="densitySlider" type="range" min="0" max="1" step="0.01" value="${draft.density}" style="width:100%">
        <div style="font-size:12px;color:var(--muted);margin-top:6px">Compact ↔ Cozy (preview)</div>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Sidebar width</div>
        <input id="sidebarSlider" type="range" min="0" max="1" step="0.01" value="${draft.sidebar}" style="width:100%">
        <div style="font-size:12px;color:var(--muted);margin-top:6px">Narrow ↔ Wide (preview)</div>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div>
            <div style="font-weight:900;font-size:12px">Hide mild profanity</div>
            <div style="font-size:11px;color:var(--muted)">F/S/A words get masked as •••.</div>
          </div>
          <button class="btn small" id="toggleMild">${draft.hideMildProfanity ? "On" : "Off"}</button>
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px">
          <div>
            <div style="font-weight:900;font-size:12px">Custom cursor</div>
            <div style="font-size:11px;color:var(--muted)">Default ON.</div>
          </div>
          <button class="btn small" id="toggleCursor">${draft.cursorOn ? "On" : "Off"}</button>
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px">
          <div>
            <div style="font-weight:900;font-size:12px">Reduce motion</div>
            <div style="font-size:11px;color:var(--muted)">Disables animations.</div>
          </div>
          <button class="btn small" id="toggleMotion">${draft.reducedMotion ? "On" : "Off"}</button>
        </div>
      </div>

      <div style="display:flex;gap:10px">
        <button class="btn primary" id="saveS">Save</button>
        <button class="btn" id="closeS">Close</button>
      </div>

      <div style="font-size:11px;color:var(--muted);line-height:1.4">
        Preview changes won’t save unless you press <b>Save</b>.
      </div>
    </div>
  `);

  const applyDraftPreview = ()=>{
    applyTheme(draft.theme);
    applyDensity(draft.density);
    applySidebarWidth(draft.sidebar);
    applyCursor(draft.cursorOn);
    applyReduceMotion(draft.reducedMotion);
  };

  // Start preview immediately from draft (matches current settings)
  applyDraftPreview();

  $("themeSlider").addEventListener("input", ()=>{
    draft.theme = themeKeys[Number($("themeSlider").value)];
    $("themeName").textContent = draft.theme;
    applyDraftPreview();
  });

  $("densitySlider").addEventListener("input", ()=>{
    draft.density = Number($("densitySlider").value);
    applyDraftPreview();
  });

  $("sidebarSlider").addEventListener("input", ()=>{
    draft.sidebar = Number($("sidebarSlider").value);
    applyDraftPreview();
  });

  $("toggleMild").onclick = ()=>{
    draft.hideMildProfanity = !draft.hideMildProfanity;
    $("toggleMild").textContent = draft.hideMildProfanity ? "On" : "Off";
  };

  $("toggleCursor").onclick = ()=>{
    draft.cursorOn = !draft.cursorOn;
    $("toggleCursor").textContent = draft.cursorOn ? "On" : "Off";
    applyDraftPreview();
  };

  $("toggleMotion").onclick = ()=>{
    draft.reducedMotion = !draft.reducedMotion;
    $("toggleMotion").textContent = draft.reducedMotion ? "On" : "Off";
    applyDraftPreview();
  };

  $("closeS").onclick = ()=>{
    // revert preview back to saved settings on close
    applyTheme(settings?.theme || "dark");
    applyDensity(Number.isFinite(settings?.density) ? settings.density : 0.25);
    applySidebarWidth(Number.isFinite(settings?.sidebar) ? settings.sidebar : 0.25);
    applyCursor(settings?.cursorOn !== false);
    applyReduceMotion(!!settings?.reducedMotion);
    closeModal();
  };

  $("saveS").onclick = ()=>{
    settings = settings || {};
  // commit draft into settings (server saved)
    settings.theme = draft.theme;
    settings.density = draft.density;
    settings.sidebar = draft.sidebar;
    settings.hideMildProfanity = draft.hideMildProfanity;
    settings.cursorOn = draft.cursorOn;
    settings.reducedMotion = draft.reducedMotion;

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
  socket.emit("login", { guest:true });
});

passwordEl.addEventListener("keydown",(e)=>{
  if(e.key==="Enter") joinBtn.click();
});

// ---------- boot local UI ----------
(function bootLocalUI(){
  $("year").textContent = String(new Date().getFullYear());

  // local cursor + reduced motion (these are UI-only, not server)
  if(typeof uiLocal.cursorOn !== "boolean") uiLocal.cursorOn = true;
  if(typeof uiLocal.reducedMotion !== "boolean") uiLocal.reducedMotion = false;
  applyCursor(uiLocal.cursorOn);
  applyReduceMotion(uiLocal.reducedMotion);

  // compact defaults BEFORE login
  applyTheme("dark");
  applyDensity(0.25);
  applySidebarWidth(0.25);

  // resume if token exists
  if(token){
    socket.emit("resume", { token });
  }
})();

// ---------- socket events ----------
socket.on("loginSuccess",(data)=>{
  hideLoading();

  me = data.username;
  isGuest = !!data.guest;
  settings = data.settings || settings || {};
  social = data.social || social || { friends:[], incoming:[], outgoing:[], blocked:[], groupInvites:[] };
  xp = data.xp || null;

  // apply settings (saved)
  applyTheme(settings?.theme || "dark");
  applyDensity(Number.isFinite(settings?.density) ? settings.density : 0.25);
  applySidebarWidth(Number.isFinite(settings?.sidebar) ? settings.sidebar : 0.25);
  applyCursor(settings?.cursorOn !== false);
  applyReduceMotion(!!settings?.reducedMotion);

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
    // guest limitations
    settingsBtn.style.display="none";
    logoutBtn.style.display="none";
    loginBtn.style.display="inline-flex";
  } else {
    settingsBtn.style.display="inline-flex";
    logoutBtn.style.display="inline-flex";
    loginBtn.style.display="none";
  }

  toast("Welcome", isGuest ? "Joined as Guest" : `Logged in as ${me}`);

  // default start global
  openGlobal(true);

  // sync inbox pings
  if(!isGuest) socket.emit("social:sync");
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
  settings = s || settings || {};
  applyTheme(settings?.theme || "dark");
  applyDensity(Number.isFinite(settings?.density) ? settings.density : 0.25);
  applySidebarWidth(Number.isFinite(settings?.sidebar) ? settings.sidebar : 0.25);
  applyCursor(settings?.cursorOn !== false);
  applyReduceMotion(!!settings?.reducedMotion);
});

socket.on("social:update",(s)=>{
  social = s || social;
  if(tabInbox.classList.contains("primary")) renderSidebarInbox();
  recomputePings();
});

socket.on("xp:update",(x)=>{
  xp = x;
});

socket.on("onlineUsers",(list)=>{
  onlineUsers = Array.isArray(list) ? list : [];
  if(view.type==="global") renderSidebarGlobal();
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
  if(globalCache.length > 200) globalCache.shift();

  if(view.type==="global"){
    addMessageToUI(m, { scope:"global" });
  }
  // no red pings for global (you asked)
});

socket.on("sendError",(e)=>{
  toast("Action blocked", e?.reason || "Blocked.");
});

// DMs
socket.on("dm:history", ({ withUser, msgs }={})=>{
  if(!withUser) return;
  dmCache.set(withUser, msgs || []);
  if(view.type==="dm" && currentDM===withUser){
    clearChat();
    (msgs || []).forEach(m=> addMessageToUI(m, { scope:"dm", from: (m.user===me? withUser : m.user) }));
  }
});

socket.on("dm:message", ({ from, msg }={})=>{
  if(!from || !msg) return;

  if(!dmCache.has(from)) dmCache.set(from, []);
  dmCache.get(from).push(msg);
  if(dmCache.get(from).length > 250) dmCache.get(from).shift();

  const scopeKey = "dm:"+from;

  if(view.type==="dm" && currentDM===from){
    addMessageToUI(msg, { scope:"dm", from });
  } else {
    unread.dm.set(from, (unread.dm.get(from) || 0) + 1);
    recomputePings();
    if(!isMuted(scopeKey)) { pingSound(); }
  }

  if(tabMessages.classList.contains("primary")) renderSidebarMessages();
});

// Groups
socket.on("groups:list",(list)=>{
  if(isGuest) return;

  groupMeta.clear();
  (Array.isArray(list)?list:[]).forEach(g=>{
    groupMeta.set(g.id, { id:g.id, name:g.name, owner:g.owner, members:g.members || [], active: !!g.active });
  });

  if(tabMessages.classList.contains("primary")) renderSidebarMessages();
});

socket.on("group:history",({ groupId, meta, msgs })=>{
  groupMeta.set(groupId, meta);
  groupCache.set(groupId, msgs || []);
  currentGroupId = groupId;

  setView("group", groupId);

  clearChat();
  (msgs || []).forEach(m=> addMessageToUI(m, { scope:"group" }));

  // header manage link
  chatHint.innerHTML = `members: <b style="color:var(--text)">${meta.members.length}</b> • <span style="text-decoration:underline;cursor:pointer" id="manageGroupLink">manage</span>`;
  setTimeout(()=>{
    const link = document.getElementById("manageGroupLink");
    if(link) link.onclick = ()=> openGroupManage(groupId);
  }, 0);
});

socket.on("group:message",({ groupId, msg })=>{
  if(!groupId || !msg) return;
  if(!groupCache.has(groupId)) groupCache.set(groupId, []);
  groupCache.get(groupId).push(msg);
  if(groupCache.get(groupId).length > 250) groupCache.get(groupId).shift();

  const scopeKey = "group:"+groupId;

  if(view.type==="group" && currentGroupId===groupId){
    addMessageToUI(msg, { scope:"group" });
  } else {
    unread.group.set(groupId, (unread.group.get(groupId) || 0) + 1);
    recomputePings();
    if(!isMuted(scopeKey)) { pingSound(); }
  }

  if(tabMessages.classList.contains("primary")) renderSidebarMessages();
});

socket.on("group:meta",({ groupId, meta })=>{
  if(!groupId || !meta) return;
  groupMeta.set(groupId, meta);
  if(view.type==="group" && currentGroupId===groupId){
    chatTitle.textContent = `Group — ${meta.name}`;
  }
  if(tabMessages.classList.contains("primary")) renderSidebarMessages();
});

socket.on("group:left",({ groupId })=>{
  toast("Group", "Left group.");
  groupMeta.delete(groupId);
  groupCache.delete(groupId);
  if(view.type==="group" && currentGroupId===groupId){
    openGlobal(true);
  }
  socket.emit("groups:list");
});

socket.on("group:deleted",({ groupId })=>{
  toast("Group", "Group deleted.");
  groupMeta.delete(groupId);
  groupCache.delete(groupId);
  if(view.type==="group" && currentGroupId===groupId){
    openGlobal(true);
  }
  socket.emit("groups:list");
});

// Profile data
socket.on("profile:data",(data)=>{
  const u = modalBody?._profileUser;
  if(!u || data?.user !== u) return;

  const sub = $("profSub");
  const stats = $("profStats");
  if(!sub || !stats) return;

  sub.textContent = `Level ${data.level} • created ${new Date(data.createdAt).toLocaleDateString()}`;

  stats.innerHTML = `
    <div>Messages: <b style="color:var(--text)">${data.messages}</b></div>
    <div>XP: <b style="color:var(--text)">${data.xp}</b> / ${data.next}</div>
    <div>Friends: <b style="color:var(--text)">${data.friendsCount}</b></div>
  `;
});
