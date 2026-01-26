// server.js
"use strict";

/*
  tonkotsu.online — single-file backend (Express + Socket.IO)
  Goals:
  - Login + Guest always works (auto-repair storage if JSON files are empty/bad)
  - No duplicate online users across multiple tabs (count tabs per user; online if count>0)
  - Global chat + DMs (friends-only) + Group chats
  - Edit/Delete window (60s) + Report to moderation bot
  - Bot admin API: delete user (progressive ban), announce, ban IP, list reports, reply-to-report (optional)
  - Simple XP + leaderboard
*/

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");

const http = require("http");
const { Server } = require("socket.io");

// -------------------- ENV --------------------
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || "development";
const CLIENT_URL = process.env.CLIENT_URL || "*";
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_SHARED_SECRET = process.env.ADMIN_SHARED_SECRET;

if (!JWT_SECRET) {
  console.error("Missing JWT_SECRET in env.");
  process.exit(1);
}
if (!ADMIN_SHARED_SECRET) {
  console.error("Missing ADMIN_SHARED_SECRET in env.");
  process.exit(1);
}

// -------------------- DATA FILES --------------------
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const MSG_FILE = path.join(DATA_DIR, "messages.json");
const GROUPS_FILE = path.join(DATA_DIR, "groups.json");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");
const BANS_FILE = path.join(DATA_DIR, "bans.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
ensureDataDir();

// -------------------- UTIL --------------------
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw || !raw.trim()) return fallback;
    const obj = JSON.parse(raw);
    return obj ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJson(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("writeJson failed:", file, e?.message || e);
  }
}
function now() {
  return Date.now();
}
function safeStr(v, max = 5000) {
  return String(v ?? "").slice(0, max);
}
function lower(v) {
  return safeStr(v, 200).trim().toLowerCase();
}
function id() {
  return nanoid(12);
}
function pickColor(seed) {
  const h = crypto.createHash("sha256").update(String(seed || "x")).digest("hex");
  const n = parseInt(h.slice(0, 6), 16);
  const hues = [210, 280, 170, 25, 340, 120, 200, 45, 300, 160];
  const hue = hues[n % hues.length];
  return `hsl(${hue} 80% 72%)`;
}
function jwtSign(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "14d" });
}
function jwtVerify(token) {
  return jwt.verify(token, JWT_SECRET);
}

// -------------------- PROGRESSIVE BAN POLICY --------------------
// 1st strike: 3 days, 2nd: 7 days, 3rd+: 365 days, 4th+: permanent
function banDurationForStrikes(strikes) {
  if (strikes <= 1) return 3 * 24 * 60 * 60 * 1000;
  if (strikes === 2) return 7 * 24 * 60 * 60 * 1000;
  return 365 * 24 * 60 * 60 * 1000;
}

// -------------------- STORAGE --------------------
let users = readJson(USERS_FILE, { byId: {}, byName: {} });
let messages = readJson(MSG_FILE, { global: [], dms: {}, groups: {} });
let groups = readJson(GROUPS_FILE, { byId: {} });
let reports = readJson(REPORTS_FILE, { items: [] });
let bans = readJson(BANS_FILE, { users: {}, ips: {} }); // users[usernameLower]={ strikes, until, permanent }

// ---- STORAGE REPAIR (prevents users.byName undefined crashes) ----
function repairStorage() {
  // Users
  if (!users || typeof users !== "object") users = {};
  if (!users.byId || typeof users.byId !== "object") users.byId = {};
  if (!users.byName || typeof users.byName !== "object") users.byName = {};

  // Messages
  if (!messages || typeof messages !== "object") messages = {};
  if (!Array.isArray(messages.global)) messages.global = [];
  if (!messages.dms || typeof messages.dms !== "object") messages.dms = {};
  if (!messages.groups || typeof messages.groups !== "object") messages.groups = {};

  // Groups
  if (!groups || typeof groups !== "object") groups = {};
  if (!groups.byId || typeof groups.byId !== "object") groups.byId = {};

  // Reports
  if (!reports || typeof reports !== "object") reports = {};
  if (!Array.isArray(reports.items)) reports.items = [];

  // Bans
  if (!bans || typeof bans !== "object") bans = {};
  if (!bans.users || typeof bans.users !== "object") bans.users = {};
  if (!bans.ips || typeof bans.ips !== "object") bans.ips = {};
}
function persistAll() {
  writeJson(USERS_FILE, users);
  writeJson(MSG_FILE, messages);
  writeJson(GROUPS_FILE, groups);
  writeJson(REPORTS_FILE, reports);
  writeJson(BANS_FILE, bans);
}
repairStorage();
persistAll();

