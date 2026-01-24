// server.js — Discord-like compact chat backend (Socket.IO)
// - Account create/login: username+password alnum only, min 4
// - Session resume token (stay logged in across tab close)
// - Status: online/idle/dnd/invisible
// - Idle auto on client (3 min) sets status=idle; DND disables notifications client-side
// - Profile stats: level, xp, messages, created
// - XP + leveling: grows with level (increasing curve)
// - Global, DM, Group chats
// - Mentions @user -> inbox mention item and badge
// - Friends + friend requests -> inbox
// - Groups with cap 200 members; group info/meta
// - Leaderboard: top XP

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const GROUPS_FILE = path.join(DATA_DIR, "groups.json");
const GLOBAL_FILE = path.join(DATA_DIR, "global.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}

let users = readJson(USERS_FILE, {});
let groups = readJson(GROUPS_FILE, {});
let globalHistory = readJson(GLOBAL_FILE, []);

function persistAll() {
  writeJson(USERS_FILE, users);
  writeJson(GROUPS_FILE, groups);
  writeJson(GLOBAL_FILE, globalHistory);
}

function now() { return Date.now(); }
function newToken() { return crypto.randomBytes(24).toString("hex"); }
function newId(prefix) { return `${prefix}_${crypto.randomBytes(10).toString("hex")}`; }

function isValidUser(u) { return /^[A-Za-z0-9]{4,20}$/.test(String(u || "")); }
function isValidPass(p) { return /^[A-Za-z0-9]{4,32}$/.test(String(p || "")); }
function isGuestName(u) { return /^Guest\d{4,5}$/.test(String(u || "")); }

function pbkdf2Hash(password, salt) {
  const iters = 140000;
  const keylen = 32;
  const digest = "sha256";
  const dk = crypto.pbkdf2Sync(password, salt, iters, keylen, digest);
  return { iters, keylen, digest, hash: dk.toString("hex") };
}
function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const out = pbkdf2Hash(password, salt);
  return { salt, iters: out.iters, keylen: out.keylen, digest: out.digest, hash: out.hash };
}
function verifyPassword(password, record) {
  try {
    const dk = crypto.pbkdf2Sync(password, record.salt, record.iters, record.keylen, record.digest);
    return crypto.timingSafeEqual(Buffer.from(record.hash, "hex"), dk);
  } catch {
    return false;
  }
}

// XP curve: grows with level (increasing requirement)
function xpNeededForNext(level) {
  const L = Math.max(1, Number(level) || 1);
  // Increasing curve; gets longer as you level:
  // base + linear + quadratic component
  return Math.floor(120 + (L * 65) + (L * L * 12));
}

function ensureUser(username) {
  if (!users[username]) {
    users[username] = {
      user: username,
      createdAt: now(),
      pass: null,
      token: null,
      status: "online",
      settings: { sounds: true, hideMildProfanity: false },
      social: { friends: [], incoming: [], outgoing: [], blocked: [] },
      inbox: [],
      stats: { messages: 0, xp: 0, level: 1 }
    };
  }
  // ensure sub-objects
  users[username].settings ||= { sounds: true, hideMildProfanity: false };
  users[username].social ||= { friends: [], incoming: [], outgoing: [], blocked: [] };
  users[username].inbox ||= [];
  users[username].stats ||= { messages: 0, xp: 0, level: 1 };
  return users[username];
}

function addInboxItem(toUser, item) {
  const u = ensureUser(toUser);
  u.inbox.unshift(item);
  if (u.inbox.length > 250) u.inbox.length = 250;
}

function countInbox(u) {
  const items = u.inbox || [];
  let friend = 0, groupInv = 0, ment = 0;
  for (const it of items) {
    if (it.type === "friend") friend++;
    else if (it.type === "group") groupInv++;
    else if (it.type === "mention") ment++;
  }
  return { total: friend + groupInv + ment, friend, groupInv, ment };
}

function safeUserPublic(u) {
  return { user: u.user, status: u.status || "online", level: u.stats?.level || 1 };
}

