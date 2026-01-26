"use strict";

/**
 * tonkotsu.online — server.js
 * - Express + Socket.IO
 * - JWT auth (cookie optional, header supported)
 * - Users + friends + groups + messages persisted to /data/*.json
 * - Idempotent send using clientId
 * - Edit/Delete allowed within 60s (server enforced)
 * - Reports stored + bot endpoints protected via ADMIN_SHARED_SECRET
 * - Online users list with presence, de-duped per user (multi-tabs won't count twice)
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");
const { Server } = require("socket.io");

// -------------------- ENV --------------------
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = String(process.env.JWT_SECRET || "").trim();
const ADMIN_SHARED_SECRET = String(process.env.ADMIN_SHARED_SECRET || "").trim();

if (!JWT_SECRET) {
  console.error("Missing JWT_SECRET in env.");
  process.exit(1);
}
if (!ADMIN_SHARED_SECRET) {
  console.error("Missing ADMIN_SHARED_SECRET in env.");
  process.exit(1);
}

// -------------------- Paths --------------------
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, "users.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");
const BANS_FILE = path.join(DATA_DIR, "bans.json");

// -------------------- Helpers --------------------
const now = () => Date.now();

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeWriteJson(file, value) {
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch (e) {
    console.error("Failed writing", file, e);
  }
}

function lower(s) {
  return String(s || "").trim().toLowerCase();
}

function randColor(seedStr) {
  // deterministic-ish color per username
  const s = lower(seedStr);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  // convert to HSL
  const hue = h % 360;
  return `hsl(${hue} 75% 70%)`;
}

function ipFromReq(req) {
  // Render uses x-forwarded-for
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.socket?.remoteAddress || "0.0.0.0";
}

// -------------------- Data model --------------------
/**
users: {
  [usernameLower]: {
     id, username, passHash, createdAt, lastSeen, bio, color,
     strikes, bannedUntil, bannedPermanent,
     friends: [userId], // mutual
  }
}
state: {
  global: { messages: [] },
  dms: { [pairKey]: { messages: [] } },
  groups: {
     list: [{id,name,ownerId,createdAt,members:[userId],cooldownSeconds}],
     threads: { [groupId]: { messages: [] } }
  },
  idempotency: { [userId]: { [clientId]: messageObj } } // prune regularly
}
reports: [{id, ts, messageId, scope, targetId, reporter:{id,username}, reason, snapshot }]
bans: {
  ip: { untilTs }
}
 */

const db = {
  users: safeReadJson(USERS_FILE, {}),
  state: safeReadJson(STATE_FILE, {
    global: { messages: [] },
    dms: {},
    groups: { list: [], threads: {} },
    idempotency: {}
  }),
  reports: safeReadJson(REPORTS_FILE, []),
  bans: safeReadJson(BANS_FILE, { ip: {} })
};

function persistAll() {
  safeWriteJson(USERS_FILE, db.users);
  safeWriteJson(STATE_FILE, db.state);
  safeWriteJson(REPORTS_FILE, db.reports);
  safeWriteJson(BANS_FILE, db.bans);
}

setInterval(() => {
  // prune idempotency older than 10 minutes
  const cutoff = now() - 10 * 60 * 1000;
  const idm = db.state.idempotency || {};
  for (const uid of Object.keys(idm)) {
    for (const cid of Object.keys(idm[uid] || {})) {
      const m = idm[uid][cid];
      if (!m || (m.ts || 0) < cutoff) delete idm[uid][cid];
    }
  }
  // prune ip bans expired
  for (const ip of Object.keys(db.bans.ip || {})) {
    if (db.bans.ip[ip] && db.bans.ip[ip].untilTs && db.bans.ip[ip].untilTs < now()) {
      delete db.bans.ip[ip];
    }
  }
  persistAll();
}, 20_000);

// -------------------- Auth --------------------
function signToken(user) {
  return jwt.sign({ uid: user.id, u: user.username }, JWT_SECRET, { expiresIn: "7d" });
}