// -------------------- USERS --------------------
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    createdAt: u.createdAt,
    lastSeen: u.lastSeen,
    bio: u.bio || "",
    color: u.color || "#dfe6ff",
    xp: u.xp || 0,
    level: u.level || 1,
    badges: u.badges || [],
    mode: u.presenceMode || "online",
  };
}

function getUserByUsername(username) {
  const key = lower(username);
  if (!key) return null;
  const uid = users.byName?.[key];
  if (!uid) return null;
  return users.byId?.[uid] || null;
}

function ensureUser(username, passwordPlain = null) {
  const key = lower(username);
  if (!key) return null;

  const existing = getUserByUsername(key);
  if (existing) return existing;

  const u = {
    id: id(),
    username: safeStr(username, 32),
    usernameLower: key,
    passHash: passwordPlain ? bcrypt.hashSync(passwordPlain, 10) : null,
    createdAt: now(),
    lastSeen: now(),
    bio: "",
    color: pickColor(username),
    xp: 0,
    level: 1,
    badges: ["beta"],
    presenceMode: "online",
    friends: [], // userIds
  };

  users.byId[u.id] = u;
  users.byName[u.usernameLower] = u.id;
  persistAll();
  return u;
}

// XP/level
function grantXp(user, amount) {
  if (!user) return;
  user.xp = (user.xp || 0) + Math.max(0, Number(amount || 0));
  const need = (lvl) => 75 + lvl * 35;
  user.level = user.level || 1;
  while (user.xp >= need(user.level)) {
    user.xp -= need(user.level);
    user.level += 1;
  }
}

// -------------------- BANS --------------------
function isUserBanned(usernameLower) {
  const entry = bans.users?.[usernameLower];
  if (!entry) return { banned: false };
  if (entry.permanent) return { banned: true, until: null, permanent: true, strikes: entry.strikes || 0 };
  if (entry.until && now() < entry.until) return { banned: true, until: entry.until, permanent: false, strikes: entry.strikes || 0 };
  return { banned: false };
}
function strikeAndBanUser(usernameLower) {
  const entry = bans.users[usernameLower] || { strikes: 0, until: 0, permanent: false };
  entry.strikes = (entry.strikes || 0) + 1;
  const dur = banDurationForStrikes(entry.strikes);
  entry.until = now() + dur;
  entry.permanent = entry.strikes >= 4 ? true : false;
  bans.users[usernameLower] = entry;
  persistAll();
  return entry;
}
function banIp(ip, ms) {
  bans.ips[ip] = { until: now() + ms };
  persistAll();
}
function isIpBanned(ip) {
  const entry = bans.ips?.[ip];
  if (!entry) return false;
  if (entry.until && now() < entry.until) return true;
  return false;
}

// -------------------- MESSAGES HELPERS --------------------
function normalizeScope(scope) {
  if (scope === "global") return "global";
  if (scope === "dm") return "dm";
  if (scope === "group") return "group";
  return null;
}
function dmKey(a, b) {
  const x = String(a), y = String(b);
  return x < y ? `${x}__${y}` : `${y}__${x}`;
}
function pushMessage(scope, targetId, msg) {
  if (scope === "global") {
    messages.global.push(msg);
    messages.global = messages.global.slice(-800);
    return;
  }
  if (scope === "dm") {
    const key = dmKey(msg.user.id, targetId);
    messages.dms[key] = Array.isArray(messages.dms[key]) ? messages.dms[key] : [];
    messages.dms[key].push(msg);
    messages.dms[key] = messages.dms[key].slice(-800);
    return;
  }
  if (scope === "group") {
    messages.groups[targetId] = Array.isArray(messages.groups[targetId]) ? messages.groups[targetId] : [];
    messages.groups[targetId].push(msg);
    messages.groups[targetId] = messages.groups[targetId].slice(-1200);
  }
}
function userGroups(uid) {
  return Object.values(groups.byId || {}).filter((g) => g && (g.members || []).includes(uid));
}

