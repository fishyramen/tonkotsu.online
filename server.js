// server.js — tonkotsu.online backend (Socket.IO + Express)
// Fix: removed broken dbObj init pattern (ReferenceError). This file is self-contained.
// Features included (core / requested):
// - Accounts: username is unique; existing usernames require correct password (no hijacking)
// - Session resume via token
// - Persisted storage (users/groups/global) on disk (JSON)
// - Friends + inbox + mentions
// - DMs require mutual friendship
// - Groups public/private + discover + invites (invites require friendship)
// - Group owner tools: rename, transfer ownership, add/remove members, mute/unmute, mute all, cooldown slider, per-member cooldown override, cancel cooldown
// - Dynamic global cooldown (server-driven)
// - Anti-repeat warning (same message twice)
// - Shadow mute on severe language / 18+ content attempts (user sees own messages; others don't)
// - Link rules: porn/18+ links blocked; 1 link per 5 minutes per user
// - Basic anti-spam: mention cap per message, mention frequency dampening
// - Per-device account creation limit: 4 per day (best-effort via IP+UA fingerprint)

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");

// -------------------- storage --------------------
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const GROUPS_FILE = path.join(DATA_DIR, "groups.json");
const GLOBAL_FILE = path.join(DATA_DIR, "global.json");
const DEVICE_CREATE_FILE = path.join(DATA_DIR, "device_creations.json");

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

let users = readJson(USERS_FILE, {});          // username -> record
let groups = readJson(GROUPS_FILE, {});        // groupId  -> record
let globalHistory = readJson(GLOBAL_FILE, []); // [{user,text,ts}]
let deviceCreations = readJson(DEVICE_CREATE_FILE, {}); // deviceKey -> { day:"YYYY-MM-DD", count:number }

function persistUsers() { writeJson(USERS_FILE, users); }
function persistGroups() { writeJson(GROUPS_FILE, groups); }
function persistGlobal() { writeJson(GLOBAL_FILE, globalHistory); }
function persistDeviceCreations() { writeJson(DEVICE_CREATE_FILE, deviceCreations); }

function now() { return Date.now(); }
function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// -------------------- validation --------------------
function isValidUser(u) { return /^[A-Za-z0-9]{4,20}$/.test(String(u || "").trim()); }
function isValidPass(p) { return /^[A-Za-z0-9]{4,32}$/.test(String(p || "").trim()); }
function isGuestName(u) { return /^Guest\d{4,5}$/.test(String(u || "")); }

// -------------------- security helpers --------------------
function sha256(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }
function newToken() { return crypto.randomBytes(24).toString("hex"); }

function deviceKeyFromSocket(socket) {
  // Best-effort "device" fingerprint. Not perfect, but meets your "per PC" intent for basic anti-bot.
  const xf = socket.handshake.headers["x-forwarded-for"];
  const ip = (Array.isArray(xf) ? xf[0] : (xf || socket.handshake.address || "")).split(",")[0].trim();
  const ua = String(socket.handshake.headers["user-agent"] || "");
  return sha256(`${ip}::${ua}`).slice(0, 32);
}

function bumpDeviceCreationLimit(deviceKey) {
  const today = dayKey();
  const rec = deviceCreations[deviceKey] || { day: today, count: 0 };
  if (rec.day !== today) { rec.day = today; rec.count = 0; }
  rec.count += 1;
  deviceCreations[deviceKey] = rec;
  persistDeviceCreations();
  return rec.count;
}
function deviceCreationCount(deviceKey) {
  const today = dayKey();
  const rec = deviceCreations[deviceKey] || { day: today, count: 0 };
  if (rec.day !== today) return 0;
  return rec.count || 0;
}

// -------------------- user model --------------------
function defaultSettings() {
  return {
    sounds: true,
    hideMildProfanity: false,
    allowFriendRequests: true,
    allowGroupInvites: true,
    customCursor: true,
    mobileUX: false
  };
}
function defaultSocial() {
  return { friends: [], incoming: [], outgoing: [], blocked: [] };
}
function defaultStats() {
  return { messages: 0, xp: 0, level: 1 };
}
function xpNeededForNext(level) {
  const L = Math.max(1, Number(level) || 1);
  return Math.floor(120 + (L * 65) + (L * L * 12));
}
function awardXP(username, amount) {
  const u = users[username];
  if (!u || isGuestName(username)) return null;

  u.stats ||= defaultStats();
  u.stats.messages = (u.stats.messages || 0) + 1;
  u.stats.xp = (u.stats.xp || 0) + amount;

  let leveled = false;
  while (u.stats.xp >= xpNeededForNext(u.stats.level || 1)) {
    u.stats.xp -= xpNeededForNext(u.stats.level || 1);
    u.stats.level = (u.stats.level || 1) + 1;
    leveled = true;
  }
  persistUsers();
  return { leveled, level: u.stats.level, xp: u.stats.xp, next: xpNeededForNext(u.stats.level) };
}

function ensureUser(username) {
  if (!users[username]) {
    users[username] = {
      user: username,
      createdAt: now(),
      lastSeen: now(),
      passHash: null,      // bcrypt hash
      token: null,
      status: "online",
      settings: defaultSettings(),
      social: defaultSocial(),
      inbox: [],
      stats: defaultStats(),
      dm: {},              // otherUser -> msgs[]
      security: {
        sessions: [],      // [{token, createdAt, ipHash, uaHash, lastSeen}]
        loginHistory: []   // [{ts, ipHash, uaHash, ok}]
      },
      flags: {
        beta: true
      }
    };
  }
  const u = users[username];
  u.settings ||= defaultSettings();
  u.social ||= defaultSocial();
  u.inbox ||= [];
  u.stats ||= defaultStats();
  u.dm ||= {};
  u.security ||= { sessions: [], loginHistory: [] };
  u.flags ||= { beta: true };

  // normalize settings defaults
  const d = defaultSettings();
  for (const k of Object.keys(d)) {
    if (typeof u.settings[k] !== typeof d[k]) u.settings[k] = d[k];
  }
  // normalize social lists
  for (const k of ["friends", "incoming", "outgoing", "blocked"]) {
    if (!Array.isArray(u.social[k])) u.social[k] = [];
  }

  return u;
}

function safeUserPublic(u) {
  return { user: u.user, status: u.status || "online", level: u.stats?.level || 1 };
}

function addInboxItem(toUser, item) {
  const u = ensureUser(toUser);
  u.inbox.unshift(item);
  if (u.inbox.length > 250) u.inbox.length = 250;
  persistUsers();
}
function countInbox(u) {
  const items = u.inbox || [];
  let friend = 0, groupInv = 0, ment = 0, groupReq = 0;
  for (const it of items) {
    if (it.type === "friend") friend++;
    else if (it.type === "group") groupInv++;
    else if (it.type === "mention") ment++;
    else if (it.type === "groupReq") groupReq++;
  }
  return { total: friend + groupInv + ment + groupReq, friend, groupInv, ment, groupReq };
}

