// server.js (ESM) — Render-ready persistence, cooldowns, inbox mentions, bios, leaderboard, groups w/ ownership controls
import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import process from "process";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

/**
 * Persistence (Render disk-ready)
 * Mount persistent disk at /data
 */
const DISK_FILE = process.env.TONKOTSU_DB_FILE || "/data/tonkotsu.json";

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveToDisk().catch(() => {});
  }, 700);
}
function safeJson(obj) {
  return JSON.stringify(obj, null, 2);
}

const db = {
  users: {},        // username -> record
  tokens: {},       // token -> username
  global: [],       // messages
  dms: {},          // "a|b" -> messages
  groups: {},       // gid -> group
  groupInvites: {}, // username -> invites
  inbox: {},        // username -> inbox items [{id,type,ts, ...}]
};

function normalizeUser(u) { return String(u || "").trim(); }
function now() { return Date.now(); }
function dmKey(a, b) {
  const x = String(a), y = String(b);
  return (x.localeCompare(y) <= 0) ? `${x}|${y}` : `${y}|${x}`;
}
function usernameValid(u) {
  return /^[A-Za-z0-9_.]{3,20}$/.test(u);
}
const USERNAME_BLOCK_PATTERNS = [
  /porn|onlyfans|nude|nsfw|sex|xxx/i,
  /child|minor|underage/i,
  /rape|rapist/i,
  /hitler|nazi/i
];
function badUsername(u) {
  const s = String(u || "");
  return USERNAME_BLOCK_PATTERNS.some(rx => rx.test(s));
}

const HARD_BLOCK_PATTERNS = [
  /\b(kys|kill\s+yourself)\b/i,
  /\b(i('?m| am)?\s+going\s+to\s+kill|i('?m| am)?\s+gonna\s+kill)\b/i,
  /\b(send\s+nudes|nude\s+pics)\b/i,
  /\b(dox|doxx|address|phone\s*number)\b/i
];
function shouldHardHide(text) {
  const t = String(text || "");
  return HARD_BLOCK_PATTERNS.some(rx => rx.test(t));
}