function verifyTokenMaybe(req) {
  const hdr = req.headers.authorization || "";
  const tok =
    hdr.startsWith("Bearer ") ? hdr.slice(7).trim() :
    (req.cookies && req.cookies.tk) ? req.cookies.tk :
    null;

  if (!tok) return null;
  try {
    const payload = jwt.verify(tok, JWT_SECRET);
    const uid = payload?.uid;
    if (!uid) return null;
    // find user by id
    const u = Object.values(db.users).find(x => x.id === uid);
    return u || null;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  // IP ban check first
  const ip = ipFromReq(req);
  const ban = db.bans.ip?.[ip];
  if (ban?.untilTs && ban.untilTs > now()) {
    return res.status(403).json({ ok: false, error: "IP blocked temporarily." });
  }

  const u = verifyTokenMaybe(req);
  if (!u) return res.status(401).json({ ok: false, error: "Not signed in." });

  // account bans
  if (u.bannedPermanent) return res.status(403).json({ ok: false, error: "Account erased." });
  if (u.bannedUntil && u.bannedUntil > now()) return res.status(403).json({ ok: false, error: "Account erased." });

  u.lastSeen = now();
  next();
}

function getAuthedUser(req) {
  return verifyTokenMaybe(req);
}

function requireBotSecret(req, res, next) {
  const s = String(req.headers["x-tonkotsu-bot-secret"] || "").trim();
  if (!s || s !== ADMIN_SHARED_SECRET) return res.status(401).json({ ok: false, error: "Bad bot secret." });
  next();
}

// -------------------- Express setup --------------------
const app = express();
app.use(helmet({
  contentSecurityPolicy: false // keep simple while you iterate
}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.set("trust proxy", 1);

app.use(rateLimit({
  windowMs: 60_000,
  limit: 400
}));

// Serve public
app.use(express.static(path.join(__dirname, "public")));

// -------------------- Basic endpoints --------------------
app.get("/api/health", (req, res) => res.json({ ok: true, ts: now() }));

app.get("/api/users/me", (req, res) => {
  const u = getAuthedUser(req);
  if (!u) return res.status(401).json({ ok: false });
  res.json({ ok: true, user: publicUser(u) });
});

// -------------------- User helpers --------------------
function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    createdAt: u.createdAt,
    lastSeen: u.lastSeen || null,
    bio: u.bio || "",
    color: u.color || randColor(u.username),
    badges: u.badges || []
  };
}

function ensureUser(username) {
  const key = lower(username);
  return db.users[key] || null;
}

function createUser(username, password) {
  const key = lower(username);
  if (db.users[key]) return null;
  const id = nanoid(12);
  const passHash = bcrypt.hashSync(String(password), 10);
  const u = {
    id,
    username: String(username).trim(),
    passHash,
    createdAt: now(),
    lastSeen: now(),
    bio: "",
    color: randColor(username),
    strikes: 0,
    bannedUntil: 0,
    bannedPermanent: false,
    friends: [],
    badges: ["beta"]
  };
  db.users[key] = u;
  persistAll();
  return u;
}

function upsertDmPair(aId, bId) {
  const s = [String(aId), String(bId)].sort();
  const key = `${s[0]}_${s[1]}`;
  if (!db.state.dms[key]) db.state.dms[key] = { messages: [] };
  return { key, thread: db.state.dms[key] };
}

function getGroup(groupId) {
  return db.state.groups.list.find(g => g.id === groupId) || null;
}

// -------------------- Auth endpoints --------------------
app.post("/api/auth/login", (req, res) => {
  const ip = ipFromReq(req);
  const ban = db.bans.ip?.[ip];
  if (ban?.untilTs && ban.untilTs > now()) {
    return res.status(403).json({ ok: false, error: "IP blocked temporarily." });
  }

  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "").trim();
  if (!username || !password) return res.status(400).json({ ok: false, error: "Missing username/password." });

  let u = ensureUser(username);

  // if user doesn't exist, create it (simple for now)
  if (!u) u = createUser(username, password);
  if (!u) return res.status(400).json({ ok: false, error: "Unable to create user." });

  if (u.bannedPermanent) return res.status(403).json({ ok: false, error: "Account erased." });
  if (u.bannedUntil && u.bannedUntil > now()) return res.status(403).json({ ok: false, error: "Account erased." });

  const ok = bcrypt.compareSync(password, u.passHash);
  if (!ok) return res.status(401).json({ ok: false, error: "Wrong password." });

  u.lastSeen = now();
  const token = signToken(u);

  // set cookie too (optional)
  res.cookie("tk", token, { httpOnly: true, sameSite: "lax", secure: false });

  persistAll();
  res.json({ ok: true, token, user: publicUser(u) });
});