// -------------------- message parsing --------------------
function extractMentions(text) {
  const t = String(text || "");
  const rx = /@([A-Za-z0-9]{4,20})/g;
  const found = new Set();
  let m;
  while ((m = rx.exec(t)) !== null) found.add(m[1]);
  return Array.from(found);
}
function containsUrl(text) {
  const t = String(text || "");
  return /(https?:\/\/|www\.)/i.test(t);
}
function extractUrls(text) {
  const t = String(text || "");
  const rx = /\bhttps?:\/\/[^\s<>"')\]]+/ig;
  const out = [];
  let m;
  while ((m = rx.exec(t)) !== null) out.push(m[0]);
  return out;
}

// A strict-ish porn/18+ block (not exhaustive; intentionally conservative)
const BLOCKED_LINK_RX = new RegExp(
  [
    "porn", "xnxx", "xvideos", "pornhub", "redtube", "youporn",
    "hentai", "rule34", "onlyfans", "fansly", "sex", "nsfw",
    "camgirl", "cam4", "chaturbate"
  ].join("|"),
  "i"
);

// Severe content triggers: racial slurs, explicit sexual content, minors, etc.
// Keep it "huge but not too huge": strong coverage without going absurd.
const SEVERE_BAD_RX = new RegExp(
  [
    // racial slurs / hate (partial list)
    "\\bn[i1]gg(?:a|er)\\b",
    "\\bchink\\b",
    "\\bwetback\\b",
    "\\bkike\\b",
    "\\bspic\\b",
    "\\bfag(?:got)?\\b",
    "\\btrann(?:y|ies)\\b",

    // sexual content + minors / coercion indicators
    "\\bcp\\b",
    "\\bchild\\s*porn\\b",
    "\\bloli\\b",
    "\\bunderage\\b",
    "\\brape\\b",
    "\\bincest\\b",
    "\\bbeastiality\\b",

    // explicit terms
    "\\bblowjob\\b",
    "\\bhandjob\\b",
    "\\bdeepthroat\\b",
    "\\bcumshot\\b",
    "\\bgangbang\\b",
    "\\bcreampie\\b",
    "\\banal\\b",
    "\\bthreesome\\b",
    "\\bstrip\\s*tease\\b"
  ].join("|"),
  "i"
);

function isSevereBad(text) {
  const t = String(text || "");
  if (SEVERE_BAD_RX.test(t)) return true;
  // Also treat 18+ link-ish content as severe
  const urls = extractUrls(t);
  for (const u of urls) {
    if (BLOCKED_LINK_RX.test(u)) return true;
  }
  return false;
}

// -------------------- global history --------------------
function pushGlobalMessage(msg) {
  globalHistory.push(msg);
  if (globalHistory.length > 350) globalHistory.shift();
  persistGlobal();
}

// -------------------- DM store --------------------
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
  persistUsers();
}

// -------------------- groups --------------------
function ensureGroupDefaults(g) {
  g.privacy = (g.privacy === "public") ? "public" : "private";
  g.cooldownSec = Number.isFinite(Number(g.cooldownSec)) ? Number(g.cooldownSec) : 2.5;
  g.cooldownEnabled = (g.cooldownEnabled !== false); // default true
  g.mutedAll = !!g.mutedAll;

  g.members ||= [];
  g.owner ||= null;
  g.createdAt ||= now();
  g.messages ||= [];

  g.mutedUsers ||= [];                 // fully muted in group
  g.unmutedWhileMutedAll ||= [];       // allowlist when mutedAll is true

  g.invites ||= [];                    // [{id,to,from,ts}]
  g.joinRequests ||= [];               // [{from,ts}]

  // permissions: who can invite others (besides owner)
  g.perms ||= { invite: [] };          // invite: [username]
  if (!Array.isArray(g.perms.invite)) g.perms.invite = [];

  // per-member cooldown override: user -> seconds (null/undefined = group default)
  g.memberCooldown ||= {};             // { username: seconds }
  return g;
}
function groupPublic(g) {
  g = ensureGroupDefaults(g);
  return {
    id: g.id,
    name: g.name,
    owner: g.owner,
    members: g.members || [],
    privacy: g.privacy,
    cooldownSec: g.cooldownSec,
    cooldownEnabled: g.cooldownEnabled !== false,
    mutedAll: !!g.mutedAll,
    perms: g.perms,
    memberCooldown: g.memberCooldown || {}
  };
}

// -------------------- online tracking --------------------
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
    if (u.status === "invisible") continue;
    list.push(safeUserPublic(u));
  }
  list.sort((a, b) => a.user.localeCompare(b.user));
  io.emit("onlineUsers", list);
}

// -------------------- cooldowns / anti-spam --------------------
// Dynamic global cooldown: base 3s, improves with level a bit, penalizes bursts.
const globalRate = new Map(); // user -> { nextAllowed, recent:[ts...], lastMsgNorm, lastLinkAt, lastMentionAt, shadowMuteUntil }
function baseCooldownForUser(username) {
  if (!users[username]) return 3;
  if (isGuestName(username)) return 5;
  const lvl = Number(users[username].stats?.level || 1);
  return Math.max(1.5, 3 - (lvl - 1) * 0.05);
}
function currentCooldownForUser(username) {
  const base = baseCooldownForUser(username);
  const r = globalRate.get(username);
  if (!r) return base;

  const cutoff = now() - 10000;
  r.recent = (r.recent || []).filter(t => t >= cutoff);

  const n = r.recent.length;
  const penalty = n >= 8 ? 3.0 : (n >= 6 ? 2.0 : (n >= 4 ? 1.0 : 0));
  return Math.min(12, base + penalty);
}
function touchGlobalSend(username) {
  const t = now();
  const r = globalRate.get(username) || { nextAllowed: 0, recent: [] };
  r.recent.push(t);
  globalRate.set(username, r);
}

// Group cooldown per-user map
const groupRate = new Map(); // key `${gid}:${user}` -> nextAllowed
function groupKey(gid, user) { return `${gid}:${user}`; }

// Repeat-warning normalization
function normMsg(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// Mention anti-spam
function canMention(username) {
  const r = globalRate.get(username) || {};
  const t = now();
  const last = Number(r.lastMentionAt || 0);
  // 1 mention-bearing message per 8s (best-effort). Still allows general chatting.
  return (t - last) >= 8000;
}

// Link rules: 1 link / 5 min per user
function canPostLink(username) {
  const r = globalRate.get(username) || {};
  const t = now();
  const last = Number(r.lastLinkAt || 0);
  return (t - last) >= 5 * 60 * 1000;
}

// Shadow mute duration (ms)
const SHADOW_MUTE_MS = 10 * 60 * 1000;

// -------------------- server setup --------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // You can tighten this later
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.json({ ok: true }));

