// server.js — tonkotsu.online
// Node + Express + Socket.IO (CommonJS). Persists to ./data.json.
// Features:
// - Accounts + bcrypt passwords + session resume tokens
// - Device-based account creation limit (5 per 24h)
// - Global chat history + XP/level leaderboard
// - Friends system (request/accept/decline) + blocking
// - DMs allowed only between friends (server-enforced)
// - Inbox: mentions, friend requests, group invites, group join requests
// - Groups: public/private, discover, invite, join public, owner tools (rename, transfer owner, kick, mute, cooldown, perms)
// - Presence/status (online/idle/dnd/invisible) + online users list

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const express = require("express");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");

const PORT = process.env.PORT || 3000;

const DATA_PATH = path.join(__dirname, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");

// -------------------- config --------------------
const CONFIG = {
  ACCOUNT_CREATE_LIMIT_PER_DEVICE_24H: 5,
  ACCOUNT_CREATE_WINDOW_MS: 24 * 60 * 60 * 1000,

  SESSION_TTL_MS: 14 * 24 * 60 * 60 * 1000, // 14 days
  GUEST_NAME_LEN: 4,

  GLOBAL_HISTORY_LIMIT: 350,
  DM_HISTORY_LIMIT: 260,
  GROUP_HISTORY_LIMIT: 420,

  GROUP_MAX_MEMBERS: 200,
  GROUP_NAME_MAX: 32,

  // default global send cooldown (seconds). Can be updated per-user later if needed.
  DEFAULT_COOLDOWN_SEC: 3.0,

  // XP / leveling
  XP_PER_MESSAGE: 5,
  LEVEL_BASE_NEXT: 100,
  LEVEL_NEXT_GROWTH: 40,

  // simple anti-abuse
  MAX_MESSAGE_LEN: 800,
  MAX_GROUP_DISCOVER: 200,
};

// -------------------- persistence --------------------
function safeReadJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeWriteJson(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    safeWriteJson(DATA_PATH, db);
  }, 250);
}

// -------------------- db schema --------------------
const DEFAULT_DB = {
  users: {
    // username: {
    //   passHash, createdAt, level, xp, next, messages,
    //   settings: { sounds, hideMildProfanity, allowFriendRequests, allowGroupInvites, customCursor },
    //   status: "online"|"idle"|"dnd"|"invisible",
    //   social: { friends:[], incoming:[], outgoing:[], blocked:[] },
    //   inbox: [ {type, text, ts, from, id, meta} ],
    // }
  },
  sessions: {
    // token: { user, exp }
  },
  globalMessages: [
    // { user, text, ts }
  ],
  dms: {
    // "a|b": [ { user, text, ts } ]
  },
  groups: {
    // groupId: {
    //   id, name, owner, privacy, createdAt,
    //   members:[], mutedAll:false, mutedUsers:{}, cooldownSec:2.5,
    //   perms: { invite: [] },
    //   memberCooldown: { user: seconds },
    //   memberCooldownUntil: { user: ts },
    //   lastSentAt: { user: ts },
    //   messages: []
    // }
  },
  deviceCreateLog: [
    // { deviceId, ts }
  ],
};

const loaded = safeReadJson(DATA_PATH);
const db = loaded && typeof loaded === "object" ? { ...DEFAULT_DB, ...loaded } : { ...DEFAULT_DB };

// normalize missing nested structures
db.users = db.users || {};
db.sessions = db.sessions || {};
db.globalMessages = Array.isArray(db.globalMessages) ? db.globalMessages : [];
db.dms = db.dms || {};
db.groups = db.groups || {};
db.deviceCreateLog = Array.isArray(db.deviceCreateLog) ? db.deviceCreateLog : [];

