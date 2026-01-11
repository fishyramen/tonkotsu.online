"use strict";

/**
 * tonkotsu.online server
 * - persistent JSON storage (data/)
 * - accounts + sessions (auto-login)
 * - global + DM + groups
 * - profiles + stats + xp/levels
 * - friends + requests + blocks
 * - NO alerts (server only emits events)
 */

const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/* -------------------- persistence -------------------- */
const DATA_DIR = path.join(__dirname, "data");
const FILES = {
  users: path.join(DATA_DIR, "users.json"),
  global: path.join(DATA_DIR, "global.json"),
  dms: path.join(DATA_DIR, "dms.json"),
  groups: path.join(DATA_DIR, "groups.json"),
  sessions: path.join(DATA_DIR, "sessions.json"),
};

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function ensureFile(file, fallback) { if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2)); }
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8") || ""); } catch { return fallback; } }
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

ensureDir(DATA_DIR);
ensureFile(FILES.users, {});
ensureFile(FILES.global, []);
ensureFile(FILES.dms, {});
ensureFile(FILES.groups, {});
ensureFile(FILES.sessions, {});

let USERS = readJSON(FILES.users, {});
let GLOBAL = readJSON(FILES.global, []);
let DMS = readJSON(FILES.dms, {});
let GROUPS = readJSON(FILES.groups, {});
let SESSIONS = readJSON(FILES.sessions, {});

function saveUsers() { writeJSON(FILES.users, USERS); }
function saveGlobal() { writeJSON(FILES.global, GLOBAL); }
function saveDms() { writeJSON(FILES.dms, DMS); }
function saveGroups() { writeJSON(FILES.groups, GROUPS); }
function saveSessions() { writeJSON(FILES.sessions, SESSIONS); }

/* -------------------- helpers -------------------- */
const ONLINE = new Map();       // socket.id -> username
const USER_SOCKETS = new Map(); // username -> Set(socket.id)

function now() { return Date.now(); }
function genId() { return crypto.randomBytes(10).toString("hex") + "-" + now().toString(36); }
function norm(s) { return String(s || "").trim(); }
function isGuest(u) { return /^Guest\d{1,10}$/.test(String(u || "")); }

function hashPass(pw) {
  const salt = "tonkotsu_salt_v2";
  return crypto.createHash("sha256").update(salt + String(pw || "")).digest("hex");
}

