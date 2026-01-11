/* tonkotsu.online - public/script.js (full replacement)
   - No window.alert() anywhere (only modal popups + toasts)
   - Fix overlap: correct initial boot/resume flow
   - Groups: add/remove/leave/delete + manage button
   - Friends: requests, accept, remove
   - Blocking: hide messages + prevent DMs to/from blocked (server enforced)
   - XP/Levels: server authoritative, increasing XP requirement
   - Profiles: createdAt, level/xp, messages, friends, blocked, etc.
   - Usernames: strict allowed chars (server enforced, client hints)
   - Remove “emoji feature”: no emoji picker / no emoji UI; password toggle uses text
*/

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
const groupManageBtn = $("groupManageBtn");

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

// ---------- State ----------
let me = null;
let isGuest = false;
let token = localStorage.getItem("tonkotsu_token") || null;

let onlineUsers = [];
let settings = null;
let social = null;
let xp = { level: 1, xp: 0, next: 120 };

let view = { type: "global", id: null }; // global | dm | group
let currentDM = null;
let currentGroupId = null;

let globalCache = [];
let dmCache = new Map();        // user -> msgs
let groupMeta = new Map();      // gid -> {id,name,owner,members[]}
let groupCache = new Map();     // gid -> msgs

let cooldownUntil = 0;

// ---------- Themes ----------
const THEMES = {
  dark:   { bg:"#0b0d10", panel:"rgba(255,255,255,.02)", stroke:"#1c232c", stroke2:"#242c36", text:"#e8edf3", muted:"#9aa7b3" },
  vortex: { bg:"#070913", panel:"rgba(120,140,255,.06)", stroke:"#1a2240", stroke2:"#28305c", text:"#eaf0ff", muted:"#9aa7d6" },
  abyss:  { bg:"#060a0b", panel:"rgba(80,255,220,.05)",  stroke:"#12312c", stroke2:"#1c3f37", text:"#e8fff9", muted:"#8abfb3" },
  carbon: { bg:"#0c0d0e", panel:"rgba(255,255,255,.035)", stroke:"#272a2e", stroke2:"#343840", text:"#f2f4f7", muted:"#a0a8b3" },
  nebula: { bg:"#07070b", panel:"rgba(255,120,220,.05)", stroke:"#2a1431", stroke2:"#3b1f45", text:"#fff0fb", muted:"#d3a7c7" },
  glacier:{ bg:"#060b10", panel:"rgba(140,220,255,.05)", stroke:"#113042", stroke2:"#1a445d", text:"#e9f7ff", muted:"#9fc6d8" },
};

const THEME_KEYS = Object.keys(THEMES);
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
  const v = clamp(Number(val), 0, 1);
  const pad = Math.round(10 + v * 10);  // 10..20
  const font = Math.round(12 + v * 2);  // 12..14
  document.documentElement.style.setProperty("--pad", `${pad}px`);
  document.documentElement.style.setProperty("--font", `${font}px`);
}

function applySidebarWidth(val){
  // 0..1 => 280..380
  const v = clamp(Number(val), 0, 1);
  const w = Math.round(280 + v * 100);
  document.documentElement.style.setProperty("--sidebarW", `${w}px`);
}

// ---------- Helpers ----------
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

function fmtTime(ts){
  const d = new Date(ts);
  if(!Number.isFinite(d.getTime())) return "";
  const h = String(d.getHours()).padStart(2,"0");
  const m = String(d.getMinutes()).padStart(2,"0");
  return `${h}:${m}`;
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
  setTimeout(() => { d.style.opacity="0"; d.style.transform="translateY(10px)"; }, 2800);
  setTimeout(() => d.remove(), 3300);
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

function confirmPopup(title, bodyHtml, yesLabel="Confirm", noLabel="Cancel"){
  return new Promise((resolve)=>{
    openModal(title, `
      <div style="color:var(--muted);font-size:12px;line-height:1.5">${bodyHtml}</div>
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="btn" id="cNo">${escapeHtml(noLabel)}</button>
        <button class="btn primary" id="cYes">${escapeHtml(yesLabel)}</button>
      </div>
    `);
    $("cNo").onclick = ()=>{ closeModal(); resolve(false); };
    $("cYes").onclick = ()=>{ closeModal(); resolve(true); };
  });
}

function shakeLogin(){
  const card = document.querySelector(".loginCard");
  card.classList.add("shake");
  setTimeout(()=> card.classList.remove("shake"), 380);
}

function isGuestUser(u){ return /^Guest\d{1,10}$/.test(String(u)); }
function isBlockedUser(u){ return !!social?.blocked?.includes(u); }
function isFriend(u){ return !!social?.friends?.includes(u); }

function humanDate(ts){
  const d = new Date(ts);
  if(!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year:"numeric", month:"short", day:"2-digit" });
}