// -------------------- APP --------------------
const app = express();
app.disable("x-powered-by");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: CLIENT_URL === "*" ? true : CLIENT_URL, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// IP ban middleware
app.use((req, res, next) => {
  const ip =
    (req.headers["x-forwarded-for"] ? String(req.headers["x-forwarded-for"]).split(",")[0].trim() : "") ||
    req.socket.remoteAddress ||
    "unknown";
  if (isIpBanned(ip)) return res.status(403).json({ ok: false, error: "IP temporarily blocked." });
  req._ip = ip;
  next();
});

// Serve public files
app.use(express.static(path.join(__dirname, "public")));

// -------------------- AUTH MIDDLEWARE --------------------
function auth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const payload = jwtVerify(token);
    const u = users.byId?.[payload.uid];
    if (!u) return res.status(401).json({ ok: false, error: "Unauthorized" });

    u.lastSeen = now();
    req.user = u; // IMPORTANT: set on req, not on next
    persistAll();
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
}
function botAuth(req, res, next) {
  const s = req.headers["x-tonkotsu-bot-secret"];
  if (!s || s !== ADMIN_SHARED_SECRET) return res.status(401).json({ ok: false, error: "Bot unauthorized" });
  next();
}

// -------------------- ROUTES: AUTH --------------------
app.post("/api/auth/login", (req, res) => {
  repairStorage();

  const username = safeStr(req.body?.username, 32).trim();
  const password = safeStr(req.body?.password, 200);

  if (!username || !password) return res.status(400).json({ ok: false, error: "Missing credentials." });

  const ban = isUserBanned(lower(username));
  if (ban.banned) return res.status(403).json({ ok: false, error: "This account has been erased / temporarily blocked." });

  let u = getUserByUsername(username);
  if (!u) {
    u = ensureUser(username, password);
    u.badges = Array.from(new Set([...(u.badges || []), "early access"]));
  } else {
    if (!u.passHash) {
      u.passHash = bcrypt.hashSync(password, 10);
    } else {
      const ok = bcrypt.compareSync(password, u.passHash);
      if (!ok) return res.status(401).json({ ok: false, error: "Invalid username/password." });
    }
  }

  const token = jwtSign({ uid: u.id });
  persistAll();
  return res.json({ ok: true, token, user: publicUser(u) });
});

app.post("/api/auth/guest", (req, res) => {
  repairStorage();

  const username = `guest_${Math.random().toString(16).slice(2, 8)}`;
  const ban = isUserBanned(lower(username));
  if (ban.banned) return res.status(403).json({ ok: false, error: "Guest temporarily blocked." });

  const u = ensureUser(username, null);
  u.badges = Array.from(new Set([...(u.badges || []), "guest"]));

  const token = jwtSign({ uid: u.id });
  persistAll();
  return res.json({ ok: true, token, user: publicUser(u) });
});

app.post("/api/auth/logout", (req, res) => res.json({ ok: true }));
app.get("/api/users/me", auth, (req, res) => res.json({ ok: true, user: publicUser(req.user) }));

// -------------------- ROUTES: PROFILE --------------------
app.post("/api/profile/update", auth, (req, res) => {
  const me = req.user;
  const bio = safeStr(req.body?.bio, 240).trim();
  me.bio = bio;
  persistAll();
  io.to(me.id).emit("profile:update", { user: publicUser(me) });
  return res.json({ ok: true, user: publicUser(me) });
});

