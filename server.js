// server.js — full working Socket.IO chat server
// Features:
// - Login/Create account (username+password strict alnum, min 4)
// - Guest login
// - Session resume via token
// - Status (online/idle/dnd/invisible), with online list broadcast
// - Global chat history
// - DMs (no guests)
// - Friends + friend requests (Inbox)
// - Mentions @username -> Inbox mention item + badge updates
// - Groups with invites, member cap 200, group info/meta, owner tools
//
// Run:
//   npm i
//   npm start
//
// Then open: http://localhost:3000

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

// -------------------- Paths / Storage --------------------
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const GROUPS_FILE = path.join(DATA_DIR, "groups.json");
const GLOBAL_FILE = path.join(DATA_DIR, "global.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}

let users = readJson(USERS_FILE, {}); // username -> userRecord
let groups = readJson(GROUPS_FILE, {}); // groupId -> groupRecord
let globalHistory = readJson(GLOBAL_FILE, []); // [{user,text,ts}]

function persistAll() {
  writeJson(USERS_FILE, users);
  writeJson(GROUPS_FILE, groups);
  writeJson(GLOBAL_FILE, globalHistory);
}

// -------------------- Validation --------------------
function isValidUser(u) {
  return /^[A-Za-z0-9]{4,20}$/.test(String(u || ""));
}
function isValidPass(p) {
  return /^[A-Za-z0-9]{4,32}$/.test(String(p || ""));
}
function isGuestName(u) {
  return /^Guest\d{4,5}$/.test(String(u || ""));
}

// -------------------- Password hashing --------------------
function pbkdf2Hash(password, salt) {
  const iters = 120000;
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

// -------------------- Helpers --------------------
function now() {
  return Date.now();
}
function newToken() {
  return crypto.randomBytes(24).toString("hex");
}
function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function ensureUser(username) {
  if (!users[username]) {
    users[username] = {
      user: username,
      createdAt: now(),
      pass: null, // {salt,iters,keylen,digest,hash}
      token: null,
      status: "online",
      settings: { sounds: true, hideMildProfanity: false },
      social: {
        friends: [],
        incoming: [],
        outgoing: [],
        blocked: []
      },
      inbox: [], // items: {id,type,from,text,ts,meta}
      stats: { messages: 0, xp: 0, level: 1 }
    };
  }
  return users[username];
}

function addInboxItem(toUser, item) {
  const u = ensureUser(toUser);
  u.inbox.unshift(item);
  // keep inbox smallish
  if (u.inbox.length > 200) u.inbox.length = 200;
}

function countInbox(u) {
  const items = (u.inbox || []);
  let friend = 0, groupInv = 0, ment = 0;
  for (const it of items) {
    if (it.type === "friend") friend++;
    else if (it.type === "group") groupInv++;
    else if (it.type === "mention") ment++;
  }
  return { total: friend + groupInv + ment, friend, groupInv, ment };
}

function safeUserPublic(u) {
  return {
    user: u.user,
    status: u.status
  };
}

// -------------------- Online tracking --------------------
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

function isOnline(user) {
  const set = socketsByUser.get(user);
  return !!set && set.size > 0;
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

    // invisible users should not appear online
    if (u.status === "invisible") continue;

    list.push(safeUserPublic(u));
  }

  // sort stable
  list.sort((a, b) => a.user.localeCompare(b.user));
  io.emit("onlineUsers", list);
}

// -------------------- Global History --------------------
function pushGlobalMessage(msg) {
  globalHistory.push(msg);
  if (globalHistory.length > 300) globalHistory.shift();
  writeJson(GLOBAL_FILE, globalHistory);
}

// -------------------- Mentions --------------------
function extractMentions(text) {
  const t = String(text || "");
  // @Username tokens, strict alnum 4-20
  const rx = /@([A-Za-z0-9]{4,20})/g;
  const found = new Set();
  let m;
  while ((m = rx.exec(t)) !== null) {
    found.add(m[1]);
  }
  return Array.from(found);
}

// -------------------- Groups --------------------
function ensureGroup(groupId) {
  return groups[groupId];
}

function groupPublic(g) {
  return {
    id: g.id,
    name: g.name,
    owner: g.owner,
    members: g.members
  };
}

function userCanSeeGroup(user, groupId) {
  const g = groups[groupId];
  if (!g) return false;
  return g.members.includes(user);
}

// -------------------- Express / Socket.IO --------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

io.on("connection", (socket) => {
  let authedUser = null;

  function requireAuth() {
    return !!authedUser && users[authedUser];
  }
  function requireNonGuest() {
    return requireAuth() && !isGuestName(authedUser);
  }

  function sendInitSuccess(u, { guest = false } = {}) {
    authedUser = u.user;
    setOnline(authedUser, socket.id);

    // default status when connecting:
    // - guests are always "online"
    // - stored status for users, but if invisible, keep invisible (they appear offline in list)
    if (guest) u.status = "online";

    // token for resume (non-guest)
    let tok = null;
    if (!guest) {
      if (!u.token) u.token = newToken();
      tok = u.token;
    }

    socket.emit("loginSuccess", {
      username: u.user,
      guest: !!guest,
      token: tok,
      status: u.status,
      settings: u.settings || { sounds: true, hideMildProfanity: false },
      social: u.social || { friends: [], incoming: [], outgoing: [], blocked: [] }
    });

    // send inbox badge + items
    if (!guest) {
      socket.emit("inbox:badge", countInbox(u));
      socket.emit("inbox:data", { items: (u.inbox || []) });
      socket.emit("social:update", u.social);
      socket.emit("settings", u.settings);
    }

    broadcastOnlineUsers();
  }

  // -------------------- Session resume --------------------
  socket.on("resume", ({ token }) => {
    const tok = String(token || "");
    if (!tok) {
      socket.emit("resumeFail");
      return;
    }
    const found = Object.values(users).find(u => u.token === tok);
    if (!found) {
      socket.emit("resumeFail");
      return;
    }
    sendInitSuccess(found, { guest: false });
  });

  // -------------------- Login / Guest --------------------
  socket.on("login", ({ username, password, guest }) => {
    if (guest) {
      // Create a unique guest username
      let g;
      for (let i = 0; i < 50; i++) {
        const n = 1000 + Math.floor(Math.random() * 9000);
        const name = `Guest${n}`;
        if (!users[name] && !isOnline(name)) {
          g = ensureUser(name);
          g.pass = null;
          g.token = null;
          g.status = "online";
          break;
        }
      }
      if (!g) {
        socket.emit("loginError", "Guest slots busy. Try again.");
        return;
      }
      sendInitSuccess(g, { guest: true });
      persistAll();
      return;
    }

    const u = String(username || "");
    const p = String(password || "");

    if (!isValidUser(u)) {
      socket.emit("loginError", "Username must be letters/numbers only (min 4).");
      return;
    }
    if (!isValidPass(p)) {
      socket.emit("loginError", "Password must be letters/numbers only (min 4).");
      return;
    }

    const rec = ensureUser(u);

    if (!rec.pass) {
      // create account
      rec.pass = createPasswordRecord(p);
      rec.token = newToken();
      rec.status = "online";
      persistAll();
      sendInitSuccess(rec, { guest: false });
      return;
    }

    if (!verifyPassword(p, rec.pass)) {
      socket.emit("loginError", "Incorrect password.");
      return;
    }

    // successful login, rotate token
    rec.token = newToken();
    rec.status = rec.status || "online";
    persistAll();
    sendInitSuccess(rec, { guest: false });
  });

  // -------------------- Disconnect --------------------
  socket.on("disconnect", () => {
    setOffline(socket.id);
    broadcastOnlineUsers();
  });

  // -------------------- Status --------------------
  socket.on("status:set", ({ status }) => {
    if (!requireAuth()) return;
    const s = String(status || "");
    const allowed = new Set(["online", "idle", "dnd", "invisible"]);
    if (!allowed.has(s)) return;

    const u = users[authedUser];
    u.status = s;

    // tell that user only (for UI), and update online list
    emitToUser(authedUser, "status:update", { status: s });
    persistAll();
    broadcastOnlineUsers();
  });

  // -------------------- Settings --------------------
  socket.on("settings:update", (s) => {
    if (!requireNonGuest()) return;
    const u = users[authedUser];
    u.settings = u.settings || {};
    if (typeof s?.sounds === "boolean") u.settings.sounds = s.sounds;
    if (typeof s?.hideMildProfanity === "boolean") u.settings.hideMildProfanity = s.hideMildProfanity;
    persistAll();
    socket.emit("settings", u.settings);
  });

  // -------------------- Social sync --------------------
  socket.on("social:sync", () => {
    if (!requireNonGuest()) return;
    socket.emit("social:update", users[authedUser].social);
  });

  // -------------------- Profile --------------------
  socket.on("profile:get", ({ user }) => {
    if (!requireAuth()) return;
    const target = String(user || "");
    const t = users[target];
    if (!t) {
      socket.emit("profile:data", { user: target, guest: true });
      return;
    }

    socket.emit("profile:data", {
      user: t.user,
      guest: isGuestName(t.user),
      createdAt: t.createdAt,
      status: t.status || "offline",
      messages: t.stats?.messages || 0,
      xp: t.stats?.xp || 0,
      level: t.stats?.level || 1,
      next: 120 + (t.stats?.level || 1) * 40
    });
  });

  // -------------------- Block/unblock --------------------
  socket.on("user:block", ({ user }) => {
    if (!requireNonGuest()) return;
    const target = String(user || "");
    if (!users[target] || target === authedUser) return;

    const meRec = users[authedUser];
    meRec.social.blocked = meRec.social.blocked || [];
    if (!meRec.social.blocked.includes(target)) meRec.social.blocked.push(target);

    // if friends, remove
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

  // -------------------- Friend requests --------------------
  socket.on("friend:request", ({ to }) => {
    if (!requireNonGuest()) return;
    const target = String(to || "");
    if (!users[target]) {
      socket.emit("sendError", { reason: "User not found." });
      return;
    }
    if (target === authedUser) return;

    const meRec = users[authedUser];
    const tRec = users[target];

    // blocked checks
    if ((meRec.social.blocked || []).includes(target)) {
      socket.emit("sendError", { reason: "Unblock user first." });
      return;
    }
    if ((tRec.social.blocked || []).includes(authedUser)) {
      socket.emit("sendError", { reason: "Cannot send request to this user." });
      return;
    }

    meRec.social.outgoing = meRec.social.outgoing || [];
    tRec.social.incoming = tRec.social.incoming || [];
    meRec.social.friends = meRec.social.friends || [];
    tRec.social.friends = tRec.social.friends || [];

    if (meRec.social.friends.includes(target)) return;
    if (meRec.social.outgoing.includes(target)) return;

    // Add outgoing/incoming
    meRec.social.outgoing.push(target);
    if (!tRec.social.incoming.includes(authedUser)) tRec.social.incoming.push(authedUser);

    // Inbox item for target
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

    meRec.social.friends = meRec.social.friends || [];
    sRec.social.friends = sRec.social.friends || [];
    if (!meRec.social.friends.includes(src)) meRec.social.friends.push(src);
    if (!sRec.social.friends.includes(authedUser)) sRec.social.friends.push(authedUser);

    // remove friend inbox items from me
    meRec.inbox = (meRec.inbox || []).filter(it => !(it.type === "friend" && it.from === src));

    persistAll();
    socket.emit("social:update", meRec.social);
    emitToUser(src, "social:update", sRec.social);

    socket.emit("inbox:badge", countInbox(meRec));
    socket.emit("inbox:data", { items: meRec.inbox });

    emitToUser(src, "inbox:badge", countInbox(sRec));
  });

  socket.on("friend:decline", ({ from }) => {
    if (!requireNonGuest()) return;
    const src = String(from || "");
    if (!users[src]) return;

    const meRec = users[authedUser];
    const sRec = users[src];

    meRec.social.incoming = (meRec.social.incoming || []).filter(x => x !== src);
    sRec.social.outgoing = (sRec.social.outgoing || []).filter(x => x !== authedUser);

    // remove friend inbox items
    meRec.inbox = (meRec.inbox || []).filter(it => !(it.type === "friend" && it.from === src));

    persistAll();
    socket.emit("social:update", meRec.social);
    emitToUser(src, "social:update", sRec.social);

    socket.emit("inbox:badge", countInbox(meRec));
    socket.emit("inbox:data", { items: meRec.inbox });
  });

  // -------------------- Inbox --------------------
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

  // -------------------- Global chat --------------------
  socket.on("requestGlobalHistory", () => {
    socket.emit("history", globalHistory);
  });

  socket.on("sendGlobal", ({ text, ts }) => {
    if (!requireAuth()) return;
    const t = String(text || "").trim();
    if (!t) return;
    if (t.length > 1000) return;

    const msg = { user: authedUser, text: t, ts: Number(ts) || now() };
    pushGlobalMessage(msg);

    // stats
    const u = users[authedUser];
    if (u && !isGuestName(authedUser)) {
      u.stats.messages = (u.stats.messages || 0) + 1;
      u.stats.xp = (u.stats.xp || 0) + 5;
      const next = 120 + (u.stats.level || 1) * 40;
      if (u.stats.xp >= next) {
        u.stats.level = (u.stats.level || 1) + 1;
        u.stats.xp = 0;
      }
      persistAll();
    }

    io.emit("globalMessage", msg);

    // mentions -> inbox mention items
    const mentions = extractMentions(t);
    if (mentions.length) {
      for (const m of mentions) {
        if (!users[m]) continue;
        if (m === authedUser) continue;

        // if mentioned user blocks sender, ignore
        const rec = users[m];
        if ((rec.social?.blocked || []).includes(authedUser)) continue;

        addInboxItem(m, {
          id: newId("inb"),
          type: "mention",
          from: authedUser,
          text: `Mentioned you in Global: ${t.slice(0, 160)}`,
          ts: now(),
          meta: { scope: "global" }
        });

        persistAll();
        emitToUser(m, "inbox:badge", countInbox(rec));
        emitToUser(m, "inbox:data", { items: rec.inbox });
      }
    }
  });

  // -------------------- DMs --------------------
  // store in memory on each user: dm[userA][userB] array (bounded)
  function ensureDMStore(userA, userB) {
    const a = ensureUser(userA);
    a.dm = a.dm || {};
    if (!a.dm[userB]) a.dm[userB] = [];
    return a.dm[userB];
  }
  function pushDM(a, b, msg) {
    const arrA = ensureDMStore(a, b);
    const arrB = ensureDMStore(b, a);
    arrA.push(msg);
    arrB.push(msg);
    if (arrA.length > 250) arrA.shift();
    if (arrB.length > 250) arrB.shift();
  }

  socket.on("dm:history", ({ withUser }) => {
    if (!requireNonGuest()) return;
    const other = String(withUser || "");
    if (!users[other] || isGuestName(other)) {
      socket.emit("dm:history", { withUser: other, msgs: [] });
      return;
    }

    const meRec = users[authedUser];
    const otherRec = users[other];

    // block checks
    if ((meRec.social?.blocked || []).includes(other)) {
      socket.emit("dm:history", { withUser: other, msgs: [] });
      return;
    }
    if ((otherRec.social?.blocked || []).includes(authedUser)) {
      socket.emit("dm:history", { withUser: other, msgs: [] });
      return;
    }

    const arr = ensureDMStore(authedUser, other);
    socket.emit("dm:history", { withUser: other, msgs: arr });
  });

  socket.on("dm:send", ({ to, text }) => {
    if (!requireNonGuest()) return;
    const other = String(to || "");
    const t = String(text || "").trim();
    if (!t) return;
    if (t.length > 1000) return;
    if (!users[other] || isGuestName(other)) return;

    const meRec = users[authedUser];
    const otherRec = users[other];

    if ((meRec.social?.blocked || []).includes(other)) return;
    if ((otherRec.social?.blocked || []).includes(authedUser)) return;

    const msg = { user: authedUser, text: t, ts: now() };
    pushDM(authedUser, other, msg);
    persistAll();

    // deliver to both sides
    emitToUser(other, "dm:message", { from: authedUser, msg });
    socket.emit("dm:message", { from: other, msg }); // echo style for client caches

    // mentions in DM -> inbox mention
    const mentions = extractMentions(t);
    for (const m of mentions) {
      if (!users[m]) continue;
      if (m === authedUser) continue;
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

  // -------------------- Groups --------------------
  socket.on("groups:list", () => {
    if (!requireNonGuest()) return;
    const list = [];
    for (const g of Object.values(groups)) {
      if (g.members.includes(authedUser)) list.push(groupPublic(g));
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    socket.emit("groups:list", list);
  });

  socket.on("group:createRequest", ({ name, invites }) => {
    if (!requireNonGuest()) return;

    const groupName = String(name || "").trim() || "Unnamed Group";
    const rawInv = Array.isArray(invites) ? invites : [];
    const uniq = Array.from(new Set(rawInv.map(x => String(x || "").trim()).filter(Boolean)));

    // cap invites to 199 so owner + 199 = 200 max potential
    const trimmed = uniq.slice(0, 199);

    // validate usernames
    for (const u of trimmed) {
      if (!isValidUser(u) || !users[u] || isGuestName(u)) {
        socket.emit("sendError", { reason: "Invalid invite list." });
        return;
      }
    }

    const gid = newId("grp");
    groups[gid] = {
      id: gid,
      name: groupName.slice(0, 32),
      owner: authedUser,
      members: [authedUser],
      invites: trimmed.map(u => ({ id: newId("inv"), to: u, from: authedUser, ts: now() })),
      createdAt: now()
    };

    // Send inbox invites
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

    // Update creator group list
    socket.emit("groups:list", Object.values(groups).filter(g => g.members.includes(authedUser)).map(groupPublic));
    socket.emit("group:meta", { groupId: gid, meta: groupPublic(groups[gid]) });
  });

  socket.on("groupInvite:accept", ({ id }) => {
    if (!requireNonGuest()) return;
    const inviteId = String(id || "");

    // find invite across groups
    let gFound = null;
    let invFound = null;
    for (const g of Object.values(groups)) {
      const inv = (g.invites || []).find(x => x.id === inviteId && x.to === authedUser);
      if (inv) {
        gFound = g;
        invFound = inv;
        break;
      }
    }
    if (!gFound || !invFound) return;

    // cap 200
    if (gFound.members.length >= 200) {
      socket.emit("sendError", { reason: "Group is full (200 member cap)." });
      return;
    }

    // add member
    if (!gFound.members.includes(authedUser)) gFound.members.push(authedUser);

    // remove invite
    gFound.invites = (gFound.invites || []).filter(x => x.id !== inviteId);

    // remove inbox item
    const meRec = users[authedUser];
    meRec.inbox = (meRec.inbox || []).filter(it => it.id !== inviteId);

    persistAll();

    // Notify group members meta update
    const meta = groupPublic(gFound);
    for (const m of gFound.members) {
      emitToUser(m, "group:meta", { groupId: gFound.id, meta });
    }

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
      if (inv) {
        gFound = g;
        break;
      }
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
    const g = ensureGroup(gid);
    if (!g || !g.members.includes(authedUser)) return;

    g.messages = g.messages || [];
    socket.emit("group:history", { groupId: gid, meta: groupPublic(g), msgs: g.messages });
  });

  socket.on("group:send", ({ groupId, text }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const g = ensureGroup(gid);
    if (!g || !g.members.includes(authedUser)) return;

    const t = String(text || "").trim();
    if (!t) return;
    if (t.length > 1000) return;

    g.messages = g.messages || [];
    const msg = { user: authedUser, text: t, ts: now() };
    g.messages.push(msg);
    if (g.messages.length > 400) g.messages.shift();

    persistAll();

    for (const m of g.members) {
      emitToUser(m, "group:message", { groupId: gid, msg });
    }

    // mentions -> inbox mention items
    const mentions = extractMentions(t);
    if (mentions.length) {
      for (const m of mentions) {
        if (!users[m]) continue;
        if (m === authedUser) continue;

        const rec = users[m];
        if ((rec.social?.blocked || []).includes(authedUser)) continue;

        addInboxItem(m, {
          id: newId("inb"),
          type: "mention",
          from: authedUser,
          text: `Mentioned you in group “${g.name}”: ${t.slice(0, 160)}`,
          ts: now(),
          meta: { scope: "group", groupId: gid, name: g.name }
        });

        persistAll();
        emitToUser(m, "inbox:badge", countInbox(rec));
        emitToUser(m, "inbox:data", { items: rec.inbox });
      }
    }
  });

  socket.on("group:addMember", ({ groupId, user }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const g = ensureGroup(gid);
    if (!g) return;
    if (g.owner !== authedUser) return;

    const target = String(user || "").trim();
    if (!isValidUser(target) || !users[target] || isGuestName(target)) {
      socket.emit("sendError", { reason: "User not found." });
      return;
    }
    if (g.members.includes(target)) return;

    if (g.members.length >= 200) {
      socket.emit("sendError", { reason: "Group is full (200 member cap)." });
      return;
    }

    g.members.push(target);
    persistAll();

    // Notify meta to members
    const meta = groupPublic(g);
    for (const m of g.members) {
      emitToUser(m, "group:meta", { groupId: gid, meta });
    }

    // also update target group list
    emitToUser(target, "groups:list", Object.values(groups).filter(x => x.members.includes(target)).map(groupPublic));
  });

  socket.on("group:leave", ({ groupId }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const g = ensureGroup(gid);
    if (!g) return;
    if (!g.members.includes(authedUser)) return;

    // owner leaving deletes group (clean and predictable)
    if (g.owner === authedUser) {
      // delete group for everyone
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
    const g = ensureGroup(gid);
    if (!g) return;
    if (g.owner !== authedUser) return;

    const members = [...g.members];
    delete groups[gid];
    persistAll();

    for (const m of members) {
      emitToUser(m, "group:deleted", { groupId: gid });
      emitToUser(m, "groups:list", Object.values(groups).filter(x => x.members.includes(m)).map(groupPublic));
    }
  });

  // -------------------- Online user list at connect (after auth only) --------------------
  // (broadcastOnlineUsers is called after login/resume)
});

// -------------------- Boot --------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