function setPing(el, n){
  if(!el) return;
  if(n > 0){
    el.textContent = String(n);
    el.classList.add("show");
  } else {
    el.classList.remove("show");
  }
}

// ---------- Password toggle (no emoji) ----------
togglePass.addEventListener("click", () => {
  const isPw = passwordEl.type === "password";
  passwordEl.type = isPw ? "text" : "password";
  togglePass.textContent = isPw ? "Hide" : "Show";
});

// ---------- Cooldown ----------
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

// ---------- View switching ----------
function setView(type, id=null){
  view = { type, id };
  socket.emit("view:set", view);

  groupManageBtn.style.display = "none";

  if(type==="global"){
    chatTitle.textContent = "Global chat";
    chatHint.textContent = "shared with everyone online";
    backBtn.style.display = "none";
  } else if(type==="dm"){
    chatTitle.textContent = `DM — ${id}`;
    chatHint.textContent = "private messages";
    backBtn.style.display = "inline-flex";
  } else if(type==="group"){
    const meta = groupMeta.get(id);
    chatTitle.textContent = meta ? `Group — ${meta.name}` : "Group";
    chatHint.textContent = "group chat";
    backBtn.style.display = "inline-flex";
    groupManageBtn.style.display = "inline-flex";
  }
}

// Back
backBtn.addEventListener("click", ()=> openGlobal(true));

// Group manage button (always visible in group view)
groupManageBtn.addEventListener("click", ()=>{
  if(view.type==="group" && currentGroupId) openGroupManage(currentGroupId);
});

// ---------- Message rendering ----------
function addMessageToUI({ user, text, ts }, { scope="global", from=null, groupId=null } = {}){
  const t = fmtTime(ts);
  if(!t) return;

  const who = scope==="dm" ? from : user;

  let bodyText = String(text ?? "");

  // Hide blocked everywhere
  if(who && isBlockedUser(who)){
    bodyText = "Message hidden (blocked user).";
  }

  // Hide “server flagged” messages
  if(bodyText === "__HIDDEN_BY_FILTER__"){
    bodyText = "Message hidden (content filtered).";
  }

  const row = document.createElement("div");
  row.className="msg";
  row.innerHTML = `
    <div class="bubble">
      <div class="meta">
        <div class="u" data-user="${escapeHtml(who)}">${escapeHtml(who)}${(who===me?" (You)":"")}</div>
        <div class="t">${escapeHtml(t)}</div>
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

// ---------- Sidebar rendering ----------
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
            <div class="statusDot ${u.user ? "on" : ""}"></div>
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
  const dmUsers = Array.from(new Set(Array.from(dmCache.keys()))).sort((a,b)=>a.localeCompare(b));
  const groups = Array.from(groupMeta.values()).sort((a,b)=>String(a.name).localeCompare(String(b.name)));

  sideSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:950;font-size:12px;color:#dbe6f1">Messages</div>
      <button class="btn small" id="createGroupBtn">Create group</button>
    </div>

    <div style="display:flex;flex-direction:column;gap:8px">
      <div style="margin-top:6px;font-size:11px;color:var(--muted)">DMs</div>
      <div id="dmList" style="display:flex;flex-direction:column;gap:8px"></div>

      <div style="margin-top:10px;font-size:11px;color:var(--muted)">Groups</div>
      <div id="groupList" style="display:flex;flex-direction:column;gap:8px"></div>
    </div>
  `;

  const dmList = $("dmList");
  const groupList = $("groupList");

  dmUsers.forEach(u=>{
    const row = document.createElement("div");
    row.className="row";
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
    dmList.appendChild(row);
  });

  groups.forEach(g=>{
    const row = document.createElement("div");
    row.className="row";
    row.innerHTML = `
      <div class="rowLeft">
        <div class="statusDot on"></div>
        <div class="nameCol">
          <div class="rowName">${escapeHtml(g.name || "Unnamed group")}</div>
          <div class="rowSub">${escapeHtml((g.members?.length ?? 0) + " members")}</div>
        </div>
      </div>
    `;
    row.addEventListener("click", ()=> openGroup(g.id));
    groupList.appendChild(row);
  });

  $("createGroupBtn").onclick = () => {
    if(isGuest){
      toast("Guests", "Guests can’t create groups. Log in to use groups.");
      return;
    }
    openModal("Create group", `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:12px;color:var(--muted)">Group name</div>
        <input id="gcName" class="field" placeholder="e.g. ramen_squad" />
        <div style="font-size:11px;color:var(--muted);line-height:1.4">
          Tip: keep it short. (Name can be changed later by owner.)
        </div>
        <button class="btn primary" id="gcCreate">Create</button>
      </div>
    `);
    setTimeout(()=> $("gcName")?.focus(), 40);
    $("gcCreate").onclick = () => {
      const name = $("gcName").value.trim();
      if(!name){
        toast("Group", "Name required.");
        return;
      }
      closeModal();
      socket.emit("group:create", { name });
      toast("Group", "Creating…");
    };
  };
}