// -------------------- socket handlers --------------------
io.on("connection", (socket) => {
  let authedUser = null;

  function requireAuth() {
    return !!authedUser && !!users[authedUser];
  }
  function requireNonGuest() {
    return requireAuth() && !isGuestName(authedUser);
  }

  function sendCooldown() {
    if (!authedUser) return;
    socket.emit("cooldown:update", { seconds: currentCooldownForUser(authedUser) });
  }

  function socketIpUaHashes() {
    const xf = socket.handshake.headers["x-forwarded-for"];
    const ip = (Array.isArray(xf) ? xf[0] : (xf || socket.handshake.address || "")).split(",")[0].trim();
    const ua = String(socket.handshake.headers["user-agent"] || "");
    return { ipHash: sha256(ip), uaHash: sha256(ua) };
  }

  function recordLogin(username, ok) {
    const u = ensureUser(username);
    const { ipHash, uaHash } = socketIpUaHashes();
    u.security.loginHistory ||= [];
    u.security.loginHistory.unshift({ ts: now(), ipHash, uaHash, ok: !!ok });
    if (u.security.loginHistory.length > 50) u.security.loginHistory.length = 50;
    persistUsers();
  }

  function upsertSession(username, token) {
    const u = ensureUser(username);
    const { ipHash, uaHash } = socketIpUaHashes();
    u.security.sessions ||= [];
    const existing = u.security.sessions.find(s => s.token === token);
    if (existing) {
      existing.lastSeen = now();
      existing.ipHash = ipHash;
      existing.uaHash = uaHash;
    } else {
      u.security.sessions.unshift({ token, createdAt: now(), lastSeen: now(), ipHash, uaHash });
      if (u.security.sessions.length > 10) u.security.sessions.length = 10;
    }
    persistUsers();
  }

  function sendInitSuccess(u, { guest = false, firstTime = false } = {}) {
    authedUser = u.user;
    setOnline(authedUser, socket.id);

    u.lastSeen = now();

    if (guest) {
      u.status = "online";
      u.token = null;
    } else {
      u.status ||= "online";
      u.token ||= newToken();
      upsertSession(u.user, u.token);
    }

    persistUsers();

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
        createdAt: u.createdAt,
        lastSeen: u.lastSeen
      },
      firstTime: !!firstTime
    });

    sendCooldown();

    if (!guest) {
      socket.emit("inbox:badge", countInbox(u));
      socket.emit("inbox:data", { items: u.inbox || [] });
    }

    broadcastOnlineUsers();
  }

  // -------------------- resume session --------------------
  socket.on("resume", ({ token }) => {
    const tok = String(token || "");
    if (!tok) return socket.emit("resumeFail");

    const found = Object.values(users).find(u => u && u.token === tok && u.passHash);
    if (!found) return socket.emit("resumeFail");

    // update session record
    upsertSession(found.user, tok);
    sendInitSuccess(found, { guest: false, firstTime: false });
  });

  // -------------------- cooldown get --------------------
  socket.on("cooldown:get", () => {
    if (!requireAuth()) return;
    sendCooldown();
  });

  // -------------------- login / create --------------------
  socket.on("login", async ({ username, password, guest }) => {
    const devKey = deviceKeyFromSocket(socket);

    // Guest login
    if (guest) {
      let g = null;
      for (let i = 0; i < 80; i++) {
        const n = 1000 + Math.floor(Math.random() * 9000);
        const name = `Guest${n}`;
        if (!users[name] && !socketsByUser.has(name)) {
          g = ensureUser(name);
          g.passHash = null;
          g.token = null;
          g.status = "online";
          g.flags.beta = true;
          break;
        }
      }
      if (!g) return socket.emit("loginError", "Guest slots busy. Try again.");
      persistUsers();
      recordLogin(g.user, true);
      return sendInitSuccess(g, { guest: true, firstTime: false });
    }

    const uName = String(username || "").trim();
    const pass = String(password || "").trim();

    if (!isValidUser(uName)) return socket.emit("loginError", "Username: letters/numbers only, 4–20.");
    if (!isValidPass(pass)) return socket.emit("loginError", "Password: letters/numbers only, 4–32.");

    const exists = !!users[uName] && !!users[uName].passHash;

    // Enforce 4 account creations/day per device (best-effort)
    if (!exists) {
      const c = deviceCreationCount(devKey);
      if (c >= 4) {
        recordLogin(uName, false);
        return socket.emit("loginError", "Account creation limit reached (4 per day on this device).");
      }
    }

    const rec = ensureUser(uName);

    // Existing account => password must match
    if (rec.passHash) {
      const ok = await bcrypt.compare(pass, rec.passHash).catch(() => false);
      recordLogin(uName, ok);
      if (!ok) return socket.emit("loginError", "Incorrect password.");

      rec.token = newToken();
      rec.status ||= "online";
      rec.lastSeen = now();
      persistUsers();

      upsertSession(rec.user, rec.token);
      return sendInitSuccess(rec, { guest: false, firstTime: false });
    }

    // New account create
    const newCount = bumpDeviceCreationLimit(devKey);
    if (newCount > 4) {
      // should not happen due to earlier check, but keep safe
      recordLogin(uName, false);
      return socket.emit("loginError", "Account creation limit reached (4 per day on this device).");
    }

    const saltRounds = 12;
    rec.passHash = await bcrypt.hash(pass, saltRounds);
    rec.token = newToken();
    rec.status = "online";
    rec.createdAt ||= now();
    rec.lastSeen = now();
    rec.flags.beta = true;

    persistUsers();
    recordLogin(uName, true);
    upsertSession(rec.user, rec.token);
    return sendInitSuccess(rec, { guest: false, firstTime: true });
  });

  // -------------------- disconnect --------------------
  socket.on("disconnect", () => {
    const u = userBySocket.get(socket.id);
    setOffline(socket.id);
    if (u && users[u]) {
      users[u].lastSeen = now();
      persistUsers();
    }
    broadcastOnlineUsers();
  });

  // -------------------- status --------------------
  socket.on("status:set", ({ status }) => {
    if (!requireAuth()) return;
    const s = String(status || "");
    const allowed = new Set(["online", "idle", "dnd", "invisible"]);
    if (!allowed.has(s)) return;

    const u = users[authedUser];
    u.status = s;
    u.lastSeen = now();
    persistUsers();

    emitToUser(authedUser, "status:update", { status: s });
    broadcastOnlineUsers();
  });

  // -------------------- settings --------------------
  socket.on("settings:update", (s) => {
    if (!requireNonGuest()) return;
    const u = users[authedUser];
    u.settings ||= defaultSettings();

    const keys = Object.keys(defaultSettings());
    for (const k of keys) {
      if (typeof s?.[k] === typeof defaultSettings()[k]) u.settings[k] = s[k];
    }

    persistUsers();
    socket.emit("settings", u.settings);
  });

  // -------------------- security endpoints (client analytics) --------------------
  socket.on("security:get", () => {
    if (!requireNonGuest()) return;
    const u = users[authedUser];
    const sec = u.security || { sessions: [], loginHistory: [] };

    socket.emit("security:data", {
      sessions: (sec.sessions || []).map(s => ({ ...s })), // contains token; your client can hide/format
      loginHistory: (sec.loginHistory || []).map(x => ({ ...x })),
    });
  });

  socket.on("security:logoutSession", ({ token }) => {
    if (!requireNonGuest()) return;
    const tok = String(token || "");
    if (!tok) return;
    const u = users[authedUser];
    u.security.sessions = (u.security.sessions || []).filter(s => s.token !== tok);
    if (u.token === tok) u.token = newToken(); // invalidate current too if requested
    persistUsers();
    socket.emit("security:data", {
      sessions: (u.security.sessions || []).map(s => ({ ...s })),
      loginHistory: (u.security.loginHistory || []).map(x => ({ ...x }))
    });
  });

  socket.on("account:changePassword", async ({ oldPass, newPass }) => {
    if (!requireNonGuest()) return;
    const u = users[authedUser];
    const o = String(oldPass || "").trim();
    const n = String(newPass || "").trim();
    if (!isValidPass(o) || !isValidPass(n)) return socket.emit("sendError", { reason: "Invalid password format." });

    const ok = await bcrypt.compare(o, u.passHash).catch(() => false);
    if (!ok) return socket.emit("sendError", { reason: "Old password incorrect." });

    u.passHash = await bcrypt.hash(n, 12);
    u.token = newToken(); // rotate
    upsertSession(u.user, u.token);
    persistUsers();
    socket.emit("account:changed", { ok: true });
  });

  socket.on("account:changeUsername", async ({ newUsername, password }) => {
    if (!requireNonGuest()) return;
    const u = users[authedUser];

    const nu = String(newUsername || "").trim();
    const pw = String(password || "").trim();
    if (!isValidUser(nu)) return socket.emit("sendError", { reason: "New username invalid." });
    if (!isValidPass(pw)) return socket.emit("sendError", { reason: "Password invalid." });
    if (users[nu]) return socket.emit("sendError", { reason: "Username already in use." });

    const ok = await bcrypt.compare(pw, u.passHash).catch(() => false);
    if (!ok) return socket.emit("sendError", { reason: "Password incorrect." });

    // rename key in users
    const old = authedUser;
    const rec = users[old];
    rec.user = nu;

    // Update references across system
    // Friends lists
    for (const otherName of Object.keys(users)) {
      const other = users[otherName];
      if (!other?.social) continue;
      for (const k of ["friends", "incoming", "outgoing", "blocked"]) {
        other.social[k] = (other.social[k] || []).map(x => (x === old ? nu : x));
      }
      // DM stores in each user's map: keys are other usernames
      if (other.dm && other.dm[old]) {
        other.dm[nu] = other.dm[old];
        delete other.dm[old];
      }
      // Inbox message text is not fully rewritten; acceptable for now.
    }

    // Groups: members, owner, perms, cooldown overrides, muted lists, allowlists
    for (const gid of Object.keys(groups)) {
      const g = ensureGroupDefaults(groups[gid]);
      g.members = (g.members || []).map(x => (x === old ? nu : x));
      if (g.owner === old) g.owner = nu;
      g.mutedUsers = (g.mutedUsers || []).map(x => (x === old ? nu : x));
      g.unmutedWhileMutedAll = (g.unmutedWhileMutedAll || []).map(x => (x === old ? nu : x));
      g.perms.invite = (g.perms.invite || []).map(x => (x === old ? nu : x));
      if (g.memberCooldown && Object.prototype.hasOwnProperty.call(g.memberCooldown, old)) {
        g.memberCooldown[nu] = g.memberCooldown[old];
        delete g.memberCooldown[old];
      }
      // Messages keep original author string; leaving as-is is acceptable for now.
    }

    // Move record key
    delete users[old];
    users[nu] = rec;

    // rotate token
    rec.token = newToken();
    upsertSession(rec.user, rec.token);

    persistUsers();
    persistGroups();

    authedUser = nu;
    emitToUser(nu, "account:renamed", { ok: true, username: nu, token: rec.token });
    broadcastOnlineUsers();
  });

  // -------------------- profile --------------------
  socket.on("profile:get", ({ user }) => {
    if (!requireAuth()) return;
    const target = String(user || "");
    const t = users[target];
    if (!t || isGuestName(target) || !t.passHash) {
      return socket.emit("profile:data", { user: target, exists: false, guest: true });
    }
    const level = t.stats?.level || 1;
    socket.emit("profile:data", {
      user: t.user,
      exists: true,
      guest: false,
      createdAt: t.createdAt,
      lastSeen: t.lastSeen || t.createdAt,
      status: t.status || "online",
      messages: t.stats?.messages || 0,
      level,
      xp: t.stats?.xp || 0,
      next: xpNeededForNext(level),
      badges: computeBadges(t)
    });
  });

  function computeBadges(userRec) {
    const out = [];
    // Early user / beta
    if (userRec?.flags?.beta) out.push({ id: "beta", label: "Early User", tone: "gold" });

    const lvl = Number(userRec?.stats?.level || 1);
    if (lvl >= 10) out.push({ id: "lv10", label: "Lv 10", tone: "blue" });
    if (lvl >= 25) out.push({ id: "lv25", label: "Lv 25", tone: "purple" });
    if (lvl >= 50) out.push({ id: "lv50", label: "Lv 50", tone: "red" });
    if (lvl >= 75) out.push({ id: "lv75", label: "Lv 75", tone: "green" });
    if (lvl >= 100) out.push({ id: "lv100", label: "Lv 100", tone: "gold" });

    return out.slice(0, 10);
  }

  // -------------------- leaderboard --------------------
  function getLeaderboard(limit = 25) {
    const arr = Object.values(users)
      .filter(u => u && u.passHash && !isGuestName(u.user))
      .map(u => ({
        user: u.user,
        level: u.stats?.level || 1,
        xp: u.stats?.xp || 0,
        next: xpNeededForNext(u.stats?.level || 1),
        messages: u.stats?.messages || 0
      }));
    arr.sort((a, b) => (b.level - a.level) || (b.xp - a.xp) || a.user.localeCompare(b.user));
    return arr.slice(0, Math.max(5, Math.min(100, limit)));
  }
  socket.on("leaderboard:get", ({ limit }) => {
    if (!requireAuth()) return;
    socket.emit("leaderboard:data", { items: getLeaderboard(Number(limit) || 25) });
  });

  // -------------------- social sync --------------------
  socket.on("social:sync", () => {
    if (!requireNonGuest()) return;
    socket.emit("social:update", users[authedUser].social);
  });

  // Block/unblock
  socket.on("user:block", ({ user }) => {
    if (!requireNonGuest()) return;
    const target = String(user || "");
    if (!users[target] || target === authedUser || isGuestName(target)) return;

    const meRec = users[authedUser];
    meRec.social.blocked ||= [];
    if (!meRec.social.blocked.includes(target)) meRec.social.blocked.push(target);

    meRec.social.friends = (meRec.social.friends || []).filter(x => x !== target);
    meRec.social.incoming = (meRec.social.incoming || []).filter(x => x !== target);
    meRec.social.outgoing = (meRec.social.outgoing || []).filter(x => x !== target);

    persistUsers();
    socket.emit("social:update", meRec.social);
  });

  socket.on("user:unblock", ({ user }) => {
    if (!requireNonGuest()) return;
    const target = String(user || "");
    const meRec = users[authedUser];
    meRec.social.blocked = (meRec.social.blocked || []).filter(x => x !== target);
    persistUsers();
    socket.emit("social:update", meRec.social);
  });

  // Friend requests
  socket.on("friend:request", ({ to }) => {
    if (!requireNonGuest()) return;
    const target = String(to || "");
    if (!users[target] || isGuestName(target) || !users[target].passHash) return socket.emit("sendError", { reason: "User not found." });
    if (target === authedUser) return;

    const meRec = users[authedUser];
    const tRec = users[target];

    if (tRec.settings?.allowFriendRequests === false) return socket.emit("sendError", { reason: "User has friend requests disabled." });
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
      id: nanoid(),
      type: "friend",
      from: authedUser,
      text: `${authedUser} sent you a friend request`,
      ts: now()
    });

    persistUsers();
    socket.emit("social:update", meRec.social);
    emitToUser(target, "social:update", tRec.social);
    emitToUser(target, "inbox:badge", countInbox(tRec));
    emitToUser(target, "inbox:data", { items: tRec.inbox });
  });

  socket.on("friend:accept", ({ from }) => {
    if (!requireNonGuest()) return;
    const src = String(from || "");
    if (!users[src] || !users[src].passHash || isGuestName(src)) return;

    const meRec = users[authedUser];
    const sRec = users[src];

    meRec.social.incoming = (meRec.social.incoming || []).filter(x => x !== src);
    sRec.social.outgoing = (sRec.social.outgoing || []).filter(x => x !== authedUser);

    meRec.social.friends ||= [];
    sRec.social.friends ||= [];
    if (!meRec.social.friends.includes(src)) meRec.social.friends.push(src);
    if (!sRec.social.friends.includes(authedUser)) sRec.social.friends.push(authedUser);

    meRec.inbox = (meRec.inbox || []).filter(it => !(it.type === "friend" && it.from === src));

    persistUsers();
    socket.emit("social:update", meRec.social);
    emitToUser(src, "social:update", sRec.social);

    socket.emit("inbox:badge", countInbox(meRec));
    socket.emit("inbox:data", { items: meRec.inbox });
  });

  socket.on("friend:decline", ({ from }) => {
    if (!requireNonGuest()) return;
    const src = String(from || "");
    if (!users[src] || !users[src].passHash || isGuestName(src)) return;

    const meRec = users[authedUser];
    const sRec = users[src];

    meRec.social.incoming = (meRec.social.incoming || []).filter(x => x !== src);
    sRec.social.outgoing = (sRec.social.outgoing || []).filter(x => x !== authedUser);
    meRec.inbox = (meRec.inbox || []).filter(it => !(it.type === "friend" && it.from === src));

    persistUsers();
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

  // -------------------- global chat --------------------
  socket.on("requestGlobalHistory", () => {
    socket.emit("history", globalHistory);
  });

  socket.on("sendGlobal", ({ text }) => {
    if (!requireAuth()) return;
    const t = String(text || "").trim();
    if (!t || t.length > 1200) return;

    const r = globalRate.get(authedUser) || { nextAllowed: 0, recent: [], lastMsgNorm: "", lastLinkAt: 0, lastMentionAt: 0, shadowMuteUntil: 0 };
    globalRate.set(authedUser, r);

    // Shadow mute logic
    if (r.shadowMuteUntil && now() < r.shadowMuteUntil) {
      // silently allow but only echo back to sender
      const msg = { user: authedUser, text: t, ts: now() };
      socket.emit("globalMessage", msg);
      return;
    }

    // Severe content => shadow mute + do not broadcast + do not store
    if (isSevereBad(t)) {
      r.shadowMuteUntil = now() + SHADOW_MUTE_MS;
      globalRate.set(authedUser, r);

      // echo only
      const msg = { user: authedUser, text: t, ts: now() };
      socket.emit("globalMessage", msg);
      socket.emit("warn", { kind: "shadow", text: "Message not delivered." });
      return;
    }

    // Link rules
    if (containsUrl(t)) {
      if (!canPostLink(authedUser)) {
        return socket.emit("sendError", { reason: "Link cooldown: you can post one link every 5 minutes." });
      }
      const urls = extractUrls(t);
      for (const u of urls) {
        if (BLOCKED_LINK_RX.test(u)) {
          r.shadowMuteUntil = now() + SHADOW_MUTE_MS;
          globalRate.set(authedUser, r);
          socket.emit("warn", { kind: "shadow", text: "Message not delivered." });
          // echo only
          socket.emit("globalMessage", { user: authedUser, text: t, ts: now() });
          return;
        }
      }
      r.lastLinkAt = now();
    }

    // Repeat warning (same message twice)
    const nm = normMsg(t);
    if (nm && nm === r.lastMsgNorm) {
      socket.emit("warn", { kind: "repeat", text: "Don’t repeat the same message." });
    }
    r.lastMsgNorm = nm;

    // mention anti-spam: cap mentions per message, and rate-limit mention-bearing messages
    const mentions = extractMentions(t).slice(0, 6);
    const hasMentions = mentions.length > 0;
    if (hasMentions) {
      if (!canMention(authedUser)) {
        return socket.emit("sendError", { reason: "Slow down on mentions." });
      }
      r.lastMentionAt = now();
    }

    // Dynamic cooldown
    const cd = currentCooldownForUser(authedUser);
    if (now() < (r.nextAllowed || 0)) {
      const left = Math.max(0, (r.nextAllowed - now()) / 1000);
      sendCooldown();
      return socket.emit("sendError", { reason: `Cooldown active (${left.toFixed(1)}s left).` });
    }

    r.nextAllowed = now() + cd * 1000;
    touchGlobalSend(authedUser);
    sendCooldown();

    const msg = { user: authedUser, text: t, ts: now() };
    pushGlobalMessage(msg);

    // stats
    if (requireNonGuest()) {
      const xpInfo = awardXP(authedUser, 6);
      if (xpInfo) emitToUser(authedUser, "me:stats", xpInfo);
    }
    users[authedUser].lastSeen = now();
    persistUsers();

    io.emit("globalMessage", msg);

    // mentions -> inbox
    for (const m of mentions) {
      if (!users[m] || m === authedUser || !users[m].passHash || isGuestName(m)) continue;
      const rec = users[m];
      if ((rec.social?.blocked || []).includes(authedUser)) continue;

      addInboxItem(m, {
        id: nanoid(),
        type: "mention",
        from: authedUser,
        text: `Mentioned you in #global: ${t.slice(0, 160)}`,
        ts: now(),
        meta: { scope: "global" }
      });
      emitToUser(m, "inbox:badge", countInbox(rec));
      emitToUser(m, "inbox:data", { items: rec.inbox });
    }
  });

  // -------------------- DM --------------------
  socket.on("dm:history", ({ withUser }) => {
    if (!requireNonGuest()) return;
    const other = String(withUser || "");
    if (!users[other] || !users[other].passHash || isGuestName(other)) return socket.emit("dm:history", { withUser: other, msgs: [] });

    const meRec = users[authedUser];
    const otherRec = users[other];

    // must be friends to DM
    const friends = new Set(meRec.social?.friends || []);
    if (!friends.has(other)) return socket.emit("dm:history", { withUser: other, msgs: [] });

    if ((meRec.social?.blocked || []).includes(other)) return socket.emit("dm:history", { withUser: other, msgs: [] });
    if ((otherRec.social?.blocked || []).includes(authedUser)) return socket.emit("dm:history", { withUser: other, msgs: [] });

    socket.emit("dm:history", { withUser: other, msgs: ensureDMStore(authedUser, other) });
  });

  socket.on("dm:send", ({ to, text }) => {
    if (!requireNonGuest()) return;
    const other = String(to || "");
    const t = String(text || "").trim();
    if (!t || t.length > 1200) return;
    if (!users[other] || !users[other].passHash || isGuestName(other)) return;

    const meRec = users[authedUser];
    const otherRec = users[other];

    // must be friends to DM
    const friends = new Set(meRec.social?.friends || []);
    if (!friends.has(other)) return socket.emit("sendError", { reason: "You must be friends to DM." });

    if ((meRec.social?.blocked || []).includes(other)) return;
    if ((otherRec.social?.blocked || []).includes(authedUser)) return;

    // Shadow mute severe content
    const r = globalRate.get(authedUser) || {};
    if (r.shadowMuteUntil && now() < r.shadowMuteUntil) {
      // only echo back
      socket.emit("dm:message", { from: other, msg: { user: authedUser, text: t, ts: now() } });
      return;
    }
    if (isSevereBad(t)) {
      r.shadowMuteUntil = now() + SHADOW_MUTE_MS;
      globalRate.set(authedUser, r);
      socket.emit("warn", { kind: "shadow", text: "Message not delivered." });
      socket.emit("dm:message", { from: other, msg: { user: authedUser, text: t, ts: now() } });
      return;
    }

    // Link rules
    if (containsUrl(t)) {
      if (!canPostLink(authedUser)) return socket.emit("sendError", { reason: "Link cooldown: one link every 5 minutes." });
      const urls = extractUrls(t);
      for (const u of urls) {
        if (BLOCKED_LINK_RX.test(u)) {
          r.shadowMuteUntil = now() + SHADOW_MUTE_MS;
          globalRate.set(authedUser, r);
          socket.emit("warn", { kind: "shadow", text: "Message not delivered." });
          socket.emit("dm:message", { from: other, msg: { user: authedUser, text: t, ts: now() } });
          return;
        }
      }
      r.lastLinkAt = now();
      globalRate.set(authedUser, r);
    }

    // repeat warning
    const dmKey = `dm:${other}`;
    const last = meRec._lastMsgByScope || {};
    const nm = normMsg(t);
    if (nm && last[dmKey] && last[dmKey] === nm) socket.emit("warn", { kind: "repeat", text: "Don’t repeat the same message." });
    last[dmKey] = nm;
    meRec._lastMsgByScope = last;

    const msg = { user: authedUser, text: t, ts: now() };
    pushDM(authedUser, other, msg);

    const xpInfo = awardXP(authedUser, 4);
    if (xpInfo) emitToUser(authedUser, "me:stats", xpInfo);

    users[authedUser].lastSeen = now();
    persistUsers();

    emitToUser(other, "dm:message", { from: authedUser, msg });
    socket.emit("dm:message", { from: other, msg });

    // mentions -> inbox
    const mentions = extractMentions(t).slice(0, 6);
    if (mentions.length) {
      const rr = globalRate.get(authedUser) || {};
      if (!canMention(authedUser)) return; // silent drop mentions, message still sent
      rr.lastMentionAt = now();
      globalRate.set(authedUser, rr);
    }

    for (const m of mentions) {
      if (!users[m] || m === authedUser || !users[m].passHash || isGuestName(m)) continue;
      const rec = users[m];
      if ((rec.social?.blocked || []).includes(authedUser)) continue;

      addInboxItem(m, {
        id: nanoid(),
        type: "mention",
        from: authedUser,
        text: `Mentioned you in a DM: ${t.slice(0, 160)}`,
        ts: now(),
        meta: { scope: "dm", with: other }
      });
      emitToUser(m, "inbox:badge", countInbox(rec));
      emitToUser(m, "inbox:data", { items: rec.inbox });
    }
  });

  // -------------------- groups: list + discover --------------------
  socket.on("groups:list", () => {
    if (!requireNonGuest()) return;
    const list = Object.values(groups)
      .map(ensureGroupDefaults)
      .filter(g => Array.isArray(g.members) && g.members.includes(authedUser))
      .map(groupPublic)
      .sort((a, b) => a.name.localeCompare(b.name));
    socket.emit("groups:list", list);
  });

  socket.on("groups:discover", () => {
    if (!requireNonGuest()) return;
    const items = Object.values(groups)
      .map(ensureGroupDefaults)
      .filter(g => g.privacy === "public")
      .map(g => ({
        id: g.id,
        name: g.name,
        owner: g.owner,
        members: (g.members || []).length
      }))
      .sort((a, b) => (b.members - a.members) || a.name.localeCompare(b.name))
      .slice(0, 80);

    socket.emit("groups:discover:data", { items });
  });

  // Create group
  socket.on("group:createRequest", ({ name, invites, privacy }) => {
    if (!requireNonGuest()) return;

    const groupName = String(name || "").trim() || "group";
    const priv = (privacy === "public") ? "public" : "private";

    const rawInv = Array.isArray(invites) ? invites : [];
    const uniq = Array.from(new Set(rawInv.map(x => String(x || "").trim()).filter(Boolean))).slice(0, 50);

    // invites must be valid + real + non-guest + friends with creator + target allows group invites
    const meRec = users[authedUser];
    const myFriends = new Set(meRec.social?.friends || []);

    for (const u of uniq) {
      if (!isValidUser(u) || !users[u] || !users[u].passHash || isGuestName(u)) return socket.emit("sendError", { reason: "Invalid invite list." });
      if (!myFriends.has(u)) return socket.emit("sendError", { reason: "You can only invite friends to a group." });
      if (users[u].settings?.allowGroupInvites === false) return socket.emit("sendError", { reason: `User ${u} has group invites disabled.` });
    }

    const gid = `grp_${nanoid(12)}`;
    groups[gid] = ensureGroupDefaults({
      id: gid,
      name: groupName.slice(0, 32),
      owner: authedUser,
      privacy: priv,
      members: [authedUser],
      invites: [],
      createdAt: now(),
      messages: [],
      joinRequests: [],
      cooldownSec: 2.5,
      cooldownEnabled: true,
      mutedAll: false,
      mutedUsers: [],
      unmutedWhileMutedAll: [],
      perms: { invite: [] },
      memberCooldown: {}
    });

    // send invites into inbox
    for (const u of uniq) {
      const invId = `inv_${nanoid(12)}`;
      groups[gid].invites.push({ id: invId, to: u, from: authedUser, ts: now() });

      addInboxItem(u, {
        id: invId,
        type: "group",
        from: authedUser,
        text: `Invited you to “${groups[gid].name}”`,
        ts: now(),
        meta: { groupId: gid, name: groups[gid].name }
      });

      const rec = users[u];
      emitToUser(u, "inbox:badge", countInbox(rec));
      emitToUser(u, "inbox:data", { items: rec.inbox });
    }

    persistGroups();
    socket.emit("groups:list", Object.values(groups).map(ensureGroupDefaults).filter(g => g.members.includes(authedUser)).map(groupPublic));
    socket.emit("group:meta", { groupId: gid, meta: groupPublic(groups[gid]) });
  });

  // Join public group
  socket.on("group:joinPublic", ({ groupId }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const g = groups[gid];
    if (!g) return;
    ensureGroupDefaults(g);

    if (g.privacy !== "public") return socket.emit("sendError", { reason: "This group is not public." });
    if ((g.members || []).length >= 200) return socket.emit("sendError", { reason: "Group is full (200 cap)." });

    if (!g.members.includes(authedUser)) g.members.push(authedUser);

    persistGroups();
    const meta = groupPublic(g);
    for (const m of g.members) emitToUser(m, "group:meta", { groupId: g.id, meta });

    socket.emit("groups:list", Object.values(groups).map(ensureGroupDefaults).filter(x => x.members.includes(authedUser)).map(groupPublic));
  });

  // Accept/decline group invite
  socket.on("groupInvite:accept", ({ id }) => {
    if (!requireNonGuest()) return;
    const inviteId = String(id || "");
    let gFound = null;

    for (const g of Object.values(groups)) {
      ensureGroupDefaults(g);
      const inv = (g.invites || []).find(x => x.id === inviteId && x.to === authedUser);
      if (inv) { gFound = g; break; }
    }
    if (!gFound) return;

    if ((gFound.members || []).length >= 200) return socket.emit("sendError", { reason: "Group is full (200 cap)." });

    if (!gFound.members.includes(authedUser)) gFound.members.push(authedUser);
    gFound.invites = (gFound.invites || []).filter(x => x.id !== inviteId);

    const meRec = users[authedUser];
    meRec.inbox = (meRec.inbox || []).filter(it => it.id !== inviteId);

    persistUsers();
    persistGroups();

    const meta = groupPublic(gFound);
    for (const m of gFound.members) emitToUser(m, "group:meta", { groupId: gFound.id, meta });

    socket.emit("inbox:badge", countInbox(meRec));
    socket.emit("inbox:data", { items: meRec.inbox });
    socket.emit("groups:list", Object.values(groups).map(ensureGroupDefaults).filter(g => g.members.includes(authedUser)).map(groupPublic));
  });

  socket.on("groupInvite:decline", ({ id }) => {
    if (!requireNonGuest()) return;
    const inviteId = String(id || "");

    let gFound = null;
    for (const g of Object.values(groups)) {
      ensureGroupDefaults(g);
      const inv = (g.invites || []).find(x => x.id === inviteId && x.to === authedUser);
      if (inv) { gFound = g; break; }
    }
    if (!gFound) return;

    gFound.invites = (gFound.invites || []).filter(x => x.id !== inviteId);
    const meRec = users[authedUser];
    meRec.inbox = (meRec.inbox || []).filter(it => it.id !== inviteId);

    persistUsers();
    persistGroups();
    socket.emit("inbox:badge", countInbox(meRec));
    socket.emit("inbox:data", { items: meRec.inbox });
  });

  // Group history
  socket.on("group:history", ({ groupId }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const g = groups[gid];
    if (!g) return;
    ensureGroupDefaults(g);
    if (!g.members.includes(authedUser)) return;

    socket.emit("group:history", { groupId: gid, meta: groupPublic(g), msgs: g.messages });
  });

  // Group send
  socket.on("group:send", ({ groupId, text }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const g = groups[gid];
    if (!g) return;
    ensureGroupDefaults(g);
    if (!g.members.includes(authedUser)) return;

    const t = String(text || "").trim();
    if (!t || t.length > 1200) return;

    // Shadow mute severe content
    const r = globalRate.get(authedUser) || {};
    if (r.shadowMuteUntil && now() < r.shadowMuteUntil) {
      socket.emit("group:message", { groupId: gid, msg: { user: authedUser, text: t, ts: now() } });
      return;
    }
    if (isSevereBad(t)) {
      r.shadowMuteUntil = now() + SHADOW_MUTE_MS;
      globalRate.set(authedUser, r);
      socket.emit("warn", { kind: "shadow", text: "Message not delivered." });
      socket.emit("group:message", { groupId: gid, msg: { user: authedUser, text: t, ts: now() } });
      return;
    }

    // Link rules
    if (containsUrl(t)) {
      if (!canPostLink(authedUser)) return socket.emit("sendError", { reason: "Link cooldown: one link every 5 minutes." });
      const urls = extractUrls(t);
      for (const u of urls) {
        if (BLOCKED_LINK_RX.test(u)) {
          r.shadowMuteUntil = now() + SHADOW_MUTE_MS;
          globalRate.set(authedUser, r);
          socket.emit("warn", { kind: "shadow", text: "Message not delivered." });
          socket.emit("group:message", { groupId: gid, msg: { user: authedUser, text: t, ts: now() } });
          return;
        }
      }
      r.lastLinkAt = now();
      globalRate.set(authedUser, r);
    }

    // mute rules
    if (g.owner !== authedUser) {
      if ((g.mutedUsers || []).includes(authedUser)) return socket.emit("sendError", { reason: "You are muted in this group." });

      if (g.mutedAll) {
        const allow = (g.unmutedWhileMutedAll || []).includes(authedUser);
        if (!allow) return socket.emit("sendError", { reason: "Group is muted by the owner." });
      }
    }

    // repeat warning
    const meRec = users[authedUser];
    const last = meRec._lastMsgByScope || {};
    const nm = normMsg(t);
    const scopeKey = `grp:${gid}`;
    if (nm && last[scopeKey] && last[scopeKey] === nm) socket.emit("warn", { kind: "repeat", text: "Don’t repeat the same message." });
    last[scopeKey] = nm;
    meRec._lastMsgByScope = last;

    // mentions anti-spam
    const mentions = extractMentions(t).slice(0, 6);
    if (mentions.length) {
      if (!canMention(authedUser)) return socket.emit("sendError", { reason: "Slow down on mentions." });
      const rr = globalRate.get(authedUser) || {};
      rr.lastMentionAt = now();
      globalRate.set(authedUser, rr);
    }

    // group cooldown
    const cdDefault = Math.max(0, Math.min(10, Number(g.cooldownSec || 2.5)));
    const cdEnabled = (g.cooldownEnabled !== false);
    const override = Number(g.memberCooldown?.[authedUser]);
    const cd = Number.isFinite(override) ? Math.max(0, Math.min(10, override)) : cdDefault;

    if (cdEnabled && cd > 0) {
      const k = groupKey(gid, authedUser);
      const nextAllowed = groupRate.get(k) || 0;
      if (now() < nextAllowed) {
        const left = ((nextAllowed - now()) / 1000).toFixed(1);
        return socket.emit("sendError", { reason: `Group cooldown active (${left}s left).` });
      }
      groupRate.set(k, now() + cd * 1000);
    }

    const msg = { user: authedUser, text: t, ts: now() };
    g.messages ||= [];
    g.messages.push(msg);
    if (g.messages.length > 420) g.messages.shift();

    persistGroups();

    const xpInfo = awardXP(authedUser, 5);
    if (xpInfo) emitToUser(authedUser, "me:stats", xpInfo);

    users[authedUser].lastSeen = now();
    persistUsers();

    for (const m of g.members) emitToUser(m, "group:message", { groupId: gid, msg });

    // mentions -> inbox
    for (const m of mentions) {
      if (!users[m] || m === authedUser || !users[m].passHash || isGuestName(m)) continue;
      const rec = users[m];
      if ((rec.social?.blocked || []).includes(authedUser)) continue;

      addInboxItem(m, {
        id: nanoid(),
        type: "mention",
        from: authedUser,
        text: `Mentioned you in “${g.name}”: ${t.slice(0, 160)}`,
        ts: now(),
        meta: { scope: "group", groupId: gid, name: g.name }
      });
      emitToUser(m, "inbox:badge", countInbox(rec));
      emitToUser(m, "inbox:data", { items: rec.inbox });
    }
  });

  // -------------------- group management (owner tools) --------------------
  function requireOwner(g) {
    return g && g.owner === authedUser;
  }

  socket.on("group:settings", ({ groupId, cooldownSec, enabled }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const g = groups[gid];
    if (!g) return;
    ensureGroupDefaults(g);
    if (!requireOwner(g)) return;

    if (typeof enabled === "boolean") g.cooldownEnabled = enabled;

    const v = Number(cooldownSec);
    if (Number.isFinite(v)) g.cooldownSec = Math.max(0, Math.min(10, v));

    persistGroups();
    const meta = groupPublic(g);
    for (const m of g.members) emitToUser(m, "group:meta", { groupId: gid, meta });
  });

  socket.on("group:memberCooldown", ({ groupId, user, seconds }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const target = String(user || "").trim();
    const g = groups[gid];
    if (!g) return;
    ensureGroupDefaults(g);
    if (!requireOwner(g)) return;
    if (!g.members.includes(target)) return;

    g.memberCooldown ||= {};
    if (seconds === null) {
      delete g.memberCooldown[target];
    } else {
      const v = Number(seconds);
      if (!Number.isFinite(v)) return;
      g.memberCooldown[target] = Math.max(0, Math.min(10, v));
    }

    persistGroups();
    const meta = groupPublic(g);
    for (const m of g.members) emitToUser(m, "group:meta", { groupId: gid, meta });
  });

  socket.on("group:muteAll", ({ groupId, on }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const g = groups[gid];
    if (!g) return;
    ensureGroupDefaults(g);
    if (!requireOwner(g)) return;

    g.mutedAll = !!on;
    if (!g.mutedAll) g.unmutedWhileMutedAll = []; // reset allowlist when turning off
    persistGroups();

    const meta = groupPublic(g);
    for (const m of g.members) emitToUser(m, "group:meta", { groupId: gid, meta });
  });

  socket.on("group:muteUser", ({ groupId, user, on }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const target = String(user || "").trim();
    const g = groups[gid];
    if (!g) return;
    ensureGroupDefaults(g);
    if (!requireOwner(g)) return;
    if (!g.members.includes(target)) return;
    if (target === g.owner) return;

    g.mutedUsers ||= [];
    g.unmutedWhileMutedAll ||= [];

    if (on) {
      if (!g.mutedUsers.includes(target)) g.mutedUsers.push(target);
      // remove from allowlist
      g.unmutedWhileMutedAll = (g.unmutedWhileMutedAll || []).filter(x => x !== target);
    } else {
      g.mutedUsers = (g.mutedUsers || []).filter(x => x !== target);
      // If mutedAll is ON, unmuting can add to allowlist
      if (g.mutedAll && !g.unmutedWhileMutedAll.includes(target)) g.unmutedWhileMutedAll.push(target);
    }

    persistGroups();
    const meta = groupPublic(g);
    for (const m of g.members) emitToUser(m, "group:meta", { groupId: gid, meta });
  });

  socket.on("group:rename", ({ groupId, name }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const g = groups[gid];
    if (!g) return;
    ensureGroupDefaults(g);
    if (!requireOwner(g)) return;

    const n = String(name || "").trim();
    if (!n) return;
    g.name = n.slice(0, 32);

    persistGroups();
    const meta = groupPublic(g);
    for (const m of g.members) emitToUser(m, "group:meta", { groupId: gid, meta });
  });

  socket.on("group:transfer", ({ groupId, to }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const target = String(to || "").trim();
    const g = groups[gid];
    if (!g) return;
    ensureGroupDefaults(g);
    if (!requireOwner(g)) return;
    if (!g.members.includes(target)) return;

    g.owner = target;

    persistGroups();
    const meta = groupPublic(g);
    for (const m of g.members) emitToUser(m, "group:meta", { groupId: gid, meta });
  });

  socket.on("group:permInvite", ({ groupId, user, on }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const target = String(user || "").trim();
    const g = groups[gid];
    if (!g) return;
    ensureGroupDefaults(g);
    if (!requireOwner(g)) return;
    if (!g.members.includes(target)) return;

    g.perms ||= { invite: [] };
    g.perms.invite ||= [];
    if (!!on) {
      if (!g.perms.invite.includes(target) && target !== g.owner) g.perms.invite.push(target);
    } else {
      g.perms.invite = (g.perms.invite || []).filter(x => x !== target);
    }

    persistGroups();
    const meta = groupPublic(g);
    for (const m of g.members) emitToUser(m, "group:meta", { groupId: gid, meta });
  });

  // Invite member (owner OR someone with invite permission). Must be friend with inviter.
  socket.on("group:invite", ({ groupId, user }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const target = String(user || "").trim();
    const g = groups[gid];
    if (!g) return;
    ensureGroupDefaults(g);

    const isOwner = g.owner === authedUser;
    const canInvite = isOwner || (g.perms?.invite || []).includes(authedUser);
    if (!canInvite) return socket.emit("sendError", { reason: "No permission to invite." });

    if (!isValidUser(target) || !users[target] || !users[target].passHash || isGuestName(target)) return socket.emit("sendError", { reason: "User not found." });
    if (g.members.includes(target)) return socket.emit("sendError", { reason: "User already in group." });
    if ((g.members || []).length >= 200) return socket.emit("sendError", { reason: "Group is full (200 cap)." });

    // inviter must be friends with target
    const inviter = users[authedUser];
    const myFriends = new Set(inviter.social?.friends || []);
    if (!myFriends.has(target)) return socket.emit("sendError", { reason: "You can only invite friends." });

    const tRec = users[target];
    if (tRec.settings?.allowGroupInvites === false) return socket.emit("sendError", { reason: "User has group invites disabled." });

    const invId = `inv_${nanoid(12)}`;
    g.invites.push({ id: invId, to: target, from: authedUser, ts: now() });

    addInboxItem(target, {
      id: invId,
      type: "group",
      from: authedUser,
      text: `Invited you to “${g.name}”`,
      ts: now(),
      meta: { groupId: gid, name: g.name }
    });

    persistGroups();
    emitToUser(target, "inbox:badge", countInbox(tRec));
    emitToUser(target, "inbox:data", { items: tRec.inbox });
  });

  // Remove member (owner)
  socket.on("group:removeMember", ({ groupId, user }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const target = String(user || "").trim();
    const g = groups[gid];
    if (!g) return;
    ensureGroupDefaults(g);
    if (!requireOwner(g)) return;
    if (!g.members.includes(target)) return;
    if (target === g.owner) return;

    g.members = (g.members || []).filter(x => x !== target);
    g.mutedUsers = (g.mutedUsers || []).filter(x => x !== target);
    g.unmutedWhileMutedAll = (g.unmutedWhileMutedAll || []).filter(x => x !== target);
    g.perms.invite = (g.perms.invite || []).filter(x => x !== target);
    if (g.memberCooldown) delete g.memberCooldown[target];

    persistGroups();

    // notify removed user
    emitToUser(target, "group:left", { groupId: gid });

    const meta = groupPublic(g);
    for (const m of g.members) emitToUser(m, "group:meta", { groupId: gid, meta });
    socket.emit("groups:list", Object.values(groups).map(ensureGroupDefaults).filter(x => x.members.includes(authedUser)).map(groupPublic));
  });

  // Leave / delete
  socket.on("group:leave", ({ groupId }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const g = groups[gid];
    if (!g) return;
    ensureGroupDefaults(g);
    if (!g.members.includes(authedUser)) return;

    if (g.owner === authedUser) {
      const members = [...g.members];
      delete groups[gid];
      persistGroups();
      for (const m of members) {
        emitToUser(m, "group:deleted", { groupId: gid });
        emitToUser(m, "groups:list", Object.values(groups).map(ensureGroupDefaults).filter(x => x.members.includes(m)).map(groupPublic));
      }
      return;
    }

    g.members = g.members.filter(x => x !== authedUser);
    g.perms.invite = (g.perms.invite || []).filter(x => x !== authedUser);
    if (g.memberCooldown) delete g.memberCooldown[authedUser];

    persistGroups();

    const meta = groupPublic(g);
    for (const m of g.members) emitToUser(m, "group:meta", { groupId: gid, meta });

    socket.emit("group:left", { groupId: gid });
    socket.emit("groups:list", Object.values(groups).map(ensureGroupDefaults).filter(x => x.members.includes(authedUser)).map(groupPublic));
  });

  socket.on("group:delete", ({ groupId }) => {
    if (!requireNonGuest()) return;
    const gid = String(groupId || "");
    const g = groups[gid];
    if (!g) return;
    ensureGroupDefaults(g);
    if (!requireOwner(g)) return;

    const members = [...g.members];
    delete groups[gid];
    persistGroups();

    for (const m of members) {
      emitToUser(m, "group:deleted", { groupId: gid });
      emitToUser(m, "groups:list", Object.values(groups).map(ensureGroupDefaults).filter(x => x.members.includes(m)).map(groupPublic));
    }
  });

  // -------------------- inbox mention clear (keep, but your client can hide the button) --------------------
  socket.on("inbox:clearMentions", () => {
    if (!requireNonGuest()) return;
    const u = users[authedUser];
    u.inbox = (u.inbox || []).filter(it => it.type !== "mention");
    persistUsers();
    socket.emit("inbox:badge", countInbox(u));
    socket.emit("inbox:data", { items: u.inbox });
  });

  // -------------------- generic sendError hook --------------------
  socket.on("sendErrorAck", () => {});
});

// -------------------- boot --------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