app.post("/api/auth/guest", (req, res) => {
  const ip = ipFromReq(req);
  const ban = db.bans.ip?.[ip];
  if (ban?.untilTs && ban.untilTs > now()) {
    return res.status(403).json({ ok: false, error: "IP blocked temporarily." });
  }

  const name = `guest_${nanoid(5)}`;
  const pass = nanoid(10);
  const u = createUser(name, pass);
  if (!u) return res.status(500).json({ ok: false, error: "Guest failed." });

  u.badges = ["beta", "guest"];
  const token = signToken(u);

  res.cookie("tk", token, { httpOnly: true, sameSite: "lax", secure: false });
  persistAll();
  res.json({ ok: true, token, user: publicUser(u) });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("tk");
  res.json({ ok: true });
});

// -------------------- State bootstrap --------------------
app.get("/api/state/bootstrap", requireAuth, (req, res) => {
  const u = getAuthedUser(req);

  // global
  const globalMsgs = (db.state.global.messages || []).slice(-250);

  // friends list (public)
  const friends = (u.friends || [])
    .map(fid => Object.values(db.users).find(x => x.id === fid))
    .filter(Boolean)
    .map(publicUser);

  // dm threads summary: last 50 messages per dm
  const dms = [];
  for (const f of friends) {
    const { key, thread } = upsertDmPair(u.id, f.id);
    dms.push({
      peer: f,
      pairKey: key,
      messages: (thread.messages || []).slice(-80)
    });
  }

  // groups
  const myGroups = (db.state.groups.list || []).filter(g => (g.members || []).includes(u.id));
  const groupThreads = myGroups.map(g => ({
    group: g,
    messages: (db.state.groups.threads?.[g.id]?.messages || []).slice(-120)
  }));

  res.json({
    ok: true,
    me: publicUser(u),
    global: { messages: globalMsgs },
    friends,
    dms,
    groups: myGroups,
    groupThreads
  });
});

// -------------------- Friends --------------------
app.post("/api/friends/add", requireAuth, (req, res) => {
  const u = getAuthedUser(req);
  const targetName = String(req.body?.username || "").trim();
  if (!targetName) return res.status(400).json({ ok: false, error: "Missing username." });

  const t = ensureUser(targetName);
  if (!t) return res.status(404).json({ ok: false, error: "User not found." });

  if (t.id === u.id) return res.status(400).json({ ok: false, error: "Cannot friend yourself." });

  u.friends = Array.isArray(u.friends) ? u.friends : [];
  t.friends = Array.isArray(t.friends) ? t.friends : [];

  if (!u.friends.includes(t.id)) u.friends.push(t.id);
  if (!t.friends.includes(u.id)) t.friends.push(u.id);

  persistAll();
  res.json({ ok: true, friend: publicUser(t) });
});

// -------------------- Groups --------------------
app.get("/api/groups", requireAuth, (req, res) => {
  const u = getAuthedUser(req);
  const myGroups = (db.state.groups.list || []).filter(g => (g.members || []).includes(u.id));
  res.json({ ok: true, groups: myGroups });
});

app.post("/api/groups/create", requireAuth, (req, res) => {
  const u = getAuthedUser(req);
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "Missing group name." });

  const id = nanoid(10);
  const cooldownSeconds = Math.max(0, Math.min(20, Number(req.body?.cooldownSeconds || 3)));

  const g = {
    id,
    name,
    ownerId: u.id,
    createdAt: now(),
    members: [u.id],
    cooldownSeconds
  };
  db.state.groups.list.push(g);
  db.state.groups.threads[id] = { messages: [] };

  persistAll();
  ioEmitGroupsUpdate();
  res.json({ ok: true, group: g });
});

// “Discover” simple: list all groups (optional)
app.get("/api/groups/discover", requireAuth, (req, res) => {
  const all = (db.state.groups.list || []).slice(-100);
  res.json({ ok: true, groups: all });
});

app.post("/api/groups/join", requireAuth, (req, res) => {
  const u = getAuthedUser(req);
  const groupId = String(req.body?.groupId || "").trim();
  const g = getGroup(groupId);
  if (!g) return res.status(404).json({ ok: false, error: "Group not found." });

  g.members = Array.isArray(g.members) ? g.members : [];
  if (!g.members.includes(u.id)) g.members.push(u.id);

  persistAll();
  ioEmitGroupsUpdate();
  res.json({ ok: true, group: g });
});

// -------------------- Messages --------------------
function canEditDelete(msg, userId) {
  const age = now() - (msg.ts || 0);
  const mine = msg.user?.id === userId;
  return mine && age <= 60_000;
}