function renderSidebarInbox(){
  if(isGuest){
    sideSection.innerHTML = `
      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);color:var(--muted);font-size:12px;line-height:1.45">
        Guest mode has no inbox.
        <br><br>
        Log in to get friend requests.
      </div>
    `;
    return;
  }

  const incoming = social?.incoming || [];
  const outgoing = social?.outgoing || [];

  sideSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:950;font-size:12px;color:#dbe6f1">Inbox</div>
      <div style="font-size:11px;color:var(--muted)">${incoming.length} incoming</div>
    </div>

    <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
      ${incoming.length ? incoming.map(u=>`
        <div class="row" data-profile="${escapeHtml(u)}">
          <div class="rowLeft">
            <div class="statusDot ${onlineUsers.some(x=>x.user===u)?"on":""}"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(u)}</div>
              <div class="rowSub">friend request</div>
            </div>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn small primary" data-accept="${escapeHtml(u)}">Accept</button>
            <button class="btn small" data-decline="${escapeHtml(u)}">Decline</button>
          </div>
        </div>
      `).join("") : `
        <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);color:var(--muted);font-size:12px">
          No incoming requests right now.
        </div>
      `}
    </div>

    <div style="margin-top:12px;font-size:11px;color:var(--muted)">Outgoing</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
      ${outgoing.length ? outgoing.map(u=>`
        <div class="row" data-profile="${escapeHtml(u)}">
          <div class="rowLeft">
            <div class="statusDot ${onlineUsers.some(x=>x.user===u)?"on":""}"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(u)}</div>
              <div class="rowSub">pending</div>
            </div>
          </div>
          <button class="btn small" data-cancel="${escapeHtml(u)}">Cancel</button>
        </div>
      `).join("") : `
        <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);color:var(--muted);font-size:12px">
          No outgoing requests.
        </div>
      `}
    </div>
  `;

  // Click profile rows
  sideSection.querySelectorAll("[data-profile]").forEach(el=>{
    el.addEventListener("click", ()=> openProfile(el.getAttribute("data-profile")));
  });

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
      toast("Friends", "Declined.");
    });
  });
  sideSection.querySelectorAll("[data-cancel]").forEach(b=>{
    b.addEventListener("click", (e)=>{
      e.stopPropagation();
      socket.emit("friend:cancel", { to: b.getAttribute("data-cancel") });
      toast("Friends", "Cancelled.");
    });
  });
}

// ---------- Open Global / DM / Group ----------
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
    toast("Guests", "Guests can’t use groups. Log in to use groups.");
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

// ---------- Group management popup ----------
function openGroupManage(gid){
  const meta = groupMeta.get(gid);
  if(!meta){
    toast("Group", "Group metadata not loaded yet.");
    return;
  }

  const isOwner = meta.owner === me;

  const membersHtml = (meta.members || []).map(u => `
    <div class="row" data-member="${escapeHtml(u)}" title="${escapeHtml(u===me ? "Right-click to leave" : "Member")}" style="cursor:default">
      <div class="rowLeft">
        <div class="statusDot ${onlineUsers.some(x=>x.user===u)?"on":""}"></div>
        <div class="nameCol">
          <div class="rowName">${escapeHtml(u)}${u===meta.owner ? " (Owner)" : ""}${u===me ? " (You)" : ""}</div>
          <div class="rowSub">member</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn small" data-profile="${escapeHtml(u)}">Profile</button>
        ${isOwner && u!==meta.owner ? `<button class="btn small danger" data-remove="${escapeHtml(u)}">Remove</button>` : ``}
      </div>
    </div>
  `).join("");

  openModal("Group settings", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div style="min-width:0">
          <div style="font-weight:950;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(meta.name)}</div>
          <div style="font-size:12px;color:var(--muted)">ID: ${escapeHtml(meta.id)} • Owner: <b style="color:var(--text)">${escapeHtml(meta.owner)}</b></div>
          <div style="font-size:12px;color:var(--muted)">Tip: Right-click your own name below to leave.</div>
        </div>
        <button class="btn small" id="closeG">Close</button>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Members (${(meta.members||[]).length})</div>
        <div style="display:flex;flex-direction:column;gap:8px" id="membersList">${membersHtml}</div>
      </div>

      ${isOwner ? `
        <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);display:flex;flex-direction:column;gap:10px">
          <div style="font-weight:900;font-size:12px">Owner controls</div>

          <div style="display:flex;gap:10px;align-items:center">
            <input id="addUser" class="field" placeholder="Add member (username)" />
            <button class="btn small primary" id="addBtn">Add</button>
          </div>

          <div style="display:flex;gap:10px;align-items:center">
            <input id="renameGroup" class="field" placeholder="Rename group…" />
            <button class="btn small" id="renameBtn">Rename</button>
          </div>

          <div style="display:flex;gap:10px;align-items:center">
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

  $("closeG").onclick = closeModal;

  // Profile buttons
  modalBody.querySelectorAll("[data-profile]").forEach(btn=>{
    btn.addEventListener("click",(e)=>{
      e.stopPropagation();
      openProfile(btn.getAttribute("data-profile"));
    });
  });

  // Remove member
  modalBody.querySelectorAll("[data-remove]").forEach(btn=>{
    btn.addEventListener("click", async (e)=>{
      e.stopPropagation();
      const u = btn.getAttribute("data-remove");
      const ok = await confirmPopup("Remove member?", `Remove <b>${escapeHtml(u)}</b> from <b>${escapeHtml(meta.name)}</b>?`, "Remove", "Cancel");
      if(!ok) return;
      socket.emit("group:removeMember", { groupId: gid, user: u });
      toast("Group", `Removing ${u}…`);
    });
  });

  // Right-click your own name -> leave
  modalBody.querySelectorAll("[data-member]").forEach(row=>{
    row.addEventListener("contextmenu", async (e)=>{
      e.preventDefault();
      const u = row.getAttribute("data-member");
      if(u !== me) return;

      const ok = await confirmPopup("Leave group?", `Leave <b>${escapeHtml(meta.name)}</b>? You can be re-added by the owner.`, "Leave", "Cancel");
      if(!ok) return;

      socket.emit("group:leave", { groupId: gid });
      toast("Group", "Leaving…");
      closeModal();
    });
  });

  if(isOwner){
    $("addBtn").onclick = ()=>{
      const u = $("addUser").value.trim();
      if(!u) return toast("Group", "Enter a username.");
      socket.emit("group:addMember", { groupId: gid, user: u });
      toast("Group", `Adding ${u}…`);
      $("addUser").value = "";
    };

    $("renameBtn").onclick = ()=>{
      const name = $("renameGroup").value.trim();
      if(!name) return toast("Group", "Enter a name.");
      socket.emit("group:rename", { groupId: gid, name });
      toast("Group", "Renaming…");
      $("renameGroup").value = "";
    };

    $("transferBtn").onclick = async ()=>{
      const u = $("transferUser").value.trim();
      if(!u) return toast("Group", "Enter a username.");
      const ok = await confirmPopup("Transfer ownership?", `Transfer ownership of <b>${escapeHtml(meta.name)}</b> to <b>${escapeHtml(u)}</b>?`, "Transfer", "Cancel");
      if(!ok) return;
      socket.emit("group:transferOwner", { groupId: gid, newOwner: u });
      toast("Group", `Transferring to ${u}…`);
      $("transferUser").value = "";
    };

    $("deleteBtn").onclick = async ()=>{
      const ok = await confirmPopup("Delete group?", `Delete <b>${escapeHtml(meta.name)}</b>? This can’t be undone.`, "Delete", "Cancel");
      if(!ok) return;
      socket.emit("group:delete", { groupId: gid });
      toast("Group", "Deleting…");
      closeModal();
    };
  } else {
    $("leaveBtn").onclick = async ()=>{
      const ok = await confirmPopup("Leave group?", `Leave <b>${escapeHtml(meta.name)}</b>?`, "Leave", "Cancel");
      if(!ok) return;
      socket.emit("group:leave", { groupId: gid });
      toast("Group", "Leaving…");
      closeModal();
    };
  }
}

