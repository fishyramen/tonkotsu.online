'use strict';

/**
 * client/script.js — SPA-ish frontend for tonkotsu.online
 * Features:
 * - Login / Register (password confirm) / Guest
 * - Settings modal (presence, status, ping sounds, global ping)
 * - Profile (bio)
 * - Threads: Global + DMs + Groups, group creation, invites via DM
 * - Online list with statuses; idle after 2 min; invisible hides from list
 * - Friend requests (non-guests) + accept/decline
 * - Block users: blurred messages + reveal button; blocked cannot DM
 * - Global chat forbids links (client-side hint; server enforces)
 * - Dynamic loading screen, toasts, animations
 * - Cooldown bar with red shake feedback when trying to send during cooldown
 * - Message dedupe via clientId; timestamps; edit/delete in 60s window
 */

const $ = (sel) => document.querySelector(sel);
const elThreads = $('#threads');
const elMessages = $('#messages');
const elComposer = $('#composer');
const elSendBtn = $('#sendBtn');
const elThreadTitle = $('#threadTitle');
const elThreadSub = $('#threadSub');
const elThreadDot = $('#threadDot');
const elMeName = $('#meName');
const elMeStatus = $('#meStatus');
const elMeDot = $('#meDot');
const elMeDot2 = $('#meDot2');
const elOnlineList = $('#onlineList');
const elOnlineCount = $('#onlineCount');
const elLoading = $('#loading');
const elLoadText = $('#loadText');
const elBackdrop = $('#backdrop');
const elModalTitle = $('#modalTitle');
const elModalBody = $('#modalBody');
const elModalFoot = $('#modalFoot');
const elCtx = $('#ctx');
const elToasts = $('#toasts');
const elCooldownBar = $('#cooldownBar');
const elCooldownFill = $('#cooldownFill');
const elBtnSettings = $('#btnSettings');
const elBtnProfile = $('#btnProfile');
const elBtnAuth = $('#btnAuth');
const elBtnNew = $('#btnNew');
const elBtnLogout = $('#btnLogout');
const elBtnAnnounce = $('#btnAnnounce');
const elBtnGroup = $('#btnGroup');
const elEnvBadge = $('#envBadge');

const API = {
  register: (body) => post('/api/register', body),
  login: (body) => post('/api/login', body),
  guest: () => post('/api/guest', {}),
  me: () => get('/api/me'),
  updateProfile: (body) => post('/api/me/profile', body),
  threads: () => get('/api/threads'),
  messages: (threadId) => get(`/api/messages?threadId=${encodeURIComponent(threadId)}&limit=120`),
  dm: (username) => post('/api/threads/dm', { username }),
  group: (name) => post('/api/threads/group', { name }),
  friendReq: (username) => post('/api/friends/request', { username }),
  friendRespond: (fromId, accept) => post('/api/friends/respond', { fromId, accept }),
  block: (username) => post('/api/block', { username }),
  unblock: (username) => post('/api/unblock', { username }),
  invite: (groupId, userId) => post('/api/groups/invite', { groupId, userId }),
  inviteRespond: (groupId, inviterId, accept) => post('/api/groups/invite/respond', { groupId, inviterId, accept }),
  announce: (content) => post('/api/announce', { content }),
};

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function now(){ return Date.now(); }
function fmtTime(ts){
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  return `${hh}:${mm}`;
}
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }

let state = {
  token: localStorage.getItem('tko_token') || null,
  user: null,
  threads: [],
  activeThreadId: 'global',
  socket: null,
  online: [],
  blockedIds: new Set(),
  friends: new Set(),
  friendRequestsIn: new Set(),
  friendRequestsOut: new Set(),
  pendingPing: new Map(), // threadId -> count
  settings: loadSettings(),
  cooldownUntil: 0,
  cooldownMs: 0,
  lastActivityAt: now(),
  idle: false
};

function loadSettings(){
  try{
    const raw = localStorage.getItem('tko_settings');
    if(!raw) return { pingDM:true, pingGlobal:false, pingInvite:true, pingFriend:true, volume:0.25, theme:'black' };
    const s = JSON.parse(raw);
    return { pingDM:!!s.pingDM, pingGlobal:!!s.pingGlobal, pingInvite:!!s.pingInvite, pingFriend:!!s.pingFriend, volume: Number(s.volume ?? 0.25), theme:'black' };
  }catch{
    return { pingDM:true, pingGlobal:false, pingInvite:true, pingFriend:true, volume:0.25, theme:'black' };
  }
}
function saveSettings(){
  localStorage.setItem('tko_settings', JSON.stringify(state.settings));
}