// -------------------- ROUTES: STATE / BOOTSTRAP --------------------
app.get("/api/state/bootstrap", auth, (req, res) => {
  repairStorage();

  const me = req.user;

  // global messages
  messages.global = Array.isArray(messages.global) ? messages.global : [];

  // Friends list + DM threads are live via socket; bootstrap sends friend metadata only
  const friends = (me.friends || [])
    .map((fid) => users.byId?.[fid])
    .filter(Boolean)
    .map((u) => ({
      ...publicUser(u),
      messages: [],
    }));

  const myGroups = Object.values(groups.byId || {})
    .filter((g) => g && (g.members || []).includes(me.id))
    .map((g) => ({
      id: g.id,
      name: g.name,
      ownerId: g.ownerId,
      cooldownSeconds: g.cooldownSeconds || 3,
      rules: g.rules || "",
      messages: Array.isArray(messages.groups?.[g.id]) ? messages.groups[g.id].slice(-160) : [],
    }));

  return res.json({
    ok: true,
    me: publicUser(me),
    global: { messages: messages.global.slice(-160) },
    friends,
    groups: myGroups,
    onlineUsers: [], // filled by socket after connect
    links: {
      github: "https://github.com/",
      kofi: "https://ko-fi.com/",
    },
  });
});

// -------------------- ROUTES: FRIENDS --------------------
app.post("/api/friends/add", auth, (req, res) => {
  const me = req.user;
  const username = safeStr(req.body?.username, 32).trim();
  if (!username) return res.status(400).json({ ok: false, error: "Missing username." });

  const other = getUserByUsername(username);
  if (!other) return res.status(404).json({ ok: false, error: "User not found." });
  if (other.id === me.id) return res.status(400).json({ ok: false, error: "Cannot add yourself." });

  me.friends = Array.isArray(me.friends) ? me.friends : [];
  other.friends = Array.isArray(other.friends) ? other.friends : [];

  if (!me.friends.includes(other.id)) me.friends.push(other.id);
  if (!other.friends.includes(me.id)) other.friends.push(me.id);

  persistAll();

  // notify both (clients can add thread without reload)
  io.to(me.id).emit("friends:update", { friends: (me.friends || []).map((fid) => publicUser(users.byId?.[fid])).filter(Boolean) });
  io.to(other.id).emit("friends:update", { friends: (other.friends || []).map((fid) => publicUser(users.byId?.[fid])).filter(Boolean) });

  return res.json({ ok: true });
});

// -------------------- ROUTES: GROUPS --------------------
app.post("/api/groups/create", auth, (req, res) => {
  const me = req.user;
  const name = safeStr(req.body?.name, 48).trim();
  const cooldownSeconds = Math.max(0, Math.min(20, Number(req.body?.cooldownSeconds || 3)));

  if (!name) return res.status(400).json({ ok: false, error: "Missing group name." });

  const g = {
    id: id(),
    name,
    ownerId: me.id,
    cooldownSeconds,
    rules: "",
    createdAt: now(),
    members: [me.id],
    inviteCode: null,
  };

  groups.byId[g.id] = g;
  messages.groups[g.id] = Array.isArray(messages.groups?.[g.id]) ? messages.groups[g.id] : [];
  persistAll();

  io.to(me.id).emit("groups:update", { groups: userGroups(me.id).map((x) => ({ id: x.id, name: x.name, ownerId: x.ownerId, cooldownSeconds: x.cooldownSeconds })) });

  return res.json({ ok: true, group: { id: g.id, name: g.name, ownerId: g.ownerId, cooldownSeconds: g.cooldownSeconds } });
});

app.post("/api/groups/inviteLink", auth, (req, res) => {
  const me = req.user;
  const groupId = safeStr(req.body?.groupId, 48).trim();
  const g = groups.byId?.[groupId];
  if (!g) return res.status(404).json({ ok: false, error: "Group not found." });
  if (g.ownerId !== me.id) return res.status(403).json({ ok: false, error: "Owner only." });

  const code = nanoid(10);
  g.inviteCode = code;
  persistAll();

  return res.json({ ok: true, inviteCode: code });
});

app.post("/api/groups/joinByCode", auth, (req, res) => {
  const me = req.user;
  const code = safeStr(req.body?.code, 32).trim();
  if (!code) return res.status(400).json({ ok: false, error: "Missing code." });

  const g = Object.values(groups.byId || {}).find((x) => x && x.inviteCode === code);
  if (!g) return res.status(404).json({ ok: false, error: "Invalid code." });

  g.members = Array.isArray(g.members) ? g.members : [];
  if (!g.members.includes(me.id)) g.members.push(me.id);
  persistAll();

  io.to(me.id).emit("groups:update", { groups: userGroups(me.id).map((x) => ({ id: x.id, name: x.name, ownerId: x.ownerId, cooldownSeconds: x.cooldownSeconds })) });

  return res.json({ ok: true, group: { id: g.id, name: g.name, ownerId: g.ownerId, cooldownSeconds: g.cooldownSeconds } });
});