// ---------- Profile popup ----------
function openProfile(user){
  if(!user) return;

  openModal("Profile", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div style="min-width:0">
          <div style="font-weight:950;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(user)}</div>
          <div style="font-size:12px;color:var(--muted)" id="profSub">loading…</div>
        </div>
        <button class="btn small" id="profClose">Close</button>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap" id="profActions"></div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Stats</div>
        <div id="profStats" style="display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:12px"></div>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap" id="profButtons"></div>
    </div>
  `);

  $("profClose").onclick = closeModal;

  socket.emit("profile:get", { user });
  modalBody._profileUser = user;
}

function renderProfileData(p){
  const user = p.user;
  const created = humanDate(p.createdAt);
  const lvl = p.level ?? 1;
  const cur = p.xp ?? 0;
  const next = p.next ?? 120;
  const msgCount = p.messages ?? 0;
  const friendsCount = p.friendsCount ?? 0;

  const sub = `Level <b style="color:var(--text)">${lvl}</b> • XP ${cur}/${next} • joined ${created}`;
  $("profSub").innerHTML = sub;

  const stats = [
    ["Messages sent", msgCount],
    ["Friends", friendsCount],
    ["Blocked users", (social?.blocked?.length ?? 0)],
  ];

  $("profStats").innerHTML = stats.map(([k,v])=>`
    <div style="display:flex;justify-content:space-between;gap:10px">
      <span>${escapeHtml(k)}</span>
      <b style="color:var(--text)">${escapeHtml(String(v))}</b>
    </div>
  `).join("");

  // Actions
  const actionsEl = $("profActions");
  const buttonsEl = $("profButtons");

  actionsEl.innerHTML = `
    <div class="badge">Level ${escapeHtml(String(lvl))}</div>
    <div class="badge">XP ${escapeHtml(String(cur))}/${escapeHtml(String(next))}</div>
    <div class="badge">Joined ${escapeHtml(created)}</div>
  `;

  const isSelf = user === me;
  const guestTarget = isGuestUser(user);

  let btns = [];

  if(!isGuest && !isSelf && !guestTarget){
    btns.push(`<button class="btn" id="dmBtn">DM</button>`);

    if(isFriend(user)){
      btns.push(`<button class="btn danger" id="removeFriendBtn">Remove friend</button>`);
    } else {
      btns.push(`<button class="btn" id="friendBtn">Add friend</button>`);
    }

    if(isBlockedUser(user)){
      btns.push(`<button class="btn" id="unblockBtn">Unblock</button>`);
    } else {
      btns.push(`<button class="btn danger" id="blockBtn">Block</button>`);
    }
  }

  if(isSelf){
    btns.push(`<button class="btn" id="mySettingsBtn">Settings</button>`);
  }

  buttonsEl.innerHTML = btns.join("");

  // Wire buttons
  if($("dmBtn")){
    $("dmBtn").onclick = ()=>{
      closeModal();
      openDM(user);
    };
  }
  if($("friendBtn")){
    $("friendBtn").onclick = ()=>{
      socket.emit("friend:request", { to: user });
      toast("Friends", "Request sent.");
    };
  }
  if($("removeFriendBtn")){
    $("removeFriendBtn").onclick = async ()=>{
      const ok = await confirmPopup("Remove friend?", `Remove <b>${escapeHtml(user)}</b> from your friends?`, "Remove", "Cancel");
      if(!ok) return;
      socket.emit("friend:remove", { user });
      toast("Friends", "Removed.");
      closeModal();
    };
  }
  if($("blockBtn")){
    $("blockBtn").onclick = async ()=>{
      const ok = await confirmPopup("Block user?", `Block <b>${escapeHtml(user)}</b>? They won’t be able to DM you and their messages will be hidden.`, "Block", "Cancel");
      if(!ok) return;
      socket.emit("user:block", { user });
      toast("Blocked", `${user} blocked.`);
      closeModal();
    };
  }
  if($("unblockBtn")){
    $("unblockBtn").onclick = ()=>{
      socket.emit("user:unblock", { user });
      toast("Blocked", `${user} unblocked.`);
      closeModal();
    };
  }
  if($("mySettingsBtn")){
    $("mySettingsBtn").onclick = ()=>{
      closeModal();
      openSettings();
    };
  }
}

// ---------- Settings popup ----------
function openSettings(){
  if(isGuest){
    openModal("Settings (Guest)", `
      <div style="color:var(--muted);font-size:12px;line-height:1.45">
        Guest settings aren’t saved. Log in to save themes/layout and use friends/groups.
      </div>
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="btn primary" id="closeS">Close</button>
      </div>
    `);
    $("closeS").onclick = closeModal;
    return;
  }

  const s = settings || {};
  const theme = s.theme || "dark";
  const density = Number.isFinite(s.density) ? s.density : 0.55;
  const sidebar = Number.isFinite(s.sidebar) ? s.sidebar : 0.40;
  const hideMild = !!s.hideMildProfanity;

  openModal("Settings", `
    <div style="display:flex;flex-direction:column;gap:10px">

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Theme</div>
        <input id="themeSlider" type="range" min="0" max="${THEME_KEYS.length-1}" step="1" value="${Math.max(0, THEME_KEYS.indexOf(theme))}" style="width:100%">
        <div style="font-size:12px;color:var(--muted);margin-top:6px">Current: <b id="themeName">${escapeHtml(theme)}</b></div>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Layout density</div>
        <input id="densitySlider" type="range" min="0" max="1" step="0.01" value="${density}" style="width:100%">
        <div style="font-size:12px;color:var(--muted);margin-top:6px">Compact ↔ Cozy</div>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Sidebar width</div>
        <input id="sidebarSlider" type="range" min="0" max="1" step="0.01" value="${sidebar}" style="width:100%">
        <div style="font-size:12px;color:var(--muted);margin-top:6px">Narrow ↔ Wide</div>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div>
            <div style="font-weight:900;font-size:12px">Hide mild profanity</div>
            <div style="font-size:11px;color:var(--muted)">Optional masking for mild words.</div>
          </div>
          <button class="btn small" id="toggleMild">${hideMild ? "On" : "Off"}</button>
        </div>
      </div>

      <div style="display:flex;gap:10px">
        <button class="btn primary" id="saveS">Save</button>
        <button class="btn" id="closeS">Close</button>
      </div>
    </div>
  `);

  $("closeS").onclick = closeModal;

  $("themeSlider").addEventListener("input", ()=>{
    const k = THEME_KEYS[Number($("themeSlider").value)];
    $("themeName").textContent = k;
    applyTheme(k);
  });

  $("densitySlider").addEventListener("input", ()=>{
    applyDensity($("densitySlider").value);
  });

  $("sidebarSlider").addEventListener("input", ()=>{
    applySidebarWidth($("sidebarSlider").value);
  });

  $("toggleMild").onclick = ()=>{
    settings.hideMildProfanity = !settings.hideMildProfanity;
    $("toggleMild").textContent = settings.hideMildProfanity ? "On" : "Off";
  };

  $("saveS").onclick = ()=>{
    const k = THEME_KEYS[Number($("themeSlider").value)];
    const d = Number($("densitySlider").value);
    const sb = Number($("sidebarSlider").value);

    settings.theme = k;
    settings.density = d;
    settings.sidebar = sb;

    socket.emit("settings:update", settings);
    toast("Settings", "Saved.");
    closeModal();
  };
}

// ---------- Tabs ----------
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

// ---------- Composer send ----------
sendBtn.addEventListener("click", sendCurrent);
messageEl.addEventListener("keydown", (e)=>{
  if(e.key==="Enter" && !e.shiftKey){
    e.preventDefault();
    sendCurrent();
  }
});

function sendCurrent(){
  if(!me) return;

  if(!canSend()){
    cooldownWarn();
    return;
  }

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

// ---------- Auth buttons ----------
settingsBtn.addEventListener("click", openSettings);

logoutBtn.addEventListener("click", async ()=>{
  showLoading("logging out…");
  socket.emit("logout");
  setTimeout(()=>{
    localStorage.removeItem("tonkotsu_token");
    location.reload();
  }, 500);
});

loginBtn.addEventListener("click", ()=>{
  loginOverlay.classList.remove("hidden");
});

// ---------- Join buttons ----------
joinBtn.addEventListener("click", ()=>{
  const u = usernameEl.value.trim();
  const p = passwordEl.value;

  if(!u || !p){
    shakeLogin();
    toast("Login", "Enter username + password, or use Guest.");
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

// ---------- Boot / Resume (fixes login overlay appearing over app) ----------
(function boot(){
  // Always start with app hidden until loginSuccess.
  app.classList.remove("show");
  mePill.style.display = "none";

  if(token){
    // If we have token, do NOT show login overlay.
    loginOverlay.classList.add("hidden");
    showLoading("resuming…");
    socket.emit("resume", { token });
  } else {
    // No token => show login overlay.
    loginOverlay.classList.remove("hidden");
  }
})();

// ---------- Socket events ----------
socket.on("resumeFail", ()=>{
  localStorage.removeItem("tonkotsu_token");
  token = null;
  hideLoading();
  loginOverlay.classList.remove("hidden");
  toast("Session", "Please log in again.");
});

socket.on("loginError",(msg)=>{
  hideLoading();
  shakeLogin();
  toast("Login failed", msg || "Try again.");
});

socket.on("loginSuccess",(data)=>{
  hideLoading();

  me = data.username;
  isGuest = !!data.guest;
  settings = data.settings || {};
  social = data.social || { friends:[], incoming:[], outgoing:[], blocked:[] };
  xp = data.xp || xp;

  applyTheme(settings.theme || "dark");
  applyDensity(settings.density ?? 0.55);
  applySidebarWidth(settings.sidebar ?? 0.40);

  loginOverlay.classList.add("hidden");
  app.classList.add("show");
  mePill.style.display = "flex";
  meName.textContent = me;

  if(!isGuest && data.token){
    localStorage.setItem("tonkotsu_token", data.token);
    token = data.token;
  }

  if(isGuest){
    settingsBtn.style.display="none";
    logoutBtn.style.display="none";
    loginBtn.style.display="inline-flex";
  } else {
    settingsBtn.style.display="inline-flex";
    logoutBtn.style.display="inline-flex";
    loginBtn.style.display="none";
  }

  toast("Welcome", isGuest ? "Joined as Guest" : `Logged in as ${me}`);

  socket.emit("groups:list");
  socket.emit("social:sync");

  openGlobal(true);
});

socket.on("settings",(s)=>{
  settings = s || settings || {};
  applyTheme(settings.theme || "dark");
  applyDensity(settings.density ?? 0.55);
  applySidebarWidth(settings.sidebar ?? 0.40);
});

socket.on("social:update",(s)=>{
  social = s || social || { friends:[], incoming:[], outgoing:[], blocked:[] };
  if(tabInbox.classList.contains("primary")) renderSidebarInbox();
});

socket.on("xp:update",(x)=>{
  xp = x || xp;
});

socket.on("ping:update", ({ inbox=0, messages=0 }={})=>{
  setPing(inboxPing, inbox);
  setPing(msgPing, messages);
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
  if(view.type==="global"){
    addMessageToUI(m, { scope:"global" });
  }
});

socket.on("dm:history", ({ withUser, msgs })=>{
  dmCache.set(withUser, msgs || []);
  if(view.type==="dm" && currentDM===withUser){
    clearChat();
    (msgs||[]).forEach(m=> addMessageToUI(m, { scope:"dm", from: m.user }));
  }
});

socket.on("dm:message", ({ from, msg })=>{
  if(!from || !msg) return;
  if(!dmCache.has(from)) dmCache.set(from, []);
  dmCache.get(from).push(msg);

  // If currently viewing that DM, render
  if(view.type==="dm" && currentDM===from){
    addMessageToUI(msg, { scope:"dm", from });
  }
});

socket.on("groups:list",(list)=>{
  if(isGuest) return;

  groupMeta.clear();
  (Array.isArray(list)?list:[]).forEach(g=>{
    groupMeta.set(g.id, { id:g.id, name:g.name, owner:g.owner, members:g.members || [] });
  });

  if(tabMessages.classList.contains("primary")) renderSidebarMessages();
  if(view.type==="group" && currentGroupId){
    const meta = groupMeta.get(currentGroupId);
    if(meta) chatTitle.textContent = `Group — ${meta.name}`;
  }
});

socket.on("group:history",({ groupId, meta, msgs })=>{
  if(!groupId) return;
  groupMeta.set(groupId, meta);
  groupCache.set(groupId, msgs || []);
  currentGroupId = groupId;

  setView("group", groupId);

  clearChat();
  (msgs || []).forEach(m=> addMessageToUI(m, { scope:"group", groupId }));

  // better hint: show members + owner + right click tip
  chatHint.textContent = `members: ${meta.members.length} • owner: ${meta.owner} • right-click your name in Manage to leave`;
});

socket.on("group:message",({ groupId, msg })=>{
  if(!groupId || !msg) return;
  if(!groupCache.has(groupId)) groupCache.set(groupId, []);
  groupCache.get(groupId).push(msg);

  if(view.type==="group" && currentGroupId===groupId){
    addMessageToUI(msg, { scope:"group", groupId });
  }
});

socket.on("group:meta",({ groupId, meta })=>{
  if(!groupId || !meta) return;
  groupMeta.set(groupId, meta);

  if(view.type==="group" && currentGroupId===groupId){
    chatTitle.textContent = `Group — ${meta.name}`;
    chatHint.textContent = `members: ${meta.members.length} • owner: ${meta.owner} • right-click your name in Manage to leave`;
  }

  if(tabMessages.classList.contains("primary")) renderSidebarMessages();
});

socket.on("group:left",({ groupId })=>{
  toast("Group", "Left the group.");
  if(view.type==="group" && currentGroupId===groupId){
    openGlobal(true);
  }
  socket.emit("groups:list");
});

socket.on("group:deleted",({ groupId })=>{
  toast("Group", "Group deleted.");
  if(view.type==="group" && currentGroupId===groupId){
    openGlobal(true);
  }
  socket.emit("groups:list");
});

socket.on("profile:data",(p)=>{
  // Only render if the profile popup is still for this user
  const wanted = modalBody._profileUser;
  if(!wanted || wanted !== p.user) return;
  renderProfileData(p);
});

socket.on("sendError",(e)=>{
  toast("Action blocked", e?.reason || "Blocked.");
});