// mentions: @AlnumUser
function extractMentions(text) {
  const t = String(text || "");
  const rx = /@([A-Za-z0-9]{4,20})/g;
  const found = new Set();
  let m;
  while ((m = rx.exec(t)) !== null) found.add(m[1]);
  return Array.from(found);
}

function pushGlobalMessage(msg) {
  globalHistory.push(msg);
  if (globalHistory.length > 350) globalHistory.shift();
  writeJson(GLOBAL_FILE, globalHistory);
}

// DM store: in users[u].dm[other] arrays (bounded)
function ensureDMStore(userA, userB) {
  const a = ensureUser(userA);
  a.dm ||= {};
  if (!a.dm[userB]) a.dm[userB] = [];
  return a.dm[userB];
}
function pushDM(a, b, msg) {
  const arrA = ensureDMStore(a, b);
  const arrB = ensureDMStore(b, a);
  arrA.push(msg);
  arrB.push(msg);
  if (arrA.length > 260) arrA.shift();
  if (arrB.length > 260) arrB.shift();
}

// XP award (global/dm/group)
function awardXP(username, amount) {
  if (!users[username]) return;
  if (isGuestName(username)) return;

  const u = ensureUser(username);
  u.stats.messages = (u.stats.messages || 0) + 1;
  u.stats.xp = (u.stats.xp || 0) + amount;

  let leveled = false;
  while (u.stats.xp >= xpNeededForNext(u.stats.level || 1)) {
    u.stats.xp -= xpNeededForNext(u.stats.level || 1);
    u.stats.level = (u.stats.level || 1) + 1;
    leveled = true;
  }
  persistAll();
  return { leveled, level: u.stats.level, xp: u.stats.xp, next: xpNeededForNext(u.stats.level) };
}

// Groups
function groupPublic(g) {
  return { id: g.id, name: g.name, owner: g.owner, members: g.members || [] };
}

// Online tracking
const socketsByUser = new Map(); // user -> Set(socket.id)
const userBySocket = new Map();  // socket.id -> user

function setOnline(user, socketId) {
  if (!socketsByUser.has(user)) socketsByUser.set(user, new Set());
  socketsByUser.get(user).add(socketId);
  userBySocket.set(socketId, user);
}

function setOffline(socketId) {
  const user = userBySocket.get(socketId);
  if (!user) return;
  userBySocket.delete(socketId);
  const set = socketsByUser.get(user);
  if (set) {
    set.delete(socketId);
    if (set.size === 0) socketsByUser.delete(user);
  }
}

function emitToUser(user, evt, payload) {
  const set = socketsByUser.get(user);
  if (!set) return;
  for (const sid of set) io.to(sid).emit(evt, payload);
}

function broadcastOnlineUsers() {
  const list = [];
  for (const [user] of socketsByUser.entries()) {
    const u = users[user];
    if (!u) continue;
    if (u.status === "invisible") continue; // invisible does not appear online
    list.push(safeUserPublic(u));
  }
  list.sort((a, b) => a.user.localeCompare(b.user));
  io.emit("onlineUsers", list);
}

// Leaderboard (top xp)
function getLeaderboard(limit = 25) {
  const arr = Object.values(users)
    .filter(u => u && u.pass && !isGuestName(u.user))
    .map(u => ({
      user: u.user,
      level: u.stats?.level || 1,
      xp: u.stats?.xp || 0,
      next: xpNeededForNext(u.stats?.level || 1),
      messages: u.stats?.messages || 0
    }));
  // sort by level desc, then xp desc
  arr.sort((a, b) => (b.level - a.level) || (b.xp - a.xp) || a.user.localeCompare(b.user));
  return arr.slice(0, Math.max(5, Math.min(100, limit)));
}

// Express / Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.json({ ok: true }));