function findMessage(scope, targetId, messageId) {
  if (scope === "global") {
    const arr = db.state.global.messages || [];
    return { arr, idx: arr.findIndex(m => m.id === messageId) };
  }
  if (scope === "dm") {
    const th = db.state.dms?.[targetId];
    if (!th) return { arr: null, idx: -1 };
    const arr = th.messages || [];
    return { arr, idx: arr.findIndex(m => m.id === messageId) };
  }
  if (scope === "group") {
    const th = db.state.groups.threads?.[targetId];
    if (!th) return { arr: null, idx: -1 };
    const arr = th.messages || [];
    return { arr, idx: arr.findIndex(m => m.id === messageId) };
  }
  return { arr: null, idx: -1 };
}

app.post("/api/messages/send", requireAuth, (req, res) => {
  const u = getAuthedUser(req);

  const scope = String(req.body?.scope || "");
  const targetId = req.body?.targetId ? String(req.body.targetId) : null;
  const text = String(req.body?.text || "").trim();
  const clientId = String(req.body?.clientId || "").trim();

  if (!scope || !["global", "dm", "group"].includes(scope)) return res.status(400).json({ ok: false, error: "Bad scope." });
  if (!text) return res.status(400).json({ ok: false, error: "Empty." });
  if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId." });

  // idempotency (prevents duplicate sends)
  db.state.idempotency[u.id] = db.state.idempotency[u.id] || {};
  const existing = db.state.idempotency[u.id][clientId];
  if (existing) return res.json({ ok: true, message: existing });

  // DM needs pair key
  let writeScope = scope;
  let writeTarget = null;

  if (scope === "dm") {
    if (!targetId) return res.status(400).json({ ok: false, error: "Missing targetId." });
    const peer = Object.values(db.users).find(x => x.id === targetId);
    if (!peer) return res.status(404).json({ ok: false, error: "Peer not found." });
    // must be friends
    if (!Array.isArray(u.friends) || !u.friends.includes(peer.id)) {
      return res.status(403).json({ ok: false, error: "Not friends." });
    }
    const { key, thread } = upsertDmPair(u.id, peer.id);
    writeTarget = key; // store by pairKey
    db.state.dms[key] = thread;
  } else if (scope === "group") {
    if (!targetId) return res.status(400).json({ ok: false, error: "Missing groupId." });
    const g = getGroup(targetId);
    if (!g) return res.status(404).json({ ok: false, error: "Group not found." });
    if (!Array.isArray(g.members) || !g.members.includes(u.id)) {
      return res.status(403).json({ ok: false, error: "Not in group." });
    }
    writeTarget = targetId;
  } else {
    writeTarget = null;
  }

  // cooldown
  const cooldownSeconds =
    scope === "group"
      ? (getGroup(targetId)?.cooldownSeconds || 3)
      : 2;

  u._cooldownUntil = u._cooldownUntil || 0;
  if (u._cooldownUntil > now()) {
    return res.status(429).json({ ok: false, error: "Cooldown", cooldownUntil: u._cooldownUntil, cooldownMs: cooldownSeconds * 1000 });
  }
  u._cooldownUntil = now() + cooldownSeconds * 1000;

  const msg = {
    id: nanoid(12),
    ts: now(),
    scope: writeScope,
    targetId: writeTarget,
    text,
    user: publicUser(u)
  };

  if (scope === "global") {
    db.state.global.messages = db.state.global.messages || [];
    db.state.global.messages.push(msg);
    db.state.global.messages = db.state.global.messages.slice(-2000);
  } else if (scope === "dm") {
    db.state.dms[writeTarget].messages = db.state.dms[writeTarget].messages || [];
    db.state.dms[writeTarget].messages.push(msg);
    db.state.dms[writeTarget].messages = db.state.dms[writeTarget].messages.slice(-1500);
  } else if (scope === "group") {
    db.state.groups.threads[writeTarget] = db.state.groups.threads[writeTarget] || { messages: [] };
    db.state.groups.threads[writeTarget].messages = db.state.groups.threads[writeTarget].messages || [];
    db.state.groups.threads[writeTarget].messages.push(msg);
    db.state.groups.threads[writeTarget].messages = db.state.groups.threads[writeTarget].messages.slice(-2000);
  }

  db.state.idempotency[u.id][clientId] = msg;
  persistAll();

  ioEmitNewMessage(msg, scope, targetId);

  res.json({
    ok: true,
    message: msg,
    cooldownUntil: u._cooldownUntil,
    cooldownMs: cooldownSeconds * 1000
  });
});