// -------------------- ROUTES: PRESENCE --------------------
app.post("/api/presence", auth, (req, res) => {
  const me = req.user;
  const mode = safeStr(req.body?.mode, 20).trim();
  me.presenceMode = ["online", "idle", "dnd", "invisible"].includes(mode) ? mode : "online";
  persistAll();

  // update online map if user is connected
  if (onlineByUserId.has(me.id)) {
    const entry = onlineByUserId.get(me.id);
    entry.mode = me.presenceMode;
    onlineByUserId.set(me.id, entry);
    broadcastOnlineUsers();
  }

  io.to(me.id).emit("presence:update", { me: { mode: me.presenceMode } });
  return res.json({ ok: true });
});

// -------------------- ROUTES: LEADERBOARD --------------------
app.get("/api/leaderboard", auth, (req, res) => {
  const top = Object.values(users.byId || [])
    .filter(Boolean)
    .map((u) => ({ id: u.id, username: u.username, color: u.color || "#dfe6ff", level: u.level || 1, xp: u.xp || 0 }))
    .sort((a, b) => (b.level - a.level) || (b.xp - a.xp) || a.username.localeCompare(b.username))
    .slice(0, 50);

  return res.json({ ok: true, top });
});

// -------------------- ROUTES: MESSAGES --------------------
const cooldownUntilByUser = new Map(); // uid -> ts
const lastClientIds = new Map(); // uid -> Map(clientId -> ts)

function isDuplicateClientId(uid, clientId) {
  if (!clientId) return false;
  let entry = lastClientIds.get(uid);
  if (!entry) {
    entry = new Map();
    lastClientIds.set(uid, entry);
  }
  const cutoff = now() - 120_000;
  for (const [k, v] of entry.entries()) if (v < cutoff) entry.delete(k);

  if (entry.has(clientId)) return true;
  entry.set(clientId, now());
  return false;
}

app.post("/api/messages/send", auth, (req, res) => {
  const me = req.user;

  const scope = normalizeScope(req.body?.scope);
  const targetId = safeStr(req.body?.targetId, 64).trim() || null;
  const text = safeStr(req.body?.text, 2000).trim();
  const clientId = safeStr(req.body?.clientId, 80).trim();

  if (!scope) return res.status(400).json({ ok: false, error: "Invalid scope." });
  if (!text) return res.status(400).json({ ok: false, error: "Empty message." });

  // idempotency to prevent duplicate sends (enter + click, script loaded twice, etc.)
  if (isDuplicateClientId(me.id, clientId)) {
    return res.json({ ok: true, message: null, deduped: true });
  }

  // scope checks
  if (scope === "dm") {
    const peer = users.byId?.[targetId];
    if (!peer) return res.status(404).json({ ok: false, error: "Peer not found." });
    const ok = (me.friends || []).includes(peer.id) && (peer.friends || []).includes(me.id);
    if (!ok) return res.status(403).json({ ok: false, error: "Not friends." });
  }
  if (scope === "group") {
    const g = groups.byId?.[targetId];
    if (!g) return res.status(404).json({ ok: false, error: "Group not found." });
    if (!(g.members || []).includes(me.id)) return res.status(403).json({ ok: false, error: "Not in group." });
  }

  // cooldown: global 2500ms, dm 1200ms, group uses group cooldownSeconds
  const base = scope === "global" ? 2500 : 1200;
  let cd = base;
  if (scope === "group") {
    const g = groups.byId?.[targetId];
    cd = Math.max(0, Math.min(20, Number(g?.cooldownSeconds || 3))) * 1000;
  }

  const until = cooldownUntilByUser.get(me.id) || 0;
  if (until && now() < until) {
    return res.status(429).json({ ok: false, error: "Cooldown", cooldownUntil: until, cooldownMs: cd });
  }

  const newUntil = now() + cd;
  cooldownUntilByUser.set(me.id, newUntil);

  const msg = {
    id: id(),
    ts: now(),
    scope,
    targetId,
    text,
    kind: "message",
    editedAt: null,
    user: publicUser(me),
  };

  // XP on send
  grantXp(me, scope === "global" ? 5 : 7);

  pushMessage(scope, targetId, msg);
  persistAll();

  // emit to correct audience
  if (scope === "global") {
    io.emit("message:new", msg);
  } else if (scope === "dm") {
    io.to(me.id).emit("message:new", msg);
    io.to(targetId).emit("message:new", msg);
  } else if (scope === "group") {
    io.to(`group:${targetId}`).emit("message:new", msg);
  }

  return res.json({ ok: true, message: msg, cooldownUntil: newUntil, cooldownMs: cd });
});