// -------------------- utilities --------------------
function now() {
  return Date.now();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function isValidUser(u) {
  return /^[A-Za-z0-9]{4,20}$/.test(String(u || "").trim());
}

function isValidPass(p) {
  return /^[A-Za-z0-9]{4,32}$/.test(String(p || "").trim());
}

function isGuestName(u) {
  return /^Guest\d{4,5}$/.test(String(u || ""));
}

function makeToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function makeGroupId() {
  return "g_" + crypto.randomBytes(9).toString("base64url");
}

function dmKey(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

function ensureUser(username) {
  const u = db.users[username];
  if (!u) return null;
  if (!u.social) u.social = { friends: [], incoming: [], outgoing: [], blocked: [] };
  if (!Array.isArray(u.social.friends)) u.social.friends = [];
  if (!Array.isArray(u.social.incoming)) u.social.incoming = [];
  if (!Array.isArray(u.social.outgoing)) u.social.outgoing = [];
  if (!Array.isArray(u.social.blocked)) u.social.blocked = [];
  if (!Array.isArray(u.inbox)) u.inbox = [];
  if (!u.settings) u.settings = {};
  if (!u.status) u.status = "online";
  if (!Number.isFinite(u.level)) u.level = 1;
  if (!Number.isFinite(u.xp)) u.xp = 0;
  if (!Number.isFinite(u.next)) u.next = nextForLevel(u.level);
  if (!Number.isFinite(u.messages)) u.messages = 0;
  return u;
}

function nextForLevel(level) {
  const lv = Math.max(1, Number(level || 1));
  return CONFIG.LEVEL_BASE_NEXT + (lv - 1) * CONFIG.LEVEL_NEXT_GROWTH;
}

function addXp(username, amount) {
  const u = ensureUser(username);
  if (!u) return { leveled: false };
  u.xp += Math.max(0, amount | 0);
  let leveled = false;
  while (u.xp >= u.next) {
    u.xp -= u.next;
    u.level += 1;
    u.next = nextForLevel(u.level);
    leveled = true;
  }
  scheduleSave();
  return { leveled, level: u.level, xp: u.xp, next: u.next };
}

function addInboxItem(username, item) {
  const u = ensureUser(username);
  if (!u) return;
  u.inbox.unshift(item);
  // cap inbox to avoid unbounded growth
  if (u.inbox.length > 250) u.inbox.length = 250;
  scheduleSave();
}

function computeInboxCounts(username) {
  const u = ensureUser(username);
  if (!u) return { total: 0, friend: 0, groupInv: 0, ment: 0, groupReq: 0 };
  const items = u.inbox || [];
  let friend = 0, groupInv = 0, ment = 0, groupReq = 0;
  for (const it of items) {
    if (it.type === "friend") friend++;
    else if (it.type === "group") groupInv++;
    else if (it.type === "mention") ment++;
    else if (it.type === "groupReq") groupReq++;
  }
  return { total: items.length, friend, groupInv, ment, groupReq };
}

function scrubOldDeviceCreates() {
  const cutoff = now() - CONFIG.ACCOUNT_CREATE_WINDOW_MS;
  db.deviceCreateLog = db.deviceCreateLog.filter((x) => x && x.ts >= cutoff);
}

function deviceCreateCount(deviceId) {
  scrubOldDeviceCreates();
  const id = String(deviceId || "");
  return db.deviceCreateLog.filter((x) => x.deviceId === id).length;
}

function logDeviceCreate(deviceId) {
  scrubOldDeviceCreates();
  db.deviceCreateLog.push({ deviceId: String(deviceId || ""), ts: now() });
  scheduleSave();
}

function mentionTargets(text) {
  // @username mentions
  const s = String(text || "");
  const out = new Set();
  const rx = /@([A-Za-z0-9]{4,20})/g;
  let m;
  while ((m = rx.exec(s))) out.add(m[1]);
  return Array.from(out);
}

function canDm(sender, target) {
  const a = ensureUser(sender);
  const b = ensureUser(target);
  if (!a || !b) return false;
  if (isGuestName(sender) || isGuestName(target)) return false;

  if (a.social.blocked.includes(target)) return false;
  if (b.social.blocked.includes(sender)) return false;

  return a.social.friends.includes(target) && b.social.friends.includes(sender);
}

function isFriend(user, other) {
  const u = ensureUser(user);
  if (!u) return false;
  return u.social.friends.includes(other);
}

function isBlocked(user, other) {
  const u = ensureUser(user);
  if (!u) return false;
  return u.social.blocked.includes(other);
}

// -------------------- server setup --------------------
const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// -------------------- presence --------------------
const sockets = new Map(); // socket.id -> { user, guest, status, cooldownSec }

function broadcastOnline() {
  const list = [];
  for (const s of sockets.values()) {
    if (!s || !s.user) continue;
    // invisible behaves as offline
    if (s.status === "invisible") continue;
    const u = ensureUser(s.user);
    list.push({
      user: s.user,
      status: s.status || "online",
      level: u ? u.level : 1,
    });
  }
  list.sort((a, b) => String(a.user).localeCompare(String(b.user)));
  io.emit("onlineUsers", list);
}

function setSocketIdentity(socket, { user, guest }) {
  const u = String(user);
  socket.data.user = u;
  socket.data.guest = !!guest;

  let st = "online";
  if (!guest) {
    const du = ensureUser(u);
    if (du) st = du.status || "online";
  }
  sockets.set(socket.id, {
    user: u,
    guest: !!guest,
    status: st,
    cooldownSec: CONFIG.DEFAULT_COOLDOWN_SEC,
  });
  broadcastOnline();
}

function clearSocketIdentity(socket) {
  sockets.delete(socket.id);
  broadcastOnline();
}

// -------------------- messaging cooldown tracking --------------------
const cooldownUntil = new Map(); // username -> ts

function canSend(user) {
  const t = cooldownUntil.get(user) || 0;
  return now() >= t;
}

function startCooldown(user, seconds) {
  const sec = clamp(Number(seconds || CONFIG.DEFAULT_COOLDOWN_SEC), 0.8, 12);
  cooldownUntil.set(user, now() + sec * 1000);
  return sec;
}

// -------------------- group helpers --------------------
function getGroup(groupId) {
  const g = db.groups[groupId];
  if (!g) return null;
  if (!Array.isArray(g.members)) g.members = [];
  if (!g.perms) g.perms = { invite: [] };
  if (!Array.isArray(g.perms.invite)) g.perms.invite = [];
  if (!g.mutedUsers) g.mutedUsers = {};
  if (!g.memberCooldown) g.memberCooldown = {};
  if (!g.memberCooldownUntil) g.memberCooldownUntil = {};
  if (!g.lastSentAt) g.lastSentAt = {};
  if (!Array.isArray(g.messages)) g.messages = [];
  if (!Number.isFinite(g.cooldownSec)) g.cooldownSec = 2.5;
  if (!g.privacy) g.privacy = "private";
  return g;
}

function groupMetaForClient(g) {
  return {
    id: g.id,
    name: g.name,
    owner: g.owner,
    members: g.members,
    privacy: g.privacy,
    cooldownSec: g.cooldownSec,
    mutedAll: !!g.mutedAll,
    perms: g.perms || { invite: [] },
  };
}

function isGroupOwner(g, user) {
  return g && String(g.owner) === String(user);
}

function isGroupMember(g, user) {
  return g && Array.isArray(g.members) && g.members.includes(user);
}

function canInviteToGroup(g, user) {
  if (!g) return false;
  if (isGroupOwner(g, user)) return true;
  return Array.isArray(g.perms?.invite) && g.perms.invite.includes(user);
}

function groupSendAllowed(g, user) {
  if (!g) return false;
  if (!isGroupMember(g, user)) return false;
  if (g.mutedAll && !isGroupOwner(g, user)) return false;
  if (g.mutedUsers && g.mutedUsers[user]) return false;

  // per-member cooldown override
  const nowTs = now();
  const until = Number(g.memberCooldownUntil?.[user] || 0);
  if (nowTs < until) return false;

  // group-level cooldown enforcement (per user per group)
  const last = Number(g.lastSentAt?.[user] || 0);
  const sec = clamp(Number(g.cooldownSec || 2.5), 0.5, 10);
  if (nowTs - last < sec * 1000) return false;

  return true;
}

function groupTouchSend(g, user) {
  g.lastSentAt[user] = now();
}

// -------------------- socket handlers --------------------
io.on("connection", (socket) => {
  socket.on("disconnect", () => {
    clearSocketIdentity(socket);
  });

  // -------------------- auth --------------------
  socket.on("resume", (payload = {}) => {
    const token = String(payload.token || "");
    const sess = db.sessions[token];
    if (!sess || !sess.user || sess.exp < now()) {
      delete db.sessions[token];
      scheduleSave();
      socket.emit("resumeFail");
      return;
    }
    const u = ensureUser(sess.user);
    if (!u) {
      delete db.sessions[token];
      scheduleSave();
      socket.emit("resumeFail");
      return;
    }

    setSocketIdentity(socket, { user: sess.user, guest: false });

    socket.emit("loginSuccess", {
      username: sess.user,
      guest: false,
      token,
      settings: u.settings || {},
      social: u.social || { friends: [], incoming: [], outgoing: [], blocked: [] },
      status: u.status || "online",
    });

    socket.emit("cooldown:update", { seconds: sockets.get(socket.id)?.cooldownSec || CONFIG.DEFAULT_COOLDOWN_SEC });

    // push inbox badge
    socket.emit("inbox:badge", computeInboxCounts(sess.user));
  });

  socket.on("login", async (payload = {}) => {
    const deviceId = String(payload.deviceId || "");
    const guest = !!payload.guest;

    if (guest) {
      // guest login
      let name = "";
      for (let i = 0; i < 20; i++) {
        const n = Math.floor(1000 + Math.random() * 9000);
        const cand = `Guest${n}`;
        if (![...sockets.values()].some((s) => s.user === cand)) {
          name = cand;
          break;
        }
      }
      if (!name) name = `Guest${Math.floor(10000 + Math.random() * 90000)}`;

      setSocketIdentity(socket, { user: name, guest: true });

      socket.emit("loginSuccess", {
        username: name,
        guest: true,
        token: "",
        settings: {}, // guests handled client-side
        social: { friends: [], incoming: [], outgoing: [], blocked: [] },
        status: "online",
      });

      socket.emit("cooldown:update", { seconds: sockets.get(socket.id)?.cooldownSec || CONFIG.DEFAULT_COOLDOWN_SEC });
      return;
    }

    const username = String(payload.username || "").trim();
    const password = String(payload.password || "").trim();

    if (!isValidUser(username) || !isValidPass(password)) {
      socket.emit("loginError", "Invalid username/password format.");
      return;
    }

    let u = ensureUser(username);

    // register if doesn't exist
    if (!u) {
      if (!deviceId) {
        socket.emit("loginError", "Device ID missing.");
        return;
      }
      if (deviceCreateCount(deviceId) >= CONFIG.ACCOUNT_CREATE_LIMIT_PER_DEVICE_24H) {
        socket.emit("loginError", "Account creation limit reached for this device (24h).");
        return;
      }

      const passHash = await bcrypt.hash(password, 10);
      db.users[username] = {
        passHash,
        createdAt: now(),
        level: 1,
        xp: 0,
        next: nextForLevel(1),
        messages: 0,
        settings: {
          sounds: true,
          hideMildProfanity: false,
          allowFriendRequests: true,
          allowGroupInvites: true,
          customCursor: true,
        },
        status: "online",
        social: { friends: [], incoming: [], outgoing: [], blocked: [] },
        inbox: [],
      };
      logDeviceCreate(deviceId);
      scheduleSave();
      u = ensureUser(username);
    } else {
      // login existing
      const ok = await bcrypt.compare(password, String(u.passHash || ""));
      if (!ok) {
        socket.emit("loginError", "Incorrect password.");
        return;
      }
    }

    // create session token
    const token = makeToken();
    db.sessions[token] = { user: username, exp: now() + CONFIG.SESSION_TTL_MS };
    scheduleSave();

    setSocketIdentity(socket, { user: username, guest: false });

    socket.emit("loginSuccess", {
      username,
      guest: false,
      token,
      settings: u.settings || {},
      social: u.social || { friends: [], incoming: [], outgoing: [], blocked: [] },
      status: u.status || "online",
    });

    socket.emit("cooldown:update", { seconds: sockets.get(socket.id)?.cooldownSec || CONFIG.DEFAULT_COOLDOWN_SEC });
    socket.emit("inbox:badge", computeInboxCounts(username));
  });

  // -------------------- settings/status --------------------
  socket.on("settings:update", (s = {}) => {
    const user = socket.data.user;
    if (!user || socket.data.guest) return;
    const u = ensureUser(user);
    if (!u) return;

    const allowed = ["sounds", "hideMildProfanity", "allowFriendRequests", "allowGroupInvites", "customCursor"];
    for (const k of allowed) {
      if (typeof s[k] !== "undefined") u.settings[k] = !!s[k];
    }
    scheduleSave();
    socket.emit("settings", u.settings);
  });

  socket.on("status:set", ({ status } = {}) => {
    const user = socket.data.user;
    if (!user) return;
    const st = String(status || "online");
    const allowed = new Set(["online", "idle", "dnd", "invisible"]);
    if (!allowed.has(st)) return;

    const pres = sockets.get(socket.id);
    if (pres) pres.status = st;

    if (!socket.data.guest) {
      const u = ensureUser(user);
      if (u) {
        u.status = st;
        scheduleSave();
      }
    }

    socket.emit("status:update", { status: st });
    broadcastOnline();
  });

  socket.on("cooldown:get", () => {
    const sec = sockets.get(socket.id)?.cooldownSec || CONFIG.DEFAULT_COOLDOWN_SEC;
    socket.emit("cooldown:update", { seconds: sec });
  });

  // -------------------- global chat --------------------
  socket.on("requestGlobalHistory", () => {
    socket.emit("history", db.globalMessages.slice(-CONFIG.GLOBAL_HISTORY_LIMIT));
  });

  socket.on("sendGlobal", ({ text } = {}) => {
    const user = socket.data.user;
    if (!user) return;

    const msgText = String(text || "").slice(0, CONFIG.MAX_MESSAGE_LEN).trim();
    if (!msgText) return;

    if (!canSend(user)) return;

    const sec = startCooldown(user, sockets.get(socket.id)?.cooldownSec);
    socket.emit("cooldown:update", { seconds: sec });

    // XP only for real accounts
    if (!socket.data.guest) {
      const u = ensureUser(user);
      if (u) u.messages += 1;

      const leveled = addXp(user, CONFIG.XP_PER_MESSAGE);
      if (leveled.leveled) socket.emit("me:stats", { leveled: true, level: leveled.level });

      scheduleSave();
    }

    const msg = { user, text: msgText, ts: now() };
    db.globalMessages.push(msg);
    if (db.globalMessages.length > CONFIG.GLOBAL_HISTORY_LIMIT) db.globalMessages.shift();
    scheduleSave();

    io.emit("globalMessage", msg);

    // mentions -> inbox
    if (!socket.data.guest) {
      const targets = mentionTargets(msgText);
      for (const t of targets) {
        if (!db.users[t]) continue;
        if (t === user) continue;

        addInboxItem(t, {
          type: "mention",
          text: `@${user} mentioned you in #global`,
          ts: now(),
        });

        // update badge for online mentioned user
        for (const [sid, p] of sockets.entries()) {
          if (p.user === t && !p.guest) io.to(sid).emit("inbox:badge", computeInboxCounts(t));
        }
      }
    }
  });

  // -------------------- profile --------------------
  socket.on("profile:get", ({ user } = {}) => {
    const target = String(user || "");
    const u = ensureUser(target);
    if (!u || isGuestName(target)) {
      socket.emit("profile:data", { user: target, exists: false, guest: true });
      return;
    }
    socket.emit("profile:data", {
      user: target,
      exists: true,
      guest: false,
      createdAt: u.createdAt,
      level: u.level,
      xp: u.xp,
      next: u.next,
      messages: u.messages,
      status: u.status,
    });
  });

  // -------------------- leaderboard --------------------
  socket.on("leaderboard:get", ({ limit } = {}) => {
    const user = socket.data.user;
    if (!user || socket.data.guest) return;

    const lim = clamp(Number(limit || 25), 5, 50);
    const items = Object.entries(db.users)
      .map(([name, u]) => ({
        user: name,
        level: Number(u.level || 1),
        xp: Number(u.xp || 0),
        next: Number(u.next || nextForLevel(Number(u.level || 1))),
        messages: Number(u.messages || 0),
      }))
      .sort((a, b) => (b.level - a.level) || (b.xp - a.xp) || (b.messages - a.messages))
      .slice(0, lim);

    socket.emit("leaderboard:data", { items });
  });

  // -------------------- social (friends/block) --------------------
  socket.on("social:sync", () => {
    const user = socket.data.user;
    if (!user || socket.data.guest) return;
    const u = ensureUser(user);
    socket.emit("social:update", u.social);
  });

  socket.on("friend:request", ({ to } = {}) => {
    const from = socket.data.user;
    if (!from || socket.data.guest) return;

    const target = String(to || "").trim();
    if (!isValidUser(target) || !db.users[target] || target === from) return;

    const a = ensureUser(from);
    const b = ensureUser(target);
    if (!a || !b) return;

    if (b.settings?.allowFriendRequests === false) {
      socket.emit("sendError", { reason: "That user is not accepting friend requests." });
      return;
    }

    if (isBlocked(from, target) || isBlocked(target, from)) {
      socket.emit("sendError", { reason: "Unable to send request." });
      return;
    }

    if (a.social.friends.includes(target)) return;

    // avoid duplicates
    if (!a.social.outgoing.includes(target)) a.social.outgoing.push(target);
    if (!b.social.incoming.includes(from)) b.social.incoming.push(from);

    addInboxItem(target, { type: "friend", from, text: `${from} sent you a friend request`, ts: now() });

    scheduleSave();

    // notify both if online
    for (const [sid, p] of sockets.entries()) {
      if (p.user === from && !p.guest) io.to(sid).emit("social:update", a.social);
      if (p.user === target && !p.guest) {
        io.to(sid).emit("social:update", b.social);
        io.to(sid).emit("inbox:badge", computeInboxCounts(target));
      }
    }
  });

  socket.on("friend:accept", ({ from } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const other = String(from || "").trim();
    if (!isValidUser(other) || !db.users[other] || other === me) return;

    const a = ensureUser(me);
    const b = ensureUser(other);
    if (!a || !b) return;

    // must be incoming
    a.social.incoming = a.social.incoming.filter((x) => x !== other);
    b.social.outgoing = b.social.outgoing.filter((x) => x !== me);

    if (!a.social.friends.includes(other)) a.social.friends.push(other);
    if (!b.social.friends.includes(me)) b.social.friends.push(me);

    // remove friend inbox items referencing the other (best-effort)
    a.inbox = (a.inbox || []).filter((it) => !(it.type === "friend" && it.from === other));
    scheduleSave();

    for (const [sid, p] of sockets.entries()) {
      if (p.user === me && !p.guest) {
        io.to(sid).emit("social:update", a.social);
        io.to(sid).emit("inbox:badge", computeInboxCounts(me));
      }
      if (p.user === other && !p.guest) io.to(sid).emit("social:update", b.social);
    }
  });

  socket.on("friend:decline", ({ from } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const other = String(from || "").trim();
    if (!isValidUser(other) || !db.users[other] || other === me) return;

    const a = ensureUser(me);
    const b = ensureUser(other);
    if (!a || !b) return;

    a.social.incoming = a.social.incoming.filter((x) => x !== other);
    b.social.outgoing = b.social.outgoing.filter((x) => x !== me);

    a.inbox = (a.inbox || []).filter((it) => !(it.type === "friend" && it.from === other));
    scheduleSave();

    for (const [sid, p] of sockets.entries()) {
      if (p.user === me && !p.guest) {
        io.to(sid).emit("social:update", a.social);
        io.to(sid).emit("inbox:badge", computeInboxCounts(me));
      }
      if (p.user === other && !p.guest) io.to(sid).emit("social:update", b.social);
    }
  });

  socket.on("user:block", ({ user } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;
    const target = String(user || "").trim();
    if (!isValidUser(target) || !db.users[target] || target === me) return;

    const a = ensureUser(me);
    const b = ensureUser(target);
    if (!a || !b) return;

    if (!a.social.blocked.includes(target)) a.social.blocked.push(target);

    // remove relations
    a.social.friends = a.social.friends.filter((x) => x !== target);
    a.social.incoming = a.social.incoming.filter((x) => x !== target);
    a.social.outgoing = a.social.outgoing.filter((x) => x !== target);

    b.social.friends = b.social.friends.filter((x) => x !== me);
    b.social.incoming = b.social.incoming.filter((x) => x !== me);
    b.social.outgoing = b.social.outgoing.filter((x) => x !== me);

    scheduleSave();

    for (const [sid, p] of sockets.entries()) {
      if (p.user === me && !p.guest) io.to(sid).emit("social:update", a.social);
      if (p.user === target && !p.guest) io.to(sid).emit("social:update", b.social);
    }
  });

  socket.on("user:unblock", ({ user } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;
    const target = String(user || "").trim();
    if (!isValidUser(target) || !db.users[target] || target === me) return;

    const a = ensureUser(me);
    if (!a) return;

    a.social.blocked = a.social.blocked.filter((x) => x !== target);
    scheduleSave();

    for (const [sid, p] of sockets.entries()) {
      if (p.user === me && !p.guest) io.to(sid).emit("social:update", a.social);
    }
  });

  // -------------------- inbox --------------------
  socket.on("inbox:get", () => {
    const user = socket.data.user;
    if (!user || socket.data.guest) return;
    const u = ensureUser(user);
    socket.emit("inbox:data", { items: u.inbox || [] });
    socket.emit("inbox:badge", computeInboxCounts(user));
  });

  socket.on("inbox:clearMentions", () => {
    const user = socket.data.user;
    if (!user || socket.data.guest) return;
    const u = ensureUser(user);
    u.inbox = (u.inbox || []).filter((it) => it.type !== "mention");
    scheduleSave();
    socket.emit("inbox:data", { items: u.inbox });
    socket.emit("inbox:badge", computeInboxCounts(user));
  });

  // -------------------- DMs --------------------
  socket.on("dm:history", ({ withUser } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const other = String(withUser || "").trim();
    if (!isValidUser(other) || !db.users[other] || other === me) return;

    if (!canDm(me, other)) {
      socket.emit("sendError", { reason: "DMs are allowed only between friends." });
      socket.emit("dm:history", { withUser: other, msgs: [] });
      return;
    }

    const key = dmKey(me, other);
    const msgs = Array.isArray(db.dms[key]) ? db.dms[key] : [];
    socket.emit("dm:history", { withUser: other, msgs: msgs.slice(-CONFIG.DM_HISTORY_LIMIT) });
  });

  socket.on("dm:send", ({ to, text } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const other = String(to || "").trim();
    const msgText = String(text || "").slice(0, CONFIG.MAX_MESSAGE_LEN).trim();
    if (!msgText) return;

    if (!isValidUser(other) || !db.users[other] || other === me) return;

    if (!canDm(me, other)) {
      socket.emit("sendError", { reason: "DMs are allowed only between friends." });
      return;
    }

    if (!canSend(me)) return;

    const sec = startCooldown(me, sockets.get(socket.id)?.cooldownSec);
    socket.emit("cooldown:update", { seconds: sec });

    // XP
    const u = ensureUser(me);
    if (u) u.messages += 1;
    const leveled = addXp(me, CONFIG.XP_PER_MESSAGE);
    if (leveled.leveled) socket.emit("me:stats", { leveled: true, level: leveled.level });
    scheduleSave();

    const key = dmKey(me, other);
    if (!Array.isArray(db.dms[key])) db.dms[key] = [];
    const msg = { user: me, text: msgText, ts: now() };
    db.dms[key].push(msg);
    if (db.dms[key].length > CONFIG.DM_HISTORY_LIMIT) db.dms[key].shift();
    scheduleSave();

    // deliver to sender's current socket
    socket.emit("dm:message", { from: other, msg }); // sender sees it in thread (from=other in client design? NO)
    // NOTE: Client expects dm:message with {from, msg} where "from" is the other person.
    // For sender, we can instead update history quickly by echoing as if from other; but that’s wrong.
    // Correct approach: send dm:history refresh for sender OR send a separate "dm:sent" event.
    // To keep compatibility, we deliver to sender by sending dm:history.
    socket.emit("dm:history", { withUser: other, msgs: db.dms[key] });

    // deliver to recipient sockets
    for (const [sid, p] of sockets.entries()) {
      if (p.user === other && !p.guest) {
        io.to(sid).emit("dm:message", { from: me, msg });
      }
    }
  });

  // -------------------- groups: list + discover --------------------
  socket.on("groups:list", () => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const list = Object.values(db.groups)
      .map((g0) => getGroup(g0.id))
      .filter((g) => g && isGroupMember(g, me))
      .map((g) => groupMetaForClient(g));

    socket.emit("groups:list", list);
  });

  socket.on("groups:discover", () => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const items = Object.values(db.groups)
      .map((g0) => getGroup(g0.id))
      .filter((g) => g && g.privacy === "public")
      .slice(0, CONFIG.MAX_GROUP_DISCOVER)
      .map((g) => ({
        id: g.id,
        name: g.name,
        owner: g.owner,
        members: (g.members || []).length,
      }))
      .sort((a, b) => (b.members - a.members) || String(a.name).localeCompare(String(b.name)));

    socket.emit("groups:discover:data", { items });
  });

  // -------------------- group create / join --------------------
  socket.on("group:createRequest", ({ name, invites, privacy } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const u = ensureUser(me);
    if (!u) return;

    const nm = String(name || "").trim().slice(0, CONFIG.GROUP_NAME_MAX);
    if (!nm) {
      socket.emit("sendError", { reason: "Group name required." });
      return;
    }

    const priv = String(privacy || "private") === "public" ? "public" : "private";
    const gid = makeGroupId();

    db.groups[gid] = {
      id: gid,
      name: nm,
      owner: me,
      privacy: priv,
      createdAt: now(),
      members: [me],
      mutedAll: false,
      mutedUsers: {},
      cooldownSec: 2.5,
      perms: { invite: [] },
      memberCooldown: {},
      memberCooldownUntil: {},
      lastSentAt: {},
      messages: [],
    };
    scheduleSave();

    const g = getGroup(gid);

    // send invites as inbox items
    const list = Array.isArray(invites) ? invites : [];
    const unique = Array.from(new Set(list.map((x) => String(x || "").trim()))).slice(0, 50);

    for (const target of unique) {
      if (!isValidUser(target) || !db.users[target]) continue;
      if (!isFriend(me, target)) continue;

      const tu = ensureUser(target);
      if (tu?.settings?.allowGroupInvites === false) continue;

      addInboxItem(target, {
        type: "group",
        id: gid,
        from: me,
        text: `${me} invited you to join #${nm}`,
        ts: now(),
      });

      for (const [sid, p] of sockets.entries()) {
        if (p.user === target && !p.guest) io.to(sid).emit("inbox:badge", computeInboxCounts(target));
      }
    }

    // refresh creator group list
    socket.emit("groups:list", Object.values(db.groups).map((x) => getGroup(x.id)).filter((gg) => gg && isGroupMember(gg, me)).map(groupMetaForClient));
  });

  socket.on("group:joinPublic", ({ groupId } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const gid = String(groupId || "");
    const g = getGroup(gid);
    if (!g || g.privacy !== "public") return;

    if (isGroupMember(g, me)) return;

    if ((g.members || []).length >= CONFIG.GROUP_MAX_MEMBERS) {
      socket.emit("sendError", { reason: "Group is full." });
      return;
    }

    g.members.push(me);
    scheduleSave();

    socket.emit("groups:list", Object.values(db.groups).map((x) => getGroup(x.id)).filter((gg) => gg && isGroupMember(gg, me)).map(groupMetaForClient));
    socket.emit("group:meta", { groupId: gid, meta: groupMetaForClient(g) });
  });

  // inbox accept/decline group invite
  socket.on("groupInvite:accept", ({ id } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;
    const gid = String(id || "");
    const g = getGroup(gid);
    if (!g) return;

    if ((g.members || []).length >= CONFIG.GROUP_MAX_MEMBERS) {
      socket.emit("sendError", { reason: "Group is full." });
      return;
    }

    if (!isGroupMember(g, me)) g.members.push(me);

    // remove invite inbox items
    const u = ensureUser(me);
    u.inbox = (u.inbox || []).filter((it) => !(it.type === "group" && it.id === gid));
    scheduleSave();

    socket.emit("inbox:badge", computeInboxCounts(me));
    socket.emit("inbox:data", { items: u.inbox });

    socket.emit("groups:list", Object.values(db.groups).map((x) => getGroup(x.id)).filter((gg) => gg && isGroupMember(gg, me)).map(groupMetaForClient));
    socket.emit("group:history", { groupId: gid, meta: groupMetaForClient(g), msgs: (g.messages || []).slice(-CONFIG.GROUP_HISTORY_LIMIT) });
  });

  socket.on("groupInvite:decline", ({ id } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;
    const gid = String(id || "");

    const u = ensureUser(me);
    u.inbox = (u.inbox || []).filter((it) => !(it.type === "group" && it.id === gid));
    scheduleSave();

    socket.emit("inbox:badge", computeInboxCounts(me));
    socket.emit("inbox:data", { items: u.inbox });
  });

  // -------------------- group history + send --------------------
  socket.on("group:history", ({ groupId } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const gid = String(groupId || "");
    const g = getGroup(gid);
    if (!g || !isGroupMember(g, me)) return;

    socket.emit("group:history", {
      groupId: gid,
      meta: groupMetaForClient(g),
      msgs: (g.messages || []).slice(-CONFIG.GROUP_HISTORY_LIMIT),
    });
  });

  socket.on("group:send", ({ groupId, text } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const gid = String(groupId || "");
    const g = getGroup(gid);
    if (!g) return;

    const msgText = String(text || "").slice(0, CONFIG.MAX_MESSAGE_LEN).trim();
    if (!msgText) return;

    if (!groupSendAllowed(g, me)) {
      socket.emit("sendError", { reason: "You cannot send to this group right now (muted/cooldown/permissions)." });
      return;
    }

    // also enforce global cooldown per-account to reduce spam across rooms
    if (!canSend(me)) return;
    const sec = startCooldown(me, sockets.get(socket.id)?.cooldownSec);
    socket.emit("cooldown:update", { seconds: sec });

    groupTouchSend(g, me);

    const msg = { user: me, text: msgText, ts: now() };
    g.messages.push(msg);
    if (g.messages.length > CONFIG.GROUP_HISTORY_LIMIT) g.messages.shift();

    // XP
    const u = ensureUser(me);
    if (u) u.messages += 1;
    const leveled = addXp(me, CONFIG.XP_PER_MESSAGE);
    if (leveled.leveled) socket.emit("me:stats", { leveled: true, level: leveled.level });
    scheduleSave();

    // deliver to all online members
    for (const [sid, p] of sockets.entries()) {
      if (p.guest) continue;
      if (!p.user) continue;
      if (!isGroupMember(g, p.user)) continue;
      io.to(sid).emit("group:message", { groupId: gid, msg });
    }

    // mentions -> inbox
    const targets = mentionTargets(msgText);
    for (const t of targets) {
      if (!db.users[t]) continue;
      if (t === me) continue;
      if (!isGroupMember(g, t)) continue;

      addInboxItem(t, {
        type: "mention",
        text: `@${me} mentioned you in #${g.name}`,
        ts: now(),
      });

      for (const [sid, p] of sockets.entries()) {
        if (p.user === t && !p.guest) io.to(sid).emit("inbox:badge", computeInboxCounts(t));
      }
    }
  });

  // -------------------- group membership actions --------------------
  socket.on("group:leave", ({ groupId } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const gid = String(groupId || "");
    const g = getGroup(gid);
    if (!g || !isGroupMember(g, me)) return;

    // owner leaving: delete group
    if (isGroupOwner(g, me)) {
      delete db.groups[gid];
      scheduleSave();

      // notify all sockets in that group
      for (const [sid, p] of sockets.entries()) {
        if (p.guest) continue;
        if (p.user && isGroupMember(g, p.user)) io.to(sid).emit("group:deleted", { groupId: gid });
      }
      return;
    }

    g.members = (g.members || []).filter((x) => x !== me);
    scheduleSave();

    socket.emit("group:left", { groupId: gid });
    socket.emit("groups:list", Object.values(db.groups).map((x) => getGroup(x.id)).filter((gg) => gg && isGroupMember(gg, me)).map(groupMetaForClient));
  });

  // -------------------- owner tools --------------------
  function requireOwner(g, me) {
    if (!g || !me) return false;
    if (!isGroupOwner(g, me)) {
      socket.emit("sendError", { reason: "Owner permission required." });
      return false;
    }
    return true;
  }

  socket.on("group:delete", ({ groupId } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;
    const gid = String(groupId || "");
    const g = getGroup(gid);
    if (!requireOwner(g, me)) return;

    delete db.groups[gid];
    scheduleSave();

    for (const [sid, p] of sockets.entries()) {
      if (p.guest) continue;
      if (p.user && isGroupMember(g, p.user)) io.to(sid).emit("group:deleted", { groupId: gid });
    }
  });

  socket.on("group:muteAll", ({ groupId, on } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;
    const gid = String(groupId || "");
    const g = getGroup(gid);
    if (!requireOwner(g, me)) return;

    g.mutedAll = !!on;
    scheduleSave();

    for (const [sid, p] of sockets.entries()) {
      if (p.guest) continue;
      if (p.user && isGroupMember(g, p.user)) io.to(sid).emit("group:meta", { groupId: gid, meta: groupMetaForClient(g) });
    }
  });

  socket.on("group:settings", ({ groupId, cooldownSec } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;
    const gid = String(groupId || "");
    const g = getGroup(gid);
    if (!requireOwner(g, me)) return;

    const v = clamp(Number(cooldownSec), 1, 10);
    if (!Number.isFinite(v)) return;

    g.cooldownSec = v;
    scheduleSave();

    for (const [sid, p] of sockets.entries()) {
      if (p.guest) continue;
      if (p.user && isGroupMember(g, p.user)) io.to(sid).emit("group:meta", { groupId: gid, meta: groupMetaForClient(g) });
    }
  });

  socket.on("group:cooldownCancel", ({ groupId } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;
    const gid = String(groupId || "");
    const g = getGroup(gid);
    if (!requireOwner(g, me)) return;

    g.lastSentAt = {};
    scheduleSave();
  });

  socket.on("group:rename", ({ groupId, name } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;
    const gid = String(groupId || "");
    const g = getGroup(gid);
    if (!requireOwner(g, me)) return;

    const nm = String(name || "").trim().slice(0, CONFIG.GROUP_NAME_MAX);
    if (!nm) return;

    g.name = nm;
    scheduleSave();

    for (const [sid, p] of sockets.entries()) {
      if (p.guest) continue;
      if (p.user && isGroupMember(g, p.user)) io.to(sid).emit("group:meta", { groupId: gid, meta: groupMetaForClient(g) });
    }
  });

  socket.on("group:invite", ({ groupId, user } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const gid = String(groupId || "");
    const target = String(user || "").trim();
    const g = getGroup(gid);
    if (!g) return;

    if (!isGroupMember(g, me)) return;
    if (!canInviteToGroup(g, me)) {
      socket.emit("sendError", { reason: "You do not have invite permission in this group." });
      return;
    }

    if (!isValidUser(target) || !db.users[target]) return;
    if (!isFriend(me, target)) {
      socket.emit("sendError", { reason: "You can only invite friends." });
      return;
    }

    const tu = ensureUser(target);
    if (tu?.settings?.allowGroupInvites === false) {
      socket.emit("sendError", { reason: "That user is not accepting group invites." });
      return;
    }

    addInboxItem(target, {
      type: "group",
      id: gid,
      from: me,
      text: `${me} invited you to join #${g.name}`,
      ts: now(),
    });

    for (const [sid, p] of sockets.entries()) {
      if (p.user === target && !p.guest) io.to(sid).emit("inbox:badge", computeInboxCounts(target));
    }
  });

  socket.on("group:muteUser", ({ groupId, user, on } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const gid = String(groupId || "");
    const target = String(user || "").trim();
    const g = getGroup(gid);
    if (!requireOwner(g, me)) return;

    if (!isValidUser(target) || !db.users[target]) return;
    if (!isGroupMember(g, target)) return;

    g.mutedUsers[target] = !!on;
    scheduleSave();

    for (const [sid, p] of sockets.entries()) {
      if (p.guest) continue;
      if (p.user && isGroupMember(g, p.user)) io.to(sid).emit("group:meta", { groupId: gid, meta: groupMetaForClient(g) });
    }
  });

  socket.on("group:kick", ({ groupId, user } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const gid = String(groupId || "");
    const target = String(user || "").trim();
    const g = getGroup(gid);
    if (!requireOwner(g, me)) return;

    if (!isValidUser(target) || !db.users[target]) return;
    if (!isGroupMember(g, target)) return;
    if (target === g.owner) return;

    g.members = g.members.filter((x) => x !== target);
    scheduleSave();

    // notify kicked user if online
    for (const [sid, p] of sockets.entries()) {
      if (p.user === target && !p.guest) io.to(sid).emit("group:left", { groupId: gid });
    }

    // broadcast updated meta to remaining
    for (const [sid, p] of sockets.entries()) {
      if (p.guest) continue;
      if (p.user && isGroupMember(g, p.user)) io.to(sid).emit("group:meta", { groupId: gid, meta: groupMetaForClient(g) });
    }
  });

  socket.on("group:transferOwner", ({ groupId, to } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const gid = String(groupId || "");
    const target = String(to || "").trim();
    const g = getGroup(gid);
    if (!requireOwner(g, me)) return;

    if (!isValidUser(target) || !db.users[target]) return;
    if (!isGroupMember(g, target)) return;

    g.owner = target;
    scheduleSave();

    for (const [sid, p] of sockets.entries()) {
      if (p.guest) continue;
      if (p.user && isGroupMember(g, p.user)) io.to(sid).emit("group:meta", { groupId: gid, meta: groupMetaForClient(g) });
    }
  });

  socket.on("group:perm", ({ groupId, user, perm } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const gid = String(groupId || "");
    const target = String(user || "").trim();
    const p = String(perm || "");
    const g = getGroup(gid);
    if (!requireOwner(g, me)) return;

    if (p !== "invite") return;
    if (!isValidUser(target) || !db.users[target]) return;
    if (!isGroupMember(g, target)) return;

    if (!g.perms) g.perms = { invite: [] };
    if (!Array.isArray(g.perms.invite)) g.perms.invite = [];

    if (g.perms.invite.includes(target)) g.perms.invite = g.perms.invite.filter((x) => x !== target);
    else g.perms.invite.push(target);

    scheduleSave();

    for (const [sid, pr] of sockets.entries()) {
      if (pr.guest) continue;
      if (pr.user && isGroupMember(g, pr.user)) io.to(sid).emit("group:meta", { groupId: gid, meta: groupMetaForClient(g) });
    }
  });

  socket.on("group:memberCooldown", ({ groupId, user, seconds } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const gid = String(groupId || "");
    const target = String(user || "").trim();
    const g = getGroup(gid);
    if (!requireOwner(g, me)) return;

    if (!isValidUser(target) || !db.users[target]) return;
    if (!isGroupMember(g, target)) return;

    const sec = clamp(Number(seconds), 0.5, 20);
    if (!Number.isFinite(sec)) return;

    g.memberCooldown[target] = sec;
    // apply immediately as "blocked until" now+sec (client requested per-member cooldown)
    g.memberCooldownUntil[target] = now() + sec * 1000;
    scheduleSave();
  });

  socket.on("group:memberCooldownClear", ({ groupId, user } = {}) => {
    const me = socket.data.user;
    if (!me || socket.data.guest) return;

    const gid = String(groupId || "");
    const target = String(user || "").trim();
    const g = getGroup(gid);
    if (!requireOwner(g, me)) return;

    delete g.memberCooldown[target];
    delete g.memberCooldownUntil[target];
    scheduleSave();
  });

  // -------------------- housekeeping: session cleanup (light) --------------------
  socket.on("ping", () => {
    // optional no-op
  });
});

// periodic cleanup
setInterval(() => {
  const t = now();
  // expire sessions
  for (const [tok, sess] of Object.entries(db.sessions)) {
    if (!sess || sess.exp < t) delete db.sessions[tok];
  }
  // trim global history safety
  if (db.globalMessages.length > CONFIG.GLOBAL_HISTORY_LIMIT) {
    db.globalMessages = db.globalMessages.slice(-CONFIG.GLOBAL_HISTORY_LIMIT);
  }
  scheduleSave();
}, 60 * 1000);

// -------------------- start --------------------
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