app.post("/api/messages/edit", requireAuth, (req, res) => {
  const u = getAuthedUser(req);
  const messageId = String(req.body?.messageId || "").trim();
  const text = String(req.body?.text || "").trim();

  if (!messageId || !text) return res.status(400).json({ ok: false, error: "Missing." });

  // Find by searching all scopes (simple)
  // In practice you’d pass scope/targetId, but we’ll do safe scan.
  const found = scanMessageById(messageId);
  if (!found) return res.status(404).json({ ok: false, error: "Not found." });

  const { arr, idx, scope, emitScope, emitTargetId } = found;
  const msg = arr[idx];

  if (!canEditDelete(msg, u.id)) return res.status(403).json({ ok: false, error: "Edit window expired." });

  msg.text = text;
  msg.editedAt = now();
  persistAll();

  io.emit("message:edit", { message: msg, scope: emitScope, targetId: emitTargetId });
  res.json({ ok: true, message: msg });
});

app.post("/api/messages/delete", requireAuth, (req, res) => {
  const u = getAuthedUser(req);
  const messageId = String(req.body?.messageId || "").trim();
  if (!messageId) return res.status(400).json({ ok: false, error: "Missing." });

  const found = scanMessageById(messageId);
  if (!found) return res.status(404).json({ ok: false, error: "Not found." });

  const { arr, idx, emitScope, emitTargetId } = found;
  const msg = arr[idx];

  if (!canEditDelete(msg, u.id)) return res.status(403).json({ ok: false, error: "Delete window expired." });

  arr.splice(idx, 1);
  persistAll();

  io.emit("message:delete", { messageId, scope: emitScope, targetId: emitTargetId });
  res.json({ ok: true });
});

app.post("/api/messages/report", requireAuth, (req, res) => {
  const u = getAuthedUser(req);
  const messageId = String(req.body?.messageId || "").trim();
  const reason = String(req.body?.reason || "").trim();

  if (!messageId) return res.status(400).json({ ok: false, error: "Missing messageId." });

  const found = scanMessageById(messageId);
  if (!found) return res.status(404).json({ ok: false, error: "Not found." });

  const { message, emitScope, emitTargetId } = found;

  const rep = {
    id: nanoid(12),
    ts: now(),
    messageId,
    scope: emitScope,
    targetId: emitTargetId || null,
    reporter: publicUser(u),
    reason,
    snapshot: message
  };
  db.reports.push(rep);
  db.reports = db.reports.slice(-5000);
  persistAll();

  io.emit("report:new", rep);
  res.json({ ok: true });
});

function scanMessageById(messageId) {
  // global
  {
    const arr = db.state.global.messages || [];
    const idx = arr.findIndex(m => m.id === messageId);
    if (idx >= 0) return { arr, idx, message: arr[idx], scope: "global", emitScope: "global", emitTargetId: null };
  }
  // dms (pair keys)
  for (const pairKey of Object.keys(db.state.dms || {})) {
    const arr = db.state.dms[pairKey]?.messages || [];
    const idx = arr.findIndex(m => m.id === messageId);
    if (idx >= 0) return { arr, idx, message: arr[idx], scope: "dm", emitScope: "dm", emitTargetId: pairKey };
  }
  // groups
  for (const gid of Object.keys(db.state.groups.threads || {})) {
    const arr = db.state.groups.threads[gid]?.messages || [];
    const idx = arr.findIndex(m => m.id === messageId);
    if (idx >= 0) return { arr, idx, message: arr[idx], scope: "group", emitScope: "group", emitTargetId: gid };
  }
  return null;
}

// -------------------- Settings (basic) --------------------
app.post("/api/users/bio", requireAuth, (req, res) => {
  const u = getAuthedUser(req);
  u.bio = String(req.body?.bio || "").slice(0, 220);
  persistAll();
  res.json({ ok: true, user: publicUser(u) });
});

// -------------------- Bot endpoints --------------------
app.post("/api/bot/deleteUser", requireBotSecret, (req, res) => {
  const username = String(req.body?.username || "").trim();
  const u = ensureUser(username);
  if (!u) return res.status(404).json({ ok: false, error: "User not found." });

  // progressive ban logic
  u.strikes = Number(u.strikes || 0) + 1;

  if (u.strikes === 1) {
    u.bannedUntil = now() + 3 * 24 * 60 * 60 * 1000; // 3 days
  } else if (u.strikes === 2) {
    u.bannedUntil = now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  } else if (u.strikes >= 3) {
    u.bannedPermanent = true; // erased forever
    u.bannedUntil = 0;
  }

  persistAll();
  res.json({
    ok: true,
    username: u.username,
    strikes: u.strikes,
    until: u.bannedUntil || null,
    permanent: !!u.bannedPermanent
  });
});