app.post("/api/messages/edit", auth, (req, res) => {
  const me = req.user;
  const messageId = safeStr(req.body?.messageId, 80).trim();
  const text = safeStr(req.body?.text, 2000).trim();
  if (!messageId || !text) return res.status(400).json({ ok: false, error: "Missing." });

  let found = null;
  let foundScope = null;
  let foundTargetId = null;

  // global
  const gm = messages.global.find((m) => m.id === messageId);
  if (gm) {
    found = gm;
    foundScope = "global";
  }

  // dm
  if (!found) {
    for (const arr of Object.values(messages.dms || {})) {
      const m = arr.find((x) => x.id === messageId);
      if (m) {
        found = m;
        foundScope = "dm";
        break;
      }
    }
  }

  // group
  if (!found) {
    for (const [gid, arr] of Object.entries(messages.groups || {})) {
      const m = (arr || []).find((x) => x.id === messageId);
      if (m) {
        found = m;
        foundScope = "group";
        foundTargetId = gid;
        break;
      }
    }
  }

  if (!found) return res.status(404).json({ ok: false, error: "Not found." });
  if (found.user?.id !== me.id) return res.status(403).json({ ok: false, error: "Not yours." });

  const age = now() - (found.ts || 0);
  if (age > 60_000) return res.status(403).json({ ok: false, error: "Edit window expired." });

  found.text = text;
  found.editedAt = now();
  persistAll();

  io.emit("message:edit", found);
  return res.json({ ok: true, message: found, scope: foundScope, targetId: foundTargetId });
});

app.post("/api/messages/delete", auth, (req, res) => {
  const me = req.user;
  const messageId = safeStr(req.body?.messageId, 80).trim();
  if (!messageId) return res.status(400).json({ ok: false, error: "Missing." });

  let scope = null;
  let targetId = null;
  let arr = null;
  let msg = null;

  // global
  msg = messages.global.find((m) => m.id === messageId);
  if (msg) {
    scope = "global";
    arr = messages.global;
  }

  // dm
  if (!msg) {
    for (const a of Object.values(messages.dms || {})) {
      const found = a.find((m) => m.id === messageId);
      if (found) {
        msg = found;
        scope = "dm";
        arr = a;
        break;
      }
    }
  }

  // group
  if (!msg) {
    for (const [gid, a] of Object.entries(messages.groups || {})) {
      const found = (a || []).find((m) => m.id === messageId);
      if (found) {
        msg = found;
        scope = "group";
        targetId = gid;
        arr = a;
        break;
      }
    }
  }

  if (!msg) return res.status(404).json({ ok: false, error: "Not found." });
  if (msg.user?.id !== me.id) return res.status(403).json({ ok: false, error: "Not yours." });

  const age = now() - (msg.ts || 0);
  if (age > 60_000) return res.status(403).json({ ok: false, error: "Delete window expired." });

  const idx = arr.findIndex((m) => m.id === messageId);
  if (idx >= 0) arr.splice(idx, 1);
  persistAll();

  io.emit("message:delete", { scope, targetId, messageId });
  return res.json({ ok: true });
});