async function get(url){
  const r = await fetch(url, { headers: authHeaders() });
  const j = await r.json().catch(()=> ({}));
  if(!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
async function post(url, body){
  const r = await fetch(url, {
    method:'POST',
    headers: { 'Content-Type':'application/json', ...authHeaders() },
    body: JSON.stringify(body || {})
  });
  const j = await r.json().catch(()=> ({}));
  if(!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
function authHeaders(){
  return state.token ? { Authorization: 'Bearer ' + state.token } : {};
}

function toast(title, detail=''){
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<div style="font-weight:950">${escapeHtml(title)}</div>${detail?`<small>${escapeHtml(detail)}</small>`:''}`;
  elToasts.appendChild(t);
  setTimeout(()=> { t.style.opacity='0'; t.style.transform='translateY(4px)'; }, 2600);
  setTimeout(()=> t.remove(), 3100);
}

function showLoading(txt){
  elLoadText.textContent = txt || 'Connecting…';
  elLoading.classList.remove('hide');
}
function hideLoading(){
  elLoading.classList.add('hide');
}

function openModal(title, bodyNodes, footNodes){
  elModalTitle.textContent = title;
  elModalBody.innerHTML = '';
  elModalFoot.innerHTML = '';
  for(const n of (bodyNodes||[])) elModalBody.appendChild(n);
  for(const n of (footNodes||[])) elModalFoot.appendChild(n);
  elBackdrop.classList.add('show');
}
function closeModal(){ elBackdrop.classList.remove('show'); }

$('#modalClose').addEventListener('click', closeModal);
elBackdrop.addEventListener('click', (e)=> { if(e.target === elBackdrop) closeModal(); });

function btn(text, cls='btn', onClick){
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}
function input(placeholder, type='text', value=''){
  const i = document.createElement('input');
  i.placeholder = placeholder;
  i.type = type;
  i.value = value || '';
  return i;
}
function select(options, value){
  const s = document.createElement('select');
  for(const [val,label] of options){
    const o = document.createElement('option');
    o.value = val; o.textContent = label;
    if(val===value) o.selected = true;
    s.appendChild(o);
  }
  return s;
}
function labelRow(lbl, control){
  const row = document.createElement('div'); row.className='row';
  const l = document.createElement('label'); l.textContent = lbl;
  row.appendChild(l); row.appendChild(control);
  return row;
}

function escapeHtml(s){
  return String(s||'').replace(/[&<>"']/g, (m)=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
}

function playPing(type){
  const s = state.settings;
  const enabled =
    (type==='dm' && s.pingDM) ||
    (type==='invite' && s.pingInvite) ||
    (type==='friend' && s.pingFriend) ||
    (type==='global' && s.pingGlobal);
  if(!enabled) return;

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  const base = (type==='invite')? 660 : (type==='friend')? 620 : (type==='dm')? 540 : 480;
  const second = base * 1.34;
  const t0 = ctx.currentTime;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.02, s.volume), t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
  osc.frequency.setValueAtTime(base, t0);
  osc.frequency.exponentialRampToValueAtTime(second, t0 + 0.08);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.24);
  osc.onended = ()=> ctx.close().catch(()=>{});
}

function setToken(token){
  state.token = token;
  if(token) localStorage.setItem('tko_token', token);
  else localStorage.removeItem('tko_token');
}

function setMe(user){
  state.user = user;
  elMeName.textContent = user ? user.username : 'Not logged in';
  elMeStatus.textContent = user ? (user.statusText || user.bio || (user.isGuest?'Guest':'Online')) : 'Login / Register / Guest';
  updateMyDot(user?.presence || 'online');
  renderHeaderButtons();
}
function updateMyDot(pres){
  const cls = ['online','idle','dnd','invisible'];
  for(const c of cls){ elMeDot.classList.remove(c); elMeDot2.classList.remove(c); }
  elMeDot.classList.add(pres || 'online');
  elMeDot2.classList.add(pres || 'online');
}

function renderHeaderButtons(){
  const logged = !!state.user;
  elBtnLogout.style.display = logged ? '' : 'none';
  elBtnAnnounce.style.display = (logged && state.user.badges && state.user.badges.includes('ANNOUNCEMENT') && !state.user.isGuest) ? '' : 'none';
}

function setActiveThread(id){
  state.activeThreadId = id;
  state.pendingPing.set(id, 0);
  renderThreads();
  loadThread(id);
}

function threadDisplayName(t){
  if(t.type==='global') return '# global';
  if(t.type==='dm') return '@ ' + (t.name || 'DM');
  if(t.type==='group') return '✦ ' + (t.name || 'Group');
  return t.name || 'Chat';
}

function updateThreadTopbar(thread){
  elThreadTitle.textContent = threadDisplayName(thread);
  elThreadSub.textContent =
    thread.type==='global' ? 'No links allowed • Cooldown enforced' :
    thread.type==='dm' ? 'Direct messages • Links allowed' :
    thread.type==='group' ? 'Group chat • Invites via friends' : 'Chat';

  // threadDot color hint
  const cls = ['online','idle','dnd','invisible'];
  for(const c of cls) elThreadDot.classList.remove(c);
  elThreadDot.classList.add('online');

  // group button
  elBtnGroup.style.display = (thread.type==='group') ? '' : 'none';
}

function renderThreads(){
  elThreads.innerHTML = '';
  const threads = state.threads.slice().sort((a,b)=>{
    if(a.id==='global') return -1;
    if(b.id==='global') return 1;
    if(a.type!==b.type) return (a.type==='dm'?-1:1);
    return (a.name||'').localeCompare(b.name||'');
  });

  for(const t of threads){
    const row = document.createElement('div');
    row.className = 'thread' + (t.id===state.activeThreadId ? ' active':'');

    const name = document.createElement('div');
    name.className = 'threadName';
    name.textContent = threadDisplayName(t);

    const ping = document.createElement('div');
    ping.className = 'ping';
    const cnt = state.pendingPing.get(t.id) || 0;
    if(cnt>0){ ping.classList.add('show'); ping.textContent = String(cnt); }

    row.appendChild(name);
    row.appendChild(ping);

    row.addEventListener('click', ()=> setActiveThread(t.id));
    elThreads.appendChild(row);
  }
}

function scrollToBottom(){
  elMessages.scrollTop = elMessages.scrollHeight;
}

function messageKey(m){ return m.senderId + '|' + (m.clientId || m.id); }

const messageIndex = new Map(); // key -> messageId
function renderMessages(msgs){
  elMessages.innerHTML = '';
  messageIndex.clear();

  for(const m of msgs){
    addMessageToUI(m, true);
  }
  setTimeout(scrollToBottom, 0);
}

function isBlockedMessage(m){
  return state.blockedIds.has(m.senderId);
}

function addMessageToUI(m, initial=false){
  const key = messageKey(m);
  if(messageIndex.has(key)) return; // client-side dedupe (extra)
  messageIndex.set(key, m.id);

  const wrap = document.createElement('div');
  wrap.className = 'msg';

  if(m.type==='announcement') wrap.classList.add('announcement');
  if(isBlockedMessage(m)) wrap.classList.add('blocked');

  wrap.dataset.mid = m.id;

  const left = document.createElement('div');
  left.style.width = '8px';
  left.style.borderRadius = '999px';
  left.style.background = m.senderColor || '#777';
  left.style.marginTop = '3px';

  const col = document.createElement('div');
  col.className = 'msgCol';

  const hdr = document.createElement('div');
  hdr.className = 'msgHdr';

  const nm = document.createElement('div');
  nm.className = 'msgName';
  nm.textContent = m.senderName || 'user';
  nm.style.color = m.senderColor || '';
  nm.addEventListener('contextmenu', (e)=> userContextMenu(e, { id:m.senderId, username:m.senderName }));

  const time = document.createElement('div');
  time.className = 'msgTime';
  time.textContent = fmtTime(m.createdAt) + (m.editedAt ? ' (edited)' : '');

  hdr.appendChild(nm);
  hdr.appendChild(time);

  const body = document.createElement('div');
  body.className = 'msgBody';
  body.textContent = m.deletedAt ? '[deleted]' : (m.content || '');

  col.appendChild(hdr);
  col.appendChild(body);

  // system/invite/friend_request
  if(m.type==='invite' && m.meta && m.meta.groupId){
    const card = document.createElement('div'); card.className='cardInline';
    const lefttxt = document.createElement('div');
    lefttxt.innerHTML = `<div style="font-weight:950">Group invite</div><div style="color:var(--muted);font-size:12px">Join “${escapeHtml(m.meta.groupName||'group')}”</div>`;
    const rightbtns = document.createElement('div'); rightbtns.style.display='flex'; rightbtns.style.gap='8px';
    const accept = btn('Accept','btn btnPrimary', async ()=>{
      try{
        await API.inviteRespond(m.meta.groupId, m.meta.inviterId, true);
        toast('Joined group', m.meta.groupName);
        await refreshThreads();
      }catch(e){ toast('Invite failed', e.message); }
    });
    const decline = btn('Decline','btn', async ()=>{
      try{
        await API.inviteRespond(m.meta.groupId, m.meta.inviterId, false);
        toast('Invite declined');
      }catch(e){ toast('Invite failed', e.message); }
    });
    rightbtns.appendChild(accept); rightbtns.appendChild(decline);
    card.appendChild(lefttxt); card.appendChild(rightbtns);
    col.appendChild(card);
  }

  if(m.type==='friend_request' && m.meta && m.meta.fromId){
    const card = document.createElement('div'); card.className='cardInline';
    const lefttxt = document.createElement('div');
    lefttxt.innerHTML = `<div style="font-weight:950">Friend request</div><div style="color:var(--muted);font-size:12px">From ${escapeHtml(m.senderName||'user')}</div>`;
    const rightbtns = document.createElement('div'); rightbtns.style.display='flex'; rightbtns.style.gap='8px';
    const accept = btn('Accept','btn btnPrimary', async ()=>{
      try{
        await API.friendRespond(m.meta.fromId, true);
        toast('Friend added');
        await refreshMe();
      }catch(e){ toast('Failed', e.message); }
    });
    const decline = btn('Decline','btn', async ()=>{
      try{
        await API.friendRespond(m.meta.fromId, false);
        toast('Declined');
        await refreshMe();
      }catch(e){ toast('Failed', e.message); }
    });
    rightbtns.appendChild(accept); rightbtns.appendChild(decline);
    card.appendChild(lefttxt); card.appendChild(rightbtns);
    col.appendChild(card);
  }

  wrap.appendChild(left);
  wrap.appendChild(col);

  if(isBlockedMessage(m) && !m.deletedAt){
    // enable reveal
    wrap.style.pointerEvents = '';
    const rb = document.createElement('button');
    rb.className = 'revealBtn';
    rb.textContent = 'Reveal';
    rb.addEventListener('click', ()=>{
      wrap.classList.remove('blocked');
      rb.remove();
    });
    wrap.appendChild(rb);
  }

  // message actions (edit/delete) — only your messages within 60s
  if(state.user && m.senderId === state.user.id && !m.deletedAt){
    wrap.addEventListener('dblclick', ()=> openEditMessage(m));
  }

  elMessages.appendChild(wrap);
  if(!initial) scrollToBottom();
}

function updateMessageUIEdit(messageId, content, editedAt){
  const el = elMessages.querySelector(`[data-mid="${CSS.escape(messageId)}"]`);
  if(!el) return;
  const body = el.querySelector('.msgBody');
  const time = el.querySelector('.msgTime');
  if(body) body.textContent = content;
  if(time){
    // preserve hh:mm from dataset? easiest: show edited
    time.textContent = time.textContent.replace(' (edited)','') + ' (edited)';
  }
}

function updateMessageUIDelete(messageId){
  const el = elMessages.querySelector(`[data-mid="${CSS.escape(messageId)}"]`);
  if(!el) return;
  const body = el.querySelector('.msgBody');
  if(body) body.textContent = '[deleted]';
}

async function loadThread(threadId){
  try{
    const thread = state.threads.find(t => t.id===threadId) || { id:'global', type:'global', name:'Global' };
    updateThreadTopbar(thread);

    showLoading('Loading messages…');
    const data = await API.messages(threadId);
    hideLoading();

    renderMessages(data.messages || []);
    ensureJoined(threadId);

    // clear ping for this thread
    state.pendingPing.set(threadId, 0);
    renderThreads();
  }catch(e){
    hideLoading();
    toast('Failed to load', e.message);
  }
}

function ensureJoined(threadId){
  if(!state.socket) return;
  state.socket.emit('thread:join', { threadId }, (resp)=>{
    if(resp && !resp.ok) toast('Join failed', resp.error || 'forbidden');
  });
}

function userContextMenu(e, user){
  e.preventDefault();
  if(!user || !user.username) return;
  hideCtx();

  const items = [];
  if(state.user && !state.user.isGuest && user.username !== state.user.username){
    if(!state.friends.has(user.id)){
      items.push({ label:'Add friend', fn: ()=> sendFriendRequest(user.username) });
    }
    items.push({ label:'Block', danger:true, fn: ()=> blockUser(user.username) });
    items.push({ label:'DM', fn: ()=> openDM(user.username) });
  }
  if(items.length===0) return;

  elCtx.innerHTML = '';
  for(const it of items){
    const div = document.createElement('div');
    div.className = 'ctxItem' + (it.danger?' danger':'');
    div.textContent = it.label;
    div.addEventListener('click', ()=>{ hideCtx(); it.fn(); });
    elCtx.appendChild(div);
  }
  elCtx.style.left = clamp(e.clientX, 8, window.innerWidth - 220) + 'px';
  elCtx.style.top = clamp(e.clientY, 8, window.innerHeight - 120) + 'px';
  elCtx.classList.add('show');
}

function hideCtx(){ elCtx.classList.remove('show'); }
window.addEventListener('click', hideCtx);
window.addEventListener('scroll', hideCtx, true);

async function openDM(username){
  try{
    if(state.user?.isGuest) return toast('Guests cannot DM');
    const r = await API.dm(username);
    await refreshThreads();
    setActiveThread(r.threadId);
  }catch(e){ toast('DM failed', e.message); }
}

async function sendFriendRequest(username){
  try{
    if(state.user?.isGuest) return toast('Guests cannot add friends');
    await API.friendReq(username);
    toast('Friend request sent', username);
    await refreshMe();
    // open dm automatically
    await openDM(username);
    playPing('friend');
  }catch(e){ toast('Friend request failed', e.message); }
}

async function blockUser(username){
  try{
    await API.block(username);
    toast('Blocked', username);
    await refreshMe();
  }catch(e){ toast('Block failed', e.message); }
}

function openEditMessage(m){
  // only within 60s
  if(now() - m.createdAt > 60_000) return toast('Edit expired','Only within 60 seconds.');
  const ta = document.createElement('textarea');
  ta.value = m.content || '';
  ta.style.minHeight = '120px';

  const body = [labelRow('Edit', ta)];
  const foot = [
    btn('Cancel','btn', closeModal),
    btn('Delete','btn btnDanger', async ()=>{
      try{
        state.socket.emit('message:delete', { messageId: m.id }, (resp)=>{
          if(resp && resp.ok) { toast('Deleted'); closeModal(); }
          else toast('Delete failed', resp?.error || 'error');
        });
      }catch(e){ toast('Delete failed', e.message); }
    }),
    btn('Save','btn btnPrimary', async ()=>{
      const content = ta.value.trim();
      if(!content) return toast('Empty','Write something.');
      state.socket.emit('message:edit', { messageId: m.id, content }, (resp)=>{
        if(resp && resp.ok) { toast('Edited'); closeModal(); }
        else toast('Edit failed', resp?.error || 'error');
      });
    })
  ];
  openModal('Edit message', body, foot);
  setTimeout(()=> ta.focus(), 20);
}

// Auth modal
function openAuthModal(){
  const modeSel = select([['login','Login'],['register','Register'],['guest','Guest']], 'login');
  const u = input('Username (letters/numbers/_ 2-20)', 'text', '');
  const p = input('Password', 'password', '');
  const p2 = input('Confirm password (register)', 'password', '');
  p2.style.display = 'none';

  modeSel.addEventListener('change', ()=>{
    const m = modeSel.value;
    const show = (m==='register');
    p2.style.display = show ? '' : 'none';
    u.style.display = (m==='guest') ? 'none' : '';
    p.style.display = (m==='guest') ? 'none' : '';
  });

  const body = [
    labelRow('Mode', modeSel),
    labelRow('Username', u),
    labelRow('Password', p),
    labelRow('Confirm', p2),
  ];

  const foot = [
    btn('Cancel','btn', closeModal),
    btn('Continue','btn btnPrimary', async ()=>{
      try{
        const m = modeSel.value;
        if(m==='guest'){
          showLoading('Creating guest…');
          const r = await API.guest();
          hideLoading();
          setToken(r.token);
          setMe(r.user);
          toast('Welcome', `Signed in as ${r.user.username}`);
          await afterLogin();
          closeModal();
          return;
        }
        const username = u.value.trim();
        const password = p.value;
        if(m==='register'){
          const r = await API.register({ username, password, password2: p2.value });
          setToken(r.token);
          setMe(r.user);
          toast('Account created', `Welcome ${r.user.username}`);
          closeModal();
          await afterLogin();
          showWelcomePopup();
          return;
        }
        if(m==='login'){
          const r = await API.login({ username, password });
          setToken(r.token);
          setMe(r.user);
          toast('Logged in', r.user.username);
          closeModal();
          await afterLogin();
          return;
        }
      }catch(e){
        toast('Auth failed', e.message);
      }finally{
        hideLoading();
      }
    })
  ];

  openModal('Authenticate', body, foot);
}

function showWelcomePopup(){
  const seenKey = 'tko_seen_welcome_' + (state.user?.id || '');
  if(localStorage.getItem(seenKey)) return;
  localStorage.setItem(seenKey,'1');

  const p = document.createElement('div');
  p.innerHTML = `
    <div style="font-weight:950;font-size:18px;margin-bottom:8px">Welcome to tonkotsu.online</div>
    <div style="color:var(--muted);line-height:1.35">
      This website is currently in <b>BETA</b>. Things may break, reset, or change quickly.<br><br>
      If you find issues, DM <b>fishy_x1</b> on Discord or open an issue as <b>fishyramen</b> on GitHub.
    </div>`;
  openModal('Beta notice', [p], [btn('Got it','btn btnPrimary', closeModal)]);
}

function openSettings(){
  if(!state.user) return openAuthModal();

  const presence = select([['online','Online'],['idle','Idle'],['dnd','Do Not Disturb'],['invisible','Invisible']], state.user.presence || 'online');
  const statusText = input('Status message (shown in online list)', 'text', state.user.statusText || '');

  const pingDM = document.createElement('input'); pingDM.type='checkbox'; pingDM.checked=!!state.settings.pingDM;
  const pingInv = document.createElement('input'); pingInv.type='checkbox'; pingInv.checked=!!state.settings.pingInvite;
  const pingFr = document.createElement('input'); pingFr.type='checkbox'; pingFr.checked=!!state.settings.pingFriend;
  const pingGl = document.createElement('input'); pingGl.type='checkbox'; pingGl.checked=!!state.settings.pingGlobal;

  const vol = document.createElement('input'); vol.type='range'; vol.min='0'; vol.max='1'; vol.step='0.01'; vol.value=String(state.settings.volume ?? 0.25);
  const test = btn('Test ping','btn', ()=> playPing('dm'));

  function rowChk(lbl, chk){
    const row = document.createElement('div'); row.className='row';
    const l = document.createElement('label'); l.textContent = lbl;
    const wrap = document.createElement('div'); wrap.style.display='flex'; wrap.style.alignItems='center'; wrap.style.gap='10px';
    wrap.appendChild(chk);
    row.appendChild(l); row.appendChild(wrap);
    return row;
  }

  const body = [
    labelRow('Presence', presence),
    labelRow('Status', statusText),
    rowChk('Ping DM', pingDM),
    rowChk('Ping Invite', pingInv),
    rowChk('Ping Friend', pingFr),
    rowChk('Ping Global', pingGl),
    labelRow('Volume', vol),
    test
  ];

  const foot = [
    btn('Cancel','btn', closeModal),
    btn('Save','btn btnPrimary', async ()=>{
      try{
        // save client settings
        state.settings.pingDM = pingDM.checked;
        state.settings.pingInvite = pingInv.checked;
        state.settings.pingFriend = pingFr.checked;
        state.settings.pingGlobal = pingGl.checked;
        state.settings.volume = Number(vol.value);
        saveSettings();

        // save server profile
        const r = await API.updateProfile({ presence: presence.value, statusText: statusText.value });
        setMe(r.user);
        toast('Saved');
        closeModal();
      }catch(e){ toast('Save failed', e.message); }
    })
  ];

  openModal('Settings', body, foot);
}

function openProfile(){
  if(!state.user) return openAuthModal();
  const bio = document.createElement('textarea');
  bio.value = state.user.bio || '';
  const body = [labelRow('Bio', bio)];
  const foot = [
    btn('Cancel','btn', closeModal),
    btn('Save','btn btnPrimary', async ()=>{
      try{
        const r = await API.updateProfile({ bio: bio.value });
        setMe(r.user);
        toast('Updated profile');
        closeModal();
      }catch(e){ toast('Failed', e.message); }
    })
  ];
  openModal('Profile', body, foot);
}

function openNewChat(){
  if(!state.user) return openAuthModal();
  if(state.user.isGuest) return toast('Guests limited','Register to use DMs, friends, groups.');

  const modeSel = select([['dm','New DM'],['group','New Group']], 'dm');
  const a = input('Username (DM) or Group name','text','');

  const body = [labelRow('Type', modeSel), labelRow('Target', a)];
  const foot = [
    btn('Cancel','btn', closeModal),
    btn('Create','btn btnPrimary', async ()=>{
      try{
        if(modeSel.value==='dm'){
          const r = await API.dm(a.value.trim());
          await refreshThreads();
          setActiveThread(r.threadId);
          closeModal();
        }else{
          const r = await API.group(a.value.trim());
          await refreshThreads();
          setActiveThread(r.threadId);
          closeModal();
        }
      }catch(e){ toast('Failed', e.message); }
    })
  ];
  openModal('Create chat', body, foot);
}

function openGroupSettings(){
  const t = state.threads.find(x => x.id === state.activeThreadId);
  if(!t || t.type!=='group') return;

  const isOwner = t.roles && state.user && t.roles[state.user.id] === 'owner';
  const body = [];
  const info = document.createElement('div');
  info.style.color='var(--muted)';
  info.innerHTML = `<div style="font-weight:950;color:var(--text);margin-bottom:6px">Group: ${escapeHtml(t.name)}</div>
    <div>Owner can invite friends. (members vs owners permissions are stored in server roles).</div>`;
  body.push(info);

  if(isOwner){
    // invite friend
    const sel = document.createElement('select');
    const friends = state.online
      .filter(o => state.friends.has(o.user.id))
      .map(o => o.user)
      .sort((a,b)=>a.username.localeCompare(b.username));
    const opt0 = document.createElement('option'); opt0.value=''; opt0.textContent='Select friend...'; sel.appendChild(opt0);
    for(const u of friends){
      const o = document.createElement('option');
      o.value = u.id; o.textContent = u.username;
      sel.appendChild(o);
    }
    body.push(labelRow('Invite', sel));
    body.push(btn('Send invite','btn btnPrimary', async ()=>{
      try{
        if(!sel.value) return toast('Pick a friend');
        await API.invite(t.id, sel.value);
        toast('Invite sent');
        playPing('invite');
      }catch(e){ toast('Invite failed', e.message); }
    }));
  }

  const foot = [btn('Close','btn', closeModal)];
  openModal('Group settings', body, foot);
}

async function refreshThreads(){
  const r = await API.threads();
  state.threads = r.threads || [];
  // ensure global exists
  if(!state.threads.some(t=>t.id==='global')) state.threads.unshift({id:'global',type:'global',name:'Global'});
  renderThreads();
}

async function refreshMe(){
  const r = await API.me();
  setMe(r.user);
  state.blockedIds = new Set(r.blocked || []);
  state.friends = new Set(r.friends || []);
  state.friendRequestsIn = new Set(r.friendRequestsIn || []);
  state.friendRequestsOut = new Set(r.friendRequestsOut || []);
}

function connectSocket(){
  if(!state.token) return;
  const socket = io({ auth: { token: state.token } });
  state.socket = socket;

  socket.on('connect', ()=>{
    hideLoading();
    toast('Connected');
    // join active and global
    ensureJoined('global');
    ensureJoined(state.activeThreadId || 'global');
  });

  socket.on('connect_error', (err)=>{
    showLoading('Connection failed…');
    toast('Socket error', err?.message || 'error');
  });

  socket.on('presence:list', (payload)=>{
    state.online = payload.users || [];
    renderOnline();
  });

  socket.on('presence:update', (payload)=>{
    const u = payload.user;
    if(!u) return;
    if(state.user && u.id === state.user.id){
      // if our presence updated elsewhere
      setMe({ ...state.user, presence: u.presence });
    }
  });

  socket.on('message:new', (payload)=>{
    const m = payload.message;
    if(!m) return;

    // ping counters for inactive threads
    if(m.threadId !== state.activeThreadId){
      const cur = state.pendingPing.get(m.threadId) || 0;
      state.pendingPing.set(m.threadId, cur + 1);
      renderThreads();
      if(m.type==='invite') playPing('invite');
      else if(m.type==='friend_request') playPing('friend');
      else if(m.threadId==='global') playPing('global');
      else playPing('dm');
    }else{
      // active thread: render
      addMessageToUI(m);
      if(m.type==='invite') playPing('invite');
      else if(m.type==='friend_request') playPing('friend');
      else if(m.threadId==='global') playPing('global');
      else playPing('dm');
    }
  });

  socket.on('message:edit', (payload)=>{
    if(!payload) return;
    updateMessageUIEdit(payload.messageId, payload.content, payload.editedAt);
  });

  socket.on('message:delete', (payload)=>{
    if(!payload) return;
    updateMessageUIDelete(payload.messageId);
  });
}

function renderOnline(){
  elOnlineList.innerHTML = '';
  elOnlineCount.textContent = String(state.online.length || 0);

  for(const entry of state.online){
    const u = entry.user;
    if(!u) continue;
    const row = document.createElement('div');
    row.className = 'userRow';
    row.addEventListener('contextmenu', (e)=> userContextMenu(e, u));
    row.addEventListener('click', ()=> {
      // click open dm
      if(state.user && !state.user.isGuest && u.id !== state.user.id) openDM(u.username);
    });

    const dot = document.createElement('div');
    dot.className = 'dot ' + (u.presence || 'online');

    const meta = document.createElement('div');
    meta.className = 'userMeta';
    const name = document.createElement('div');
    name.className = 'userName';
    name.innerHTML = `<span style="color:${escapeHtml(u.color||'#999')}">${escapeHtml(u.username)}</span>`;
    const st = document.createElement('div');
    st.className = 'userStatus';
    st.textContent = u.statusText || (u.presence || 'online');

    const badges = document.createElement('div'); badges.className='badgeRow';
    for(const b of (u.badges||[])){
      const s = document.createElement('span'); s.className='miniBadge';
      if(b==='GUEST') s.classList.add('badgeGuest');
      if(b==='BETA') s.classList.add('badgeBeta');
      if(b==='EARLY ACCESS') s.classList.add('badgeEarly');
      if(b==='ANNOUNCEMENT') s.classList.add('badgeAnn');
      s.textContent = b;
      badges.appendChild(s);
    }

    meta.appendChild(name);
    meta.appendChild(st);
    if((u.badges||[]).length) meta.appendChild(badges);

    row.appendChild(dot);
    row.appendChild(meta);
    elOnlineList.appendChild(row);
  }
}

// Cooldown UI
let cooldownTimer = null;
function startCooldown(ms){
  state.cooldownMs = ms;
  state.cooldownUntil = now() + ms;
  elCooldownBar.classList.add('show');
  elCooldownBar.classList.remove('red');
  tickCooldown();
  if(cooldownTimer) clearInterval(cooldownTimer);
  cooldownTimer = setInterval(tickCooldown, 50);
}
function tickCooldown(){
  const remain = state.cooldownUntil - now();
  const pct = 1 - (remain / state.cooldownMs);
  elCooldownFill.style.width = (clamp(pct,0,1)*100).toFixed(1) + '%';
  if(remain <= 0){
    clearInterval(cooldownTimer); cooldownTimer=null;
    elCooldownFill.style.width = '0%';
    elCooldownBar.classList.remove('show');
    state.cooldownUntil = 0;
    state.cooldownMs = 0;
  }
}
function cooldownErrorPulse(){
  elCooldownBar.classList.add('show');
  elCooldownBar.classList.add('red');
  $('#composerWrap').classList.add('shake');
  setTimeout(()=> $('#composerWrap').classList.remove('shake'), 600);
  setTimeout(()=> elCooldownBar.classList.remove('red'), 500);
}

// sending messages
function canSendNow(){
  return now() >= state.cooldownUntil;
}
function clientId(){
  return (cryptoRandom(8) + '-' + now().toString(36));
}
function cryptoRandom(len){
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function sendMessage(){
  if(!state.socket || !state.user) return openAuthModal();

  const text = elComposer.value.trim();
  if(!text) return;

  // client-side link warning in global (server enforces)
  if(state.activeThreadId==='global' && /(?:https?:\/\/|www\.)/i.test(text)){
    toast('No links in global','Use DMs or groups for websites.');
    return;
  }

  if(!canSendNow()){
    cooldownErrorPulse();
    return;
  }

  elComposer.value = '';
  autosize();

  const payload = { threadId: state.activeThreadId, content: text, clientId: clientId() };
  state.socket.emit('message:send', payload, (resp)=>{
    if(resp && resp.ok){
      if(resp.duplicate) return;
      // cooldown: only applies to global; server returns error otherwise
    }else{
      const err = resp?.error || 'error';
      if(String(err).startsWith('Cooldown:')){
        const ms = parseInt(String(err).split(':')[1],10) || 1200;
        startCooldown(ms);
        cooldownErrorPulse();
      }else{
        toast('Send failed', err);
      }
      // restore text if failed
      elComposer.value = text;
      autosize();
    }
  });
}

// idle detection
function activity(){
  state.lastActivityAt = now();
  if(state.idle){
    state.idle = false;
    state.socket?.emit('activity:ping', {});
    // restore presence if user was idle (client-side)
    if(state.user && state.user.presence==='idle'){
      // user may have manually chosen idle; don't override
    }
  }
}
function idleTick(){
  const diff = now() - state.lastActivityAt;
  if(diff >= 120_000 && !state.idle){
    state.idle = true;
    state.socket?.emit('activity:idle', {});
  }
}

function autosize(){
  elComposer.style.height = 'auto';
  elComposer.style.height = clamp(elComposer.scrollHeight, 18, 140) + 'px';
}

// announce
function openAnnounce(){
  if(!state.user || state.user.isGuest) return toast('Forbidden');
  const ta = document.createElement('textarea');
  ta.placeholder = 'Announcement (global)';
  const foot = [
    btn('Cancel','btn', closeModal),
    btn('Send','btn btnPrimary', async ()=>{
      try{
        await API.announce(ta.value.trim());
        toast('Announcement sent');
        closeModal();
      }catch(e){ toast('Failed', e.message); }
    })
  ];
  openModal('Announcement', [ta], foot);
  setTimeout(()=> ta.focus(), 20);
}

// wire UI
elSendBtn.addEventListener('click', sendMessage);
elComposer.addEventListener('keydown', (e)=>{
  if(e.key==='Enter' && !e.shiftKey){
    e.preventDefault();
    sendMessage();
  }
});
elComposer.addEventListener('input', ()=> { autosize(); activity(); });
window.addEventListener('mousemove', activity, { passive:true });
window.addEventListener('keydown', activity, { passive:true });
window.addEventListener('click', activity, { passive:true });

elBtnSettings.addEventListener('click', openSettings);
elBtnProfile.addEventListener('click', openProfile);
elBtnAuth.addEventListener('click', openAuthModal);
elBtnNew.addEventListener('click', openNewChat);
elBtnLogout.addEventListener('click', ()=>{
  setToken(null);
  state.user = null;
  state.socket?.disconnect();
  state.socket = null;
  state.threads = [{id:'global',type:'global',name:'Global'}];
  state.activeThreadId = 'global';
  renderThreads();
  renderMessages([]);
  setMe(null);
  toast('Logged out');
});
elBtnAnnounce.addEventListener('click', openAnnounce);
elBtnGroup.addEventListener('click', openGroupSettings);

// boot
async function afterLogin(){
  try{
    await refreshMe();
    await refreshThreads();
    renderThreads();
    setActiveThread('global');
    connectSocket();
  }catch(e){
    toast('Init failed', e.message);
    showLoading('Init failed…');
  }finally{
    hideLoading();
  }
}

async function boot(){
  showLoading('Starting…');
  // theme: force black
  document.documentElement.style.setProperty('--bg','#000');

  // set placeholder state
  state.threads = [{id:'global',type:'global',name:'Global'}];
  renderThreads();
  renderMessages([]);

  if(!state.token){
    setMe(null);
    hideLoading();
    return;
  }

  try{
    elEnvBadge.textContent = 'BETA';
    await refreshMe();
    await refreshThreads();
    renderThreads();
    setActiveThread(state.activeThreadId || 'global');
    connectSocket();
    hideLoading();
    // beta popup only on first account creation (handled during register) OR first time per id
    // If user has token but never saw: keep optional
  }catch(e){
    setToken(null);
    setMe(null);
    hideLoading();
    toast('Session expired', 'Please login again.');
  }
  // idle check loop
  setInterval(idleTick, 10_000);
}
boot();