// Password hashing
function hashPass(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.pbkdf2Sync(String(pw), salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${derived}`;
}
function checkPass(pw, stored) {
  const [salt, derived] = String(stored || "").split(":");
  if (!salt || !derived) return false;
  const test = crypto.pbkdf2Sync(String(pw), salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(test), Buffer.from(derived));
}
function newToken() { return crypto.randomBytes(24).toString("hex"); }

// XP
function xpNext(level) {
  const base = 120;
  const growth = Math.floor(base * Math.pow(Math.max(1, level), 1.5));
  return Math.max(base, growth);
}
function addXP(userRec, amount) {
  if (!userRec || userRec.guest) return { leveledUp: false };
  if (!userRec.xp) userRec.xp = { level: 1, xp: 0, next: xpNext(1) };
  const before = userRec.xp.level;
  userRec.xp.xp += amount;
  while (userRec.xp.xp >= userRec.xp.next) {
    userRec.xp.xp -= userRec.xp.next;
    userRec.xp.level += 1;
    userRec.xp.next = xpNext(userRec.xp.level);
  }
  return { leveledUp: userRec.xp.level > before };
}

function ensureInbox(username){
  if (!db.inbox[username]) db.inbox[username] = [];
  return db.inbox[username];
}
function pushInbox(username, item){
  const list = ensureInbox(username);
  list.unshift(item);
  db.inbox[username] = list.slice(0, 80);
}
function inboxCounts(username){
  const list = ensureInbox(username);
  // everything in inbox gets a badge count (like discord)
  return list.length;
}

function ensureUser(username, password) {
  if (!db.users[username]) {
    db.users[username] = {
      username,
      pass: hashPass(password),
      createdAt: now(),
      guest: false,
      bio: "",
      settings: {
        density: 0.10,
        sidebar: 0.22,
        cursorMode: "trail", // off|dot|trail
        sounds: true,
        pingVolume: 0.65,
        reduceAnimations: false
      },
      social: {
        friends: [],
        incoming: [],
        outgoing: [],
        blocked: []
      },
      stats: { messages: 0 },
      xp: { level: 1, xp: 0, next: xpNext(1) },
      mutes: { global: false, dms: [], groups: [] },
      tutorial: { done: false }
    };
  }
  return db.users[username];
}

function publicProfile(viewer, username) {
  const u = db.users[username];
  if (!u) return null;
  const isBlockedByViewer = viewer && db.users[viewer]?.social?.blocked?.includes(username);
  return {
    user: username,
    guest: !!u.guest,
    createdAt: u.createdAt,
    bio: u.bio || "",
    level: u.xp?.level ?? 1,
    xp: u.xp?.xp ?? 0,
    next: u.xp?.next ?? xpNext(1),
    messages: u.stats?.messages ?? 0,
    blocked: !!isBlockedByViewer
  };
}

function computeLeaderboard(limit=20){
  const arr = Object.values(db.users)
    .filter(u => u && !u.guest && u.xp && typeof u.xp.level === "number")
    .map(u => ({
      user: u.username,
      level: u.xp.level,
      xp: u.xp.xp || 0,
      next: u.xp.next || xpNext(u.xp.level || 1)
    }))
    .sort((a,b)=> (b.level - a.level) || (b.xp - a.xp) || a.user.localeCompare(b.user))
    .slice(0, limit);
  return arr;
}

// Online tracking
const socketToUser = new Map();
const online = new Set();

function emitOnline() {
  const list = Array.from(online).sort().map(user => ({ user }));
  io.emit("onlineUsers", list);
}

function emitInboxBadge(username){
  const u = db.users[username];
  if (!u || u.guest) return;
  io.to(username).emit("inbox:update", { count: inboxCounts(username) });
}

function emitSocial(username) {
  const u = db.users[username];
  if (!u || u.guest) return;
  io.to(username).emit("social:update", u.social);
  emitInboxBadge(username);
}

function emitGroupsList(username) {
  const u = db.users[username];
  if (!u || u.guest) return;
  const groups = Object.values(db.groups)
    .filter(g => g.active && g.members.includes(username))
    .map(g => ({ id: g.id, name: g.name, owner: g.owner, members: g.members }));
  io.to(username).emit("groups:list", groups);
}

function getOrCreateDM(key) {
  if (!db.dms[key]) db.dms[key] = [];
  return db.dms[key];
}

// Disk load/save
async function loadFromDisk() {
  try {
    if (!fs.existsSync(DISK_FILE)) return;
    const raw = await fs.promises.readFile(DISK_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      db.users = parsed.users || db.users;
      db.tokens = parsed.tokens || {};
      db.global = parsed.global || [];
      db.dms = parsed.dms || {};
      db.groups = parsed.groups || {};
      db.groupInvites = parsed.groupInvites || {};
      db.inbox = parsed.inbox || {};
    }
    console.log("[db] loaded", DISK_FILE);
  } catch (e) {
    console.log("[db] load failed", e?.message || e);
  }
}
async function saveToDisk() {
  try {
    const dir = path.dirname(DISK_FILE);
    if (!fs.existsSync(dir)) return;
    const payload = {
      users: db.users,
      tokens: db.tokens,
      global: db.global,
      dms: db.dms,
      groups: db.groups,
      groupInvites: db.groupInvites,
      inbox: db.inbox
    };
    await fs.promises.writeFile(DISK_FILE, safeJson(payload), "utf8");
  } catch {}
}

await loadFromDisk();

// Mention parsing: @username
function extractMentions(text){
  const t = String(text || "");
  const m = t.match(/@([A-Za-z0-9_.]{3,20})/g) || [];
  const names = m.map(x => x.slice(1)).filter(Boolean);
  return Array.from(new Set(names));
}

// Cooldown store (per socket)
const cooldown = new Map(); // socket.id -> { globalUntil:number }

io.on("connection", (socket) => {
  function currentUser() {
    return socketToUser.get(socket.id) || null;
  }
  function isGuestUserName(name) {
    return /^Guest\d{4,5}$/.test(String(name));
  }
  function requireAuth() {
    const u = currentUser();
    if (!u) return null;
    if (isGuestUserName(u)) return null;
    return u;
  }

  function setGlobalCooldown(ms){
    const until = now() + ms;
    cooldown.set(socket.id, { globalUntil: until });
    socket.emit("cooldown:update", { globalUntil: until });
  }
  function canSendGlobal(){
    const c = cooldown.get(socket.id);
    if (!c?.globalUntil) return true;
    return now() >= c.globalUntil;
  }

  socket.on("resume", ({ token } = {}) => {
    const t = String(token || "");
    const username = db.tokens[t];
    if (!username || !db.users[username]) {
      socket.emit("resumeFail");
      return;
    }

    socketToUser.set(socket.id, username);
    socket.join(username);
    online.add(username);
    emitOnline();

    const userRec = db.users[username];
    socket.emit("loginSuccess", {
      username,
      guest: false,
      token: t,
      isNew: !userRec.tutorial?.done && !userRec.tutorial?.seenPrompt, // prompt tutorial once
      settings: userRec.settings,
      social: userRec.social,
      xp: userRec.xp,
      bio: userRec.bio || "",
      tutorialDone: !!userRec.tutorial?.done
    });

    socket.emit("settings", userRec.settings);
    socket.emit("xp:update", userRec.xp);
    emitSocial(username);
    emitGroupsList(username);
    socket.emit("leaderboard:data", computeLeaderboard(20));
  });

  socket.on("login", ({ username, password, guest } = {}) => {
    if (guest) {
      const digits = (Math.random() < 0.5)
        ? String(Math.floor(1000 + Math.random() * 9000))
        : String(Math.floor(10000 + Math.random() * 90000));
      const g = `Guest${digits}`;

      socketToUser.set(socket.id, g);
      socket.emit("loginSuccess", {
        username: g,
        guest: true,
        token: null,
        isNew: false,
        settings: {
          density: 0.10,
          sidebar: 0.22,
          cursorMode: "trail",
          sounds: true,
          pingVolume: 0.65,
          reduceAnimations: false
        },
        social: { friends: [], incoming: [], outgoing: [], blocked: [] },
        xp: null,
        bio: "",
        tutorialDone: true
      });

      // guests get longer cooldown
      setGlobalCooldown(0);
      return;
    }

    const u = normalizeUser(username);
    const p = String(password || "");

    if (!usernameValid(u) || badUsername(u)) {
      socket.emit("loginError", "Username not allowed. Use letters/numbers/_/. only (3-20). No spaces.");
      return;
    }
    if (!p || p.length < 4) {
      socket.emit("loginError", "Password too short.");
      return;
    }

    const existing = db.users[u];
    let isNewAccount = false;
    if (!existing) {
      ensureUser(u, p);
      isNewAccount = true;
      db.users[u].tutorial.seenPrompt = true;
      scheduleSave();
    } else {
      if (!checkPass(p, existing.pass)) {
        socket.emit("loginError", "Wrong password.");
        return;
      }
      if (!existing.tutorial) existing.tutorial = { done: false };
      if (existing.tutorial.seenPrompt !== true) existing.tutorial.seenPrompt = true;
    }

    const token = newToken();
    db.tokens[token] = u;

    socketToUser.set(socket.id, u);
    socket.join(u);
    online.add(u);
    emitOnline();

    const userRec = db.users[u];
    socket.emit("loginSuccess", {
      username: u,
      guest: false,
      token,
      isNew: isNewAccount && !userRec.tutorial?.done,
      settings: userRec.settings,
      social: userRec.social,
      xp: userRec.xp,
      bio: userRec.bio || "",
      tutorialDone: !!userRec.tutorial?.done
    });

    socket.emit("settings", userRec.settings);
    socket.emit("xp:update", userRec.xp);
    emitSocial(u);
    emitGroupsList(u);
    socket.emit("leaderboard:data", computeLeaderboard(20));
    scheduleSave();
  });

  socket.on("logout", () => {
    const u = currentUser();
    socketToUser.delete(socket.id);
    cooldown.delete(socket.id);
    if (u && !/^Guest/.test(u)) {
      online.delete(u);
      emitOnline();
    }
  });

  socket.on("disconnect", () => {
    const u = currentUser();
    socketToUser.delete(socket.id);
    cooldown.delete(socket.id);
    if (u && !/^Guest/.test(u)) {
      online.delete(u);
      emitOnline();
    }
  });

  // Settings update
  socket.on("settings:update", (settings) => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];
    if (!u) return;
    const s = settings || {};
    u.settings = {
      density: Number.isFinite(s.density) ? Math.max(0, Math.min(1, s.density)) : 0.10,
      sidebar: Number.isFinite(s.sidebar) ? Math.max(0, Math.min(1, s.sidebar)) : 0.22,
      cursorMode: ["off","dot","trail"].includes(s.cursorMode) ? s.cursorMode : "trail",
      sounds: s.sounds !== false,
      pingVolume: Number.isFinite(s.pingVolume) ? Math.max(0, Math.min(1, s.pingVolume)) : 0.65,
      reduceAnimations: !!s.reduceAnimations
    };
    socket.emit("settings", u.settings);
    scheduleSave();
  });

  // Bio update
  socket.on("bio:update", ({ bio } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];
    if (!u) return;
    const b = String(bio || "").slice(0, 180);
    u.bio = b;
    socket.emit("bio:data", { bio: b });
    scheduleSave();
  });

  // Profile get
  socket.on("profile:get", ({ user } = {}) => {
    const viewer = currentUser();
    const target = normalizeUser(user);
    if (!target) return;

    if (/^Guest\d{4,5}$/.test(target)) {
      socket.emit("profile:data", { user: target, guest: true });
      return;
    }

    const p = publicProfile(!viewer || /^Guest/.test(viewer) ? null : viewer, target);
    if (!p) {
      socket.emit("profile:data", { user: target, missing: true });
      return;
    }
    socket.emit("profile:data", p);
  });

  // Leaderboard
  socket.on("leaderboard:get", () => {
    socket.emit("leaderboard:data", computeLeaderboard(20));
  });

  // Inbox
  socket.on("inbox:get", () => {
    const username = requireAuth();
    if (!username) return;
    socket.emit("inbox:data", ensureInbox(username));
    emitInboxBadge(username);
  });
  socket.on("inbox:clear", ({ id } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const itemId = String(id || "");
    db.inbox[username] = ensureInbox(username).filter(x => x.id !== itemId);
    socket.emit("inbox:data", ensureInbox(username));
    emitInboxBadge(username);
    scheduleSave();
  });

  // Friend requests
  socket.on("friend:request", ({ to } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(to);
    if (!db.users[target]) return socket.emit("sendError", { reason: "User not found." });
    if (target === username) return socket.emit("sendError", { reason: "You can’t friend yourself." });

    const me = db.users[username];
    const them = db.users[target];

    if (me.social.blocked.includes(target) || them.social.blocked.includes(username)) {
      return socket.emit("sendError", { reason: "Blocked." });
    }
    if (me.social.friends.includes(target)) return socket.emit("sendError", { reason: "Already friends." });
    if (me.social.outgoing.includes(target)) return socket.emit("sendError", { reason: "Request already sent." });

    me.social.outgoing.push(target);
    them.social.incoming.push(username);

    // inbox item for target
    pushInbox(target, { id: crypto.randomBytes(8).toString("hex"), type: "friend_request", from: username, ts: now() });
    emitSocial(username);
    emitSocial(target);
    scheduleSave();
  });

  socket.on("friend:accept", ({ from } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const src = normalizeUser(from);
    const me = db.users[username];
    const them = db.users[src];
    if (!them) return;

    me.social.incoming = me.social.incoming.filter(x => x !== src);
    them.social.outgoing = them.social.outgoing.filter(x => x !== username);

    if (!me.social.friends.includes(src)) me.social.friends.push(src);
    if (!them.social.friends.includes(username)) them.social.friends.push(username);

    emitSocial(username);
    emitSocial(src);
    scheduleSave();
  });

  socket.on("friend:decline", ({ from } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const src = normalizeUser(from);
    const me = db.users[username];
    const them = db.users[src];
    if (!them) return;

    me.social.incoming = me.social.incoming.filter(x => x !== src);
    them.social.outgoing = them.social.outgoing.filter(x => x !== username);

    emitSocial(username);
    emitSocial(src);
    scheduleSave();
  });

  socket.on("friend:remove", ({ user } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(user);
    const me = db.users[username];
    const them = db.users[target];
    if (!them) return;

    me.social.friends = me.social.friends.filter(x => x !== target);
    them.social.friends = them.social.friends.filter(x => x !== username);

    // NOTE: DMs still exist on server, but client will hide them if not friends (as requested).
    emitSocial(username);
    emitSocial(target);
    scheduleSave();
  });

  // Block/unblock
  socket.on("user:block", ({ user } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(user);
    if (!db.users[target]) return socket.emit("sendError", { reason: "User not found." });

    const me = db.users[username];
    if (!me.social.blocked.includes(target)) me.social.blocked.push(target);

    // remove friendship & pending
    me.social.friends = me.social.friends.filter(x => x !== target);
    me.social.incoming = me.social.incoming.filter(x => x !== target);
    me.social.outgoing = me.social.outgoing.filter(x => x !== target);

    const them = db.users[target];
    them.social.friends = them.social.friends.filter(x => x !== username);
    them.social.incoming = them.social.incoming.filter(x => x !== username);
    them.social.outgoing = them.social.outgoing.filter(x => x !== username);

    emitSocial(username);
    emitSocial(target);
    scheduleSave();
  });

  socket.on("user:unblock", ({ user } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const target = normalizeUser(user);
    const me = db.users[username];
    me.social.blocked = me.social.blocked.filter(x => x !== target);
    emitSocial(username);
    scheduleSave();
  });

  // Global history + send (with cooldown)
  socket.on("requestGlobalHistory", () => {
    socket.emit("history", db.global.slice(-220));
  });

  socket.on("sendGlobal", ({ text, ts } = {}) => {
    const sender = currentUser();
    if (!sender) return;

    // cooldown: 3s logged-in, 5s guests
    const guest = /^Guest/.test(sender);
    const cdMs = guest ? 5000 : 3000;
    if (!canSendGlobal()) {
      const c = cooldown.get(socket.id);
      socket.emit("cooldown:blocked", { globalUntil: c?.globalUntil || (now() + cdMs) });
      return;
    }

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { id: crypto.randomBytes(8).toString("hex"), user: sender, text: safeText, ts: Number(ts) || now() };
    db.global.push(msg);
    if (db.global.length > 320) db.global.shift();

    io.emit("globalMessage", msg);

    // mentions -> inbox
    if (!guest && safeText && safeText !== "__HIDDEN_BY_FILTER__") {
      const mentioned = extractMentions(safeText)
        .filter(name => db.users[name] && name !== sender); // existing accounts only
      for (const name of mentioned) {
        pushInbox(name, {
          id: crypto.randomBytes(8).toString("hex"),
          type: "mention",
          from: sender,
          where: "global",
          messageId: msg.id,
          preview: safeText.slice(0, 90),
          ts: now()
        });
        emitInboxBadge(name);
      }
    }

    // XP for real users
    if (!guest && db.users[sender]) {
      db.users[sender].stats.messages += 1;
      const { leveledUp } = addXP(db.users[sender], 8);
      io.to(sender).emit("xp:update", db.users[sender].xp);
      if (leveledUp) io.emit("leaderboard:data", computeLeaderboard(20));
      scheduleSave();
    }

    // set cooldown after successful send
    setGlobalCooldown(cdMs);
  });

  // DM history + send
  socket.on("dm:history", ({ withUser } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const other = normalizeUser(withUser);
    if (!db.users[other]) return socket.emit("dm:history", { withUser: other, msgs: [] });

    const key = dmKey(username, other);
    const msgs = (db.dms[key] || []).slice(-220);
    socket.emit("dm:history", { withUser: other, msgs });
  });

  socket.on("dm:send", ({ to, text } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(to);
    if (!db.users[target]) return socket.emit("sendError", { reason: "User not found." });

    const me = db.users[username];
    const them = db.users[target];

    if (me.social.blocked.includes(target) || them.social.blocked.includes(username)) {
      return socket.emit("sendError", { reason: "You can’t message this user." });
    }

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { id: crypto.randomBytes(8).toString("hex"), user: username, text: safeText, ts: now() };

    const key = dmKey(username, target);
    const list = getOrCreateDM(key);
    list.push(msg);
    if (list.length > 300) list.shift();

    io.to(username).emit("dm:message", { from: target, msg });
    io.to(target).emit("dm:message", { from: username, msg });

    me.stats.messages += 1;
    const { leveledUp } = addXP(me, 10);
    io.to(username).emit("xp:update", me.xp);
    if (leveledUp) io.emit("leaderboard:data", computeLeaderboard(20));

    // DM mention -> inbox
    const mentioned = extractMentions(safeText).filter(n => n === target);
    if (mentioned.length) {
      pushInbox(target, {
        id: crypto.randomBytes(8).toString("hex"),
        type: "mention",
        from: username,
        where: "dm",
        preview: safeText.slice(0, 90),
        ts: now()
      });
      emitInboxBadge(target);
    }

    scheduleSave();
  });

  // Groups list
  socket.on("groups:list", () => {
    const username = requireAuth();
    if (!username) return;
    emitGroupsList(username);
  });

  // Create group: must invite at least 1 person, becomes active after first accept
  socket.on("group:createRequest", ({ name, invites } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const list = Array.isArray(invites) ? invites.map(normalizeUser) : [];
    const uniqueInvites = Array.from(new Set(list))
      .filter(u => u && u !== username && db.users[u]);

    if (uniqueInvites.length < 1) {
      socket.emit("sendError", { reason: "Invite at least 1 person to create a group." });
      return;
    }

    const gname = String(name || "").trim().slice(0, 40) || "Unnamed Group";
    const gid = crypto.randomBytes(6).toString("hex");

    db.groups[gid] = {
      id: gid,
      name: gname,
      owner: username,
      members: [username],
      msgs: [],
      active: false,
      pendingInvites: uniqueInvites
    };

    for (const u of uniqueInvites) {
      if (!db.groupInvites[u]) db.groupInvites[u] = [];
      db.groupInvites[u].unshift({ id: gid, from: username, name: gname, ts: now() });
      db.groupInvites[u] = db.groupInvites[u].slice(0, 50);

      pushInbox(u, { id: crypto.randomBytes(8).toString("hex"), type: "group_invite", from: username, groupId: gid, groupName: gname, ts: now() });
      emitInboxBadge(u);
    }

    socket.emit("group:requestCreated", { id: gid, name: gname, invites: uniqueInvites });
    scheduleSave();
  });

  socket.on("groupInvite:accept", ({ id } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const gid = String(id || "");
    const g = db.groups[gid];
    if (!g) return;

    db.groupInvites[username] = (db.groupInvites[username] || []).filter(x => x.id !== gid);

    if (!g.members.includes(username)) g.members.push(username);
    if (!g.active) g.active = true;
    g.pendingInvites = (g.pendingInvites || []).filter(x => x !== username);

    for (const member of g.members) {
      io.to(member).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
      emitGroupsList(member);
    }

    // clear related inbox invite items
    db.inbox[username] = ensureInbox(username).filter(it => !(it.type === "group_invite" && it.groupId === gid));
    emitInboxBadge(username);

    scheduleSave();
  });

  socket.on("groupInvite:decline", ({ id } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const gid = String(id || "");
    const g = db.groups[gid];
    if (g?.pendingInvites) g.pendingInvites = g.pendingInvites.filter(x => x !== username);
    db.groupInvites[username] = (db.groupInvites[username] || []).filter(x => x.id !== gid);

    db.inbox[username] = ensureInbox(username).filter(it => !(it.type === "group_invite" && it.groupId === gid));
    emitInboxBadge(username);

    scheduleSave();
  });

  socket.on("group:history", ({ groupId } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || !g.members.includes(username)) {
      socket.emit("sendError", { reason: "No access to group." });
      return;
    }
    socket.emit("group:history", {
      groupId: gid,
      meta: { id: gid, name: g.name, owner: g.owner, members: g.members },
      msgs: g.msgs.slice(-260)
    });
  });

  socket.on("group:send", ({ groupId, text } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || !g.members.includes(username)) {
      socket.emit("sendError", { reason: "No access to group." });
      return;
    }

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";
    const msg = { id: crypto.randomBytes(8).toString("hex"), user: username, text: safeText, ts: now() };
    g.msgs.push(msg);
    if (g.msgs.length > 380) g.msgs.shift();

    for (const member of g.members) {
      io.to(member).emit("group:message", { groupId: gid, msg });
    }

    const me = db.users[username];
    me.stats.messages += 1;
    const { leveledUp } = addXP(me, 9);
    io.to(username).emit("xp:update", me.xp);
    if (leveledUp) io.emit("leaderboard:data", computeLeaderboard(20));

    // mention -> inbox (any member mentioned)
    const mentioned = extractMentions(safeText).filter(n => g.members.includes(n) && n !== username);
    for (const name of mentioned) {
      pushInbox(name, {
        id: crypto.randomBytes(8).toString("hex"),
        type: "mention",
        from: username,
        where: "group",
        groupId: gid,
        groupName: g.name,
        preview: safeText.slice(0, 90),
        ts: now()
      });
      emitInboxBadge(name);
    }

    scheduleSave();
  });

  // Owner controls
  socket.on("group:rename", ({ groupId, name } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || g.owner !== username) return socket.emit("sendError", { reason: "Only owner can rename." });
    g.name = String(name || "").trim().slice(0, 40) || "Unnamed Group";
    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
      emitGroupsList(m);
    }
    scheduleSave();
  });

  socket.on("group:addMember", ({ groupId, user } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const gid = String(groupId || "");
    const target = normalizeUser(user);
    const g = db.groups[gid];
    if (!g || !g.active || g.owner !== username) return socket.emit("sendError", { reason: "Only owner can invite." });
    if (!db.users[target]) return socket.emit("sendError", { reason: "User not found." });
    if (g.members.includes(target)) return;

    // Send invite (same inbox style)
    if (!db.groupInvites[target]) db.groupInvites[target] = [];
    db.groupInvites[target].unshift({ id: gid, from: username, name: g.name, ts: now() });
    db.groupInvites[target] = db.groupInvites[target].slice(0, 50);

    pushInbox(target, { id: crypto.randomBytes(8).toString("hex"), type: "group_invite", from: username, groupId: gid, groupName: g.name, ts: now() });
    emitInboxBadge(target);
    scheduleSave();
  });

  socket.on("group:removeMember", ({ groupId, user } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const gid = String(groupId || "");
    const target = normalizeUser(user);
    const g = db.groups[gid];
    if (!g || !g.active || g.owner !== username) return socket.emit("sendError", { reason: "Only owner can remove." });
    if (target === g.owner) return socket.emit("sendError", { reason: "Owner can’t be removed." });

    g.members = g.members.filter(x => x !== target);
    io.to(target).emit("group:left", { groupId: gid });

    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
      emitGroupsList(m);
    }
    emitGroupsList(target);
    scheduleSave();
  });

  socket.on("group:transferOwner", ({ groupId, newOwner } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const gid = String(groupId || "");
    const target = normalizeUser(newOwner);
    const g = db.groups[gid];
    if (!g || !g.active || g.owner !== username) return socket.emit("sendError", { reason: "Only owner can transfer." });
    if (!g.members.includes(target)) return socket.emit("sendError", { reason: "New owner must be a member." });

    g.owner = target;
    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
      emitGroupsList(m);
    }
    scheduleSave();
  });

  socket.on("group:delete", ({ groupId } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || g.owner !== username) return socket.emit("sendError", { reason: "Only owner can delete." });

    const members = [...g.members];
    delete db.groups[gid];
    for (const m of members) {
      io.to(m).emit("group:deleted", { groupId: gid });
      emitGroupsList(m);
    }
    scheduleSave();
  });

  socket.on("group:leave", ({ groupId } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || !g.members.includes(username)) return;

    if (g.owner === username) {
      // owner leaving deletes group
      const members = [...g.members];
      delete db.groups[gid];
      for (const m of members) {
        io.to(m).emit("group:deleted", { groupId: gid });
        emitGroupsList(m);
      }
      scheduleSave();
      return;
    }

    g.members = g.members.filter(x => x !== username);
    io.to(username).emit("group:left", { groupId: gid });
    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
      emitGroupsList(m);
    }
    emitGroupsList(username);
    scheduleSave();
  });

  // Tutorial state
  socket.on("tutorial:setDone", ({ done } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];
    if (!u.tutorial) u.tutorial = { done: false };
    u.tutorial.done = !!done;
    scheduleSave();
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));