app.post("/api/messages/report", auth, (req, res) => {
  const me = req.user;
  const messageId = safeStr(req.body?.messageId, 80).trim();
  const reason = safeStr(req.body?.reason, 300).trim();
  if (!messageId) return res.status(400).json({ ok: false, error: "Missing messageId." });

  const rep = {
    id: id(),
    ts: now(),
    messageId,
    reason,
    reporter: publicUser(me),
    ip: req._ip || "unknown",
    status: "open",
    replies: [], // {ts, text, by:"bot"|"admin"}
  };

  reports.items = Array.isArray(reports.items) ? reports.items : [];
  reports.items.push(rep);
  reports.items = reports.items.slice(-800);
  persistAll();

  io.emit("report:new", rep);
  return res.json({ ok: true });
});

// -------------------- BOT ADMIN API --------------------
app.post("/api/bot/deleteUser", botAuth, (req, res) => {
  repairStorage();

  const username = safeStr(req.body?.username, 64).trim();
  if (!username) return res.status(400).json({ ok: false, error: "Missing username." });

  const key = lower(username);
  const u = getUserByUsername(key);

  // strike+ban regardless of existence
  const entry = strikeAndBanUser(key);

  // if exists: delete account + scrub membership
  if (u) {
    delete users.byId[u.id];
    delete users.byName[u.usernameLower];

    for (const user of Object.values(users.byId || {})) {
      user.friends = (user.friends || []).filter((fid) => fid !== u.id);
    }
    for (const g of Object.values(groups.byId || {})) {
      g.members = (g.members || []).filter((mid) => mid !== u.id);
    }

    persistAll();
  }

  return res.json({
    ok: true,
    strikes: entry.strikes,
    until: entry.permanent ? null : entry.until,
    permanent: !!entry.permanent,
  });
});

app.post("/api/bot/announce", botAuth, (req, res) => {
  const text = safeStr(req.body?.text, 1200).trim();
  if (!text) return res.status(400).json({ ok: false, error: "Missing text." });

  const msg = {
    id: id(),
    ts: now(),
    scope: "global",
    targetId: null,
    text,
    kind: "announcement",
    editedAt: null,
    user: {
      id: "system",
      username: "tonkotsu",
      color: "hsl(45 90% 75%)",
      badges: ["announcement"],
      createdAt: now(),
      lastSeen: now(),
      bio: "",
      xp: 0,
      level: 1,
      mode: "online",
    },
  };

  pushMessage("global", null, msg);
  persistAll();
  io.emit("message:new", msg);

  return res.json({ ok: true });
});

app.post("/api/bot/banIp", botAuth, (req, res) => {
  const ip = safeStr(req.body?.ip, 80).trim();
  const seconds = Math.max(60, Math.min(60 * 60 * 24 * 30, Number(req.body?.seconds || 3600)));
  if (!ip) return res.status(400).json({ ok: false, error: "Missing ip." });

  banIp(ip, seconds * 1000);
  return res.json({ ok: true });
});

app.get("/api/bot/reports", botAuth, (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 10)));
  const items = (reports.items || []).slice(-limit).reverse();
  return res.json({ ok: true, reports: items });
});

app.post("/api/bot/reports/reply", botAuth, (req, res) => {
  const reportId = safeStr(req.body?.reportId, 80).trim();
  const text = safeStr(req.body?.text, 1200).trim();
  if (!reportId || !text) return res.status(400).json({ ok: false, error: "Missing." });

  const rep = (reports.items || []).find((r) => r.id === reportId);
  if (!rep) return res.status(404).json({ ok: false, error: "Report not found." });

  rep.replies = Array.isArray(rep.replies) ? rep.replies : [];
  rep.replies.push({ ts: now(), text, by: "bot" });
  persistAll();

  io.emit("report:reply", { reportId, reply: rep.replies[rep.replies.length - 1] });
  return res.json({ ok: true });
});

// -------------------- HTTP + SOCKET.IO --------------------
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_URL === "*" ? true : CLIENT_URL,
    credentials: true,
  },
});

// Online tracking: userId -> { countTabs, mode }
const onlineByUserId = new Map();

