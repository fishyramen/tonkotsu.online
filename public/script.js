/* script.js — tonkotsu.online (client)
   Notes:
   - This file is written to be resilient: it will work best if server.js implements the socket events below,
     but it also fails gracefully if some events are missing.
   - Implemented per your requirements:
     • Removed “Clear notifications” UI (not rendered here; inbox uses per-item actions only)
     • Inbox button improved (handled via badge + modal)
     • Group “Manage” button beside group name, with owner controls (limit slider downwards, add/remove/transfer/mute/unmute)
     • Cooldown is a dynamic bar; shakes red on early send then fades back
     • Loading screen between login and chat
     • Clean alignment + larger text
     • No “current status” in bottom-right (not rendered)
     • Settings includes “Blocked users” list + unblock
     • Username/password enforcement (server-side). Client does correct auth flow and shows errors.
     • Welcome popup on first login (per-user once) + beta disclaimer + contact info
     • Profile badges + stats (created, last seen, level milestones) in profile modal
     • Content embed cards (small, theme-fit) + porn/18+ links blocked + link-spam rule (1 link / 5 min)
     • Mobile UX Mode toggle + sidebar behavior
     • Security analytics in Settings: login history, session manager, change password, change username (server-supported)
*/

(() => {
  'use strict';

  /* ----------------------------- DOM helpers ----------------------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const ce = (tag, props = {}, children = []) => {
    const el = document.createElement(tag);
    Object.assign(el, props);
    for (const ch of children) el.appendChild(typeof ch === 'string' ? document.createTextNode(ch) : ch);
    return el;
  };
  const escapeHTML = (s) => String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const now = () => Date.now();

  const pad2 = (n) => String(n).padStart(2, '0');
  const formatTime = (ts) => {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const formatDate = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };

  /* ----------------------------- Elements ----------------------------- */
  const el = {
    frame: $('#frame'),
    year: $('#year'),

    loading: $('#loading'),
    loaderTitle: $('#loaderTitle'),
    loaderSub: $('#loaderSub'),
    loaderPct: $('#loaderPct'),
    loaderBar: $('#loaderBar'),

    loginOverlay: $('#loginOverlay'),
    username: $('#username'),
    password: $('#password'),
    togglePass: $('#togglePass'),
    joinBtn: $('#joinBtn'),
    guestBtn: $('#guestBtn'),

    channelList: $('#channelList'),
    onlineList: $('#onlineList'),

    topicTitle: $('#topicTitle'),
    topicSub: $('#topicSub'),
    manageBtn: $('#manageBtn'),

    inboxBtnWrap: $('#inboxBtnWrap'),
    inboxBtn: $('#inboxBtn'),
    inboxBadgeMini: $('#inboxBadgeMini'),

    mePill: $('#mePill'),
    meName: $('#meName'),
    meDot: $('#meDot'),

    chat: $('#chat'),

    message: $('#message'),
    sendBtn: $('#sendBtn'),

    hintLeft: $('#hintLeft'),
    cooldownWrap: $('#cooldownWrap'),
    cooldownFill: $('#cooldownFill'),

    modalBack: $('#modalBack'),
    modalTitle: $('#modalTitle'),
    modalBody: $('#modalBody'),
    modalClose: $('#modalClose'),
  };

  el.year.textContent = String(new Date().getFullYear());

  /* ----------------------------- Cursor ----------------------------- */
  const cursor = $('#cursor');
  const cursor2 = $('#cursor2');
  let cursorEnabled = matchMedia('(prefers-reduced-motion: reduce)').matches ? false : true;

  if (cursorEnabled) {
    let lastX = window.innerWidth / 2, lastY = window.innerHeight / 2;
    const move = (x, y) => {
      cursor.style.transform = `translate(${x}px, ${y}px)`;
      cursor2.style.transform = `translate(${x}px, ${y}px)`;
      cursor.style.opacity = '1';
      cursor2.style.opacity = '1';
    };
    window.addEventListener('mousemove', (e) => {
      lastX = e.clientX; lastY = e.clientY;
      move(lastX, lastY);
    }, { passive: true });

    window.addEventListener('mousedown', () => document.body.classList.add('cursorPress'));
    window.addEventListener('mouseup', () => document.body.classList.remove('cursorPress'));

    const hoverables = new Set(['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL']);
    window.addEventListener('mouseover', (e) => {
      const t = e.target;
      if (!t) return;
      if (hoverables.has(t.tagName)) document.body.classList.add('cursorHover');
      else document.body.classList.remove('cursorHover');
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') document.body.classList.add('cursorText');
      else document.body.classList.remove('cursorText');
    }, { passive: true });

    // keep visible when tab refocus
    window.addEventListener('focus', () => move(lastX, lastY), { passive: true });
  } else {
    cursor.style.display = 'none';
    cursor2.style.display = 'none';
    document.body.style.cursor = 'auto';
  }

  /* ----------------------------- Ripple ----------------------------- */
  const ripple = (evt, parentBtn) => {
    const b = parentBtn || evt.currentTarget;
    if (!b || !b.getBoundingClientRect) return;
    const r = b.getBoundingClientRect();
    const x = evt.clientX - r.left;
    const y = evt.clientY - r.top;
    const drop = ce('div', { className: 'ripple' });
    drop.style.left = `${x}px`;
    drop.style.top = `${y}px`;
    b.appendChild(drop);
    setTimeout(() => drop.remove(), 560);
  };
  const bindRipples = (root = document) => {
    $$('button.btn, button.iconBtn', root).forEach((b) => {
      if (b.__rippleBound) return;
      b.__rippleBound = true;
      b.addEventListener('click', (e) => ripple(e, b));
    });
  };
  bindRipples();

  /* ----------------------------- Toasts (minimal, no “clear all”) ----------------------------- */
  const Toast = (() => {
    const wrap = ce('div', { id: 'toastWrap' });
    Object.assign(wrap.style, {
      position: 'fixed',
      left: '14px',
      bottom: '14px',
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      pointerEvents: 'none',
      width: 'min(380px, calc(100vw - 28px))',
    });
    document.body.appendChild(wrap);

    const show = (msg, type = 'info', ms = 3200) => {
      const card = ce('div');
      Object.assign(card.style, {
        pointerEvents: 'auto',
        borderRadius: '14px',
        border: '1px solid rgba(255,255,255,.10)',
        background: 'rgba(12,14,20,.92)',
        boxShadow: '0 18px 70px rgba(0,0,0,.55)',
        padding: '10px 10px',
        color: 'rgba(255,255,255,.92)',
        fontWeight: '800',
        fontSize: '13px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
      });

      const left = ce('div', { textContent: msg });
      left.style.flex = '1';
      left.style.minWidth = '0';

      const close = ce('button', { className: 'btn small', textContent: 'Close' });
      close.style.height = '30px';
      close.style.padding = '0 10px';
      close.addEventListener('click', () => card.remove());

      // subtle type hint by border
      if (type === 'error') card.style.borderColor = 'rgba(255,77,77,.28)';
      if (type === 'ok') card.style.borderColor = 'rgba(59,212,127,.22)';

      card.append(left, close);
      wrap.appendChild(card);
      bindRipples(card);

      if (ms > 0) setTimeout(() => card.remove(), ms);
    };

    return { show };
  })();

  /* ----------------------------- Modal ----------------------------- */
  const Modal = (() => {
    let onClose = null;

    const open = (title, bodyNode, closeCb = null) => {
      el.modalTitle.textContent = title;
      el.modalBody.innerHTML = '';
      el.modalBody.appendChild(bodyNode);
      el.modalBack.classList.add('show');
      onClose = closeCb || null;
      bindRipples(el.modalBack);
      // focus first input if present
      setTimeout(() => {
        const first = $('input,button,textarea,select', el.modalBody);
        first?.focus?.();
      }, 50);
    };

    const close = () => {
      el.modalBack.classList.remove('show');
      if (typeof onClose === 'function') {
        const cb = onClose;
        onClose = null;
        try { cb(); } catch (_) {}
      } else {
        onClose = null;
      }
    };

    el.modalClose.addEventListener('click', close);
    el.modalBack.addEventListener('click', (e) => {
      if (e.target === el.modalBack) close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el.modalBack.classList.contains('show')) close();
    });

    return { open, close };
  })();

  /* ----------------------------- Loading overlay ----------------------------- */
  const Loading = (() => {
    let t = null;
    let pct = 0;

    const set = (title, sub) => {
      el.loaderTitle.textContent = title || 'Loading';
      el.loaderSub.textContent = sub || 'syncing…';
    };

    const show = (title, sub) => {
      set(title, sub);
      pct = 0;
      el.loaderPct.textContent = '0%';
      el.loaderBar.style.width = '18%';
      el.loading.classList.add('show');

      // smooth faux progress while waiting on server
      clearInterval(t);
      t = setInterval(() => {
        const target = 88;
        pct = clamp(pct + (Math.random() * 9 + 3), 0, target);
        el.loaderPct.textContent = `${Math.round(pct)}%`;
        el.loaderBar.style.width = `${clamp(pct, 0, 100)}%`;
      }, 260);
    };

    const done = (title, sub) => {
      set(title || 'Loaded', sub || 'ready');
      clearInterval(t);
      pct = 100;
      el.loaderPct.textContent = '100%';
      el.loaderBar.style.width = '100%';
      setTimeout(() => {
        el.loading.classList.remove('show');
      }, 240);
    };

    const hide = () => {
      clearInterval(t);
      el.loading.classList.remove('show');
    };

    return { show, done, hide };
  })();

  /* ----------------------------- Mobile UX Mode ----------------------------- */
  const UX = (() => {
    const lsKey = 'tonkotsu_mobileUx';
    const state = { forced: null }; // null=auto; true/false=forced

    const read = () => {
      const raw = localStorage.getItem(lsKey);
      if (raw === '1') state.forced = true;
      else if (raw === '0') state.forced = false;
      else state.forced = null;
    };

    const apply = () => {
      const auto = window.innerWidth <= 860;
      const enabled = state.forced === null ? auto : state.forced;

      if (enabled) document.body.setAttribute('data-mobile', '1');
      else document.body.removeAttribute('data-mobile');

      // if in mobile mode, allow tapping the topic title to open/close sidebar
      if (enabled) {
        el.topicTitle.classList.add('clickable');
      } else {
        document.body.classList.remove('sidebarOpen');
        el.topicTitle.classList.remove('clickable');
      }
    };

    const setForced = (val /* null|boolean */) => {
      state.forced = val;
      if (val === null) localStorage.removeItem(lsKey);
      else localStorage.setItem(lsKey, val ? '1' : '0');
      apply();
    };

    const toggleSidebar = (open = null) => {
      const isOpen = document.body.classList.contains('sidebarOpen');
      const next = open === null ? !isOpen : !!open;
      if (next) document.body.classList.add('sidebarOpen');
      else document.body.classList.remove('sidebarOpen');
    };

    window.addEventListener('resize', () => apply(), { passive: true });
    el.topicTitle.addEventListener('click', () => {
      if (document.body.getAttribute('data-mobile') === '1') toggleSidebar(null);
    });

    read();
    apply();

    return { setForced, getForced: () => state.forced, apply, toggleSidebar };
  })();

  /* ----------------------------- Cooldown bar ----------------------------- */
  const Cooldown = (() => {
    const state = {
      ms: 4000,
      until: 0,
      tick: null,
      linkUntil: 0,
    };

    const setCooldownMs = (ms) => {
      if (!Number.isFinite(ms) || ms < 300) return;
      state.ms = clamp(ms, 300, 600000);
      el.hintLeft.textContent = `Cooldown: ${Math.round(state.ms / 1000)}s`;
    };

    const setLinkCooldownMs = (ms) => {
      if (!Number.isFinite(ms) || ms < 1000) return;
      // separate anti-link-spam rule
      state.linkMs = clamp(ms, 1000, 3600000);
    };

    const start = () => {
      state.until = now() + state.ms;
      el.sendBtn.disabled = true;
      update();
      clearInterval(state.tick);
      state.tick = setInterval(update, 50);
    };

    const update = () => {
      const remaining = state.until - now();
      if (remaining <= 0) {
        clearInterval(state.tick);
        state.tick = null;
        state.until = 0;
        el.sendBtn.disabled = false;
        el.cooldownFill.style.width = '0%';
        return;
      }
      const pct = clamp((remaining / state.ms) * 100, 0, 100);
      // show remaining as fill (100% down to 0)
      el.cooldownFill.style.width = `${pct}%`;
    };

    const canSend = () => now() >= state.until;

    const shake = () => {
      el.cooldownWrap.classList.remove('shake');
      // reflow to restart animation
      void el.cooldownWrap.offsetWidth;
      el.cooldownWrap.classList.add('shake');
      setTimeout(() => el.cooldownWrap.classList.remove('shake'), 520);
    };

    const registerLinkSend = () => {
      state.linkUntil = now() + 5 * 60 * 1000; // 5 minutes
    };
    const canSendLink = () => now() >= state.linkUntil;
    const remainingLinkMs = () => Math.max(0, state.linkUntil - now());

    setCooldownMs(state.ms);

    return { setCooldownMs, start, canSend, shake, registerLinkSend, canSendLink, remainingLinkMs, setLinkCooldownMs };
  })();

  /* ----------------------------- Content rules: bad words + links ----------------------------- */
  const Moderation = (() => {
    // IMPORTANT: keep this list “huge but not too huge” and focused on 18+ and slurs.
    // We avoid enumerating every variant; we use patterns with common substitutions.
    const bannedPatterns = [
      // explicit sexual content
      /\b(porn|pornhub|xvideos|xhamster|xnxx|redtube|onlyfans|fansly|hentai)\b/i,
      /\b(nude|nudes|naked|sex\s?chat|escort|camgirl|cam\s?site)\b/i,
      /\b(blowjob|handjob|anal|deepthroat|cumshot|creampie)\b/i,
      /\b(rape|molest|incest|bestiality|zoophilia)\b/i,

      // slurs (patterned; not exhaustive)
      /\b(n[\W_]*i[\W_]*g[\W_]*g[\W_]*e[\W_]*r|n[\W_]*i[\W_]*g[\W_]*g[\W_]*a)\b/i,
      /\b(f[\W_]*a[\W_]*g[\W_]*g[\W_]*o[\W_]*t|f[\W_]*a[\W_]*g)\b/i,
      /\b(r[\W_]*e[\W_]*t[\W_]*a[\W_]*r[\W_]*d)\b/i,
      /\b(k[\W_]*i[\W_]*k[\W_]*)\b/i,
      /\b(s[\W_]*p[\W_]*i[\W_]*c)\b/i,
      /\b(c[\W_]*h[\W_]*i[\W_]*n[\W_]*k)\b/i,
    ];

    // Porn / 18+ domains (fast block)
    const bannedHosts = [
      'pornhub.com', 'xvideos.com', 'xhamster.com', 'xnxx.com', 'redtube.com',
      'onlyfans.com', 'fansly.com',
    ];

    const urlRegex = /\bhttps?:\/\/[^\s<>()]+\b/ig;

    const containsBanned = (text) => {
      const t = String(text || '');
      return bannedPatterns.some((re) => re.test(t));
    };

    const extractUrls = (text) => {
      const t = String(text || '');
      const found = t.match(urlRegex) || [];
      // normalize trailing punctuation
      return found.map(u => u.replace(/[)\].,!?:;]+$/g, ''));
    };

    const isBannedUrl = (u) => {
      try {
        const url = new URL(u);
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        if (bannedHosts.includes(host)) return true;

        // keyword-based fallback
        const hay = (host + url.pathname + url.search).toLowerCase();
        if (/(porn|hentai|xxx|sex|nude|onlyfans|xvideos|xnxx|xhamster)/i.test(hay)) return true;

        return false;
      } catch {
        return true;
      }
    };

    const isSpammyUrls = (urls) => urls.length >= 3; // general no-link-spam, plus server should enforce

    return { containsBanned, extractUrls, isBannedUrl, isSpammyUrls };
  })();

  /* ----------------------------- Inbox / Notifications ----------------------------- */
  const Inbox = (() => {
    const LS_KEY = () => `tonkotsu_inbox_${State.user?.username || 'anon'}`;

    let items = []; // {id, type, ts, title, body, read, meta}

    const load = () => {
      try {
        items = JSON.parse(localStorage.getItem(LS_KEY()) || '[]') || [];
      } catch { items = []; }
      if (!Array.isArray(items)) items = [];
      prune();
      renderBadge();
    };

    const save = () => {
      prune();
      localStorage.setItem(LS_KEY(), JSON.stringify(items.slice(-250)));
      renderBadge();
    };

    const prune = () => {
      // keep last 250, keep last 30 days max
      const cutoff = now() - 30 * 24 * 60 * 60 * 1000;
      items = items.filter(x => x && x.ts >= cutoff).slice(-250);
    };

    const add = (notif) => {
      const n = {
        id: String(notif.id || `n_${now()}_${Math.random().toString(16).slice(2)}`),
        type: notif.type || 'info',
        ts: Number(notif.ts || now()),
        title: notif.title || 'Notification',
        body: notif.body || '',
        read: !!notif.read,
        meta: notif.meta || {},
      };
      items.push(n);
      save();
    };

    const unreadCount = () => items.reduce((a, n) => a + (n.read ? 0 : 1), 0);

    const renderBadge = () => {
      const n = unreadCount();
      if (!State.authed) {
        el.inboxBtnWrap.style.display = 'none';
        return;
      }
      el.inboxBtnWrap.style.display = 'inline-block';
      if (n > 0) {
        el.inboxBadgeMini.textContent = String(n > 99 ? '99+' : n);
        el.inboxBadgeMini.classList.add('show');
      } else {
        el.inboxBadgeMini.classList.remove('show');
      }
    };

    const open = () => {
      load();
      const wrap = ce('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '10px';

      const top = ce('div');
      top.style.display = 'flex';
      top.style.gap = '10px';
      top.style.alignItems = 'center';
      top.style.justifyContent = 'space-between';

      const left = ce('div');
      left.innerHTML = `<div style="font-weight:950">Inbox</div><div class="muted tiny">Mentions, invites, security notices. No “clear all”.</div>`;

      const right = ce('div');
      right.style.display = 'flex';
      right.style.gap = '8px';

      const markAll = ce('button', { className: 'btn small', textContent: 'Mark all read' });
      markAll.addEventListener('click', () => {
        items = items.map(x => ({ ...x, read: true }));
        save();
        Modal.close();
        open();
      });

      right.append(markAll);
      top.append(left, right);

      const list = ce('div');
      list.style.display = 'flex';
      list.style.flexDirection = 'column';
      list.style.gap = '8px';

      const sorted = items.slice().sort((a, b) => b.ts - a.ts);
      if (sorted.length === 0) {
        list.append(ce('div', { className: 'muted tiny', textContent: 'Nothing here yet.' }));
      } else {
        for (const n of sorted) {
          const card = ce('div');
          card.style.border = '1px solid rgba(255,255,255,.10)';
          card.style.borderRadius = '14px';
          card.style.background = n.read ? 'rgba(255,255,255,.02)' : 'rgba(255,255,255,.04)';
          card.style.padding = '10px';
          card.style.display = 'flex';
          card.style.flexDirection = 'column';
          card.style.gap = '6px';

          const row = ce('div');
          row.style.display = 'flex';
          row.style.alignItems = 'center';
          row.style.justifyContent = 'space-between';
          row.style.gap = '10px';

          const title = ce('div');
          title.style.fontWeight = '950';
          title.style.minWidth = '0';
          title.style.overflow = 'hidden';
          title.style.textOverflow = 'ellipsis';
          title.style.whiteSpace = 'nowrap';
          title.textContent = n.title;

          const time = ce('div', { className: 'muted tiny', textContent: `${formatDate(n.ts)} ${formatTime(n.ts)}` });

          row.append(title, time);

          const body = ce('div', { className: 'tiny muted' });
          body.style.whiteSpace = 'pre-wrap';
          body.textContent = n.body;

          const actions = ce('div');
          actions.style.display = 'flex';
          actions.style.gap = '8px';
          actions.style.flexWrap = 'wrap';

          const mark = ce('button', { className: 'btn small', textContent: n.read ? 'Mark unread' : 'Mark read' });
          mark.addEventListener('click', () => {
            n.read = !n.read;
            save();
            Modal.close();
            open();
          });

          const del = ce('button', { className: 'btn small', textContent: 'Delete' });
          del.addEventListener('click', () => {
            items = items.filter(x => x.id !== n.id);
            save();
            Modal.close();
            open();
          });

          // contextual quick actions
          if (n.meta && n.meta.channelId) {
            const go = ce('button', { className: 'btn small primary', textContent: 'Go' });
            go.addEventListener('click', () => {
              Modal.close();
              Channels.select(n.meta.channelId);
            });
            actions.append(go);
          }

          actions.append(mark, del);
          card.append(row, body, actions);
          list.append(card);
        }
      }

      wrap.append(top, list);
      Modal.open('Inbox', wrap);
    };

    return { load, add, open, renderBadge };
  })();

  el.inboxBtn.addEventListener('click', () => Inbox.open());

  /* ----------------------------- State ----------------------------- */
  const State = {
    authed: false,
    socketReady: false,
    user: null, // {username, token, createdAt, lastSeen, level, badges, isGuest}
    channels: [], // {id, name, type:'global'|'group'|'dm', owner, membersCount, limit, muted:Set, ...}
    currentChannelId: null,
    messages: new Map(), // channelId -> array
    online: [], // {username, status, lastSeen}
    blocked: new Set(),
    roles: { isOwner: false }, // for current group
  };

  /* ----------------------------- Socket wiring ----------------------------- */
  const socket = (typeof io === 'function') ? io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelayMax: 4000
  }) : null;

  const emitAck = (event, payload, timeoutMs = 9000) => {
    return new Promise((resolve) => {
      if (!socket) return resolve({ ok: false, error: 'Socket not available' });
      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ ok: false, error: 'Timed out' });
      }, timeoutMs);

      socket.emit(event, payload, (resp) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(resp || { ok: true });
      });
    });
  };

  if (socket) {
    socket.on('connect', () => {
      State.socketReady = true;
      // try resume
      const saved = Session.load();
      if (saved && !State.authed) {
        Auth.resume(saved).catch(() => {});
      }
    });

    socket.on('disconnect', () => {
      State.socketReady = false;
      if (State.authed) Toast.show('Disconnected. Reconnecting…', 'error', 2400);
    });

    // bootstrap data
    socket.on('bootstrap', (data) => {
      try { Boot.apply(data); } catch (_) {}
    });

    // real-time
    socket.on('channels', (data) => {
      if (!data) return;
      Boot.apply({ channels: data.channels || data });
    });

    socket.on('online', (data) => {
      Boot.apply({ online: data.online || data });
    });

    socket.on('message', (m) => {
      Messages.onIncoming(m);
    });

    socket.on('systemNotification', (n) => {
      // server can push notifications here (mentions/invites/security)
      Inbox.add(n);
    });

    socket.on('groupUpdated', (g) => {
      Channels.upsert(g);
      Channels.render();
      if (State.currentChannelId === g.id) {
        Channels.setTopicForChannel(g.id);
      }
    });

    socket.on('profile', (p) => {
      // if server pushes profile updates
      if (p?.username) {
        if (p.username === State.user?.username) {
          // keep local stats fresh
          State.user.createdAt = p.createdAt ?? State.user.createdAt;
          State.user.lastSeen = p.lastSeen ?? State.user.lastSeen;
          State.user.level = p.level ?? State.user.level;
          State.user.badges = p.badges ?? State.user.badges;
        }
      }
    });

    // optional: server tells us cooldown/limits
    socket.on('cooldown', (cd) => {
      if (cd && Number.isFinite(cd.ms)) Cooldown.setCooldownMs(cd.ms);
    });
  }

  /* ----------------------------- Session persistence ----------------------------- */
  const Session = (() => {
    const KEY = 'tonkotsu_session_v1';
    const save = (obj) => localStorage.setItem(KEY, JSON.stringify(obj));
    const load = () => {
      try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
    };
    const clear = () => localStorage.removeItem(KEY);
    return { save, load, clear };
  })();

  /* ----------------------------- Auth ----------------------------- */
  const Auth = (() => {
    const validUser = (u) => /^[a-z0-9_]{4,20}$/i.test(u);
    const validPass = (p) => /^[a-z0-9_]{4,32}$/i.test(p);

    const setAuthedUI = () => {
      el.mePill.style.display = 'inline-flex';
      el.meName.textContent = State.user?.username || 'You';
      el.inboxBtnWrap.style.display = 'inline-block';
      Inbox.renderBadge();
      el.loginOverlay.classList.add('hidden');
      setTimeout(() => el.loginOverlay.style.display = 'none', 240);
    };

    const setLoggedOutUI = () => {
      el.loginOverlay.style.display = 'flex';
      el.loginOverlay.classList.remove('hidden');
      el.mePill.style.display = 'none';
      el.inboxBtnWrap.style.display = 'none';
    };

    const welcomeOnce = () => {
      const u = State.user?.username;
      if (!u) return;
      const k = `tonkotsu_welcome_seen_${u}`;
      if (localStorage.getItem(k) === '1') return;
      localStorage.setItem(k, '1');

      const wrap = ce('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '10px';

      wrap.append(
        ce('div', { innerHTML: `<div style="font-weight:950;font-size:14px">Welcome to tonkotsu.online (beta)</div>
          <div class="muted tiny" style="margin-top:4px;line-height:1.45">
            Accounts and data are not guaranteed to persist after a new update.
            If you see problems, contact <span style="font-weight:950">fishy_x1</span> on Discord
            or <span style="font-weight:950">fishyramen</span> on GitHub.
          </div>` })
      );

      const ok = ce('button', { className: 'btn primary', textContent: 'Got it' });
      ok.addEventListener('click', () => Modal.close());
      wrap.append(ok);

      Modal.open('Welcome', wrap);
    };

    const login = async ({ username, password, guest = false }) => {
      if (!socket) {
        Toast.show('Socket.io missing. Ensure /socket.io/socket.io.js loads.', 'error', 5000);
        return { ok: false, error: 'No socket' };
      }

      if (!guest) {
        if (!validUser(username)) return { ok: false, error: 'Username must be 4–20 letters/numbers/_.' };
        if (!validPass(password)) return { ok: false, error: 'Password must be 4–32 letters/numbers/_.' };
      }

      Loading.show('Signing in', 'verifying…');
      const resp = await emitAck('auth', guest ? { guest: true } : { username, password });

      if (!resp || !resp.ok) {
        Loading.hide();
        return { ok: false, error: resp?.error || 'Login failed' };
      }

      // expected: {ok:true, token, user:{username,createdAt,lastSeen,level,badges}, isNew}
      State.authed = true;
      State.user = resp.user || {
        username: username || resp.username || 'guest',
        createdAt: resp.createdAt || now(),
        lastSeen: resp.lastSeen || now(),
        level: resp.level || 1,
        badges: resp.badges || [],
        isGuest: !!guest
      };
      State.user.token = resp.token || resp.sessionToken || null;

      // blocked list from server if present
      State.blocked = new Set((resp.blocked || State.user.blocked || []).map(x => String(x).toLowerCase()));

      Session.save({ token: State.user.token, username: State.user.username });

      // bootstrap request
      await Boot.fetch();

      // show UI
      setAuthedUI();
      Loading.done('Loading messages', 'syncing…');

      // welcome popup on first login (per-user once)
      if (resp.isNew) {
        // server knows new account
        setTimeout(welcomeOnce, 350);
      } else {
        // if server didn't send isNew, we still show once per user on first login in this browser
        setTimeout(welcomeOnce, 350);
      }

      return { ok: true };
    };

    const resume = async (saved) => {
      if (!socket || !saved || !saved.token) return;
      Loading.show('Resuming session', 'syncing…');
      const resp = await emitAck('resume', { token: saved.token });
      if (!resp || !resp.ok) {
        Loading.hide();
        Session.clear();
        setLoggedOutUI();
        return;
      }
      State.authed = true;
      State.user = resp.user || { username: saved.username || 'you' };
      State.user.token = saved.token;

      State.blocked = new Set((resp.blocked || []).map(x => String(x).toLowerCase()));

      await Boot.fetch();
      setAuthedUI();
      Loading.done('Loaded', 'ready');
    };

    const logout = async () => {
      try { await emitAck('logout', {}); } catch (_) {}
      Session.clear();
      State.authed = false;
      State.user = null;
      State.channels = [];
      State.messages.clear();
      State.currentChannelId = null;
      setLoggedOutUI();
      UI.clearAll();
      Toast.show('Logged out.', 'ok', 2200);
    };

    return { login, resume, logout };
  })();

  /* ----------------------------- Boot / data apply ----------------------------- */
  const Boot = (() => {
    const fetch = async () => {
      if (!socket) return;
      // Ask server for initial state.
      const resp = await emitAck('bootstrap', {});
      if (resp && resp.ok === false) {
        // server may not use ack for bootstrap; ignore
      } else if (resp && (resp.channels || resp.online)) {
        apply(resp);
      }
    };

    const apply = (data) => {
      if (!data) return;

      if (data.cooldownMs) Cooldown.setCooldownMs(data.cooldownMs);
      if (data.linkCooldownMs) Cooldown.setLinkCooldownMs(data.linkCooldownMs);

      if (Array.isArray(data.channels)) {
        State.channels = normalizeChannels(data.channels);
        Channels.render();
        // default select
        if (!State.currentChannelId && State.channels.length) {
          const preferred = State.channels.find(c => c.type === 'global') || State.channels[0];
          Channels.select(preferred.id);
        } else if (State.currentChannelId) {
          Channels.setTopicForChannel(State.currentChannelId);
        }
      }

      if (Array.isArray(data.online)) {
        State.online = data.online.map(o => ({
          username: String(o.username || o.name || '').trim(),
          status: o.status || 'online',
          lastSeen: o.lastSeen || now()
        })).filter(x => x.username);
        Online.render();
      }

      if (Array.isArray(data.messages)) {
        // optional bootstrap messages: [{channelId, items:[...]}]
        for (const pack of data.messages) {
          const cid = pack.channelId;
          const arr = (pack.items || []).map(Messages.normalize);
          State.messages.set(cid, arr);
        }
        Messages.renderCurrent();
      }

      // user stats updates
      if (data.user && State.user) {
        State.user.createdAt = data.user.createdAt ?? State.user.createdAt;
        State.user.lastSeen = data.user.lastSeen ?? State.user.lastSeen;
        State.user.level = data.user.level ?? State.user.level;
        State.user.badges = data.user.badges ?? State.user.badges;
      }

      Inbox.load();
    };

    const normalizeChannels = (channels) => {
      const out = [];
      for (const c of channels) {
        if (!c) continue;
        out.push({
          id: String(c.id ?? c.channelId ?? c.name ?? Math.random()),
          name: String(c.name ?? 'channel'),
          type: c.type || (c.isDM ? 'dm' : (c.isGroup ? 'group' : 'global')),
          owner: c.owner || null,
          members: Array.isArray(c.members) ? c.members.slice() : null,
          membersCount: Number.isFinite(c.membersCount) ? c.membersCount : (Array.isArray(c.members) ? c.members.length : null),
          limit: Number.isFinite(c.limit) ? c.limit : null,
          cooldownMs: Number.isFinite(c.cooldownMs) ? c.cooldownMs : null,
          muted: c.muted || [],
          unread: Number.isFinite(c.unread) ? c.unread : 0,
          lastActivity: c.lastActivity || 0,
        });
      }
      // sort: unread first, then last activity
      out.sort((a, b) => (b.unread - a.unread) || ((b.lastActivity || 0) - (a.lastActivity || 0)));
      return out;
    };

    return { fetch, apply };
  })();

  /* ----------------------------- UI core ----------------------------- */
  const UI = (() => {
    const clearAll = () => {
      el.channelList.innerHTML = '';
      el.onlineList.innerHTML = '';
      el.chat.innerHTML = '';
      el.topicTitle.textContent = '# global';
      el.topicSub.textContent = 'everyone';
      el.manageBtn.classList.remove('show');
      el.inboxBadgeMini.classList.remove('show');
    };

    return { clearAll };
  })();

  /* ----------------------------- Channels ----------------------------- */
  const Channels = (() => {
    const render = () => {
      el.channelList.innerHTML = '';
      for (const c of State.channels) {
        const item = ce('div', { className: 'item' + (c.id === State.currentChannelId ? ' active' : '') });

        const left = ce('div', { className: 'left' });
        const hash = ce('div', { className: 'hash', textContent: c.type === 'dm' ? '✉' : '#' });
        const nameCol = ce('div', { className: 'nameCol' });

        const title = ce('div', { className: 'name', textContent: c.name });
        const sub = ce('div', {
          className: 'sub',
          textContent: c.type === 'dm'
            ? 'direct'
            : (c.type === 'group'
              ? (c.membersCount ? `${c.membersCount} members` : 'group')
              : 'global')
        });

        nameCol.append(title, sub);
        left.append(hash, nameCol);

        const badge = ce('div', { className: 'badge', textContent: String(c.unread || 0) });
        if ((c.unread || 0) > 0) badge.classList.add('show');

        item.append(left, badge);

        item.addEventListener('click', () => {
          select(c.id);
          if (document.body.getAttribute('data-mobile') === '1') UX.toggleSidebar(false);
        });

        el.channelList.appendChild(item);
      }
      bindRipples(el.channelList);
    };

    const upsert = (chan) => {
      if (!chan) return;
      const id = String(chan.id ?? chan.channelId ?? chan.name);
      const idx = State.channels.findIndex(x => x.id === id);
      const merged = Object.assign({}, (idx >= 0 ? State.channels[idx] : {}), Boot.apply ? {} : {}, {
        id,
        name: String(chan.name ?? (idx >= 0 ? State.channels[idx].name : 'channel')),
        type: chan.type || (chan.isDM ? 'dm' : (chan.isGroup ? 'group' : (idx >= 0 ? State.channels[idx].type : 'global'))),
        owner: chan.owner ?? (idx >= 0 ? State.channels[idx].owner : null),
        members: Array.isArray(chan.members) ? chan.members.slice() : (idx >= 0 ? State.channels[idx].members : null),
        membersCount: Number.isFinite(chan.membersCount) ? chan.membersCount
          : (Array.isArray(chan.members) ? chan.members.length : (idx >= 0 ? State.channels[idx].membersCount : null)),
        limit: Number.isFinite(chan.limit) ? chan.limit : (idx >= 0 ? State.channels[idx].limit : null),
        cooldownMs: Number.isFinite(chan.cooldownMs) ? chan.cooldownMs : (idx >= 0 ? State.channels[idx].cooldownMs : null),
        muted: chan.muted ?? (idx >= 0 ? State.channels[idx].muted : []),
        unread: Number.isFinite(chan.unread) ? chan.unread : (idx >= 0 ? State.channels[idx].unread : 0),
        lastActivity: chan.lastActivity ?? (idx >= 0 ? State.channels[idx].lastActivity : 0),
      });

      if (idx >= 0) State.channels[idx] = merged;
      else State.channels.push(merged);
    };

    const select = async (id) => {
      State.currentChannelId = id;
      render();
      setTopicForChannel(id);

      // reset unread locally
      const c = State.channels.find(x => x.id === id);
      if (c) c.unread = 0;

      // ask server for history if we don’t have it
      if (!State.messages.has(id) && socket) {
        const resp = await emitAck('getMessages', { channelId: id, limit: 60 });
        if (resp?.ok && Array.isArray(resp.items)) {
          State.messages.set(id, resp.items.map(Messages.normalize));
        } else {
          State.messages.set(id, []);
        }
      }

      Messages.renderCurrent();

      // notify server that we viewed channel (for unread accounting)
      if (socket) socket.emit('viewChannel', { channelId: id });

      // apply per-channel cooldown if provided
      const cd = c?.cooldownMs;
      if (Number.isFinite(cd) && cd > 200) Cooldown.setCooldownMs(cd);
    };

    const setTopicForChannel = (id) => {
      const c = State.channels.find(x => x.id === id);
      if (!c) return;

      el.topicTitle.textContent = (c.type === 'dm' ? `✉ ${c.name}` : `# ${c.name}`);

      // show manage button for group chats only
      if (c.type === 'group') {
        el.manageBtn.classList.add('show');
        // owner label in sub
        const mem = c.membersCount ? `${c.membersCount} members` : 'group';
        const limit = Number.isFinite(c.limit) ? ` • limit ${c.limit}` : '';
        el.topicSub.textContent = `${mem}${limit}`;
      } else {
        el.manageBtn.classList.remove('show');
        el.topicSub.textContent = (c.type === 'dm' ? 'direct message' : 'everyone');
      }

      // compute owner state
      State.roles.isOwner = (c.type === 'group' && c.owner && State.user && String(c.owner).toLowerCase() === String(State.user.username).toLowerCase());
    };

    return { render, select, upsert, setTopicForChannel };
  })();

  /* ----------------------------- Online list ----------------------------- */
  const Online = (() => {
    const statusClass = (s) => {
      const x = String(s || 'online').toLowerCase();
      if (x.includes('idle') || x.includes('away')) return 'idle';
      if (x.includes('dnd') || x.includes('busy') || x.includes('mute')) return 'dnd';
      if (x.includes('off')) return 'offline';
      return 'online';
    };

    const render = () => {
      el.onlineList.innerHTML = '';
      const me = (State.user?.username || '').toLowerCase();

      const list = State.online.slice().sort((a, b) => {
        const sa = statusClass(a.status);
        const sb = statusClass(b.status);
        const rank = { online: 0, idle: 1, dnd: 2, offline: 3 };
        return (rank[sa] - rank[sb]) || a.username.localeCompare(b.username);
      });

      for (const u of list) {
        const row = ce('div', { className: 'onlineRow' });

        const left = ce('div');
        left.style.display = 'flex';
        left.style.alignItems = 'center';
        left.style.gap = '10px';
        left.style.minWidth = '0';

        const dot = ce('div', { className: `dot ${statusClass(u.status)}` });
        const name = ce('div', { className: 'name', textContent: u.username });
        name.style.fontSize = '13px';

        left.append(dot, name);

        const right = ce('div', { className: 'muted tiny', textContent: u.username.toLowerCase() === me ? 'you' : '' });

        row.append(left, right);

        row.addEventListener('click', () => Profiles.open(u.username));
        el.onlineList.appendChild(row);
      }
    };

    return { render };
  })();

  /* ----------------------------- Messages & embeds ----------------------------- */
  const Messages = (() => {
    const normalize = (m) => ({
      id: String(m.id ?? m.messageId ?? `m_${now()}_${Math.random().toString(16).slice(2)}`),
      channelId: String(m.channelId ?? m.cid ?? State.currentChannelId ?? 'global'),
      username: String(m.username ?? m.user ?? 'unknown'),
      text: String(m.text ?? m.message ?? ''),
      ts: Number(m.ts ?? m.time ?? now()),
      // optional fields
      meta: m.meta || {},
    });

    const getArr = (channelId) => {
      if (!State.messages.has(channelId)) State.messages.set(channelId, []);
      return State.messages.get(channelId);
    };

    const addLocal = (m) => {
      const nm = normalize(m);
      const arr = getArr(nm.channelId);
      arr.push(nm);
      // cap
      if (arr.length > 600) arr.splice(0, arr.length - 600);
      // update last activity
      const c = State.channels.find(x => x.id === nm.channelId);
      if (c) c.lastActivity = nm.ts;
      return nm;
    };

    const onIncoming = (m) => {
      const nm = normalize(m);

      // blocked filter (client-side): hide from view and prevent mention notifs
      if (State.blocked.has(nm.username.toLowerCase())) return;

      addLocal(nm);

      // mention notification
      const me = State.user?.username;
      if (me && new RegExp(`\\B@${me}\\b`, 'i').test(nm.text)) {
        Inbox.add({
          type: 'mention',
          title: `Mentioned by ${nm.username}`,
          body: nm.text.slice(0, 250),
          meta: { channelId: nm.channelId }
        });
      }

      // unread count if not viewing
      if (State.currentChannelId !== nm.channelId) {
        const c = State.channels.find(x => x.id === nm.channelId);
        if (c) {
          c.unread = (c.unread || 0) + 1;
          Channels.render();
        }
      } else {
        renderCurrent(true);
      }
    };

    const renderCurrent = (scrollToBottom = false) => {
      const cid = State.currentChannelId;
      if (!cid) return;
      const arr = getArr(cid);

      el.chat.innerHTML = '';

      for (const m of arr) {
        const row = ce('div', { className: 'msg' });
        const bubble = ce('div', { className: 'bubble' });

        const meta = ce('div', { className: 'meta' });
        const user = ce('div', { className: 'user', textContent: m.username });
        user.addEventListener('click', () => Profiles.open(m.username));

        const time = ce('div', { className: 'time', textContent: formatTime(m.ts) });

        meta.append(user, time);

        const text = ce('div', { className: 'text' });
        text.innerHTML = renderText(m.text);

        bubble.append(meta, text);

        // embed cards (1 card max per message to keep it small)
        const urls = Moderation.extractUrls(m.text);
        const safeUrls = urls.filter(u => !Moderation.isBannedUrl(u));
        if (safeUrls.length > 0) {
          const card = makeEmbedCard(safeUrls[0]);
          if (card) bubble.append(card);
        }

        row.appendChild(bubble);
        el.chat.appendChild(row);
      }

      bindRipples(el.chat);

      if (scrollToBottom) {
        requestAnimationFrame(() => {
          el.chat.scrollTop = el.chat.scrollHeight;
        });
      }
    };

    const renderText = (t) => {
      const me = State.user?.username || '';
      const safe = escapeHTML(String(t || ''));

      // linkify, mentions, keep it light
      const withMentions = me
        ? safe.replace(new RegExp(`\\B@(${escapeReg(me)})\\b`, 'ig'), `<span class="mention">@$1</span>`)
        : safe;

      const linked = withMentions.replace(/\bhttps?:\/\/[^\s<>()]+/ig, (u) => {
        const url = u.replace(/[)\].,!?:;]+$/g, '');
        const shown = escapeHTML(url.length > 56 ? url.slice(0, 53) + '…' : url);
        return `<a href="${escapeHTML(url)}" target="_blank" rel="noreferrer" style="color:rgba(255,255,255,.82);font-weight:900;text-decoration:none;border-bottom:1px solid rgba(255,255,255,.18)">${shown}</a>`;
      });

      return linked;
    };

    const escapeReg = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const makeEmbedCard = (urlStr) => {
      let url;
      try { url = new URL(urlStr); } catch { return null; }

      const host = url.hostname.replace(/^www\./, '');
      const path = url.pathname.length > 38 ? url.pathname.slice(0, 35) + '…' : url.pathname;

      const card = ce('div');
      card.style.marginTop = '8px';
      card.style.borderRadius = '14px';
      card.style.border = '1px solid rgba(255,255,255,.10)';
      card.style.background = 'rgba(255,255,255,.02)';
      card.style.padding = '10px';
      card.style.display = 'flex';
      card.style.gap = '10px';
      card.style.alignItems = 'center';

      const icon = ce('div');
      icon.style.width = '40px';
      icon.style.height = '40px';
      icon.style.borderRadius = '14px';
      icon.style.border = '1px solid rgba(255,255,255,.10)';
      icon.style.background = 'rgba(255,255,255,.04)';
      icon.style.display = 'flex';
      icon.style.alignItems = 'center';
      icon.style.justifyContent = 'center';
      icon.style.fontWeight = '950';
      icon.textContent = '↗';

      // special: YouTube thumbnail (no fetch needed)
      if (/^(youtube\.com|youtu\.be)$/i.test(host)) {
        const id = (() => {
          if (host === 'youtu.be') return url.pathname.slice(1);
          if (url.searchParams.get('v')) return url.searchParams.get('v');
          const m = url.pathname.match(/\/shorts\/([^/]+)/);
          return m ? m[1] : null;
        })();

        if (id) {
          const img = ce('img');
          img.alt = 'preview';
          img.src = `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
          img.style.width = '52px';
          img.style.height = '40px';
          img.style.objectFit = 'cover';
          img.style.borderRadius = '14px';
          img.style.border = '1px solid rgba(255,255,255,.10)';
          icon.replaceWith(img);
        }
      }

      const col = ce('div');
      col.style.minWidth = '0';
      col.style.display = 'flex';
      col.style.flexDirection = 'column';
      col.style.gap = '3px';

      const a = ce('a');
      a.href = urlStr;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.style.color = 'rgba(255,255,255,.88)';
      a.style.fontWeight = '950';
      a.style.textDecoration = 'none';
      a.textContent = host;

      const b = ce('div', { className: 'muted tiny', textContent: path || '/' });

      col.append(a, b);

      card.append(icon, col);
      return card;
    };

    return { normalize, addLocal, onIncoming, renderCurrent };
  })();

  /* ----------------------------- Profiles (badges + stats) ----------------------------- */
  const Profiles = (() => {
    const levelBadges = (lvl) => {
      const out = [];
      const thresholds = [10, 25, 50, 75, 100];
      for (const t of thresholds) if (lvl >= t) out.push(`Lv ${t}`);
      return out;
    };

    const prettyBadge = (label) => {
      const b = ce('span', { textContent: label });
      Object.assign(b.style, {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '22px',
        padding: '0 10px',
        borderRadius: '10px',
        border: '1px solid rgba(255,255,255,.12)',
        background: 'rgba(255,255,255,.03)',
        fontWeight: '950',
        fontSize: '12px',
        color: 'rgba(255,255,255,.90)',
      });
      return b;
    };

    const open = async (username) => {
      const wrap = ce('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '12px';

      const top = ce('div');
      top.innerHTML = `<div style="font-weight:950;font-size:14px">${escapeHTML(username)}</div>
        <div class="muted tiny">Profile</div>`;

      wrap.append(top);

      // optimistic skeleton
      const skeleton = ce('div', { className: 'muted tiny', textContent: 'Loading…' });
      wrap.append(skeleton);

      Modal.open('Profile', wrap);

      // fetch from server if possible
      let profile = null;
      if (socket) {
        const resp = await emitAck('getProfile', { username });
        if (resp?.ok && resp.profile) profile = resp.profile;
      }

      // fallback minimal
      if (!profile) {
        profile = {
          username,
          createdAt: null,
          lastSeen: null,
          level: null,
          badges: [],
          isBeta: null,
        };
      }

      // derive beta + levels
      const badges = [];
      if (profile.isBeta === true) badges.push('Early User');
      if (Number.isFinite(profile.level)) badges.push(...levelBadges(profile.level));
      if (Array.isArray(profile.badges)) badges.push(...profile.badges);

      // rebuild body
      wrap.removeChild(skeleton);

      const stats = ce('div');
      stats.style.display = 'grid';
      stats.style.gridTemplateColumns = '1fr 1fr';
      stats.style.gap = '10px';

      const statCard = (k, v) => {
        const c = ce('div');
        Object.assign(c.style, {
          borderRadius: '14px',
          border: '1px solid rgba(255,255,255,.10)',
          background: 'rgba(255,255,255,.02)',
          padding: '10px',
        });
        const a = ce('div', { textContent: k });
        a.style.fontWeight = '950';
        a.style.fontSize = '12.5px';
        const b = ce('div', { className: 'muted tiny', textContent: v || '—' });
        b.style.marginTop = '4px';
        c.append(a, b);
        return c;
      };

      stats.append(
        statCard('Account created', profile.createdAt ? formatDate(profile.createdAt) : '—'),
        statCard('Last seen', profile.lastSeen ? `${formatDate(profile.lastSeen)} ${formatTime(profile.lastSeen)}` : '—'),
        statCard('Level', Number.isFinite(profile.level) ? String(profile.level) : '—'),
        statCard('Status', profile.status ? String(profile.status) : '—')
      );

      const badgeWrap = ce('div');
      badgeWrap.style.display = 'flex';
      badgeWrap.style.flexWrap = 'wrap';
      badgeWrap.style.gap = '8px';

      if (badges.length === 0) {
        badgeWrap.append(ce('div', { className: 'muted tiny', textContent: 'No badges yet.' }));
      } else {
        for (const b of Array.from(new Set(badges)).slice(0, 14)) badgeWrap.append(prettyBadge(b));
      }

      const actions = ce('div');
      actions.style.display = 'flex';
      actions.style.gap = '10px';
      actions.style.flexWrap = 'wrap';

      const blockBtn = ce('button', { className: 'btn', textContent: State.blocked.has(username.toLowerCase()) ? 'Unblock' : 'Block' });
      blockBtn.addEventListener('click', async () => {
        const u = username.toLowerCase();
        if (State.blocked.has(u)) {
          await Settings.unblockUser(u);
          Toast.show(`Unblocked ${username}`, 'ok', 2200);
        } else {
          await Settings.blockUser(u);
          Toast.show(`Blocked ${username}`, 'ok', 2200);
        }
        Modal.close();
      });

      const dmBtn = ce('button', { className: 'btn primary', textContent: 'Message' });
      dmBtn.addEventListener('click', async () => {
        Modal.close();
        await DMs.openOrCreate(username);
      });

      actions.append(dmBtn, blockBtn);

      wrap.append(
        ce('div', { innerHTML: `<div style="font-weight:950">Badges</div><div class="muted tiny" style="margin-top:4px">Shown on your profile.</div>` }),
        badgeWrap,
        ce('div', { innerHTML: `<div style="font-weight:950">Stats</div><div class="muted tiny" style="margin-top:4px">Basic account information.</div>` }),
        stats,
        ce('div', { innerHTML: `<div style="font-weight:950">Actions</div>` }),
        actions
      );
    };

    return { open };
  })();

  /* ----------------------------- DMs helper ----------------------------- */
  const DMs = (() => {
    const openOrCreate = async (username) => {
      // server should create/find DM channel
      if (!socket) return;

      Loading.show('Opening DM', 'syncing…');
      const resp = await emitAck('openDM', { username });
      if (resp?.ok && resp.channel) {
        Channels.upsert(resp.channel);
        Channels.render();
        await Channels.select(String(resp.channel.id));
        Loading.done('Opened', 'ready');
      } else {
        Loading.hide();
        Toast.show(resp?.error || 'Could not open DM.', 'error', 3200);
      }
    };
    return { openOrCreate };
  })();

  /* ----------------------------- Group management (Manage modal) ----------------------------- */
  const Manage = (() => {
    const open = async () => {
      const cid = State.currentChannelId;
      const chan = State.channels.find(x => x.id === cid);
      if (!chan || chan.type !== 'group') return;

      // fetch latest group data from server
      let g = chan;
      if (socket) {
        const resp = await emitAck('getGroup', { channelId: cid });
        if (resp?.ok && resp.group) g = Object.assign({}, g, resp.group);
      }

      const isOwner = State.roles.isOwner;

      const wrap = ce('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '12px';

      // header
      wrap.append(
        ce('div', {
          innerHTML: `<div style="font-weight:950;font-size:14px">${escapeHTML(g.name)}</div>
            <div class="muted tiny">Manage members, ownership, limits, and moderation.</div>`
        })
      );

      // Limit slider (owner can turn DOWN only)
      const limitCard = ce('div');
      Object.assign(limitCard.style, {
        borderRadius: '14px',
        border: '1px solid rgba(255,255,255,.10)',
        background: 'rgba(255,255,255,.02)',
        padding: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px'
      });

      const currentLimit = Number.isFinite(g.limit) ? g.limit : 30;
      const minLimit = 2;
      const maxLimit = Math.max(currentLimit, 50);

      const limitTop = ce('div');
      limitTop.style.display = 'flex';
      limitTop.style.alignItems = 'center';
      limitTop.style.justifyContent = 'space-between';
      limitTop.style.gap = '10px';

      const limitLabel = ce('div', { textContent: 'Group limit' });
      limitLabel.style.fontWeight = '950';

      const limitVal = ce('div', { className: 'muted tiny', textContent: String(currentLimit) });

      limitTop.append(limitLabel, limitVal);

      const slider = ce('input');
      slider.type = 'range';
      slider.min = String(minLimit);
      slider.max = String(maxLimit);
      slider.value = String(currentLimit);
      slider.style.width = '100%';
      slider.disabled = !isOwner;
      slider.title = isOwner ? 'Owner can reduce the limit.' : 'Only the owner can change this.';

      const limitHint = ce('div', { className: 'muted tiny' });
      limitHint.textContent = isOwner
        ? 'You can reduce the limit. Increasing it requires creating a new group or owner approval (server policy).'
        : 'Only the group owner can change the limit.';

      slider.addEventListener('input', () => {
        const v = Number(slider.value);
        limitVal.textContent = String(v);
      });

      const applyLimit = ce('button', { className: 'btn small primary', textContent: 'Apply limit' });
      applyLimit.disabled = !isOwner;
      applyLimit.addEventListener('click', async () => {
        const v = Number(slider.value);
        if (!Number.isFinite(v)) return;

        // enforce “down only” client-side
        const current = Number.isFinite(g.limit) ? g.limit : currentLimit;
        if (v > current) {
          Toast.show('You can only lower the limit here.', 'error', 2600);
          slider.value = String(current);
          limitVal.textContent = String(current);
          return;
        }

        const resp = await emitAck('setGroupLimit', { channelId: cid, limit: v });
        if (resp?.ok) {
          Toast.show('Limit updated.', 'ok', 2200);
          g.limit = v;
          Channels.upsert({ id: cid, limit: v });
          Channels.render();
          Channels.setTopicForChannel(cid);
        } else {
          Toast.show(resp?.error || 'Could not update limit.', 'error', 2800);
        }
      });

      const limitActions = ce('div');
      limitActions.style.display = 'flex';
      limitActions.style.justifyContent = 'flex-end';
      limitActions.append(applyLimit);

      limitCard.append(limitTop, slider, limitHint, limitActions);

      wrap.append(limitCard);

      // Members management
      const members = Array.isArray(g.members) ? g.members.slice() : [];
      const owner = g.owner || chan.owner;

      const memCard = ce('div');
      Object.assign(memCard.style, {
        borderRadius: '14px',
        border: '1px solid rgba(255,255,255,.10)',
        background: 'rgba(255,255,255,.02)',
        padding: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px'
      });

      memCard.append(ce('div', { innerHTML: `<div style="font-weight:950">Members</div><div class="muted tiny">Add, remove, mute, unmute, or transfer ownership.</div>` }));

      // Add member row
      const addRow = ce('div');
      addRow.style.display = 'flex';
      addRow.style.gap = '10px';

      const addInput = ce('input', { className: 'field', placeholder: 'username to add…' });
      const addBtn = ce('button', { className: 'btn primary', textContent: 'Add' });
      addBtn.style.width = '132px';
      addBtn.disabled = !isOwner;

      addBtn.addEventListener('click', async () => {
        const u = String(addInput.value || '').trim();
        if (!u) return;
        const resp = await emitAck('addGroupMember', { channelId: cid, username: u });
        if (resp?.ok) {
          Toast.show(`Added ${u}`, 'ok', 2200);
          addInput.value = '';
          // refresh group
          Modal.close();
          open();
        } else {
          Toast.show(resp?.error || 'Could not add user.', 'error', 2800);
        }
      });

      addRow.append(addInput, addBtn);
      memCard.append(addRow);

      // Member list
      const list = ce('div');
      list.style.display = 'flex';
      list.style.flexDirection = 'column';
      list.style.gap = '8px';

      const mutedSet = new Set((g.muted || chan.muted || []).map(x => String(x).toLowerCase()));

      const memRow = (u) => {
        const row = ce('div');
        Object.assign(row.style, {
          height: '40px',
          borderRadius: '12px',
          border: '1px solid rgba(255,255,255,.08)',
          background: 'rgba(255,255,255,.02)',
          padding: '0 10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px'
        });

        const left = ce('div');
        left.style.display = 'flex';
        left.style.alignItems = 'center';
        left.style.gap = '10px';
        left.style.minWidth = '0';

        const label = ce('div', { className: 'name', textContent: u });
        label.style.fontSize = '13px';
        label.addEventListener('click', () => Profiles.open(u));

        const tags = ce('div');
        tags.style.display = 'flex';
        tags.style.gap = '6px';
        tags.style.flexWrap = 'wrap';

        if (String(u).toLowerCase() === String(owner || '').toLowerCase()) {
          const t = ce('span', { textContent: 'Owner' });
          Object.assign(t.style, {
            height: '18px',
            padding: '0 8px',
            borderRadius: '9px',
            border: '1px solid rgba(255,255,255,.12)',
            background: 'rgba(255,255,255,.03)',
            fontSize: '11px',
            fontWeight: '950',
            color: 'rgba(255,255,255,.85)'
          });
          tags.append(t);
        }
        if (mutedSet.has(String(u).toLowerCase())) {
          const t = ce('span', { textContent: 'Muted' });
          Object.assign(t.style, {
            height: '18px',
            padding: '0 8px',
            borderRadius: '9px',
            border: '1px solid rgba(255,77,77,.18)',
            background: 'rgba(255,77,77,.06)',
            fontSize: '11px',
            fontWeight: '950',
            color: 'rgba(255,255,255,.85)'
          });
          tags.append(t);
        }

        left.append(label, tags);

        const actions = ce('div');
        actions.style.display = 'flex';
        actions.style.gap = '8px';

        const isSelf = State.user && String(u).toLowerCase() === String(State.user.username).toLowerCase();
        const isOwnerUser = String(u).toLowerCase() === String(owner || '').toLowerCase();

        const muteBtn = ce('button', { className: 'btn small', textContent: mutedSet.has(String(u).toLowerCase()) ? 'Unmute' : 'Mute' });
        muteBtn.disabled = !isOwner || isOwnerUser;

        muteBtn.addEventListener('click', async () => {
          const wantMute = !mutedSet.has(String(u).toLowerCase());
          const resp = await emitAck(wantMute ? 'muteGroupMember' : 'unmuteGroupMember', { channelId: cid, username: u });
          if (resp?.ok) {
            Toast.show(wantMute ? `Muted ${u}` : `Unmuted ${u}`, 'ok', 2200);
            Modal.close();
            open();
          } else {
            Toast.show(resp?.error || 'Action failed.', 'error', 2800);
          }
        });

        const removeBtn = ce('button', { className: 'btn small', textContent: 'Remove' });
        removeBtn.disabled = !isOwner || isOwnerUser || isSelf;

        removeBtn.addEventListener('click', async () => {
          const resp = await emitAck('removeGroupMember', { channelId: cid, username: u });
          if (resp?.ok) {
            Toast.show(`Removed ${u}`, 'ok', 2200);
            Modal.close();
            open();
          } else {
            Toast.show(resp?.error || 'Could not remove.', 'error', 2800);
          }
        });

        const transferBtn = ce('button', { className: 'btn small primary', textContent: 'Make owner' });
        transferBtn.disabled = !isOwner || isOwnerUser || isSelf;

        transferBtn.addEventListener('click', async () => {
          const resp = await emitAck('transferGroupOwnership', { channelId: cid, username: u });
          if (resp?.ok) {
            Toast.show(`Transferred ownership to ${u}`, 'ok', 2400);
            Modal.close();
          } else {
            Toast.show(resp?.error || 'Could not transfer ownership.', 'error', 2800);
          }
        });

        actions.append(muteBtn, removeBtn, transferBtn);

        row.append(left, actions);
        return row;
      };

      if (members.length === 0) {
        list.append(ce('div', { className: 'muted tiny', textContent: 'No member list available (server did not provide).'}));
      } else {
        for (const u of members) list.append(memRow(u));
      }

      memCard.append(list);

      if (!isOwner) {
        memCard.append(ce('div', { className: 'muted tiny', textContent: 'You are not the owner. You can view members but cannot manage them.' }));
      }

      wrap.append(memCard);

      // quick group actions
      const bottom = ce('div');
      bottom.style.display = 'flex';
      bottom.style.gap = '10px';
      bottom.style.flexWrap = 'wrap';
      bottom.style.justifyContent = 'flex-end';

      const settingsBtn = ce('button', { className: 'btn', textContent: 'Settings' });
      settingsBtn.addEventListener('click', () => {
        Modal.close();
        Settings.open();
      });

      bottom.append(settingsBtn);
      wrap.append(bottom);

      Modal.open('Manage group', wrap);
    };

    return { open };
  })();

  el.manageBtn.addEventListener('click', () => Manage.open());

  /* ----------------------------- Settings (Blocked users + Security analytics) ----------------------------- */
  const Settings = (() => {
    const blockUser = async (usernameLower) => {
      const u = String(usernameLower).toLowerCase();
      if (!u) return;
      State.blocked.add(u);
      persistBlocked();

      if (socket) {
        const resp = await emitAck('blockUser', { username: u });
        if (!resp?.ok) {
          // keep local anyway
        }
      }
    };

    const unblockUser = async (usernameLower) => {
      const u = String(usernameLower).toLowerCase();
      if (!u) return;
      State.blocked.delete(u);
      persistBlocked();

      if (socket) {
        const resp = await emitAck('unblockUser', { username: u });
        if (!resp?.ok) {
          // keep local anyway
        }
      }
    };

    const persistBlocked = () => {
      const k = `tonkotsu_blocked_${State.user?.username || 'anon'}`;
      localStorage.setItem(k, JSON.stringify(Array.from(State.blocked)));
    };

    const loadBlocked = () => {
      const k = `tonkotsu_blocked_${State.user?.username || 'anon'}`;
      try {
        const arr = JSON.parse(localStorage.getItem(k) || '[]');
        if (Array.isArray(arr)) State.blocked = new Set(arr.map(x => String(x).toLowerCase()));
      } catch {}
    };

    const openBlockedPopup = () => {
      loadBlocked();
      const wrap = ce('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '10px';

      wrap.append(ce('div', { innerHTML: `<div style="font-weight:950">Blocked users</div><div class="muted tiny">Messages from blocked users are hidden for you.</div>` }));

      const list = ce('div');
      list.style.display = 'flex';
      list.style.flexDirection = 'column';
      list.style.gap = '8px';

      const arr = Array.from(State.blocked).sort();
      if (arr.length === 0) {
        list.append(ce('div', { className: 'muted tiny', textContent: 'No blocked users.' }));
      } else {
        for (const u of arr) {
          const row = ce('div');
          Object.assign(row.style, {
            height: '40px',
            borderRadius: '12px',
            border: '1px solid rgba(255,255,255,.08)',
            background: 'rgba(255,255,255,.02)',
            padding: '0 10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px'
          });

          const name = ce('div', { className: 'name', textContent: u });
          name.style.fontSize = '13px';
          name.addEventListener('click', () => Profiles.open(u));

          const btn = ce('button', { className: 'btn small primary', textContent: 'Unblock' });
          btn.addEventListener('click', async () => {
            await unblockUser(u);
            Toast.show(`Unblocked ${u}`, 'ok', 2200);
            Modal.close();
            openBlockedPopup();
          });

          row.append(name, btn);
          list.append(row);
        }
      }

      wrap.append(list);
      Modal.open('Blocked users', wrap);
    };

    const open = async () => {
      if (!State.authed) return;

      loadBlocked();

      const wrap = ce('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '12px';

      const header = ce('div', {
        innerHTML: `<div style="font-weight:950;font-size:14px">Settings</div>
          <div class="muted tiny">Preferences, blocked users, and security analytics.</div>`
      });

      // Mobile UX Mode
      const mobileCard = ce('div');
      Object.assign(mobileCard.style, {
        borderRadius: '14px',
        border: '1px solid rgba(255,255,255,.10)',
        background: 'rgba(255,255,255,.02)',
        padding: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px'
      });

      const mobileTop = ce('div');
      mobileTop.style.display = 'flex';
      mobileTop.style.alignItems = 'center';
      mobileTop.style.justifyContent = 'space-between';
      mobileTop.style.gap = '10px';

      const mobileLabel = ce('div', { textContent: 'Mobile UX Mode' });
      mobileLabel.style.fontWeight = '950';

      const mode = UX.getForced(); // null auto
      const modeText = mode === null ? 'Auto' : (mode ? 'On' : 'Off');
      const mobileVal = ce('div', { className: 'muted tiny', textContent: modeText });

      mobileTop.append(mobileLabel, mobileVal);

      const mobileActions = ce('div');
      mobileActions.style.display = 'flex';
      mobileActions.style.gap = '8px';
      mobileActions.style.flexWrap = 'wrap';

      const btnAuto = ce('button', { className: 'btn small', textContent: 'Auto' });
      const btnOn = ce('button', { className: 'btn small', textContent: 'On' });
      const btnOff = ce('button', { className: 'btn small', textContent: 'Off' });

      const setBtns = () => {
        const f = UX.getForced();
        mobileVal.textContent = f === null ? 'Auto' : (f ? 'On' : 'Off');
        [btnAuto, btnOn, btnOff].forEach(b => b.classList.remove('primary'));
        if (f === null) btnAuto.classList.add('primary');
        else if (f === true) btnOn.classList.add('primary');
        else btnOff.classList.add('primary');
      };

      btnAuto.addEventListener('click', () => { UX.setForced(null); setBtns(); });
      btnOn.addEventListener('click', () => { UX.setForced(true); setBtns(); });
      btnOff.addEventListener('click', () => { UX.setForced(false); setBtns(); });

      mobileActions.append(btnAuto, btnOn, btnOff);
      mobileCard.append(mobileTop, ce('div', { className: 'muted tiny', textContent: 'For small screens: sidebar slides in and topic title toggles it.' }), mobileActions);

      // Blocked users button
      const blockedCard = ce('div');
      Object.assign(blockedCard.style, {
        borderRadius: '14px',
        border: '1px solid rgba(255,255,255,.10)',
        background: 'rgba(255,255,255,.02)',
        padding: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px'
      });

      const blockedTop = ce('div');
      blockedTop.style.display = 'flex';
      blockedTop.style.alignItems = 'center';
      blockedTop.style.justifyContent = 'space-between';
      blockedTop.style.gap = '10px';

      const blockedLabel = ce('div', { textContent: 'Blocked users' });
      blockedLabel.style.fontWeight = '950';

      const blockedCount = ce('div', { className: 'muted tiny', textContent: `${State.blocked.size}` });

      blockedTop.append(blockedLabel, blockedCount);

      const blockedBtn = ce('button', { className: 'btn small primary', textContent: 'Open' });
      blockedBtn.addEventListener('click', () => openBlockedPopup());

      blockedCard.append(blockedTop, ce('div', { className: 'muted tiny', textContent: 'View and unblock users.' }), blockedBtn);

      // Security analytics
      const secCard = ce('div');
      Object.assign(secCard.style, {
        borderRadius: '14px',
        border: '1px solid rgba(255,255,255,.10)',
        background: 'rgba(255,255,255,.02)',
        padding: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px'
      });

      secCard.append(ce('div', { innerHTML: `<div style="font-weight:950">Security</div><div class="muted tiny">Login history, session manager, and account changes (server must support).</div>` }));

      const secBtns = ce('div');
      secBtns.style.display = 'flex';
      secBtns.style.gap = '10px';
      secBtns.style.flexWrap = 'wrap';

      const btnHistory = ce('button', { className: 'btn small', textContent: 'Login history' });
      const btnSessions = ce('button', { className: 'btn small', textContent: 'Session manager' });
      const btnPass = ce('button', { className: 'btn small', textContent: 'Change password' });
      const btnUser = ce('button', { className: 'btn small', textContent: 'Change username' });

      btnHistory.addEventListener('click', () => openLoginHistory());
      btnSessions.addEventListener('click', () => openSessions());
      btnPass.addEventListener('click', () => openChangePassword());
      btnUser.addEventListener('click', () => openChangeUsername());

      secBtns.append(btnHistory, btnSessions, btnPass, btnUser);
      secCard.append(secBtns);

      // Logout
      const logoutRow = ce('div');
      logoutRow.style.display = 'flex';
      logoutRow.style.justifyContent = 'flex-end';

      const logoutBtn = ce('button', { className: 'btn', textContent: 'Log out' });
      logoutBtn.addEventListener('click', () => {
        Modal.close();
        Auth.logout();
      });

      logoutRow.append(logoutBtn);

      wrap.append(header, mobileCard, blockedCard, secCard, logoutRow);
      setBtns();

      Modal.open('Settings', wrap);
    };

    const openLoginHistory = async () => {
      const wrap = ce('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '10px';

      wrap.append(ce('div', { innerHTML: `<div style="font-weight:950">Login history</div><div class="muted tiny">Recent sign-ins (server-provided).</div>` }));

      let items = [];
      if (socket) {
        const resp = await emitAck('getLoginHistory', {});
        if (resp?.ok && Array.isArray(resp.items)) items = resp.items;
      }

      const list = ce('div');
      list.style.display = 'flex';
      list.style.flexDirection = 'column';
      list.style.gap = '8px';

      if (items.length === 0) {
        list.append(ce('div', { className: 'muted tiny', textContent: 'No history available.' }));
      } else {
        for (const it of items.slice(0, 25)) {
          const row = ce('div');
          Object.assign(row.style, {
            borderRadius: '14px',
            border: '1px solid rgba(255,255,255,.10)',
            background: 'rgba(255,255,255,.02)',
            padding: '10px'
          });
          const when = it.ts ? `${formatDate(it.ts)} ${formatTime(it.ts)}` : '—';
          row.innerHTML = `<div style="font-weight:950">${escapeHTML(when)}</div>
            <div class="muted tiny">${escapeHTML(it.ip || '—')} • ${escapeHTML(it.ua || '—')}</div>`;
          list.append(row);
        }
      }

      wrap.append(list);
      Modal.open('Login history', wrap);
    };

    const openSessions = async () => {
      const wrap = ce('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '10px';

      wrap.append(ce('div', { innerHTML: `<div style="font-weight:950">Session manager</div><div class="muted tiny">View and revoke active sessions (server-provided).</div>` }));

      let items = [];
      if (socket) {
        const resp = await emitAck('getSessions', {});
        if (resp?.ok && Array.isArray(resp.items)) items = resp.items;
      }

      const list = ce('div');
      list.style.display = 'flex';
      list.style.flexDirection = 'column';
      list.style.gap = '8px';

      if (items.length === 0) {
        list.append(ce('div', { className: 'muted tiny', textContent: 'No sessions available.' }));
      } else {
        for (const it of items.slice(0, 20)) {
          const row = ce('div');
          Object.assign(row.style, {
            borderRadius: '14px',
            border: '1px solid rgba(255,255,255,.10)',
            background: 'rgba(255,255,255,.02)',
            padding: '10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px'
          });

          const left = ce('div');
          left.style.minWidth = '0';
          left.innerHTML = `<div style="font-weight:950">${escapeHTML(it.label || 'Session')}</div>
            <div class="muted tiny">${escapeHTML(it.ip || '—')} • ${escapeHTML(it.ua || '—')}</div>`;

          const btn = ce('button', { className: 'btn small', textContent: it.current ? 'Current' : 'Revoke' });
          btn.disabled = !!it.current;

          btn.addEventListener('click', async () => {
            const resp = await emitAck('revokeSession', { sessionId: it.id });
            if (resp?.ok) {
              Toast.show('Session revoked.', 'ok', 2200);
              Modal.close();
              openSessions();
            } else {
              Toast.show(resp?.error || 'Could not revoke.', 'error', 2800);
            }
          });

          row.append(left, btn);
          list.append(row);
        }
      }

      wrap.append(list);
      Modal.open('Sessions', wrap);
    };

    const openChangePassword = async () => {
      const wrap = ce('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '10px';

      wrap.append(ce('div', { innerHTML: `<div style="font-weight:950">Change password</div><div class="muted tiny">Requires current password (server-provided).</div>` }));

      const cur = ce('input', { className: 'field', placeholder: 'current password' });
      cur.type = 'password';
      const next = ce('input', { className: 'field', placeholder: 'new password (4–32 letters/numbers/_)' });
      next.type = 'password';

      const row = ce('div');
      row.style.display = 'flex';
      row.style.gap = '10px';
      row.style.justifyContent = 'flex-end';

      const btn = ce('button', { className: 'btn primary', textContent: 'Update' });
      btn.addEventListener('click', async () => {
        const resp = await emitAck('changePassword', { currentPassword: cur.value, newPassword: next.value });
        if (resp?.ok) {
          Toast.show('Password updated.', 'ok', 2400);
          Modal.close();
        } else {
          Toast.show(resp?.error || 'Could not change password.', 'error', 3200);
        }
      });

      row.append(btn);
      wrap.append(cur, next, row);
      Modal.open('Change password', wrap);
    };

    const openChangeUsername = async () => {
      const wrap = ce('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '10px';

      wrap.append(ce('div', { innerHTML: `<div style="font-weight:950">Change username</div><div class="muted tiny">May require re-login (server-provided).</div>` }));

      const pass = ce('input', { className: 'field', placeholder: 'password' });
      pass.type = 'password';
      const next = ce('input', { className: 'field', placeholder: 'new username (4–20 letters/numbers/_)' });

      const row = ce('div');
      row.style.display = 'flex';
      row.style.gap = '10px';
      row.style.justifyContent = 'flex-end';

      const btn = ce('button', { className: 'btn primary', textContent: 'Update' });
      btn.addEventListener('click', async () => {
        const resp = await emitAck('changeUsername', { password: pass.value, newUsername: next.value });
        if (resp?.ok) {
          Toast.show('Username updated. Reconnecting…', 'ok', 2600);
          Modal.close();
          // safest: reload to fully rebind
          setTimeout(() => window.location.reload(), 500);
        } else {
          Toast.show(resp?.error || 'Could not change username.', 'error', 3200);
        }
      });

      row.append(btn);
      wrap.append(pass, next, row);
      Modal.open('Change username', wrap);
    };

    return { open, blockUser, unblockUser, openBlockedPopup };
  })();

  /* ----------------------------- Me pill (settings) ----------------------------- */
  el.mePill.addEventListener('click', () => Settings.open());

  /* ----------------------------- Discover / Create group (left header) ----------------------------- */
  const discoverGroupsBtn = $('#discoverGroupsBtn');
  const createGroupBtn = $('#createGroupBtn');

  discoverGroupsBtn.addEventListener('click', async () => {
    if (!State.authed) return;

    const wrap = ce('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '10px';

    wrap.append(ce('div', { innerHTML: `<div style="font-weight:950">Discover groups</div><div class="muted tiny">Browse public groups (server-provided).</div>` }));

    let groups = [];
    if (socket) {
      const resp = await emitAck('discoverGroups', {});
      if (resp?.ok && Array.isArray(resp.items)) groups = resp.items;
    }

    const list = ce('div');
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '8px';

    if (groups.length === 0) {
      list.append(ce('div', { className: 'muted tiny', textContent: 'No groups available.' }));
    } else {
      for (const g of groups.slice(0, 30)) {
        const row = ce('div');
        Object.assign(row.style, {
          height: '40px',
          borderRadius: '12px',
          border: '1px solid rgba(255,255,255,.08)',
          background: 'rgba(255,255,255,.02)',
          padding: '0 10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
          cursor: 'pointer'
        });

        const left = ce('div');
        left.style.minWidth = '0';
        left.innerHTML = `<div style="font-weight:950;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHTML(g.name || 'group')}</div>
          <div class="muted tiny">${escapeHTML(g.membersCount ? `${g.membersCount} members` : 'group')}</div>`;

        const btn = ce('button', { className: 'btn small primary', textContent: 'Join' });
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const resp = await emitAck('joinGroup', { groupId: g.id });
          if (resp?.ok && resp.channel) {
            Toast.show('Joined group.', 'ok', 2200);
            Channels.upsert(resp.channel);
            Channels.render();
            Modal.close();
            Channels.select(String(resp.channel.id));
          } else {
            Toast.show(resp?.error || 'Could not join.', 'error', 2800);
          }
        });

        row.addEventListener('click', () => {
          // view details
          Toast.show('Use Join to enter.', 'info', 1800);
        });

        row.append(left, btn);
        list.append(row);
      }
    }

    wrap.append(list);
    Modal.open('Discover groups', wrap);
  });

  createGroupBtn.addEventListener('click', async () => {
    if (!State.authed) return;

    const wrap = ce('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '10px';

    wrap.append(ce('div', { innerHTML: `<div style="font-weight:950">Create group</div><div class="muted tiny">You can add members now and manage later.</div>` }));

    const name = ce('input', { className: 'field', placeholder: 'group name…' });
    const limit = ce('input');
    limit.type = 'range';
    limit.min = '2';
    limit.max = '50';
    limit.value = '30';
    limit.style.width = '100%';

    const limRow = ce('div');
    limRow.style.display = 'flex';
    limRow.style.alignItems = 'center';
    limRow.style.justifyContent = 'space-between';
    limRow.style.gap = '10px';

    const limLabel = ce('div', { textContent: 'Limit' });
    limLabel.style.fontWeight = '950';

    const limVal = ce('div', { className: 'muted tiny', textContent: '30' });
    limRow.append(limLabel, limVal);

    limit.addEventListener('input', () => limVal.textContent = limit.value);

    const members = ce('input', { className: 'field', placeholder: 'add members (comma-separated usernames)…' });

    const btn = ce('button', { className: 'btn primary', textContent: 'Create' });
    btn.addEventListener('click', async () => {
      const groupName = String(name.value || '').trim();
      if (groupName.length < 2) return Toast.show('Group name is too short.', 'error', 2400);
      const memberList = String(members.value || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      const resp = await emitAck('createGroup', { name: groupName, limit: Number(limit.value), members: memberList });
      if (resp?.ok && resp.channel) {
        Toast.show('Group created.', 'ok', 2200);
        Channels.upsert(resp.channel);
        Channels.render();
        Modal.close();
        Channels.select(String(resp.channel.id));
      } else {
        Toast.show(resp?.error || 'Could not create group.', 'error', 2800);
      }
    });

    wrap.append(name, limRow, limit, members, btn);
    Modal.open('Create group', wrap);
  });

  /* ----------------------------- Sending messages ----------------------------- */
  const Sender = (() => {
    const send = async () => {
      if (!State.authed) return;
      const cid = State.currentChannelId;
      if (!cid) return;

      const text = String(el.message.value || '').trim();
      if (!text) return;

      // local filters
      if (Moderation.containsBanned(text)) {
        // “temporary shadow mute” is server responsibility; client blocks obvious things too
        Toast.show('Message blocked: content not allowed.', 'error', 2800);
        return;
      }

      const urls = Moderation.extractUrls(text);
      if (urls.some(Moderation.isBannedUrl)) {
        Toast.show('Message blocked: 18+ link detected.', 'error', 2800);
        return;
      }
      if (Moderation.isSpammyUrls(urls)) {
        Toast.show('Message blocked: too many links.', 'error', 2800);
        return;
      }

      // one link every 5 minutes
      if (urls.length > 0) {
        if (!Cooldown.canSendLink()) {
          const s = Math.ceil(Cooldown.remainingLinkMs() / 1000);
          Toast.show(`Link cooldown: wait ${s}s`, 'error', 2800);
          return;
        }
      }

      // cooldown gating
      if (!Cooldown.canSend()) {
        Cooldown.shake();
        return;
      }

      // send
      const outgoing = {
        channelId: cid,
        text,
        clientTs: now(),
      };

      // optimistic render
      Messages.addLocal({
        channelId: cid,
        username: State.user.username,
        text,
        ts: now(),
        meta: { optimistic: true }
      });
      Messages.renderCurrent(true);

      // start cooldown immediately for responsiveness
      Cooldown.start();

      // link cooldown
      if (urls.length > 0) Cooldown.registerLinkSend();

      el.message.value = '';

      if (!socket) return;

      const resp = await emitAck('sendMessage', outgoing);
      // server can return {ok, message} or {ok:false,error}
      if (resp?.ok === false) {
        Toast.show(resp.error || 'Message failed to send.', 'error', 3200);
      } else if (resp?.message) {
        // server may return canonical message (id/ts)
        Messages.onIncoming(resp.message);
      }
    };

    return { send };
  })();

  el.sendBtn.addEventListener('click', () => Sender.send());
  el.message.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      Sender.send();
    }
  });

  /* ----------------------------- Login UI ----------------------------- */
  el.togglePass.addEventListener('click', () => {
    el.password.type = (el.password.type === 'password') ? 'text' : 'password';
  });

  el.joinBtn.addEventListener('click', async () => {
    const username = String(el.username.value || '').trim();
    const password = String(el.password.value || '').trim();

    // This is where “wrong password can’t log you in” is enforced by server.
    // Client just displays the server error.
    const resp = await Auth.login({ username, password, guest: false });
    if (!resp.ok) {
      Toast.show(resp.error || 'Login failed.', 'error', 3200);
    }
  });

  el.guestBtn.addEventListener('click', async () => {
    const resp = await Auth.login({ guest: true });
    if (!resp.ok) Toast.show(resp.error || 'Guest login failed.', 'error', 3200);
  });

  // Enter-to-submit on password field
  el.password.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.joinBtn.click();
  });

  /* ----------------------------- Me dot/status (simple) ----------------------------- */
  const updateMeStatusDot = () => {
    // keep it simple: online if socket connected, offline otherwise
    const cls = socket?.connected ? 'online' : 'offline';
    el.meDot.className = `dot ${cls}`;
  };
  setInterval(updateMeStatusDot, 800);
  updateMeStatusDot();

  /* ----------------------------- “Manage” and “Settings” access keys ----------------------------- */
  window.addEventListener('keydown', (e) => {
    if (!State.authed) return;
    // Ctrl/Cmd + , => settings
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      Settings.open();
    }
  });

  /* ----------------------------- Startup: try resume ----------------------------- */
  (async () => {
    // if session exists and socket connects, resume is auto-called in connect handler
    // show login overlay by default
    const saved = Session.load();
    if (saved && saved.username) {
      el.username.value = saved.username;
    }
    Inbox.load();
  })();

})();