app.post("/api/bot/announce", requireBotSecret, (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "Missing text." });

  const msg = {
    id: nanoid(12),
    ts: now(),
    scope: "global",
    targetId: null,
    text,
    kind: "announcement",
    user: { id: "system", username: "tonkotsu", color: "hsl(48 95% 70%)", badges: ["announcement"] }
  };

  db.state.global.messages = db.state.global.messages || [];
  db.state.global.messages.push(msg);
  db.state.global.messages = db.state.global.messages.slice(-2000);
  persistAll();

  io.emit("message:new", { message: msg, scope: "global", targetId: null });
  res.json({ ok: true });
});

app.post("/api/bot/banIp", requireBotSecret, (req, res) => {
  const ip = String(req.body?.ip || "").trim();
  const seconds = Number(req.body?.seconds || 3600);
  if (!ip) return res.status(400).json({ ok: false, error: "Missing ip." });
  const untilTs = now() + Math.max(60, Math.min(30 * 24 * 3600, seconds)) * 1000;
  db.bans.ip[ip] = { untilTs };
  persistAll();
  res.json({ ok: true, ip, untilTs });
});

app.get("/api/bot/reports", requireBotSecret, (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 10)));
  const reports = (db.reports || []).slice(-limit);
  res.json({ ok: true, reports });
});

// -------------------- Socket.IO --------------------
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true }
});

// online presence map (dedupe multi-tab)
const online = {
  // userId -> { user, sockets:Set, mode, lastSeen }
  byUser: new Map()
};

function onlineList() {
  const out = [];
  for (const v of online.byUser.values()) {
    out.push({
      id: v.user.id,
      username: v.user.username,
      mode: v.mode || "online",
      color: v.user.color
    });
  }
  out.sort((a, b) => a.username.localeCompare(b.username));
  return out;
}

function emitOnline() {
  const list = onlineList();
  io.emit("users:online", { count: list.length, users: list });
}

function ioEmitNewMessage(msg, scope, rawTargetId) {
  // emit payload that client understands
  if (scope === "global") {
    io.emit("message:new", { message: msg, scope: "global", targetId: null });
  } else if (scope === "dm") {
    // rawTargetId is peerId; stored targetId is pairKey
    // We can emit to all, client will filter by pairKey
    io.emit("message:new", { message: msg, scope: "dm", targetId: msg.targetId });
  } else if (scope === "group") {
    io.emit("message:new", { message: msg, scope: "group", targetId: rawTargetId });
  }
}

function ioEmitGroupsUpdate() {
  io.emit("groups:update", { groups: db.state.groups.list || [] });
}

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("no token"));
    const payload = jwt.verify(token, JWT_SECRET);
    const uid = payload?.uid;
    const u = Object.values(db.users).find(x => x.id === uid);
    if (!u) return next(new Error("bad token"));
    if (u.bannedPermanent) return next(new Error("banned"));
    if (u.bannedUntil && u.bannedUntil > now()) return next(new Error("banned"));
    socket.data.user = u;
    next();
  } catch (e) {
    next(new Error("auth failed"));
  }
});

io.on("connection", (socket) => {
  const u = socket.data.user;
  u.lastSeen = now();

  // register online
  const existing = online.byUser.get(u.id) || { user: publicUser(u), sockets: new Set(), mode: "online", lastSeen: now() };
  existing.user = publicUser(u);
  existing.sockets.add(socket.id);
  existing.lastSeen = now();
  online.byUser.set(u.id, existing);

  emitOnline();

  socket.on("presence:set", (p) => {
    const mode = String(p?.mode || "online");
    const entry = online.byUser.get(u.id);
    if (entry) {
      entry.mode = ["online", "idle", "dnd", "invisible"].includes(mode) ? mode : "online";
      emitOnline();
    }
  });

  socket.on("typing", (p) => {
    // pass-through typing
    const scope = String(p?.scope || "");
    const targetId = p?.targetId ? String(p.targetId) : null;
    const typing = !!p?.typing;

    io.emit("typing:update", {
      scope,
      targetId,
      typing,
      user: { id: u.id, username: u.username }
    });
  });

  socket.on("disconnect", () => {
    const entry = online.byUser.get(u.id);
    if (entry) {
      entry.sockets.delete(socket.id);
      if (entry.sockets.size === 0) {
        online.byUser.delete(u.id);
      }
    }
    emitOnline();
  });
});

// -------------------- Start --------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
