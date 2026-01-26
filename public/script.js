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
        const scope =
          kind === "global" ? "global" :
          kind === "dm" ? "dm" :
          kind === "group" ? "group" : "global";

        const targetId =
          kind === "dm" ? id :
          kind === "group" ? id : null;

        const resp = await api("/api/messages/send", {
          method: "POST",
          body: { scope, targetId, text, clientId }
        });

        // server can return cooldown info
        if (resp?.cooldownUntil) {
          setCooldown(resp.cooldownUntil, resp.cooldownMs || 0);
        }

        if (resp?.ok && resp.message) {
          // replace local optimistic message
          const msgs = t.messages;
          const idx = msgs.findIndex(x => x.id === localId);
          if (idx >= 0) msgs[idx] = resp.message;
          renderMessages(state.ui.activeThread);
          state.ui.sendingLock = false;
          return true;
        }

        throw new Error(resp?.error || "Send failed");
      }catch(e){
        const status = e?.status || 0;
        const transient = status === 0 || status === 502 || status === 503 || status === 504;
        if (transient && n < 2){
          await sleep(250 * (n + 1));
          return attempt(n + 1);
        }

        // mark message failed
        const msgs = t.messages;
        const idx = msgs.findIndex(x => x.id === localId);
        if (idx >= 0){
          msgs[idx].pending = false;
          msgs[idx].failed = true;
          msgs[idx].error = e.message || "Send failed";
        }
        renderMessages(state.ui.activeThread);
        toast.show("Message failed to send.", "err", 1800);
        state.ui.sendingLock = false;
        return false;
      }
    };

    await attempt(0);
  }

  dom.btnSend.addEventListener("click", () => sendMessage());
  dom.msgInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Edit/Delete/Report actions
  async function editMessage(threadKey, messageId, newText){
    const info = threadKey === "global"
      ? { scope:"global", targetId:null }
      : threadKey.startsWith("dm:")
        ? { scope:"dm", targetId: threadKey.slice(3) }
        : threadKey.startsWith("group:")
          ? { scope:"group", targetId: threadKey.slice(6) }
          : { scope:"global", targetId:null };

    const resp = await api("/api/messages/edit", {
      method:"POST",
      body:{ messageId, text: newText, scope: info.scope, targetId: info.targetId }
    });

    if (resp?.ok && resp.message){
      const t = state.data.threads[threadKey];
      if (t){
        const idx = t.messages.findIndex(x => x.id === resp.message.id);
        if (idx >= 0) t.messages[idx] = resp.message;
        renderMessages(threadKey);
        toast.show("Edited.", "ok", 1200);
      }
      return;
    }
    throw new Error(resp?.error || "Edit failed");
  }

  async function deleteMessage(threadKey, messageId){
    const info = threadKey === "global"
      ? { scope:"global", targetId:null }
      : threadKey.startsWith("dm:")
        ? { scope:"dm", targetId: threadKey.slice(3) }
        : threadKey.startsWith("group:")
          ? { scope:"group", targetId: threadKey.slice(6) }
          : { scope:"global", targetId:null };

    const resp = await api("/api/messages/delete", {
      method:"POST",
      body:{ messageId, scope: info.scope, targetId: info.targetId }
    });

    if (resp?.ok){
      const t = state.data.threads[threadKey];
      if (t){
        const idx = t.messages.findIndex(x => x.id === messageId);
        if (idx >= 0) t.messages.splice(idx, 1);
        renderMessages(threadKey);
        toast.show("Deleted.", "ok", 1200);
      }
      return;
    }
    throw new Error(resp?.error || "Delete failed");
  }

  async function reportMessage(threadKey, messageId, reason){
    const info = threadKey === "global"
      ? { scope:"global", targetId:null }
      : threadKey.startsWith("dm:")
        ? { scope:"dm", targetId: threadKey.slice(3) }
        : threadKey.startsWith("group:")
          ? { scope:"group", targetId: threadKey.slice(6) }
          : { scope:"global", targetId:null };

    const resp = await api("/api/messages/report", {
      method:"POST",
      body:{ messageId, reason: reason || "", scope: info.scope, targetId: info.targetId }
    });

    if (resp?.ok){
      toast.show("Reported to moderation.", "ok", 1400);
      return;
    }
    throw new Error(resp?.error || "Report failed");
  }

  // Online users right panel (small + not repeated)
  function renderOnlineUsers(){
    if (!dom.rightBody) return;

    const users = Array.isArray(state.ui.onlineUsers) ? state.ui.onlineUsers : [];
    const rows = users.slice(0, 50).map(u => {
      const mode = u.mode || "online";
      const cls = mode === "idle" ? "idle" : mode === "dnd" ? "dnd" : mode === "invisible" ? "inv" : "on";
      return `
        <div class="ou">
          <span class="pDot ${cls}"></span>
          <span class="ouName">${esc(u.username || "user")}</span>
        </div>
      `;
    }).join("");

    dom.rightBody.innerHTML = `
      <div class="onlineHead">
        <div class="onlineTitle">Online users</div>
        <div class="onlineCount">${users.length}</div>
      </div>
      <div class="onlineList">
        ${rows || `<div class="small" style="color:rgba(154,163,183,.85)">No users online.</div>`}
      </div>
    `;
  }

  // Presence buttons (optional)
  function bindPresenceButtons(){
    const set = (m)=>setPresence(m);
    dom.btnPresenceOnline?.addEventListener("click", ()=>set("online"));
    dom.btnPresenceIdle?.addEventListener("click", ()=>set("idle"));
    dom.btnPresenceDnd?.addEventListener("click", ()=>set("dnd"));
    dom.btnPresenceInv?.addEventListener("click", ()=>set("invisible"));
  }
  bindPresenceButtons();

  // Settings modal (basic; restores “nothing works” complaint)
  function openSettings(){
    const cur = state.ui.settings.cursor;
    const snd = state.ui.settings.sound;

    openModal(
      "Settings",
      `
        <div class="setRow">
          <div class="setLeft">
            <div class="setT">Custom cursor</div>
            <div class="setD">Hide native cursor, show circle + trail.</div>
          </div>
          <label class="switch">
            <input id="setCursorOn" type="checkbox" ${cur.enabled ? "checked" : ""}>
            <span class="slider"></span>
          </label>
        </div>

        <div class="setRow">
          <div class="setLeft">
            <div class="setT">Cursor size</div>
            <div class="setD">Bigger feels better on dark UI.</div>
          </div>
          <input id="setCursorSize" class="range" type="range" min="0.9" max="2" step="0.05" value="${cur.size}">
        </div>

        <div class="setRow">
          <div class="setLeft">
            <div class="setT">Dynamic cursor</div>
            <div class="setD">React to hover/click and idle pulse.</div>
          </div>
          <label class="switch">
            <input id="setCursorDyn" type="checkbox" ${cur.dynamic ? "checked" : ""}>
            <span class="slider"></span>
          </label>
        </div>

        <div class="setRow">
          <div class="setLeft">
            <div class="setT">Sound</div>
            <div class="setD">Toasts only if sound is off.</div>
          </div>
          <label class="switch">
            <input id="setSoundOn" type="checkbox" ${snd.enabled ? "checked" : ""}>
            <span class="slider"></span>
          </label>
        </div>

        <div class="setRow">
          <div class="setLeft">
            <div class="setT">Sound volume</div>
            <div class="setD">Only applies if sound is enabled.</div>
          </div>
          <input id="setSoundVol" class="range" type="range" min="0" max="1" step="0.05" value="${snd.volume}">
        </div>
      `,
      [
        { label:"Close", onClick: closeModal },
        {
          label:"Save",
          kind:"primary",
          onClick: ()=>{
            const on = $("#setCursorOn")?.checked;
            const size = Number($("#setCursorSize")?.value || 1.35);
            const dyn = $("#setCursorDyn")?.checked;

            const sndOn = $("#setSoundOn")?.checked;
            const sndVol = Number($("#setSoundVol")?.value || 0.35);

            state.ui.settings.cursor.enabled = !!on;
            state.ui.settings.cursor.size = size;
            state.ui.settings.cursor.dynamic = !!dyn;
            state.ui.settings.sound.enabled = !!sndOn;
            state.ui.settings.sound.volume = Math.max(0, Math.min(1, sndVol));

            saveSettings();
            applyCursorMode();
            closeModal();
            toast.show("Saved settings.", "ok", 1200);
          }
        }
      ]
    );
  }

  dom.btnSettings?.addEventListener("click", openSettings);

  // Friend add / Group create (hooks that must exist in index + server)
  async function addFriend(username){
    const u = safe(username).trim();
    if (!u) return;
    const resp = await api("/api/friends/request", { method:"POST", body:{ username: u } });
    if (resp?.ok){
      toast.show("Friend request sent.", "ok", 1500);
      await bootstrap();
      renderThreadList();
      return;
    }
    throw new Error(resp?.error || "Friend request failed");
  }

  async function createGroup(name){
    const n = safe(name).trim();
    if (!n) return;
    const resp = await api("/api/groups/create", { method:"POST", body:{ name: n, limit: 25, cooldownSeconds: 2 } });
    if (resp?.ok && resp.group?.id){
      toast.show("Group created.", "ok", 1500);
      await bootstrap();
      // auto-open it
      const key = `group:${resp.group.id}`;
      state.ui.activeThread = key;
      renderThreadList();
      await refreshActiveThread();
      return;
    }
    throw new Error(resp?.error || "Group create failed");
  }

  dom.btnAddFriend?.addEventListener("click", ()=>{
    openModal(
      "Add friend",
      `<input id="friendUser" class="input" placeholder="username" />`,
      [
        { label:"Cancel", onClick: closeModal },
        { label:"Request", kind:"primary", onClick: async ()=>{
          const u = $("#friendUser")?.value || "";
          try { await addFriend(u); closeModal(); } catch(e){ toast.show(e.message || "Failed", "err"); }
        }}
      ]
    );
  });

  dom.btnNewGroup?.addEventListener("click", ()=>{
    openModal(
      "Create group chat",
      `<input id="groupName" class="input" placeholder="Group name" />`,
      [
        { label:"Cancel", onClick: closeModal },
        { label:"Create", kind:"primary", onClick: async ()=>{
          const g = $("#groupName")?.value || "";
          try { await createGroup(g); closeModal(); } catch(e){ toast.show(e.message || "Failed", "err"); }
        }}
      ]
    );
  });

  // Refresh active thread (no “jump” / “refresh” buttons in UI required)
  async function refreshActiveThread(){
    const key = state.ui.activeThread;
    const t = state.data.threads[key];
    if (!t) return;

    showLoading("Syncing…", "thread");

    try{
      if (key === "global"){
        const r = await api(`/api/messages/global?limit=80`, { method:"GET" });
        if (r?.ok){
          t.messages = Array.isArray(r.messages) ? r.messages : [];
          t.cursor = r.cursor ?? null;
          t.hasMore = r.hasMore ?? true;
        }
      } else if (key.startsWith("dm:")){
        const peerId = key.slice(3);
        const r = await api(`/api/messages/dm/${encodeURIComponent(peerId)}?limit=80`, { method:"GET" });
        if (r?.ok){
          t.messages = Array.isArray(r.messages) ? r.messages : [];
          t.cursor = r.cursor ?? null;
          t.hasMore = r.hasMore ?? true;
          if (r.peer) t.name = r.peer.username || t.name;
        }
      } else if (key.startsWith("group:")){
        const gid = key.slice(6);
        const r = await api(`/api/messages/group/${encodeURIComponent(gid)}?limit=90`, { method:"GET" });
        if (r?.ok){
          t.messages = Array.isArray(r.messages) ? r.messages : [];
          t.cursor = r.cursor ?? null;
          t.hasMore = r.hasMore ?? true;
          if (r.group) t.name = r.group.name || t.name;
        }
      }

      renderMessages(key);
      renderThreadList();
    }catch(e){
      toast.show(e.message || "Failed to refresh thread.", "err", 2000);
    } finally {
      hideLoading();
    }
  }

  // Bootstrap state into thread sidebar
  async function bootstrap(){
    showLoading("Loading…", "state");
    const data = await api("/api/state/bootstrap", { method:"GET" });

    // hard enforce black background if CSS didn’t apply (fix blue bg)
    document.documentElement.style.background = "#05060a";
    document.body.style.background = "#05060a";

    // ensure global exists
    const global = ensureThread("global", { kind:"global", id:null, name:"Global" });
    global.messages = Array.isArray(data.global?.messages) ? data.global.messages : global.messages;

    // friends + dm threads
    state.data.friends = Array.isArray(data.friends) ? data.friends : [];
    for (const f of state.data.friends){
      if (!f?.id) continue;
      const key = `dm:${f.id}`;
      const th = ensureThread(key, { kind:"dm", id:f.id, name: f.username || "User" });
      // server may include threads in bootstrap; accept if present
      if (Array.isArray(f.messages)) th.messages = f.messages;
    }

    // group list + group threads
    state.data.groups = Array.isArray(data.groups) ? data.groups : [];
    for (const g of state.data.groups){
      if (!g?.id) continue;
      const key = `group:${g.id}`;
      const th = ensureThread(key, { kind:"group", id:g.id, name: g.name || "Group" });
      if (Array.isArray(g.messages)) th.messages = g.messages;
    }

    // keep active thread valid
    if (!state.data.threads[state.ui.activeThread]) {
      state.ui.activeThread = "global";
    }

    // online
    state.ui.onlineUsers = Array.isArray(data.onlineUsers) ? data.onlineUsers : [];

    hideLoading();
    renderTop();
    renderThreadList();
    renderMessages(state.ui.activeThread);
    renderOnlineUsers();
  }

  // Socket wiring (must be supported server-side)
  async function initSocket(){
    if (!window.io || !state.session.token) return;

    try { state.socket?.removeAllListeners?.(); state.socket?.disconnect?.(); } catch {}
    state.socket = null;

    const sock = io({ transports:["websocket","polling"], auth:{ token: state.session.token } });
    state.socket = sock;

    sock.on("connect", ()=>{
      sock.emit("auth", { token: state.session.token });
      sock.emit("presence:set", { mode: state.settings?.presenceMode || "online" });
    });

    // IMPORTANT: server should dedupe multiple tabs by userId, not per socket
    sock.on("users:online", (p)=>{
      // Expect: { users:[{id,username,mode}], count }
      const users = Array.isArray(p?.users) ? p.users : [];
      state.ui.onlineUsers = users;
      renderOnlineUsers();
    });

    sock.on("presence:update", (p)=>{
      // optional { me:{mode} }
      if (p?.me?.mode) setPresenceUi(p.me.mode);
    });

    // Message events: dedupe by id + also ignore echoed optimistic clientId if server returns it
    sock.on("message:new", (m)=>{
      if (!m || !m.id) return;

      const key =
        m.scope === "global" ? "global" :
        m.scope === "dm" ? `dm:${m.targetId || m.peerId || ""}` :
        m.scope === "group" ? `group:${m.targetId || m.groupId || ""}` : "global";

      const th = state.data.threads[key];
      if (!th) return;

      // prevent duplicates
      if (th.messages.some(x => x.id === m.id)) return;

      th.messages.push(m);
      th.messages.sort((a,b)=>(a.ts||0)-(b.ts||0));

      if (state.ui.activeThread === key) renderMessages(key);
      renderThreadList();
    });

    sock.on("message:edit", (m)=>{
      if (!m || !m.id) return;
      const key =
        m.scope === "global" ? "global" :
        m.scope === "dm" ? `dm:${m.targetId || m.peerId || ""}` :
        m.scope === "group" ? `group:${m.targetId || m.groupId || ""}` : null;
      if (!key) return;
      const th = state.data.threads[key];
      if (!th) return;
      const idx = th.messages.findIndex(x => x.id === m.id);
      if (idx >= 0) th.messages[idx] = { ...th.messages[idx], ...m };
      if (state.ui.activeThread === key) renderMessages(key);
    });

    sock.on("message:delete", (p)=>{
      const messageId = p?.messageId;
      if (!messageId) return;
      const key =
        p.scope === "global" ? "global" :
        p.scope === "dm" ? `dm:${p.targetId || ""}` :
        p.scope === "group" ? `group:${p.targetId || ""}` : null;
      if (!key) return;
      const th = state.data.threads[key];
      if (!th) return;
      const idx = th.messages.findIndex(x => x.id === messageId);
      if (idx >= 0) th.messages.splice(idx, 1);
      if (state.ui.activeThread === key) renderMessages(key);
      renderThreadList();
    });

    sock.on("connect_error", (e)=>{
      console.warn("socket error:", e?.message);
    });
  }

  // Auth boot
  async function afterAuth(){
    showApp();
    showLoading("Preparing…", "boot");
    renderTop();
    try{
      await bootstrap();
      await initSocket();
      toast.show("Connected.", "ok", 1200);
    }catch(e){
      toast.show(e.message || "Failed to boot.", "err", 2200);
      showLogin();
    } finally {
      hideLoading();
    }
  }

  // Search threads live
  dom.searchThreads?.addEventListener("input", ()=>renderThreadList());

  // Presence badge click opens small menu (optional)
  dom.presencePill?.addEventListener("click", ()=>{
    openModal(
      "Presence",
      `<div class="small">Choose how you appear.</div>
       <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn" id="pOn">Online</button>
        <button class="btn" id="pIdle">Idle</button>
        <button class="btn" id="pDnd">DND</button>
        <button class="btn" id="pInv">Invisible</button>
       </div>`,
      []
    );
    $("#pOn")?.addEventListener("click", ()=>{ setPresence("online"); closeModal(); });
    $("#pIdle")?.addEventListener("click", ()=>{ setPresence("idle"); closeModal(); });
    $("#pDnd")?.addEventListener("click", ()=>{ setPresence("dnd"); closeModal(); });
    $("#pInv")?.addEventListener("click", ()=>{ setPresence("invisible"); closeModal(); });
  });

  // Hard disable “jump/refresh” if they exist (you asked to remove them)
  dom.btnJumpLastRead && (dom.btnJumpLastRead.style.display = "none");
  dom.btnRefresh && (dom.btnRefresh.style.display = "none");

  // App start
  (async ()=>{
    applyCursorMode();
    renderTop();

    if (state.session.token) {
      // attempt restore
      try{
        showApp();
        showLoading("Restoring…", "resume");
        const me = await api("/api/users/me", { method:"GET" });
        if (me?.ok && me.user) {
          state.session.user = me.user;
          localStorage.setItem("tk_user", JSON.stringify(me.user));
          await afterAuth();
          return;
        }
      } catch {}
      // cleanup invalid token
      state.session.token = null;
      state.session.user = null;
      localStorage.setItem("tk_token","null");
      localStorage.setItem("tk_user","null");
    }

    // show login if not authenticated
    showLogin();
  })();

})();