// helper to broadcast
function buildOnlineUsers() {
  const out = [];
  for (const [uid, info] of onlineByUserId.entries()) {
    const u = users.byId?.[uid];
    if (!u) continue;
    out.push({ ...publicUser(u), mode: info.mode || u.presenceMode || "online" });
  }
  out.sort((a, b) => a.username.localeCompare(b.username));
  return out;
}
function broadcastOnlineUsers() {
  const list = buildOnlineUsers();
  io.emit("users:online", { users: list, count: list.length });
}

// Socket auth from token
function socketAuthFromHandshake(socket) {
  const token =
    (socket.handshake.auth && socket.handshake.auth.token) ||
    (socket.handshake.headers.authorization || "").replace(/^Bearer\s+/i, "") ||
    null;
  if (!token) return null;
  try {
    const payload = jwtVerify(token);
    const u = users.byId?.[payload.uid];
    if (!u) return null;
    return u;
  } catch {
    return null;
  }
}

io.on("connection", (socket) => {
  const u = socketAuthFromHandshake(socket);
  if (!u) {
    socket.emit("auth:error", { error: "Unauthorized" });
    socket.disconnect(true);
    return;
  }

  // rooms: user private room + group rooms
  socket.join(u.id);
  const gs = userGroups(u.id);
  for (const g of gs) socket.join(`group:${g.id}`);

  // online increment
  const prev = onlineByUserId.get(u.id) || { count: 0, mode: u.presenceMode || "online" };
  prev.count += 1;
  prev.mode = u.presenceMode || prev.mode || "online";
  onlineByUserId.set(u.id, prev);

  // set lastSeen
  u.lastSeen = now();
  persistAll();

  // initial online list to this socket + broadcast
  socket.emit("users:online", { users: buildOnlineUsers(), count: onlineByUserId.size });
  broadcastOnlineUsers();

  // request: fetch dm history with a peer (friends only)
  socket.on("dm:history", (data, cb) => {
    try {
      const peerId = safeStr(data?.peerId, 64).trim();
      const peer = users.byId?.[peerId];
      if (!peer) return cb && cb({ ok: false, error: "Peer not found." });

      const ok = (u.friends || []).includes(peer.id) && (peer.friends || []).includes(u.id);
      if (!ok) return cb && cb({ ok: false, error: "Not friends." });

      const key = dmKey(u.id, peer.id);
      const arr = Array.isArray(messages.dms?.[key]) ? messages.dms[key] : [];
      return cb && cb({ ok: true, messages: arr.slice(-200) });
    } catch (e) {
      return cb && cb({ ok: false, error: e?.message || "dm history failed" });
    }
  });

  // request: fetch group history (member only)
  socket.on("group:history", (data, cb) => {
    try {
      const groupId = safeStr(data?.groupId, 64).trim();
      const g = groups.byId?.[groupId];
      if (!g) return cb && cb({ ok: false, error: "Group not found." });
      if (!(g.members || []).includes(u.id)) return cb && cb({ ok: false, error: "Not in group." });

      const arr = Array.isArray(messages.groups?.[groupId]) ? messages.groups[groupId] : [];
      return cb && cb({ ok: true, messages: arr.slice(-250) });
    } catch (e) {
      return cb && cb({ ok: false, error: e?.message || "group history failed" });
    }
  });

  // presence:set via socket
  socket.on("presence:set", (data) => {
    const mode = safeStr(data?.mode, 20).trim();
    u.presenceMode = ["online", "idle", "dnd", "invisible"].includes(mode) ? mode : "online";
    persistAll();

    const entry = onlineByUserId.get(u.id);
    if (entry) {
      entry.mode = u.presenceMode;
      onlineByUserId.set(u.id, entry);
      broadcastOnlineUsers();
    }
  });

  socket.on("disconnect", () => {
    const entry = onlineByUserId.get(u.id);
    if (entry) {
      entry.count -= 1;
      if (entry.count <= 0) onlineByUserId.delete(u.id);
      else onlineByUserId.set(u.id, entry);
    }
    broadcastOnlineUsers();
  });
});

// -------------------- START --------------------
server.listen(PORT, () => {
  console.log(`[tonkotsu] server listening on :${PORT} (${NODE_ENV})`);
  console.log(`[tonkotsu] CLIENT_URL=${CLIENT_URL}`);
});
