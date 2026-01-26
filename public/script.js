(() => {
  "use strict";

  // Prevent double-load -> stops duplicate messages and repeated UI
  if (window.__TONKOTSU_LOADED__) return;
  window.__TONKOTSU_LOADED__ = true;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const now = () => Date.now();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const safe = (v) => (typeof v === "string" ? v : "");
  const esc = (s) => safe(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");

  function uid(prefix="id"){ return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`; }

  // DOM
  const dom = {
    loginWrap: $("#loginWrap"),
    loginUser: $("#loginUser"),
    loginPass: $("#loginPass"),
    loginMsg: $("#loginMsg"),
    btnLogin: $("#btnLogin"),
    btnGuest: $("#btnGuest"),

    loading: $("#loading"),
    loadMsg: $("#loadMsg"),
    loadTag: $("#loadTag"),

    app: $("#app"),
    subtitle: $("#subtitle"),
    btnUser: $("#btnUser"),
    btnLogout: $("#btnLogout"),

    left: $(".left"),
    threadList: $("#threadList"),
    searchThreads: $("#searchThreads"),
    btnAddFriend: $("#btnAddFriend"),
    btnNewGroup: $("#btnNewGroup"),

    centerH: $("#centerH"),
    centerS: $("#centerS"),
    centerBody: $("#centerBody"),

    composer: $("#composer"),
    msgInput: $("#msgInput"),
    btnSend: $("#btnSend"),
    typingText: $("#typingText"),

    cooldownBar: $("#cooldownBar"),
    cooldownText: $("#cooldownText"),

    rightBody: $("#onlineUsers"),
    presenceDot: $("#presenceDot"),
    presenceLabel: $("#presenceLabel"),
    btnPresenceOnline: $("#btnPresenceOnline"),
    btnPresenceIdle: $("#btnPresenceIdle"),
    btnPresenceDnd: $("#btnPresenceDnd"),
    btnPresenceInv: $("#btnPresenceInv"),
    btnSettings: $("#btnSettings"),

    backdrop: $("#backdrop"),
    modalTitle: $("#modalTitle"),
    modalBody: $("#modalBody"),
    modalFoot: $("#modalFoot"),
    modalClose: $("#modalClose"),

    ctx: $("#ctx"),
    cursor: $("#cursor"),
    trail: $("#trail"),
  };

  // State
  const state = {
    session: {
      token: JSON.parse(localStorage.getItem("tk_token") || "null"),
      user: JSON.parse(localStorage.getItem("tk_user") || "null"),
    },
    ui: {
      // threadKey format: "global" | `dm:${peerId}` | `group:${groupId}`
      activeThread: "global",
      sendingLock: false,
      lastClientId: null,
      cooldown: { until: 0, durationMs: 0 },
      context: { open: false, threadKey: null, msgId: null },
      onlineUsers: [],
      settings: {
        cursor: { enabled: true, size: 1.35, dynamic: true },
        sound: { enabled: true, volume: 0.35 },
      },
      firstJoinShown: !!JSON.parse(localStorage.getItem("tk_firstJoinShown") || "false"),
    },
    data: {
      me: null,
      threads: {
        // threadKey -> { kind, id, name, messages:[], cursor, hasMore }
      },
      friends: [],
      groups: [],
    },
    socket: null,
  };

  // Settings load/save
  try {
    const s = JSON.parse(localStorage.getItem("tk_settings") || "null");
    if (s && typeof s === "object") state.ui.settings = { ...state.ui.settings, ...s };
  } catch {}

  function saveSettings() {
    localStorage.setItem("tk_settings", JSON.stringify(state.ui.settings));
  }

  // API
  async function api(path, { method="GET", body=null } = {}) {
    const headers = { "Content-Type":"application/json" };
    if (state.session.token) headers.Authorization = `Bearer ${state.session.token}`;
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : null });
    const ct = res.headers.get("content-type") || "";
    const isJson = ct.includes("application/json");
    const data = isJson ? await res.json().catch(()=>({})) : await res.text().catch(()=>(""));
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // Loading overlay
  function showLoading(msg="Loading…", tag="boot"){
    if (dom.loadMsg) dom.loadMsg.textContent = msg;
    if (dom.loadTag) dom.loadTag.textContent = tag;
    dom.loading?.classList.add("show");
  }
  function hideLoading(){ dom.loading?.classList.remove("show"); }

  // Modal (single close button)
  function closeModal(){
    dom.backdrop?.classList.remove("show");
    if (dom.modalTitle) dom.modalTitle.textContent = "";
    if (dom.modalBody) dom.modalBody.innerHTML = "";
    if (dom.modalFoot) dom.modalFoot.innerHTML = "";
  }
  function openModal(title, bodyHtml, buttons=[]){
    if (dom.modalTitle) dom.modalTitle.textContent = title;
    if (dom.modalBody) dom.modalBody.innerHTML = bodyHtml;
    if (dom.modalFoot) dom.modalFoot.innerHTML = "";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.className = `btn ${b.kind || ""}`.trim();
      btn.textContent = b.label;
      btn.onclick = () => b.onClick?.();
      dom.modalFoot.appendChild(btn);
    }
    dom.backdrop?.classList.add("show");
  }
  dom.modalClose?.addEventListener("click", closeModal);
  dom.backdrop?.addEventListener("click", (e)=>{ if (e.target === dom.backdrop) closeModal(); });

  // Toasts (simple)
  const toast = (() => {
    let wrap = null;
    function ensure(){
      if (wrap) return wrap;
      wrap = document.createElement("div");
      wrap.style.position="fixed";
      wrap.style.right="14px";
      wrap.style.bottom="14px";
      wrap.style.display="flex";
      wrap.style.flexDirection="column";
      wrap.style.gap="10px";
      wrap.style.zIndex="9998";
      document.body.appendChild(wrap);
      return wrap;
    }
    function show(msg, kind="info", ttl=2200){
      ensure();
      const el = document.createElement("div");
      el.className = "toast";
      el.style.padding="10px 12px";
      el.style.borderRadius="14px";
      el.style.border="1px solid rgba(130,140,170,.22)";
      el.style.background="rgba(10,12,16,.92)";
      el.style.color="rgba(235,240,255,.92)";
      el.style.maxWidth="320px";
      el.style.boxShadow="0 10px 30px rgba(0,0,0,.45)";
      if (kind==="err") el.style.borderColor="rgba(255,92,122,.35)";
      if (kind==="ok") el.style.borderColor="rgba(120,255,190,.25)";
      if (kind==="warn") el.style.borderColor="rgba(255,210,120,.25)";
      el.innerHTML = `<div>${esc(msg)}</div>`;
      wrap.appendChild(el);

      const kill = () => { el.style.opacity="0"; el.style.transform="translateY(8px)"; setTimeout(()=>el.remove(), 180); };
      el.style.transition="all 180ms ease";
      el.style.opacity="0";
      el.style.transform="translateY(8px)";
      requestAnimationFrame(()=>{ el.style.opacity="1"; el.style.transform="translateY(0)"; });

      const id = setTimeout(kill, ttl);
      el.onclick = () => { clearTimeout(id); kill(); };
    }
    return { show };
  })();

  // Cursor (force-hide native cursor everywhere)
  function applyCursorMode(){
    const enabled = !!state.ui.settings.cursor.enabled;
    if (enabled) {
      document.documentElement.style.cursor = "none";
      document.body.style.cursor = "none";
      if (!document.getElementById("__cursor_force")) {
        const st = document.createElement("style");
        st.id="__cursor_force";
        st.textContent = `html, html * { cursor: none !important; } #cursor,#trail{pointer-events:none!important;}`;
        document.head.appendChild(st);
      }
      dom.cursor.style.display="block";
      dom.trail.style.display="block";
    } else {
      document.documentElement.style.cursor = "";
      document.body.style.cursor = "";
      dom.cursor.style.display="none";
      dom.trail.style.display="none";
    }
  }
  applyCursorMode();

  // Cursor dynamics
  const cur = { x:innerWidth/2, y:innerHeight/2, tx:innerWidth/2, ty:innerHeight/2, vx:0, vy:0, over:false, down:false, last:now() };
  addEventListener("mousemove",(e)=>{ cur.tx=e.clientX; cur.ty=e.clientY; cur.last=now(); });
  addEventListener("mousedown",()=>cur.down=true);
  addEventListener("mouseup",()=>cur.down=false);
  addEventListener("mouseover",(e)=>{
    const t=e.target;
    cur.over = !!(t && (t.closest("button")||t.closest("a")||t.closest("input")||t.closest("textarea")||t.closest("[role='button']")||t.closest(".thread")||t.closest(".msg")));
  }, true);

  function cursorTick(){
    if (!state.ui.settings.cursor.enabled) return requestAnimationFrame(cursorTick);
    const dynamic = !!state.ui.settings.cursor.dynamic;
    const base = Math.max(0.9, Math.min(2.0, state.ui.settings.cursor.size || 1.35));

    const dx = cur.tx - cur.x, dy = cur.ty - cur.y;
    cur.vx = (cur.vx + dx * 0.18) * 0.62;
    cur.vy = (cur.vy + dy * 0.18) * 0.62;
    cur.x += cur.vx; cur.y += cur.vy;

    let scale = base;
    if (dynamic){
      if (cur.over) scale *= 1.26;
      if (cur.down) scale *= 0.82;
      const idle = Math.min(1, (now()-cur.last)/2200);
      scale *= (1 + idle*0.09*Math.sin(now()/340));
    }

    dom.cursor.style.transform = `translate(${cur.x}px,${cur.y}px) translate(-50%,-50%) scale(${scale})`;

    // visible trail like before
    const tx = cur.x - cur.vx*2.2, ty = cur.y - cur.vy*2.2;
    const speed = Math.min(1, Math.hypot(cur.vx,cur.vy)/26);
    dom.trail.style.transform = `translate(${tx}px,${ty}px) translate(-50%,-50%)`;
    dom.trail.style.opacity = String(0.16 + speed*0.55);

    requestAnimationFrame(cursorTick);
  }
  requestAnimationFrame(cursorTick);

  // Cooldown UI
  function setCooldown(untilTs, durationMs=0){
    state.ui.cooldown.until = untilTs || 0;
    if (durationMs) state.ui.cooldown.durationMs = durationMs;
  }
  function flashCooldownViolation(){
    dom.composer?.classList.remove("cd-red","cd-shake");
    void dom.composer?.offsetWidth;
    dom.composer?.classList.add("cd-red","cd-shake");
    setTimeout(()=>dom.composer?.classList.remove("cd-red"), 520);
    setTimeout(()=>dom.composer?.classList.remove("cd-shake"), 620);
  }
  function updateCooldownUi(){
    const until = state.ui.cooldown.until || 0;
    const active = until && now() < until;
    if (!active){
      dom.cooldownText.textContent = "";
      dom.cooldownBar.style.width="0%";
      dom.cooldownBar.style.opacity="0";
      return;
    }
    const left = until - now();
    dom.cooldownText.textContent = `cooldown: ${Math.ceil(left/1000)}s`;

    const dur = state.ui.cooldown.durationMs || 5000;
    const start = until - dur;
    const pct = Math.max(0, Math.min(100, ((now()-start)/dur)*100));
    dom.cooldownBar.style.opacity="1";
    dom.cooldownBar.style.width = `${pct}%`;
  }
  setInterval(updateCooldownUi, 120);

  // Login screen
  function setLoginMsg(msg, err=false){
    dom.loginMsg.textContent = msg;
    dom.loginMsg.style.color = err ? "rgba(255,92,122,.95)" : "";
  }
  function showLogin(){
    dom.app.style.display="none";
    dom.loginWrap.style.display="flex";
    hideLoading();
    applyCursorMode();

    if (!state.ui.firstJoinShown) {
      state.ui.firstJoinShown = true;
      localStorage.setItem("tk_firstJoinShown","true");
      openModal(
        "Welcome to tonkotsu.online (beta)",
        `<div style="color:rgba(154,163,183,.85);font-size:13px;line-height:1.5">
          This is a beta build. Features may change and bugs can happen.<br><br>
          You have early access. If the server assigns it, you’ll see an <b>Early Access</b> badge.
        </div>`,
        []
      );
    }
  }
  function showApp(){
    dom.loginWrap.style.display="none";
    dom.app.style.display="flex";
    applyCursorMode();
  }

  async function doLogin(username, password){
    setLoginMsg("Signing in…");
    try{
      const r = await api("/api/auth/login", { method:"POST", body:{ username, password } });
      if (!r?.ok || !r.token) throw new Error(r?.error || "Login failed");
      state.session.token = r.token;
      state.session.user = r.user;
      localStorage.setItem("tk_token", JSON.stringify(r.token));
      localStorage.setItem("tk_user", JSON.stringify(r.user));
      await afterAuth();
    }catch(e){
      setLoginMsg(e.message || "Login failed", true);
      toast.show("Sign-in failed.", "err");
    }
  }
  async function doGuest(){
    setLoginMsg("Starting guest…");
    try{
      const r = await api("/api/auth/guest", { method:"POST", body:{} });
      if (!r?.ok || !r.token) throw new Error(r?.error || "Guest failed");
      state.session.token = r.token;
      state.session.user = r.user;
      localStorage.setItem("tk_token", JSON.stringify(r.token));
      localStorage.setItem("tk_user", JSON.stringify(r.user));
      await afterAuth();
    }catch(e){
      setLoginMsg(e.message || "Guest failed", true);
      toast.show("Guest sign-in failed.", "err");
    }
  }
  async function doLogout(){
    try{ await api("/api/auth/logout",{method:"POST"}).catch(()=>{}); } finally {
      try{ state.socket?.removeAllListeners?.(); state.socket?.disconnect?.(); }catch{}
      state.socket=null;
      state.session.token=null;
      state.session.user=null;
      localStorage.setItem("tk_token","null");
      localStorage.setItem("tk_user","null");
      showLogin();
    }
  }

  dom.btnLogin.addEventListener("click",()=>doLogin(dom.loginUser.value.trim(), dom.loginPass.value));
  dom.btnGuest.addEventListener("click",()=>doGuest());
  dom.loginPass.addEventListener("keydown",(e)=>{ if(e.key==="Enter") dom.btnLogin.click(); });
  dom.btnLogout.addEventListener("click", doLogout);

  // Threads
  function ensureThread(threadKey, meta){
    if (!state.data.threads[threadKey]) {
      state.data.threads[threadKey] = { ...meta, messages:[], cursor:null, hasMore:true };
    }
    return state.data.threads[threadKey];
  }

  function formatThreadName(t){
    if (t.kind==="global") return "Global";
    if (t.kind==="dm") return `@${t.name}`;
    if (t.kind==="group") return `#${t.name}`;
    return t.name || "Thread";
  }

  function lastMsgPreview(thread){
    const m = thread.messages?.[thread.messages.length-1];
    return m ? safe(m.text).slice(0,80) : "No messages yet.";
  }

  function renderThreadList(){
    const q = dom.searchThreads.value.trim().toLowerCase();
    const keys = Object.keys(state.data.threads);

    // stable order: global first, then dms, then groups
    const sorted = keys.sort((a,b)=>{
      const A=state.data.threads[a], B=state.data.threads[b];
      const pr = (t)=> t.kind==="global"?0 : t.kind==="dm"?1 : 2;
      const pa = pr(A)-pr(B); if (pa) return pa;
      return formatThreadName(A).localeCompare(formatThreadName(B));
    });

    const frag = document.createDocumentFragment();
    for (const k of sorted){
      const t = state.data.threads[k];
      const name = formatThreadName(t);
      if (q && !name.toLowerCase().includes(q)) continue;

      const el = document.createElement("div");
      el.className = "thread" + (state.ui.activeThread===k ? " active":"");
      el.innerHTML = `
        <div class="threadTop">
          <div class="threadName">${esc(name)}</div>
          <div class="threadMeta">${t.kind}</div>
        </div>
        <div class="threadLast">${esc(lastMsgPreview(t))}</div>
      `;
      el.addEventListener("click", async ()=>{
        state.ui.activeThread = k;
        renderThreadList();
        await refreshActiveThread();
      });
      frag.appendChild(el);
    }
    dom.threadList.innerHTML="";
    dom.threadList.appendChild(frag);
  }

  function setCenterHeaderFromThread(threadKey){
    const t = state.data.threads[threadKey];
    if (!t) return;
    dom.centerH.textContent = formatThreadName(t);
    dom.centerS.textContent = t.kind==="global" ? "" : (t.kind==="dm" ? "Direct message" : "Group chat");
  }

  function renderMessages(threadKey){
    const t = state.data.threads[threadKey];
    if (!t) return;

    setCenterHeaderFromThread(threadKey);
    dom.centerBody.innerHTML="";

    if (!t.messages.length){
      dom.centerBody.innerHTML = `<div class="msg"><div class="msgBody">No messages. Send the first message.</div></div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    for (const m of t.messages){
      const el = document.createElement("div");
      el.className = "msg";
      el.dataset.id = m.id;

      const uname = esc(m.user?.username || "user");
      const ts = new Date(m.ts || now());
      const time = `${String(ts.getHours()).padStart(2,"0")}:${String(ts.getMinutes()).padStart(2,"0")}`;

      const chips = [];
      if (m.kind==="announcement") chips.push(`<span class="chip ann">ANNOUNCEMENT</span>`);
      if (m.pending) chips.push(`<span class="chip">sending</span>`);
      if (m.failed) chips.push(`<span class="chip err">failed</span>`);
      if (m.editedAt) chips.push(`<span class="chip">edited</span>`);

      el.innerHTML = `
        <div class="msgTop">
          <div class="msgUser">${uname}</div>
          <div class="msgTime">${esc(time)}</div>
        </div>
        <div class="msgBody">${esc(m.text)}</div>
        <div class="chips">${chips.join("")}</div>
      `;

      // Right-click context menu works on messages
      el.addEventListener("contextmenu",(e)=>{
        e.preventDefault();
        openMessageContextMenu(e.clientX, e.clientY, threadKey, m);
      });

      // Clicking message opens user profile
      el.addEventListener("click", ()=>{
        openProfile(m.user);
      });

      frag.appendChild(el);
    }
    dom.centerBody.appendChild(frag);
    dom.centerBody.scrollTop = dom.centerBody.scrollHeight;
  }

  // Context menu
  function closeCtx(){
    state.ui.context.open=false;
    dom.ctx.classList.remove("show");
    dom.ctx.innerHTML="";
  }
  document.addEventListener("click", ()=>state.ui.context.open && closeCtx());
  window.addEventListener("resize", ()=>state.ui.context.open && closeCtx());

  function openMessageContextMenu(x,y,threadKey,m){
    closeCtx();
    const mine = (m.user?.id && state.session.user?.id && m.user.id===state.session.user.id)
      || (m.user?.username && state.session.user?.username && m.user.username===state.session.user.username);

    const age = now() - (m.ts || 0);
    const canEdit = mine && age <= 60_000;
    const items = [];

    if (canEdit) {
      items.push({ label:"Edit (1 min)", onClick: ()=>{ closeCtx(); promptEdit(threadKey,m); }});
      items.push({ label:"Delete (1 min)", danger:true, onClick: ()=>{ closeCtx(); promptDelete(threadKey,m); }});
    }
    items.push({ label:"Report", danger:true, onClick: ()=>{ closeCtx(); promptReport(threadKey,m); }});

    dom.ctx.innerHTML = items.map((it,i)=>`
      <div class="item ${it.danger?"danger":""}" data-i="${i}">
        <span>${esc(it.label)}</span>
        <span style="opacity:.7">${it.danger?"!":""}</span>
      </div>
    `).join("");

    $$(".item", dom.ctx).forEach(node=>{
      const i = Number(node.dataset.i);
      node.addEventListener("click", ()=>items[i].onClick());
    });

    const vw=innerWidth, vh=innerHeight;
    const w=220, h=items.length*44;
    const px=Math.max(10, Math.min(vw-w-10, x));
    const py=Math.max(10, Math.min(vh-h-10, y));
    dom.ctx.style.left = px+"px";
    dom.ctx.style.top = py+"px";
    dom.ctx.classList.add("show");
    state.ui.context.open=true;
    state.ui.context.threadKey=threadKey;
    state.ui.context.msgId=m.id;
  }

  function promptEdit(threadKey,m){
    openModal(
      "Edit message",
      `<div style="color:rgba(154,163,183,.85);font-size:13px;margin-bottom:10px">Edits allowed within 1 minute.</div>
       <textarea id="editText" class="input" rows="4">${esc(m.text||"")}</textarea>`,
      [
        { label:"Cancel", onClick: closeModal },
        { label:"Save", kind:"primary", onClick: async ()=>{
          const text = $("#editText").value.trim();
          if (!text) return;
          await editMessage(threadKey, m.id, text);
          closeModal();
        }}
      ]
    );
  }

  function promptDelete(threadKey,m){
    openModal(
      "Delete message",
      `<div style="color:rgba(154,163,183,.85);font-size:13px">Delete this message? (1 minute window)</div>`,
      [
        { label:"Cancel", onClick: closeModal },
        { label:"Delete", kind:"danger", onClick: async ()=>{
          await deleteMessage(threadKey, m.id);
          closeModal();
        }}
      ]
    );
  }

  function promptReport(threadKey,m){
    openModal(
      "Report message",
      `<div style="color:rgba(154,163,183,.85);font-size:13px;margin-bottom:10px">
        This sends a report to the moderation bot.
       </div>
       <input id="reportReason" class="input" placeholder="Reason (optional)" />`,
      [
        { label:"Cancel", onClick: closeModal },
        { label:"Report", kind:"danger", onClick: async ()=>{
          const reason = $("#reportReason").value.trim();
          await reportMessage(threadKey, m.id, reason);
          closeModal();
        }}
      ]
    );
  }

  // Profile
  function openProfile(user){
    if (!user) return;
    const created = user.createdAt ? new Date(user.createdAt).toLocaleString() : "—";
    const lastSeen = user.lastSeen ? new Date(user.lastSeen).toLocaleString() : "—";
    const bio = user.bio ? esc(user.bio) : `<span style="color:rgba(154,163,183,.75)">No bio.</span>`;
    openModal(
      user.username || "Profile",
      `<div style="display:flex;flex-direction:column;gap:10px">
        <div><b>Bio</b><div style="margin-top:6px;color:rgba(235,240,255,.9)">${bio}</div></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div><b>Created</b><div style="color:rgba(154,163,183,.85);margin-top:6px">${esc(created)}</div></div>
          <div><b>Last seen</b><div style="color:rgba(154,163,183,.85);margin-top:6px">${esc(lastSeen)}</div></div>
        </div>
      </div>`,
      []
    );
  }
  dom.btnUser.addEventListener("click", ()=>openProfile(state.session.user));

  // Messaging actions
  function activeThreadInfo(){
    const key = state.ui.activeThread;
    if (key==="global") return { kind:"global", id:null };
    if (key.startsWith("dm:")) return { kind:"dm", id:key.slice(3) };
    if (key.startsWith("group:")) return { kind:"group", id:key.slice(6) };
    return { kind:"global", id:null };
  }

  function inCooldown(){
    return state.ui.cooldown.until && now() < state.ui.cooldown.until;
  }

  async function sendMessage(){
    const text = dom.msgInput.value.trim();
    if (!text) return;

    if (inCooldown()){
      flashCooldownViolation();
      toast.show("Cooldown active.", "warn", 1200);
      return;
    }

    if (state.ui.sendingLock) return;
    state.ui.sendingLock = true;

    const { kind, id } = activeThreadInfo();
    const clientId = uid("c");
    state.ui.lastClientId = clientId;

    // optimistic message
    const localId = uid("m");
    const t = state.data.threads[state.ui.activeThread];
    t.messages.push({
      id: localId,
      ts: now(),
      text,
      user: state.session.user,
      pending: true,
    });
    dom.msgInput.value="";
    renderMessages(state.ui.activeThread);

    // retry on transient failures
    const attempt = async (n) => {
      try{