io.on("connection", (socket) => {
  let authedUser = null;

  function requireAuth() {
    return !!authedUser && !!users[authedUser];
  }
  function requireNonGuest() {
    return requireAuth() && !isGuestName(authedUser);
  }

  function sendInitSuccess(u, { guest = false } = {}) {
    authedUser = u.user;
    setOnline(authedUser, socket.id);

    if (guest) {
      u.status = "online";
      u.token = null;
    } else {
      // keep saved status; if missing, default online
      u.status ||= "online";
      u.token ||= newToken();
    }

    socket.emit("loginSuccess", {
      username: u.user,
      guest: !!guest,
      token: guest ? null : u.token,
      status: u.status,
      settings: u.settings,
      social: u.social,
      stats: {
        level: u.stats?.level || 1,
        xp: u.stats?.xp || 0,
        next: xpNeededForNext(u.stats?.level || 1),
        messages: u.stats?.messages || 0,
        createdAt: u.createdAt
      }
    });

    if (!guest) {
      socket.emit("inbox:badge", countInbox(u));
      socket.emit("inbox:data", { items: u.inbox || [] });
    }

    broadcastOnlineUsers();
  }

  // Resume session
  socket.on("resume", ({ token }) => {
    const tok = String(token || "");
    if (!tok) return socket.emit("resumeFail");
    const found = Object.values(users).find(u => u && u.token === tok);
    if (!found) return socket.emit("resumeFail");
    sendInitSuccess(found, { guest: false });
  });

  // Login or create
  socket.on("login", ({ username, password, guest }) => {
    if (guest) {
      let g = null;
      for (let i = 0; i < 70; i++) {
        const n = 1000 + Math.floor(Math.random() * 9000);
        const name = `Guest${n}`;
        if (!users[name] && !socketsByUser.has(name)) {
          g = ensureUser(name);
          g.pass = null;
          g.token = null;
          g.status = "online";
          break;
        }
      }
      if (!g) return socket.emit("loginError", "Guest slots busy. Try again.");
      persistAll();
      return sendInitSuccess(g, { guest: true });
    }

    const u = String(username || "").trim();
    const p = String(password || "").trim();

    if (!isValidUser(u)) return socket.emit("loginError", "Username: letters/numbers only, 4–20.");
    if (!isValidPass(p)) return socket.emit("loginError", "Password: letters/numbers only, 4–32.");

    const rec = ensureUser(u);

    if (!rec.pass) {
      // create account
      rec.pass = createPasswordRecord(p);
      rec.token = newToken();
      rec.status = "online";
      persistAll();
      return sendInitSuccess(rec, { guest: false });
    }

    if (!verifyPassword(p, rec.pass)) {
      return socket.emit("loginError", "Incorrect password.");
    }

    // successful login: rotate token
    rec.token = newToken();
    rec.status ||= "online";
    persistAll();
    return sendInitSuccess(rec, { guest: false });
  });

  socket.on("disconnect", () => {
    setOffline(socket.id);
    broadcastOnlineUsers();
  });

  // Status
  socket.on("status:set", ({ status }) => {
    if (!requireAuth()) return;
    const s = String(status || "");
    const allowed = new Set(["online", "idle", "dnd", "invisible"]);
    if (!allowed.has(s)) return;

    const u = users[authedUser];
    u.status = s;
    persistAll();
    emitToUser(authedUser, "status:update", { status: s });
    broadcastOnlineUsers();
  });

  // Settings
  socket.on("settings:update", (s) => {
    if (!requireNonGuest()) return;
    const u = users[authedUser];
    u.settings ||= { sounds: true, hideMildProfanity: false };
    if (typeof s?.sounds === "boolean") u.settings.sounds = s.sounds;
    if (typeof s?.hideMildProfanity === "boolean") u.settings.hideMildProfanity = s.hideMildProfanity;
    persistAll();
    socket.emit("settings", u.settings);
  });

  // Profile
  socket.on("profile:get", ({ user }) => {
    if (!requireAuth()) return;
    const target = String(user || "");
    const t = users[target];
    if (!t) {
      return socket.emit("profile:data", { user: target, exists: false, guest: true });
    }
    const level = t.stats?.level || 1;
    socket.emit("profile:data", {
      user: t.user,
      exists: true,
      guest: isGuestName(t.user),
      createdAt: t.createdAt,
      status: t.status || "online",
      messages: t.stats?.messages || 0,
      level,
      xp: t.stats?.xp || 0,
      next: xpNeededForNext(level)
    });
  });

  // Leaderboard
  socket.on("leaderboard:get", ({ limit }) => {
    if (!requireAuth()) return;
    socket.emit("leaderboard:data", { items: getLeaderboard(Number(limit) || 25) });
  });

  // Social sync
  socket.on("social:sync", () => {
    if (!requireNonGuest()) return;
    socket.emit("social:update", users[authedUser].social);
  });

  // Block/unblock
  socket.on("user:block", ({ user }) => {
    if (!requireNonGuest()) return;
    const target = String(user || "");
    if (!users[target] || target === authedUser) return;

    const meRec = users[authedUser];
    meRec.social.blocked ||= [];
    if (!meRec.social.blocked.includes(target)) meRec.social.blocked.push(target);

    // remove friend links
    meRec.social.friends = (meRec.social.friends || []).filter(x => x !== target);
    meRec.social.incoming = (meRec.social.incoming || []).filter(x => x !== target);
    meRec.social.outgoing = (meRec.social.outgoing || []).filter(x => x !== target);

    persistAll();
    socket.emit("social:update", meRec.social);
  });

  socket.on("user:unblock", ({ user }) => {
    if (!requireNonGuest()) return;
    const target = String(user || "");
    const meRec = users[authedUser];
    meRec.social.blocked = (meRec.social.blocked || []).filter(x => x !== target);
    persistAll();
    socket.emit("social:update", meRec.social);
  });

  // Friend requests
  socket.on("friend:request", ({ to }) => {
    if (!requireNonGuest()) return;
    const target = String(to || "");
    if (!users[target] || isGuestName(target)) return socket.emit("sendError", { reason: "User not found." });
    if (target === authedUser) return;

    const meRec = users[authedUser];
    const tRec = users[target];

    if ((meRec.social.blocked || []).includes(target)) return socket.emit("sendError", { reason: "Unblock user first." });
    if ((tRec.social.blocked || []).includes(authedUser)) return socket.emit("sendError", { reason: "Cannot send request." });

    meRec.social.friends ||= [];
    meRec.social.outgoing ||= [];
    tRec.social.incoming ||= [];

    if (meRec.social.friends.includes(target)) return;
    if (meRec.social.outgoing.includes(target)) return;

    meRec.social.outgoing.push(target);
    if (!tRec.social.incoming.includes(authedUser)) tRec.social.incoming.push(authedUser);

    addInboxItem(target, {
      id: newId("inb"),
      type: "friend",
      from: authedUser,
      text: `${authedUser} sent you a friend request`,
      ts: now()
    });

    persistAll();
    socket.emit("social:update", meRec.social);
    emitToUser(target, "social:update", tRec.social);
    emitToUser(target, "inbox:badge", countInbox(tRec));
    emitToUser(target, "inbox:data", { items: tRec.inbox });
  });

  socket.on("friend:accept", ({ from }) => {
    if (!requireNonGuest()) return;
    const src = String(from || "");
    if (!users[src]) return;

    const meRec = users[authedUser];
    const sRec = users[src];

    meRec.social.incoming = (meRec.social.incoming || []).filter(x => x !== src);
    sRec.social.outgoing = (sRec.social.outgoing || []).filter(x => x !== authedUser);

    meRec.social.friends ||= [];
    sRec.social.friends ||= [];
    if (!meRec.social.friends.includes(src)) meRec.social.friends.push(src);
    if (!sRec.social.friends.includes(authedUser)) sRec.social.friends.push(authedUser);

    meRec.inbox = (meRec.inbox || []).filter(it => !(it.type === "friend" && it.from === src));

    persistAll();
    socket.emit("social:update", meRec.social);
    emitToUser(src, "social:update", sRec.social);

    socket.emit("inbox:badge", countInbox(meRec));
    socket.emit("inbox:data", { items: meRec.inbox });
  });

  socket.on("friend:decline", ({ from }) => {
    if (!requireNonGuest()) return;
    const src = String(from || "");
    if (!users[src]) return;

    const meRec = users[authedUser];
    const sRec = users[src];

    meRec.social.incoming = (meRec.social.incoming || []).filter(x => x !== src);
    sRec.social.outgoing = (sRec.social.outgoing || []).filter(x => x !== authedUser);
    meRec.inbox = (meRec.inbox || []).filter(it => !(it.type === "friend" && it.from === src));

    persistAll();
    socket.emit("social:update", meRec.social);
    emitToUser(src, "social:update", sRec.social);

    socket.emit("inbox:badge", countInbox(meRec));
    socket.emit("inbox:data", { items: meRec.inbox });
  });

  // Inbox
  socket.on("inbox:get", () => {
    if (!requireNonGuest()) return;
    const u = users[authedUser];
    socket.emit("inbox:badge", countInbox(u));
    socket.emit("inbox:data", { items: u.inbox || [] });
  });

  socket.on("inbox:clearMentions", () => {
    if (!requireNonGuest()) return;
    const u = users[authedUser];
    u.inbox = (u.inbox || []).filter(it => it.type !== "mention");
    persistAll();
    socket.emit("inbox:badge", countInbox(u));
    socket.emit("inbox:data", { items: u.inbox });
  });

  // Global
  socket.on("requestGlobalHistory", () => {
    socket.emit("history", globalHistory);
  });

  socket.on("sendGlobal", ({ text }) => {
    if (!requireAuth()) return;
    const t = String(text || "").trim();
    if (!t || t.length > 1200) return;

    const msg = { user: authedUser, text: t, ts: now() };
    pushGlobalMessage(msg);

    // Award XP: global
    const xpInfo = awardXP(authedUser, 6);
    if (xpInfo) emitToUser(authedUser, "me:stats", xpInfo);

    io.emit("globalMessage", msg);

    const mentions = extractMentions(t);
    for (const m of mentions) {
      if (!users[m] || m === authedUser) continue;
      const rec = users[m];
      if ((rec.social?.blocked || []).includes(authedUser)) continue;

      addInboxItem(m, {
        id: newId("inb"),
        type: "mention",
        from: authedUser,
        text: `Mentioned you in #global: ${t.slice(0, 160)}`,
        ts: now(),
        meta: { scope: "global" }
      });
      persistAll();
      emitToUser(m, "inbox:badge", countInbox(rec));
      emitToUser(m, "inbox:data", { items: rec.inbox });
    }
  });

  // DM
  socket.on("dm:history", ({ withUser }) => {
    if (!requireNonGuest()) return;
    const other = String(withUser || "");
    if (!users[other] || isGuestName(other)) return socket.emit("dm:history", { withUser: other, msgs: [] });

    const meRec = users[authedUser];
    const otherRec = users[other];
    if ((meRec.social?.blocked || []).includes(other)) return socket.emit("dm:history", { withUser: other, msgs: [] });
    if ((otherRec.social?.blocked || []).includes(authedUser)) return socket.emit("dm:history", { withUser: other, msgs: [] });

    socket.emit("dm:history", { withUser: other, msgs: ensureDMStore(authedUser, other) });
  });

  socket.on("dm:send", ({ to, text }) => {
    if (!requireNonGuest()) return;
    const other = String(to || "");
    const t = String(text || "").trim();
    if (!t || t.length > 1200) return;
    if (!users[other] || isGuestName(other)) return;

    const meRec = users[authedUser];
    const otherRec = users[other];
    if ((meRec.social?.blocked || []).includes(other)) return;
    if ((otherRec.social?.blocked || []).includes(authedUser)) return;

    const msg = { user: authedUser, text: t, ts: now() };
    pushDM(authedUser, other, msg);
    persistAll();

    // Award XP: DM
    const xpInfo = awardXP(authedUser, 4);
    if (xpInfo) emitToUser(authedUser, "me:stats", xpInfo);

    emitToUser(other, "dm:message", { from: authedUser, msg });
    socket.emit("dm:message", { from: other, msg });

    const mentions = extractMentions(t);
    for (const m of mentions) {
      if (!users[m] || m === authedUser) continue;
      const rec = users[m];
      if ((rec.social?.blocked || []).includes(authedUser)) continue;

      addInboxItem(m, {
        id: newId("inb"),
        type: "mention",
        from: authedUser,
        text: `Mentioned you in a DM: ${t.slice(0, 160)}`,
        ts: now(),
        meta: { scope: "dm", with: other }
      });
      persistAll();
      emitToUser(m, "inbox:badge", countInbox(rec));
      emitToUser(m, "inbox:data", { items: rec.inbox });
    }
  });

  // Groups
  socket.on("groups:list", () => {
    if (!requireNonGuest()) return;
    const list = Object.values(groups)
      .filter(g => Array.isArray(g.members) && g.members.includes(authedUser))
      .map(groupPublic)
      .sort((a, b) => a.name.localeCompare(b.name));
    socket.emit("groups:list", list);
  });

  socket.on("group:createRequest", ({ name, invites }) => {
    if (!requireNonGuest()) return;

    const groupName = String(name || "").trim() || "group";
    const rawInv = Array.isArray(invites) ? invites : [];
    const uniq = Array.from(new Set(rawInv.map(x => String(x || "").trim()).filter(Boolean))).slice(0, 199);

    for (const u of uniq) {
      if (!isValidUser(u) || !users[u] || isGuestName(u)) return socket.emit("sendError", { reason: "Invalid invite list." });
    }

    const gid = newId("grp");
    groups[gid] = {
      id: gid,
      name: groupName.slice(0, 32),
      owner: authedUser,
      members: [authedUser],
      invites: uniq.map(u => ({ id: newId("inv"), to: u, from: authedUser, ts: now() })),
      createdAt: now(),
      messages: []
    };

    for (const inv of groups[gid].invites) {
      addInboxItem(inv.to, {
        id: inv.id,
        type: "group",
        from: authedUser,
        text: `Invited you to “${groups[gid].name}”`,
        ts: inv.ts,
        meta: { groupId: gid, name: groups[gid].name }
      });
      const rec = users[inv.to];
      emitToUser(inv.to, "inbox:badge", countInbox(rec));
      emitToUser(inv.to, "inbox:data", { items: rec.inbox });
    }

    persistAll();
    socket.emit("groups:list", Object.values(groups).filter(g => g.members.includes(authedUser)).map(groupPublic));
    socket.emit("group:meta", { groupId: gid, meta: groupPublic(groups[gid]) });
  });

  socket.on("groupInvite:accept", ({ id }) => {
    if (!requireNonGuest()) return;
    const inviteId = String(id || "");
    let gFound = null;

    for (const g of Object.values(groups)) {
      const inv = (g.invites || []).find(x => x.id === inviteId && x.to === authedUser);
      if (inv) { gFound = g; break; }
    }
    if (!gFound) return;

    if ((gFound.members || []).length >= 200) return socket.emit("sendError", { reason: "Group is full (200 cap)." });

    if (!gFound.members.includes(authedUser)) gFound.members.push(authedUser);
    gFound.invites = (gFound.invites || []).filter(x => x.id !== inviteId);

    const meRec = users[authedUser];
    meRec.inbox = (meRec.inbox || []).filter(it => it.id !== inviteId);

    persistAll();

    const meta = groupPublic(gFound);
    for (const m of gFound.members) emitToUser(m, "group:meta", { groupId: gFound.id, meta });

    socket.emit("inbox:badge", countInbox(meRec));
    socket.emit("inbox:data", { items: meRec.inbox });
    socket.emit("groups:list", Object.values(groups).filter(g => g.members.includes(authedUser)).map(groupPublic));
  });

  socket.on("groupInvite:decline", ({ id }) => {
    if (!requireNonGuest()) return;
    const inviteId = String(id || "");

    let gFound = null;
    for (const g of Object.values(groups)) {
      const inv = (g.invites || []).find(x => x.id === inviteId && x.to === authedUser);
      if (inv) { gFound = g; break; }
    }
    if (!gFound) return;

    gFound.invites = (gFound.invites || []).filter(x => x.id !== inviteId);
    const meRec = users[authedUser];
    meRec.inbox = (meRec.inbox || []).filter(it => it.id !== inviteId);

    persistAll();
    socket.emit("inbox:badge", countInbox(meRec));
    socket.emit("inbox:data", { items: meRec.inbox });
  });

  socket.on("group:history", ({ groupId }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const g = groups[gid];
    if (!g || !g.members.includes(authedUser)) return;
    g.messages ||= [];
    socket.emit("group:history", { groupId: gid, meta: groupPublic(g), msgs: g.messages });
  });

  socket.on("group:send", ({ groupId, text }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const g = groups[gid];
    if (!g || !g.members.includes(authedUser)) return;

    const t = String(text || "").trim();
    if (!t || t.length > 1200) return;

    g.messages ||= [];
    const msg = { user: authedUser, text: t, ts: now() };
    g.messages.push(msg);
    if (g.messages.length > 420) g.messages.shift();

    persistAll();

    // Award XP: group
    const xpInfo = awardXP(authedUser, 5);
    if (xpInfo) emitToUser(authedUser, "me:stats", xpInfo);

    for (const m of g.members) emitToUser(m, "group:message", { groupId: gid, msg });

    const mentions = extractMentions(t);
    for (const m of mentions) {
      if (!users[m] || m === authedUser) continue;
      const rec = users[m];
      if ((rec.social?.blocked || []).includes(authedUser)) continue;

      addInboxItem(m, {
        id: newId("inb"),
        type: "mention",
        from: authedUser,
        text: `Mentioned you in “${g.name}”: ${t.slice(0, 160)}`,
        ts: now(),
        meta: { scope: "group", groupId: gid, name: g.name }
      });
      persistAll();
      emitToUser(m, "inbox:badge", countInbox(rec));
      emitToUser(m, "inbox:data", { items: rec.inbox });
    }
  });

  socket.on("group:addMember", ({ groupId, user }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const g = groups[gid];
    if (!g) return;
    if (g.owner !== authedUser) return;

    const target = String(user || "").trim();
    if (!isValidUser(target) || !users[target] || isGuestName(target)) return socket.emit("sendError", { reason: "User not found." });

    if (g.members.includes(target)) return;
    if (g.members.length >= 200) return socket.emit("sendError", { reason: "Group is full (200 cap)." });

    g.members.push(target);
    persistAll();

    const meta = groupPublic(g);
    for (const m of g.members) emitToUser(m, "group:meta", { groupId: gid, meta });

    emitToUser(target, "groups:list", Object.values(groups).filter(x => x.members.includes(target)).map(groupPublic));
  });

  socket.on("group:leave", ({ groupId }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const g = groups[gid];
    if (!g || !g.members.includes(authedUser)) return;

    if (g.owner === authedUser) {
      const members = [...g.members];
      delete groups[gid];
      persistAll();
      for (const m of members) {
        emitToUser(m, "group:deleted", { groupId: gid });
        emitToUser(m, "groups:list", Object.values(groups).filter(x => x.members.includes(m)).map(groupPublic));
      }
      return;
    }

    g.members = g.members.filter(x => x !== authedUser);
    persistAll();

    const meta = groupPublic(g);
    for (const m of g.members) emitToUser(m, "group:meta", { groupId: gid, meta });

    socket.emit("group:left", { groupId: gid });
    socket.emit("groups:list", Object.values(groups).filter(x => x.members.includes(authedUser)).map(groupPublic));
  });

  socket.on("group:delete", ({ groupId }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const g = groups[gid];
    if (!g || g.owner !== authedUser) return;

    const members = [...g.members];
    delete groups[gid];
    persistAll();

    for (const m of members) {
      emitToUser(m, "group:deleted", { groupId: gid });
      emitToUser(m, "groups:list", Object.values(groups).filter(x => x.members.includes(m)).map(groupPublic));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