function dmKey(a, b) {
  const x = String(a), y = String(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

function defaultSettings() {
  return {
    muteAll: false,
    muteGlobal: true,
    muteDM: false,
    muteGroups: false,
    sound: true,
    volume: 0.2,
    reduceMotion: false,
    customCursor: false,
    hideMildProfanity: false,
    theme: "dark",     // dark | vortex | abyss | carbon
    density: 0.55,     // 0 compact -> 1 cozy
  };
}

// username rules: letters numbers _ .
const USERNAME_RX = /^[A-Za-z0-9._]{3,20}$/;

// big-ish banned word list for usernames (slurs + explicit / 18+)
const USERNAME_BANNED = [
  // slurs / hateful (partial list)
  "nigger","nigga","niqqa","faggot","fag","tranny","kike","spic","chink","wetback",
  "retard","rape","rapist",
  // explicit / 18+ / porn related
  "porn","xxx","sex","sexy","nsfw","onlyfans","hentai","boobs","tits","dick","cock","pussy",
  "cum","cumming","orgasm","blowjob","handjob","anal","milf","bdsm",
];

function usernameAllowed(u) {
  if (!USERNAME_RX.test(u)) return { ok: false, reason: "Usernames must be 3-20 chars and only use letters, numbers, _ or ." };
  const low = u.toLowerCase();
  for (const w of USERNAME_BANNED) {
    if (low.includes(w)) return { ok: false, reason: "That username isn’t allowed." };
  }
  return { ok: true };
}

function ensureUser(user) {
  if (!USERS[user]) return null;
  USERS[user].settings = USERS[user].settings || defaultSettings();
  USERS[user].createdAt = USERS[user].createdAt || now();
  USERS[user].stats = USERS[user].stats || { total: 0, global: 0, dm: 0, group: 0 };
  USERS[user].social = USERS[user].social || { friends: [], incoming: [], outgoing: [], blocked: [] };
  USERS[user].xp = USERS[user].xp || { level: 1, xp: 0 };
  return USERS[user];
}

function addSocketToUser(user, sid) {
  if (!USER_SOCKETS.has(user)) USER_SOCKETS.set(user, new Set());
  USER_SOCKETS.get(user).add(sid);
}
function removeSocketFromUser(user, sid) {
  const set = USER_SOCKETS.get(user);
  if (!set) return;
  set.delete(sid);
  if (set.size === 0) USER_SOCKETS.delete(user);
}
function emitToUser(user, event, payload) {
  const set = USER_SOCKETS.get(user);
  if (!set) return;
  for (const sid of set) io.to(sid).emit(event, payload);
}

function onlineUsersPayload() {
  const uniq = new Set();
  const list = [];
  for (const u of ONLINE.values()) {
    if (!u || uniq.has(u)) continue;
    uniq.add(u);
    list.push({ user: u });
  }
  list.sort((a, b) => a.user.localeCompare(b.user));
  return list;
}
function broadcastOnline() { io.emit("onlineUsers", onlineUsersPayload()); }

// XP/Level curve
function xpNeeded(level) {
  // grows faster each level
  // L1->2: 120, L2->3: 165, L3->4: 220, ...
  return Math.floor(90 + level * level * 30);
}
function addXp(user, amount) {
  const U = ensureUser(user);
  if (!U) return;
  const X = U.xp || (U.xp = { level: 1, xp: 0 });

  X.xp += amount;
  while (X.xp >= xpNeeded(X.level)) {
    X.xp -= xpNeeded(X.level);
    X.level += 1;
  }
  saveUsers();
  emitToUser(user, "xp:update", { level: X.level, xp: X.xp, next: xpNeeded(X.level) });
}

/* -------------------- profanity filter (GLOBAL) -------------------- */
function normalizeForFilter(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsGlobalBan(text) {
  const t = normalizeForFilter(text);

  const hard = [
    // n-word variants
    /\bn\s*[i1l!]\s*[gq]\s*[gq]\s*[e3a]\s*r\b/,
    /\bn\s*[i1l!]\s*[gq]\s*[gq]\s*[a4]\b/,
    /\bnigg(er|a|ah|uh|as|az)\b/,
    /\bniqq(a|er)\b/,
    /\bfaggot\b/,
    /\btranny\b/,
    /\bkike\b/,
    /\bspic\b/,
    /\bchink\b/,
    // threats
    /\bkill\s+yourself\b/,
    /\bkys\b/,
    /\bi\s*(will|am\s+going\s+to|gonna)\s+kill\s+you\b/,
    /\bgo\s+die\b/,
    /\bi\s*hope\s+you\s+die\b/,
    /\bshoot\s+you\b/,
    /\bstab\s+you\b/,
  ];

  for (const rx of hard) {
    if (rx.test(t)) return { blocked: true, reason: "That message is blocked in global chat.", code: "HARMFUL" };
  }
  return { blocked: false };
}

/* -------------------- groups helpers -------------------- */
function groupSummaryFor(user) {
  const list = [];
  for (const g of Object.values(GROUPS)) {
    if (g && Array.isArray(g.members) && g.members.includes(user)) {
      list.push({ id: g.id, name: g.name, owner: g.owner, members: g.members.length });
    }
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

/* -------------------- social helpers -------------------- */
function isBlocked(viewer, other) {
  const V = ensureUser(viewer);
  if (!V) return false;
  return V.social?.blocked?.includes(other) || false;
}

/* -------------------- socket -------------------- */
io.on("connection", (socket) => {
  socket.data.user = null;
  socket.data.view = { type: "none", id: null };

  socket.on("view:set", ({ type, id }) => {
    socket.data.view = { type: type || "none", id: id || null };
  });

  socket.on("requestGlobalHistory", () => {
    socket.emit("history", GLOBAL);
  });

  // -------- resume (auto-login) --------
  socket.on("resume", ({ token }) => {
    const t = norm(token);
    const sess = SESSIONS[t];
    if (!t || !sess || !sess.user || !USERS[sess.user]) {
      socket.emit("resumeFail");
      return;
    }

    const u = sess.user;
    ensureUser(u);

    socket.data.user = u;
    ONLINE.set(socket.id, u);
    addSocketToUser(u, socket.id);

    socket.emit("loginSuccess", {
      username: u,
      guest: false,
      token: t,
      settings: USERS[u].settings,
      social: USERS[u].social,
      xp: USERS[u].xp,
    });

    socket.emit("history", GLOBAL);
    socket.emit("groups:list", groupSummaryFor(u));
    broadcastOnline();
  });

  // -------- login --------
  socket.on("login", (payload) => {
    const guest = !!payload?.guest;

    if (guest) {
      const guestName = `Guest${Math.floor(Math.random() * 9000 + 1000)}`;
      socket.data.user = guestName;
      ONLINE.set(socket.id, guestName);

      socket.emit("loginSuccess", {
        username: guestName,
        guest: true,
        token: null,
        settings: null,
        social: null,
        xp: { level: 1, xp: 0, next: xpNeeded(1) },
      });

      socket.emit("history", GLOBAL);
      broadcastOnline();
      return;
    }

    const username = norm(payload?.username ?? payload?.user);
    const password = String(payload?.password ?? payload?.pass ?? "");

    if (!username || !password) {
      socket.emit("loginError", "Missing credentials");
      return;
    }

    const ok = usernameAllowed(username);
    if (!ok.ok) {
      socket.emit("loginError", ok.reason);
      return;
    }

    if (!USERS[username]) {
      USERS[username] = {
        passwordHash: hashPass(password),
        createdAt: now(),
        settings: defaultSettings(),
        stats: { total: 0, global: 0, dm: 0, group: 0 },
        social: { friends: [], incoming: [], outgoing: [], blocked: [] },
        xp: { level: 1, xp: 0 },
      };
      saveUsers();
    } else {
      ensureUser(username);
      if (USERS[username].passwordHash !== hashPass(password)) {
        socket.emit("loginError", "Wrong password");
        return;
      }
    }

    const token = crypto.randomBytes(24).toString("hex");
    SESSIONS[token] = { user: username, createdAt: now() };
    saveSessions();

    socket.data.user = username;
    ONLINE.set(socket.id, username);
    addSocketToUser(username, socket.id);

    socket.emit("loginSuccess", {
      username,
      guest: false,
      token,
      settings: USERS[username].settings,
      social: USERS[username].social,
      xp: USERS[username].xp,
    });

    socket.emit("history", GLOBAL);
    socket.emit("groups:list", groupSummaryFor(username));
    broadcastOnline();
  });

  // -------- settings update --------
  socket.on("settings:update", (settings) => {
    const u = socket.data.user;
    if (!u || isGuest(u)) return;
    ensureUser(u);
    USERS[u].settings = { ...USERS[u].settings, ...(settings || {}) };
    saveUsers();
    emitToUser(u, "settings", USERS[u].settings);
  });

  // -------- profile get --------
  socket.on("profile:get", ({ user }) => {
    const target = norm(user);
    if (!target) return;

    // guest profiles: limited
    if (isGuest(target)) {
      socket.emit("profile:data", { user: target, guest: true, createdAt: null, xp: { level: 1, xp: 0 }, stats: { total: 0 } });
      return;
    }

    const U = ensureUser(target);
    if (!U) {
      socket.emit("profile:error", "User not found.");
      return;
    }

    socket.emit("profile:data", {
      user: target,
      guest: false,
      createdAt: U.createdAt,
      xp: { level: U.xp.level, xp: U.xp.xp, next: xpNeeded(U.xp.level) },
      stats: U.stats,
      socialCounts: {
        friends: U.social.friends.length,
        blocked: U.social.blocked.length,
      }
    });
  });

  // -------- social: friend request / accept / remove / block --------
  socket.on("friend:request", ({ to }) => {
    const me = socket.data.user;
    const target = norm(to);
    if (!me || isGuest(me)) return;
    if (!target || !USERS[target]) return;
    if (target === me) return;

    ensureUser(me);
    ensureUser(target);

    if (USERS[me].social.friends.includes(target)) return;
    if (USERS[me].social.outgoing.includes(target)) return;

    // if blocked either way, ignore
    if (isBlocked(me, target) || isBlocked(target, me)) return;

    USERS[me].social.outgoing.push(target);
    USERS[target].social.incoming.push(me);
    saveUsers();

    emitToUser(me, "social:update", USERS[me].social);
    emitToUser(target, "social:update", USERS[target].social);
  });

  socket.on("friend:accept", ({ from }) => {
    const me = socket.data.user;
    const who = norm(from);
    if (!me || isGuest(me)) return;
    if (!who || !USERS[who]) return;

    ensureUser(me);
    ensureUser(who);

    // remove pending
    USERS[me].social.incoming = USERS[me].social.incoming.filter(x => x !== who);
    USERS[who].social.outgoing = USERS[who].social.outgoing.filter(x => x !== me);

    // add friends both sides
    if (!USERS[me].social.friends.includes(who)) USERS[me].social.friends.push(who);
    if (!USERS[who].social.friends.includes(me)) USERS[who].social.friends.push(me);

    saveUsers();
    emitToUser(me, "social:update", USERS[me].social);
    emitToUser(who, "social:update", USERS[who].social);
  });

  socket.on("friend:remove", ({ user }) => {
    const me = socket.data.user;
    const who = norm(user);
    if (!me || isGuest(me)) return;
    if (!who || !USERS[who]) return;

    ensureUser(me);
    ensureUser(who);

    USERS[me].social.friends = USERS[me].social.friends.filter(x => x !== who);
    USERS[who].social.friends = USERS[who].social.friends.filter(x => x !== me);

    saveUsers();
    emitToUser(me, "social:update", USERS[me].social);
    emitToUser(who, "social:update", USERS[who].social);
  });

  socket.on("block:set", ({ user, blocked }) => {
    const me = socket.data.user;
    const who = norm(user);
    if (!me || isGuest(me)) return;
    if (!who || !USERS[who] || who === me) return;

    ensureUser(me);

    const list = USERS[me].social.blocked;
    const isB = list.includes(who);

    if (blocked && !isB) list.push(who);
    if (!blocked && isB) USERS[me].social.blocked = list.filter(x => x !== who);

    // if blocked, also remove friend relation and pending
    if (blocked) {
      USERS[me].social.friends = USERS[me].social.friends.filter(x => x !== who);
      USERS[me].social.incoming = USERS[me].social.incoming.filter(x => x !== who);
      USERS[me].social.outgoing = USERS[me].social.outgoing.filter(x => x !== who);

      ensureUser(who);
      USERS[who].social.friends = USERS[who].social.friends.filter(x => x !== me);
      USERS[who].social.incoming = USERS[who].social.incoming.filter(x => x !== me);
      USERS[who].social.outgoing = USERS[who].social.outgoing.filter(x => x !== me);
    }

    saveUsers();
    emitToUser(me, "social:update", USERS[me].social);
    if (USERS[who]) emitToUser(who, "social:update", USERS[who].social);
  });

  // -------- GLOBAL SEND --------
  socket.on("sendGlobal", ({ text, ts }) => {
    const u = socket.data.user;
    if (!u) return;

    const msg = String(text || "").trim();
    if (!msg) return;

    const time = Number.isFinite(ts) ? ts : now();

    // server-enforced harmful filter
    const check = containsGlobalBan(msg);
    if (check.blocked) {
      socket.emit("sendError", { scope: "global", reason: check.reason, code: check.code });
      return;
    }

    const payload = { id: genId(), user: u, text: msg.slice(0, 900), ts: time };
    GLOBAL.push(payload);
    if (GLOBAL.length > 450) GLOBAL = GLOBAL.slice(GLOBAL.length - 450);
    saveGlobal();

    io.emit("globalMessage", payload);

    // stats/xp for non-guest
    if (!isGuest(u)) {
      ensureUser(u);
      USERS[u].stats.total += 1;
      USERS[u].stats.global += 1;
      saveUsers();
      addXp(u, 8);
    }
  });

  // -------- DM HISTORY / SEND --------
  socket.on("dm:history", ({ withUser }) => {
    const me = socket.data.user;
    const other = norm(withUser);
    if (!me || isGuest(me)) return;
    if (!other || !USERS[other]) return;

    if (isBlocked(me, other) || isBlocked(other, me)) {
      socket.emit("dm:history", { withUser: other, msgs: [] });
      return;
    }

    const key = dmKey(me, other);
    const list = Array.isArray(DMS[key]) ? DMS[key] : [];
    socket.emit("dm:history", { withUser: other, msgs: list });
  });

  socket.on("dm:send", ({ to, text }) => {
    const from = socket.data.user;
    const target = norm(to);
    const msg = String(text || "").trim();

    if (!from || isGuest(from)) {
      socket.emit("sendError", { scope: "dm", reason: "Guests can't DM." });
      return;
    }
    if (!target || !USERS[target]) {
      socket.emit("sendError", { scope: "dm", reason: "User not found." });
      return;
    }
    if (!msg) return;

    // block enforcement
    if (isBlocked(from, target) || isBlocked(target, from)) {
      socket.emit("sendError", { scope: "dm", reason: "You can’t message this user." });
      return;
    }

    const key = dmKey(from, target);
    if (!Array.isArray(DMS[key])) DMS[key] = [];
    const payload = { id: genId(), from, to: target, text: msg.slice(0, 1200), ts: now() };
    DMS[key].push(payload);
    if (DMS[key].length > 500) DMS[key] = DMS[key].slice(DMS[key].length - 500);
    saveDms();

    emitToUser(from, "dm:message", payload);
    emitToUser(target, "dm:message", payload);

    ensureUser(from);
    USERS[from].stats.total += 1;
    USERS[from].stats.dm += 1;
    saveUsers();
    addXp(from, 10);
  });

  // -------- GROUPS LIST --------
  socket.on("groups:list", () => {
    const me = socket.data.user;
    if (!me || isGuest(me)) {
      socket.emit("groups:list", []);
      return;
    }
    socket.emit("groups:list", groupSummaryFor(me));
  });

  // -------- GROUP CREATE --------
  socket.on("group:create", ({ name }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) {
      socket.emit("sendError", { scope: "group", reason: "Guests can't create groups." });
      return;
    }
    const n = norm(name);
    if (!n) {
      socket.emit("sendError", { scope: "group", reason: "Group needs a name." });
      return;
    }

    const gid = "g_" + genId();
    GROUPS[gid] = {
      id: gid,
      name: n.slice(0, 40),
      owner: me,
      members: [me],
      messages: [],
      createdAt: now(),
    };
    saveGroups();

    socket.emit("group:created", { id: gid, name: GROUPS[gid].name, owner: me, members: 1 });
    socket.emit("groups:list", groupSummaryFor(me));
  });

  // -------- GROUP HISTORY --------
  socket.on("group:history", ({ groupId }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) return;

    const gid = norm(groupId);
    const g = GROUPS[gid];
    if (!g || !g.members.includes(me)) return;

    socket.emit("group:history", {
      groupId: gid,
      meta: { id: gid, name: g.name, owner: g.owner, members: g.members },
      msgs: g.messages || [],
    });
  });

  // -------- GROUP SEND --------
  socket.on("group:send", ({ groupId, text }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) return;

    const gid = norm(groupId);
    const g = GROUPS[gid];
    const msg = String(text || "").trim();
    if (!g || !g.members.includes(me) || !msg) return;

    const payload = { id: genId(), user: me, text: msg.slice(0, 1200), ts: now() };
    g.messages = g.messages || [];
    g.messages.push(payload);
    if (g.messages.length > 700) g.messages = g.messages.slice(g.messages.length - 700);
    saveGroups();

    for (const member of g.members) emitToUser(member, "group:message", { groupId: gid, msg: payload });

    ensureUser(me);
    USERS[me].stats.total += 1;
    USERS[me].stats.group += 1;
    saveUsers();
    addXp(me, 12);
  });

  // -------- GROUP ADD MEMBER (owner-only) --------
  socket.on("group:addMember", ({ groupId, user }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) return;

    const gid = norm(groupId);
    const who = norm(user);
    const g = GROUPS[gid];
    if (!g) return;

    if (g.owner !== me) {
      socket.emit("sendError", { scope: "group", reason: "Owner only." });
      return;
    }
    if (!who || !USERS[who]) {
      socket.emit("sendError", { scope: "group", reason: "User not found." });
      return;
    }
    if (g.members.includes(who)) {
      socket.emit("sendError", { scope: "group", reason: "User is already in the group." });
      return;
    }

    // block check (owner cannot add someone who blocked them / owner blocked them)
    if (isBlocked(me, who) || isBlocked(who, me)) {
      socket.emit("sendError", { scope: "group", reason: "Can’t add this user (blocked)." });
      return;
    }

    g.members.push(who);
    saveGroups();

    // notify both
    emitToUser(me, "groups:list", groupSummaryFor(me));
    emitToUser(who, "groups:list", groupSummaryFor(who));

    emitToUser(who, "group:added", { id: g.id, name: g.name, owner: g.owner });
    emitToUser(me, "group:meta", { groupId: g.id, name: g.name, owner: g.owner, members: g.members });
    emitToUser(who, "group:meta", { groupId: g.id, name: g.name, owner: g.owner, members: g.members });
  });

  // -------- GROUP REMOVE MEMBER (owner-only) --------
  socket.on("group:removeMember", ({ groupId, user }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) return;

    const gid = norm(groupId);
    const who = norm(user);
    const g = GROUPS[gid];
    if (!g) return;

    if (g.owner !== me) {
      socket.emit("sendError", { scope: "group", reason: "Owner only." });
      return;
    }
    if (!who || !g.members.includes(who)) return;
    if (who === g.owner) {
      socket.emit("sendError", { scope: "group", reason: "Transfer ownership before removing the owner." });
      return;
    }

    g.members = g.members.filter(x => x !== who);
    saveGroups();

    emitToUser(me, "groups:list", groupSummaryFor(me));
    emitToUser(who, "groups:list", groupSummaryFor(who));
    emitToUser(who, "group:removed", { groupId: gid, name: g.name });

    for (const member of g.members) emitToUser(member, "group:meta", { groupId: gid, name: g.name, owner: g.owner, members: g.members });
  });

  // -------- GROUP LEAVE (any member) --------
  socket.on("group:leave", ({ groupId }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) return;

    const gid = norm(groupId);
    const g = GROUPS[gid];
    if (!g || !g.members.includes(me)) return;

    // owner leaving requires transfer or delete
    if (g.owner === me) {
      socket.emit("sendError", { scope: "group", reason: "Owner must transfer ownership or delete the group." });
      return;
    }

    g.members = g.members.filter(x => x !== me);
    saveGroups();

    socket.emit("groups:list", groupSummaryFor(me));
    socket.emit("group:left", { groupId: gid });

    for (const member of g.members) emitToUser(member, "group:meta", { groupId: gid, name: g.name, owner: g.owner, members: g.members });
  });

  // -------- GROUP DELETE (owner-only) --------
  socket.on("group:delete", ({ groupId }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) return;

    const gid = norm(groupId);
    const g = GROUPS[gid];
    if (!g) return;

    if (g.owner !== me) {
      socket.emit("sendError", { scope: "group", reason: "Owner only." });
      return;
    }

    const members = g.members.slice();
    delete GROUPS[gid];
    saveGroups();

    for (const m of members) {
      emitToUser(m, "groups:list", groupSummaryFor(m));
      emitToUser(m, "group:deleted", { groupId: gid });
    }
  });

  // -------- GROUP TRANSFER OWNER (owner-only) --------
  socket.on("group:transferOwner", ({ groupId, newOwner }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) return;

    const gid = norm(groupId);
    const to = norm(newOwner);
    const g = GROUPS[gid];
    if (!g) return;

    if (g.owner !== me) {
      socket.emit("sendError", { scope: "group", reason: "Owner only." });
      return;
    }
    if (!to || !g.members.includes(to)) {
      socket.emit("sendError", { scope: "group", reason: "New owner must be a member." });
      return;
    }

    g.owner = to;
    saveGroups();

    for (const member of g.members) {
      emitToUser(member, "group:meta", { groupId: gid, name: g.name, owner: g.owner, members: g.members });
      emitToUser(member, "groups:list", groupSummaryFor(member));
    }
  });

  // -------- disconnect --------
  socket.on("disconnect", () => {
    const u = ONLINE.get(socket.id);
    ONLINE.delete(socket.id);
    if (u) removeSocketFromUser(u, socket.id);
    broadcastOnline();
  });

  // send online list to new socket quickly
  broadcastOnline();
});

server.listen(PORT, "0.0.0.0", () => console.log(`✅ listening on ${PORT}`));

