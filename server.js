// server.js — tonkotsu.online backend (Express + Socket.IO)
// - REST API expected by public/script.js
// - Socket events compatible with both old + new client event names
// - Strict auth: first login creates account, then password must match
// - Discord webhook logs: every login + every global message (global is public + logged)
// - Shadow-mute for prohibited content (user sees own msg, others do not; logged)
// - Link rules: block 18+ domains/keywords; 1 link per 5 minutes (server enforced)
// - Cooldowns: guests 5s, users ~3s (level-based + spam penalty)
// - /status page (public)
//
// IMPORTANT (Render):
// Set Environment variable: DISCORD_WEBHOOK_URL
// Do NOT hardcode your webhook in code.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");

/* ------------------------------ Runtime Info ------------------------------ */

const STARTED_AT = Date.now();
const PORT = process.env.PORT || 3000;

/* ------------------------------ Discord Webhook --------------------------- */

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function discordContentSafe(s) {
  let t = String(s || "");
  t = t.replace(/@everyone/g, "@\u200Beveryone").replace(/@here/g, "@\u200Bhere");
  if (t.length > 1800) t = t.slice(0, 1800) + "…";
  return t;
}

// Simple paced queue to avoid rate-limit chaos.
const webhookQueue = [];
let webhookBusy = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function enqueueWebhook(payload) {
  if (!DISCORD_WEBHOOK_URL) return;
  webhookQueue.push(payload);
  if (!webhookBusy) void drainWebhookQueue();
}

async function drainWebhookQueue() {
  webhookBusy = true;
  while (webhookQueue.length) {
    const payload = webhookQueue.shift();
    try {
      await postWebhook(payload);
    } catch {
      // Drop on failure (non-blocking)
    }
    await sleep(350);
  }
  webhookBusy = false;
}

async function postWebhook(payload) {
  if (!DISCORD_WEBHOOK_URL) return;

  // Node 18+ has fetch. If missing, use https fallback.
  if (typeof fetch === "function") {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.status === 429) {
      let retryMs = 1500;
      try {
        const data = await res.json();
        if (typeof data?.retry_after === "number") retryMs = Math.ceil(data.retry_after * 1000);
      } catch {}
      await sleep(Math.min(15000, Math.max(500, retryMs)));
      webhookQueue.unshift(payload);
      return;
    }
    return;
  }

  // Very small https fallback
  const https = require("https");
  await new Promise((resolve) => {
    try {
      const u = new URL(DISCORD_WEBHOOK_URL);
      const body = Buffer.from(JSON.stringify(payload));
      const req = https.request(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": body.length,
          },
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", resolve);
        }
      );
      req.on("error", resolve);
      req.write(body);
      req.end();
    } catch {
      resolve();
    }
  });
}

function discordSendEmbed({ title, description, fields = [], footer, color } = {}) {
  const embed = {
    title: String(title || "").slice(0, 256),
    description: String(description || "").slice(0, 4096),
    fields: (fields || [])
      .slice(0, 25)
      .map((f) => ({
        name: String(f.name || "").slice(0, 256),
        value: String(f.value || "").slice(0, 1024),
        inline: !!f.inline,
      })),
  };
  if (footer) embed.footer = { text: String(footer).slice(0, 2048) };
  if (typeof color === "number") embed.color = color;
  enqueueWebhook({ embeds: [embed] });
}

function discordSendText(content) {
  enqueueWebhook({ content: discordContentSafe(content) });
}

/* ------------------------------ Storage (JSON) ----------------------------- */

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

let users = readJson(USERS_FILE, {});
let groups = readJson(GROUPS_FILE, {});
let globalHistory = readJson(GLOBAL_FILE, []);
let deviceCreations = readJson(DEVICE_CREATE_FILE, {});

function persistUsers() {
  writeJson(USERS_FILE, users);
}
function persistGroups() {
  writeJson(GROUPS_FILE, groups);
}
function persistGlobal() {
  writeJson(GLOBAL_FILE, globalHistory);
}
function persistDeviceCreations() {
  writeJson(DEVICE_CREATE_FILE, deviceCreations);
}

function now() {
  return Date.now();
}
function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/* ------------------------------ Validation -------------------------------- */

function isValidUser(u) {
  return /^[A-Za-z0-9]{4,20}$/.test(String(u || "").trim());
}
function isValidPass(p) {
  return /^[A-Za-z0-9]{4,32}$/.test(String(p || "").trim());
}
function isGuestName(u) {
  return /^Guest\d{4,5}$/.test(String(u || ""));
}

/* ------------------------------ Device Limits ------------------------------ */

function deviceKeyFromReq(req) {
  const xf = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(xf) ? xf[0] : xf || req.socket.remoteAddress || "").split(",")[0].trim();
  const ua = String(req.headers["user-agent"] || "");
  return sha256(`${ip}::${ua}`).slice(0, 32);
}

function deviceKeyFromSocket(socket) {
  const xf = socket.handshake.headers["x-forwarded-for"];
  const ip = (Array.isArray(xf) ? xf[0] : xf || socket.handshake.address || "").split(",")[0].trim();
  const ua = String(socket.handshake.headers["user-agent"] || "");
  return sha256(`${ip}::${ua}`).slice(0, 32);
}

function bumpDeviceCreationLimit(deviceKey) {
  const today = dayKey();
  const rec = deviceCreations[deviceKey] || { day: today, count: 0 };
  if (rec.day !== today) {
    rec.day = today;
    rec.count = 0;
  }
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

/* ------------------------------ User Model -------------------------------- */

function defaultSettings() {
  return {
    sounds: true,
    hideMildProfanity: false,
    allowFriendRequests: true,
    allowGroupInvites: true,
    customCursor: true,
    mobileUX: false,
    autoLogin: false, // optional: can be toggled by client later
  };
}

function defaultSocial() {
  return {
    friends: [],
    incoming: [],
    outgoing: [],
    blocked: [],
    blockedMeta: {}, // username -> ts
  };
}

function defaultStats() {
  return { messages: 0, xp: 0, level: 1 };
}

function xpNeededForNext(level) {
  const L = Math.max(1, Number(level) || 1);
  return Math.floor(120 + L * 65 + L * L * 12);
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
  return {
    leveled,
    level: u.stats.level,
    xp: u.stats.xp,
    next: xpNeededForNext(u.stats.level),
    messages: u.stats.messages,
  };
}

function ensureUser(username) {
  if (!users[username]) {
    users[username] = {
      user: username,
      createdAt: now(),
      lastSeen: now(),
      passHash: null,
      token: null, // current token (for simple auth)
      status: "online",
      settings: defaultSettings(),
      social: defaultSocial(),
      inbox: [],
      stats: defaultStats(),
      dm: {},
      security: {
        sessions: [], // [{token, createdAt, lastSeen, ipHash, uaHash}]
        loginHistory: [], // [{ts, ipHash, uaHash, ok}]
        events: [], // [{ts, type, detail}]
      },
      flags: { beta: true },
    };
  }

  const u = users[username];
  u.settings ||= defaultSettings();
  u.social ||= defaultSocial();
  u.inbox ||= [];
  u.stats ||= defaultStats();
  u.dm ||= {};
  u.security ||= { sessions: [], loginHistory: [], events: [] };
  u.flags ||= { beta: true };

  // backfill defaults
  const d = defaultSettings();
  for (const k of Object.keys(d)) {
    if (typeof u.settings[k] !== typeof d[k]) u.settings[k] = d[k];
  }
  const soc = defaultSocial();
  for (const k of Object.keys(soc)) {
    if (k === "blockedMeta") {
      if (typeof u.social.blockedMeta !== "object" || !u.social.blockedMeta) u.social.blockedMeta = {};
      continue;
    }
    if (!Array.isArray(u.social[k])) u.social[k] = [];
  }
  if (typeof u.social.blockedMeta !== "object" || !u.social.blockedMeta) u.social.blockedMeta = {};

  if (!Array.isArray(u.security.sessions)) u.security.sessions = [];
  if (!Array.isArray(u.security.loginHistory)) u.security.loginHistory = [];
  if (!Array.isArray(u.security.events)) u.security.events = [];

  return u;
}

function safeUserForClient(u) {
  return {
    username: u.user,
    id: sha256(u.user).slice(0, 12),
    role: isGuestName(u.user) ? "guest" : "user",
    createdAt: u.createdAt,
    lastSeen: u.lastSeen,
    level: u.stats?.level || 1,
    badges: computeBadgeLabels(u),
    betaJoinAt: u.flags?.beta ? u.createdAt : null,
  };
}

function logSecurityEvent(username, type, detail) {
  const u = ensureUser(username);
  u.security.events ||= [];
  u.security.events.unshift({ ts: now(), type: String(type || "event"), detail: String(detail || "") });
  if (u.security.events.length > 60) u.security.events.length = 60;
  persistUsers();
}

/* ------------------------------ Inbox Helpers ----------------------------- */

function addInboxItem(toUser, item) {
  const u = ensureUser(toUser);
  u.inbox.unshift(item);
  if (u.inbox.length > 250) u.inbox.length = 250;
  persistUsers();
}

function countInbox(u) {
  const items = u.inbox || [];
  let total = 0;
  for (const it of items) {
    // Count everything for now; you can split later.
    total += 1;
  }
  return { total };
}

/* ------------------------------ Messages / Rules --------------------------- */

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
  const rx = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
  const out = [];
  let m;
  while ((m = rx.exec(t)) !== null) out.push(m[0]);
  return out;
}

// Block porn/18+ links entirely (keyword-based)
const BLOCKED_LINK_RX = new RegExp(
  [
    "porn",
    "xnxx",
    "xvideos",
    "pornhub",
    "redtube",
    "youporn",
    "hentai",
    "rule34",
    "onlyfans",
    "fansly",
    "nsfw",
    "camgirl",
    "cam4",
    "chaturbate",
    "erome",
    "xhamster",
    "spankbang",
  ].join("|"),
  "i"
);

// Prohibited content list (slurs + explicit 18+ content) => shadow mute
const SEVERE_BAD_RX = new RegExp(
  [
    "\\bn[i1]gg(?:a|er)\\b",
    "\\bchink\\b",
    "\\bwetback\\b",
    "\\bkike\\b",
    "\\bspic\\b",
    "\\bfag(?:got)?\\b",
    "\\btrann(?:y|ies)\\b",
    "\\bchild\\s*porn\\b",
    "\\b(?:cp)\\b",
    "\\bloli\\b",
    "\\bunderage\\b",
    "\\brape\\b",
    "\\bincest\\b",
    "\\bbeastiality\\b",
    "\\bblowjob\\b",
    "\\bhandjob\\b",
    "\\bdeepthroat\\b",
    "\\bcumshot\\b",
    "\\bgangbang\\b",
    "\\bcreampie\\b",
    "\\banal\\b",
    "\\bthreesome\\b",
    "\\bstrip\\s*tease\\b",
  ].join("|"),
  "i"
);

function isSevereBad(text) {
  const t = String(text || "");
  if (SEVERE_BAD_RX.test(t)) return true;
  const urls = extractUrls(t);
  for (const u of urls) {
    if (BLOCKED_LINK_RX.test(u)) return true;
  }
  return false;
}

function pushGlobalMessage(msg) {
  globalHistory.push(msg);
  if (globalHistory.length > 350) globalHistory.shift();
  persistGlobal();
}

/* ------------------------------ Groups (minimal) --------------------------- */

function ensureGroupDefaults(g) {
  g.id ||= nanoid(10);
  g.name ||= "Group";
  g.owner ||= null;
  g.members ||= [];
  g.createdAt ||= now();
  g.limit = Number.isFinite(Number(g.limit)) ? Number(g.limit) : 10;
  g.mutedUsers ||= [];
  return g;
}

function requireGroup(gid) {
  const g = groups[gid];
  if (!g) return null;
  return ensureGroupDefaults(g);
}

/* ------------------------------ Online Tracking ---------------------------- */

const socketsByUser = new Map(); // username -> Set(socket.id)
const userBySocket = new Map(); // socket.id -> username

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

function onlineCount() {
  return socketsByUser.size;
}

function emitToUser(user, evt, payload, io) {
  const set = socketsByUser.get(user);
  if (!set) return;
  for (const sid of set) io.to(sid).emit(evt, payload);
}

function broadcastOnlineCount(io) {
  io.emit("online:update", { online: onlineCount() }); // expected by new client
}

/* ------------------------------ Cooldowns --------------------------------- */

const globalRate = new Map();
// rate record: { nextAllowed, recent[], lastMsgNorm, lastLinkAt, lastMentionAt, shadowMuteUntil }

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
  r.recent = (r.recent || []).filter((t) => t >= cutoff);

  const n = r.recent.length;
  const penalty = n >= 8 ? 3.0 : n >= 6 ? 2.0 : n >= 4 ? 1.0 : 0;
  return Math.min(12, base + penalty);
}

function touchGlobalSend(username) {
  const t = now();
  const r = globalRate.get(username) || { nextAllowed: 0, recent: [] };
  r.recent.push(t);
  globalRate.set(username, r);
}

function normMsg(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function canMention(username) {
  const r = globalRate.get(username) || {};
  const t = now();
  const last = Number(r.lastMentionAt || 0);
  return t - last >= 8000;
}

function canPostLink(username) {
  const r = globalRate.get(username) || {};
  const t = now();
  const last = Number(r.lastLinkAt || 0);
  return t - last >= 5 * 60 * 1000;
}

const SHADOW_MUTE_MS = 10 * 60 * 1000;

/* ------------------------------ Auth Helpers ------------------------------ */

function reqIpUaHashes(req) {
  const xf = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(xf) ? xf[0] : xf || req.socket.remoteAddress || "").split(",")[0].trim();
  const ua = String(req.headers["user-agent"] || "");
  return { ipHash: sha256(ip), uaHash: sha256(ua), uaShort: ua.slice(0, 120) };
}

function socketIpUaHashes(socket) {
  const xf = socket.handshake.headers["x-forwarded-for"];
  const ip = (Array.isArray(xf) ? xf[0] : xf || socket.handshake.address || "").split(",")[0].trim();
  const ua = String(socket.handshake.headers["user-agent"] || "");
  return { ipHash: sha256(ip), uaHash: sha256(ua), uaShort: ua.slice(0, 120) };
}

function recordLogin(username, ok, ipHash, uaHash) {
  const u = ensureUser(username);
  u.security.loginHistory ||= [];
  u.security.loginHistory.unshift({ ts: now(), ipHash, uaHash, ok: !!ok });
  if (u.security.loginHistory.length > 50) u.security.loginHistory.length = 50;
  persistUsers();
}

function upsertSession(username, token, ipHash, uaHash) {
  const u = ensureUser(username);
  u.security.sessions ||= [];
  const existing = u.security.sessions.find((s) => s.token === token);
  if (existing) {
    existing.lastSeen = now();
    existing.ipHash = ipHash;
    existing.uaHash = uaHash;
  } else {
    u.security.sessions.unshift({ id: nanoid(10), token, createdAt: now(), lastSeen: now(), ipHash, uaHash });
    if (u.security.sessions.length > 10) u.security.sessions.length = 10;
  }
  persistUsers();
}

function findUserByToken(token) {
  const tok = String(token || "");
  if (!tok) return null;
  // Token must match an existing, password-protected account
  const found = Object.values(users).find((u) => u && u.token === tok && u.passHash);
  return found || null;
}

function authMiddleware(req, res, next) {
  const h = String(req.headers.authorization || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  const tok = m ? m[1] : "";
  const u = findUserByToken(tok);
  if (!u) return res.status(401).json({ error: "Unauthorized" });
  req.userRec = u;
  req.token = tok;
  next();
}

/* ------------------------------ Badges ------------------------------------ */

function computeBadgeLabels(userRec) {
  const out = [];
  if (userRec?.flags?.beta) out.push("EARLY USER");
  const lvl = Number(userRec?.stats?.level || 1);
  if (lvl >= 10) out.push("LV 10");
  if (lvl >= 25) out.push("LV 25");
  if (lvl >= 50) out.push("LV 50");
  if (lvl >= 75) out.push("LV 75");
  if (lvl >= 100) out.push("LV 100");
  return out.slice(0, 10);
}

/* ------------------------------ Express Setup ----------------------------- */

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ------------------------------ Public Status ----------------------------- */

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    online: onlineCount(),
    startedAt: STARTED_AT,
    lastRestartAt: STARTED_AT,
    issues: [],
  });
});

/* ------------------------------ Telemetry -------------------------------- */

app.post("/api/telemetry/hello", (req, res) => {
  // Intentionally minimal: server can use IP for bot detection; do not store raw IP in file.
  // If you want, you can aggregate counters here.
  res.json({ ok: true });
});

/* ------------------------------ REST: Auth -------------------------------- */

app.post("/api/auth/login", async (req, res) => {
  const { username, password, guest, client } = req.body || {};
  const { ipHash, uaHash, uaShort } = reqIpUaHashes(req);
  const devKey = deviceKeyFromReq(req);

  if (guest) {
    // Create a unique Guest#### name
    let g = null;
    for (let i = 0; i < 80; i++) {
      const n = 1000 + Math.floor(Math.random() * 9000);
      const name = `Guest${n}`;
      if (!users[name]) {
        g = ensureUser(name);
        g.passHash = null;
        g.token = null;
        g.status = "online";
        g.flags.beta = true;
        break;
      }
    }
    if (!g) return res.status(429).json({ ok: false, error: "Guest slots busy. Try again." });

    recordLogin(g.user, true, ipHash, uaHash);
    g.lastSeen = now();
    persistUsers();

    // Log guest join/login
    if (DISCORD_WEBHOOK_URL) {
      discordSendEmbed({
        title: "Guest Session Created",
        description: `Guest joined: **${g.user}**`,
        color: 0x2f3136,
        fields: [
          { name: "User", value: `\`${g.user}\``, inline: true },
          { name: "Type", value: "guest", inline: true },
          { name: "When", value: `<t:${Math.floor(now() / 1000)}:F>`, inline: false },
          { name: "Device Key", value: `\`${devKey}\``, inline: false },
          { name: "IP Hash", value: `\`${ipHash.slice(0, 16)}…\``, inline: true },
          { name: "UA Hash", value: `\`${uaHash.slice(0, 16)}…\``, inline: true },
          { name: "UA (short)", value: `\`${uaShort.replace(/`/g, "ˋ")}\``, inline: false },
        ],
        footer: "tonkotsu.online",
      });
    }

    return res.json({
      ok: true,
      token: null,
      user: safeUserForClient(g),
      isNew: false,
      guest: true,
    });
  }

  const uName = String(username || "").trim();
  const pass = String(password || "").trim();

  if (!isValidUser(uName)) return res.status(400).json({ ok: false, error: "Username: letters/numbers only, 4–20." });
  if (!isValidPass(pass)) return res.status(400).json({ ok: false, error: "Password: letters/numbers only, 4–32." });

  const exists = !!users[uName] && !!users[uName].passHash;

  if (!exists) {
    const c = deviceCreationCount(devKey);
    if (c >= 4) {
      recordLogin(uName, false, ipHash, uaHash);
      return res.status(429).json({ ok: false, error: "Account creation limit reached (4 per day on this device)." });
    }
  }

  const rec = ensureUser(uName);

  if (rec.passHash) {
    const ok = await bcrypt.compare(pass, rec.passHash).catch(() => false);
    recordLogin(uName, ok, ipHash, uaHash);
    if (!ok) return res.status(401).json({ ok: false, error: "Incorrect password." });

    // Strict login: refresh token
    rec.token = crypto.randomBytes(24).toString("hex");
    rec.status ||= "online";
    rec.lastSeen = now();
    upsertSession(rec.user, rec.token, ipHash, uaHash);
    logSecurityEvent(rec.user, "login", `Login ok (ipHash ${ipHash.slice(0, 10)}…)`);
    persistUsers();

    // Log login
    if (DISCORD_WEBHOOK_URL) {
      discordSendEmbed({
        title: "User Logged In",
        description: `User logged in: **${rec.user}**`,
        color: 0x2f3136,
        fields: [
          { name: "User", value: `\`${rec.user}\``, inline: true },
          { name: "Type", value: "login", inline: true },
          { name: "When", value: `<t:${Math.floor(now() / 1000)}:F>`, inline: false },
          { name: "Device Key", value: `\`${devKey}\``, inline: false },
          { name: "IP Hash", value: `\`${ipHash.slice(0, 16)}…\``, inline: true },
          { name: "UA Hash", value: `\`${uaHash.slice(0, 16)}…\``, inline: true },
          { name: "UA (short)", value: `\`${uaShort.replace(/`/g, "ˋ")}\``, inline: false },
        ],
        footer: "tonkotsu.online",
      });
    }

    return res.json({
      ok: true,
      token: rec.token,
      user: safeUserForClient(rec),
      isNew: false,
    });
  }

  // Create new account
  const newCount = bumpDeviceCreationLimit(devKey);
  if (newCount > 4) {
    recordLogin(uName, false, ipHash, uaHash);
    return res.status(429).json({ ok: false, error: "Account creation limit reached (4 per day on this device)." });
  }

  rec.passHash = await bcrypt.hash(pass, 12);
  rec.token = crypto.randomBytes(24).toString("hex");
  rec.status = "online";
  rec.createdAt ||= now();
  rec.lastSeen = now();
  rec.flags.beta = true;

  recordLogin(uName, true, ipHash, uaHash);
  upsertSession(rec.user, rec.token, ipHash, uaHash);
  logSecurityEvent(rec.user, "account_create", "Account created");
  persistUsers();

  // Log new account
  if (DISCORD_WEBHOOK_URL) {
    discordSendEmbed({
      title: "New Account Created",
      description: `New user created: **${rec.user}**`,
      color: 0x5865f2,
      fields: [
        { name: "User", value: `\`${rec.user}\``, inline: true },
        { name: "Type", value: "new_account", inline: true },
        { name: "When", value: `<t:${Math.floor(now() / 1000)}:F>`, inline: false },
        { name: "Device Key", value: `\`${devKey}\``, inline: false },
        { name: "IP Hash", value: `\`${ipHash.slice(0, 16)}…\``, inline: true },
        { name: "UA Hash", value: `\`${uaHash.slice(0, 16)}…\``, inline: true },
        { name: "UA (short)", value: `\`${uaShort.replace(/`/g, "ˋ")}\``, inline: false },
      ],
      footer: "tonkotsu.online",
    });
  }

  return res.json({
    ok: true,
    token: rec.token,
    user: safeUserForClient(rec),
    isNew: true,
  });
});

/* ------------------------------ REST: Me / Inbox -------------------------- */

app.get("/api/me", authMiddleware, (req, res) => {
  const u = ensureUser(req.userRec.user);
  // keep token session fresh
  const { ipHash, uaHash } = reqIpUaHashes(req);
  upsertSession(u.user, u.token, ipHash, uaHash);
  u.lastSeen = now();
  persistUsers();
  res.json({ ok: true, user: safeUserForClient(u) });
});

app.get("/api/inbox/count", authMiddleware, (req, res) => {
  const u = ensureUser(req.userRec.user);
  const c = countInbox(u);
  res.json({ ok: true, count: c.total });
});

/* ------------------------------ REST: Blocks ------------------------------- */

app.get("/api/blocks", authMiddleware, (req, res) => {
  const u = ensureUser(req.userRec.user);
  const blocked = u.social?.blocked || [];
  const meta = u.social?.blockedMeta || {};
  const items = blocked.map((name) => ({
    username: name,
    blockedAt: meta[name] || null,
  }));
  res.json({ ok: true, items });
});

app.post("/api/blocks/unblock", authMiddleware, (req, res) => {
  const target = String(req.body?.username || "").trim();
  const u = ensureUser(req.userRec.user);

  u.social.blocked = (u.social.blocked || []).filter((x) => x !== target);
  if (u.social.blockedMeta && u.social.blockedMeta[target]) delete u.social.blockedMeta[target];

  persistUsers();
  logSecurityEvent(u.user, "unblock", `Unblocked ${target}`);
  res.json({ ok: true });
});

/* ------------------------------ REST: Security ----------------------------- */

app.get("/api/security/overview", authMiddleware, (req, res) => {
  const u = ensureUser(req.userRec.user);
  const sec = u.security || { sessions: [], loginHistory: [], events: [] };

  // Provide masked values (hashes already)
  const loginHistory = (sec.loginHistory || []).slice(0, 20).map((x) => ({
    when: x.ts,
    ip: x.ipHash ? `${String(x.ipHash).slice(0, 10)}…` : "—",
    ua: x.uaHash ? `${String(x.uaHash).slice(0, 10)}…` : "—",
    ok: !!x.ok,
  }));

  const sessions = (sec.sessions || []).slice(0, 12).map((s) => ({
    id: s.id || nanoid(8),
    current: s.token === u.token,
    ip: s.ipHash ? `${String(s.ipHash).slice(0, 10)}…` : "—",
    lastSeen: s.lastSeen || null,
  }));

  const events = (sec.events || []).slice(0, 20).map((e) => ({
    type: e.type,
    when: e.ts,
    detail: e.detail,
  }));

  res.json({ ok: true, loginHistory, sessions, events });
});

app.post("/api/security/revoke-session", authMiddleware, (req, res) => {
  const sessionId = String(req.body?.sessionId || "").trim();
  const u = ensureUser(req.userRec.user);
  u.security.sessions = (u.security.sessions || []).filter((s) => String(s.id || "") !== sessionId);

  persistUsers();
  logSecurityEvent(u.user, "revoke_session", `Revoked session ${sessionId}`);
  res.json({ ok: true });
});

app.post("/api/security/change-password", authMiddleware, async (req, res) => {
  const pw = String(req.body?.password || "").trim();
  if (!isValidPass(pw)) return res.status(400).json({ ok: false, error: "Password: letters/numbers only, 4–32." });

  const u = ensureUser(req.userRec.user);
  u.passHash = await bcrypt.hash(pw, 12);

  // Rotate token (forces relogin elsewhere)
  u.token = crypto.randomBytes(24).toString("hex");

  const { ipHash, uaHash } = reqIpUaHashes(req);
  upsertSession(u.user, u.token, ipHash, uaHash);

  persistUsers();
  logSecurityEvent(u.user, "change_password", "Password changed");
  res.json({ ok: true });
});

app.post("/api/security/change-username", authMiddleware, async (req, res) => {
  const nu = String(req.body?.username || "").trim();
  if (!isValidUser(nu)) return res.status(400).json({ ok: false, error: "New username invalid." });
  if (users[nu]) return res.status(409).json({ ok: false, error: "Username already in use." });

  const old = req.userRec.user;
  const rec = ensureUser(old);

  // Move record
  delete users[old];
  rec.user = nu;
  users[nu] = rec;

  // Rotate token
  rec.token = crypto.randomBytes(24).toString("hex");

  // Update online map keys
  const sockets = socketsByUser.get(old);
  if (sockets) {
    socketsByUser.delete(old);
    socketsByUser.set(nu, sockets);
    for (const sid of sockets) userBySocket.set(sid, nu);
  }

  persistUsers();
  logSecurityEvent(nu, "change_username", `Renamed from ${old} to ${nu}`);
  res.json({ ok: true, user: safeUserForClient(rec) });
});

/* ------------------------------ REST: Global ------------------------------- */

app.get("/api/global/history", (req, res) => {
  const limit = Math.max(5, Math.min(200, Number(req.query?.limit || 80)));
  const items = Array.isArray(globalHistory) ? globalHistory.slice(-limit) : [];
  res.json({ ok: true, items });
});

app.post("/api/global/send", authMiddleware, (req, res) => {
  // Global is intentionally public/logged, but still requires a logged-in user here.
  // Socket path supports guests; REST path enforces auth.
  const username = req.userRec.user;
  const text = String(req.body?.text || "").trim();
  const ack = handleGlobalSend({ username, text, isFromSocket: false });
  if (!ack.ok) return res.status(400).json(ack);
  res.json(ack);
});

/* ------------------------------ REST: Groups (minimal) ---------------------- */

app.get("/api/groups/:id", authMiddleware, (req, res) => {
  const u = ensureUser(req.userRec.user);
  const gid = String(req.params.id || "");
  const g = requireGroup(gid);
  if (!g) return res.status(404).json({ ok: false, error: "Group not found." });
  if (!g.members.includes(u.user)) return res.status(403).json({ ok: false, error: "Not a member." });

  res.json({
    ok: true,
    id: g.id,
    name: g.name,
    owner: g.owner,
    limit: g.limit,
    isOwner: g.owner === u.user,
    members: g.members.map((name) => ({
      username: name,
      role: name === g.owner ? "owner" : "member",
      muted: (g.mutedUsers || []).includes(name),
    })),
  });
});

app.post("/api/groups/:id/limit", authMiddleware, (req, res) => {
  const u = ensureUser(req.userRec.user);
  const gid = String(req.params.id || "");
  const g = requireGroup(gid);
  if (!g) return res.status(404).json({ ok: false, error: "Group not found." });
  if (g.owner !== u.user) return res.status(403).json({ ok: false, error: "Owner only." });

  const limit = Number(req.body?.limit || 0);
  const newLimit = Math.max(2, Math.min(50, Math.floor(limit)));
  // Owner can reduce; allow increases too if you want. Here: allow both.
  g.limit = newLimit;
  persistGroups();
  res.json({ ok: true });
});

app.post("/api/groups/:id/members/add", authMiddleware, (req, res) => {
  const u = ensureUser(req.userRec.user);
  const gid = String(req.params.id || "");
  const g = requireGroup(gid);
  if (!g) return res.status(404).json({ ok: false, error: "Group not found." });
  if (g.owner !== u.user) return res.status(403).json({ ok: false, error: "Owner only." });

  const target = String(req.body?.username || "").trim();
  if (!users[target] || !users[target].passHash || isGuestName(target)) return res.status(404).json({ ok: false, error: "User not found." });
  if (g.members.includes(target)) return res.json({ ok: true });

  if (g.members.length >= g.limit) return res.status(400).json({ ok: false, error: "Group is at member limit." });

  g.members.push(target);
  persistGroups();
  res.json({ ok: true });
});

app.post("/api/groups/:id/members/remove", authMiddleware, (req, res) => {
  const u = ensureUser(req.userRec.user);
  const gid = String(req.params.id || "");
  const g = requireGroup(gid);
  if (!g) return res.status(404).json({ ok: false, error: "Group not found." });
  if (g.owner !== u.user) return res.status(403).json({ ok: false, error: "Owner only." });

  const target = String(req.body?.username || "").trim();
  if (target === g.owner) return res.status(400).json({ ok: false, error: "Transfer ownership first." });

  g.members = (g.members || []).filter((x) => x !== target);
  g.mutedUsers = (g.mutedUsers || []).filter((x) => x !== target);
  persistGroups();
  res.json({ ok: true });
});

app.post("/api/groups/:id/members/mute", authMiddleware, (req, res) => {
  const u = ensureUser(req.userRec.user);
  const gid = String(req.params.id || "");
  const g = requireGroup(gid);
  if (!g) return res.status(404).json({ ok: false, error: "Group not found." });
  if (g.owner !== u.user) return res.status(403).json({ ok: false, error: "Owner only." });

  const target = String(req.body?.username || "").trim();
  const muted = !!req.body?.muted;

  if (!g.members.includes(target)) return res.status(400).json({ ok: false, error: "Not a member." });

  g.mutedUsers ||= [];
  if (muted) {
    if (!g.mutedUsers.includes(target)) g.mutedUsers.push(target);
  } else {
    g.mutedUsers = g.mutedUsers.filter((x) => x !== target);
  }
  persistGroups();
  res.json({ ok: true });
});

app.post("/api/groups/:id/transfer", authMiddleware, (req, res) => {
  const u = ensureUser(req.userRec.user);
  const gid = String(req.params.id || "");
  const g = requireGroup(gid);
  if (!g) return res.status(404).json({ ok: false, error: "Group not found." });
  if (g.owner !== u.user) return res.status(403).json({ ok: false, error: "Owner only." });

  const target = String(req.body?.username || "").trim();
  if (!g.members.includes(target)) return res.status(400).json({ ok: false, error: "Target must be a member." });
  if (isGuestName(target)) return res.status(400).json({ ok: false, error: "Guests cannot be owners." });

  g.owner = target;
  persistGroups();
  res.json({ ok: true });
});

app.delete("/api/groups/:id", authMiddleware, (req, res) => {
  const u = ensureUser(req.userRec.user);
  const gid = String(req.params.id || "");
  const g = requireGroup(gid);
  if (!g) return res.status(404).json({ ok: false, error: "Group not found." });
  if (g.owner !== u.user) return res.status(403).json({ ok: false, error: "Owner only." });

  delete groups[gid];
  persistGroups();
  res.json({ ok: true });
});

/* ------------------------------ Global Send Core --------------------------- */

function discordLogGlobalMessage({ user, text, ts, meta }) {
  if (!DISCORD_WEBHOOK_URL) return;

  const when = `<t:${Math.floor(ts / 1000)}:F>`;
  const userId = sha256(user).slice(0, 12);

  const fields = [
    { name: "User", value: `\`${user}\``, inline: true },
    { name: "User ID", value: `\`${userId}\``, inline: true },
    { name: "When", value: when, inline: false },
  ];

  if (meta?.shadow === true) fields.push({ name: "Delivery", value: "shadow-muted (not visible to others)", inline: false });
  if (meta?.cooldownSec) fields.push({ name: "Cooldown", value: `${meta.cooldownSec.toFixed(2)}s`, inline: true });
  if (meta?.fingerprint) fields.push({ name: "FP (hash)", value: `\`${meta.fingerprint.slice(0, 16)}…\``, inline: true });

  discordSendEmbed({
    title: "Global Message",
    description: discordContentSafe(text),
    color: 0x2f3136,
    fields,
    footer: "Global is public and logged",
  });
}

function handleGlobalSend({ username, text, isFromSocket, socket }) {
  const t = String(text || "").trim();
  if (!t || t.length > 1200) return { ok: false, error: "Invalid message." };

  const r =
    globalRate.get(username) ||
    { nextAllowed: 0, recent: [], lastMsgNorm: "", lastLinkAt: 0, lastMentionAt: 0, shadowMuteUntil: 0 };
  globalRate.set(username, r);

  // If currently shadow-muted, only echo to sender
  if (r.shadowMuteUntil && now() < r.shadowMuteUntil) {
    const msg = { user: username, text: t, ts: now() };
    // sender sees it
    if (socket) socket.emit("global:msg", msg);
    if (socket) socket.emit("globalMessage", msg); // legacy
    discordLogGlobalMessage({ user: username, text: t, ts: msg.ts, meta: { shadow: true } });
    return { ok: true, shadow: true, cooldownMs: Math.floor(currentCooldownForUser(username) * 1000) };
  }

  // Prohibited content => apply new shadow mute and only echo to sender
  if (isSevereBad(t)) {
    r.shadowMuteUntil = now() + SHADOW_MUTE_MS;
    globalRate.set(username, r);

    const msg = { user: username, text: t, ts: now() };
    if (socket) socket.emit("global:msg", msg);
    if (socket) socket.emit("globalMessage", msg); // legacy
    if (socket) socket.emit("shadow:notice", { hint: "Message not delivered." });
    if (socket) socket.emit("warn", { kind: "shadow", text: "Message not delivered." }); // legacy

    discordLogGlobalMessage({ user: username, text: t, ts: msg.ts, meta: { shadow: true } });
    return { ok: true, shadow: true, cooldownMs: Math.floor(currentCooldownForUser(username) * 1000) };
  }

  // Link rules
  if (containsUrl(t)) {
    if (!canPostLink(username)) {
      return { ok: false, error: "Link cooldown: you can post one link every 5 minutes." };
    }
    const urls = extractUrls(t);
    for (const u of urls) {
      if (BLOCKED_LINK_RX.test(u)) {
        // Block porn/18+ links: shadow-mute
        r.shadowMuteUntil = now() + SHADOW_MUTE_MS;
        globalRate.set(username, r);

        const msg = { user: username, text: t, ts: now() };
        if (socket) socket.emit("global:msg", msg);
        if (socket) socket.emit("globalMessage", msg); // legacy
        if (socket) socket.emit("shadow:notice", { hint: "Message not delivered." });
        if (socket) socket.emit("warn", { kind: "shadow", text: "Message not delivered." }); // legacy

        discordLogGlobalMessage({ user: username, text: t, ts: msg.ts, meta: { shadow: true } });
        return { ok: true, shadow: true, cooldownMs: Math.floor(currentCooldownForUser(username) * 1000) };
      }
    }
    r.lastLinkAt = now();
  }

  // Mention pacing
  const mentions = extractMentions(t).slice(0, 6);
  if (mentions.length) {
    if (!canMention(username)) return { ok: false, error: "Slow down on mentions." };
    r.lastMentionAt = now();
  }

  // Cooldown enforcement
  const cd = currentCooldownForUser(username);
  if (now() < (r.nextAllowed || 0)) {
    const left = Math.max(0, (r.nextAllowed - now()) / 1000);
    return { ok: false, error: `Cooldown active (${left.toFixed(1)}s left).` };
  }

  r.nextAllowed = now() + cd * 1000;
  touchGlobalSend(username);

  const msg = { user: username, text: t, ts: now() };
  pushGlobalMessage(msg);

  // Discord log (GLOBAL ONLY)
  const fp = socket ? deviceKeyFromSocket(socket) : null;
  discordLogGlobalMessage({ user: username, text: t, ts: msg.ts, meta: { cooldownSec: cd, fingerprint: fp } });

  // XP
  if (users[username] && !isGuestName(username)) {
    const xpInfo = awardXP(username, 6);
    if (xpInfo && io) emitToUser(username, "me:stats", xpInfo, io);
  }

  if (users[username]) {
    users[username].lastSeen = now();
    persistUsers();
  }

  // Broadcast to everyone
  if (io) {
    io.emit("global:msg", msg);
    io.emit("globalMessage", msg); // legacy
  }

  return { ok: true, shadow: false, cooldownMs: Math.floor(cd * 1000) };
}

/* ------------------------------ Socket.IO --------------------------------- */

io.on("connection", (socket) => {
  let authedUser = null;

  function requireAuth() {
    return !!authedUser && !!users[authedUser];
  }

  // If client sent token via socket auth, attempt resume automatically
  try {
    const tok = socket.handshake?.auth?.token;
    if (tok) {
      const found = findUserByToken(tok);
      if (found) {
        authedUser = found.user;
        setOnline(authedUser, socket.id);
        found.lastSeen = now();
        persistUsers();
      }
    }
  } catch {}

  // Always emit online count on connect
  broadcastOnlineCount(io);

  socket.on("hello", () => {
    // client telemetry; keep silent
  });

  socket.on("online:get", () => {
    socket.emit("online:update", { online: onlineCount() });
  });

  // Legacy: some clients may request "onlineUsers"; keep minimal
  socket.on("onlineUsers:get", () => {
    socket.emit("online:update", { online: onlineCount() });
  });

  // Socket resume
  socket.on("resume", ({ token }) => {
    const tok = String(token || "");
    const found = findUserByToken(tok);
    if (!found) return socket.emit("resumeFail");
    authedUser = found.user;
    setOnline(authedUser, socket.id);
    found.lastSeen = now();
    persistUsers();
    socket.emit("resumeOk", { ok: true });
    broadcastOnlineCount(io);
  });

  // Socket login (legacy support)
  socket.on("login", async ({ username, password, guest }) => {
    // Keep this for older clients; new client uses REST /api/auth/login
    const { ipHash, uaHash, uaShort } = socketIpUaHashes(socket);
    const devKey = deviceKeyFromSocket(socket);

    if (guest) {
      let g = null;
      for (let i = 0; i < 80; i++) {
        const n = 1000 + Math.floor(Math.random() * 9000);
        const name = `Guest${n}`;
        if (!users[name]) {
          g = ensureUser(name);
          g.passHash = null;
          g.token = null;
          g.status = "online";
          g.flags.beta = true;
          break;
        }
      }
      if (!g) return socket.emit("loginError", "Guest slots busy. Try again.");

      recordLogin(g.user, true, ipHash, uaHash);
      authedUser = g.user;
      setOnline(authedUser, socket.id);
      persistUsers();

      if (DISCORD_WEBHOOK_URL) {
        discordSendEmbed({
          title: "Guest Session Created",
          description: `Guest joined: **${g.user}**`,
          fields: [
            { name: "User", value: `\`${g.user}\``, inline: true },
            { name: "Type", value: "guest", inline: true },
            { name: "When", value: `<t:${Math.floor(now() / 1000)}:F>`, inline: false },
            { name: "Device Key", value: `\`${devKey}\``, inline: false },
            { name: "IP Hash", value: `\`${ipHash.slice(0, 16)}…\``, inline: true },
            { name: "UA Hash", value: `\`${uaHash.slice(0, 16)}…\``, inline: true },
            { name: "UA (short)", value: `\`${uaShort.replace(/`/g, "ˋ")}\``, inline: false },
          ],
          footer: "tonkotsu.online",
        });
      }

      socket.emit("loginSuccess", { username: g.user, guest: true, token: null, firstTime: false });
      broadcastOnlineCount(io);
      return;
    }

    const uName = String(username || "").trim();
    const pass = String(password || "").trim();

    if (!isValidUser(uName)) return socket.emit("loginError", "Username: letters/numbers only, 4–20.");
    if (!isValidPass(pass)) return socket.emit("loginError", "Password: letters/numbers only, 4–32.");

    const exists = !!users[uName] && !!users[uName].passHash;

    if (!exists) {
      const c = deviceCreationCount(devKey);
      if (c >= 4) {
        recordLogin(uName, false, ipHash, uaHash);
        return socket.emit("loginError", "Account creation limit reached (4 per day on this device).");
      }
    }

    const rec = ensureUser(uName);

    if (rec.passHash) {
      const ok = await bcrypt.compare(pass, rec.passHash).catch(() => false);
      recordLogin(uName, ok, ipHash, uaHash);
      if (!ok) return socket.emit("loginError", "Incorrect password.");

      rec.token = crypto.randomBytes(24).toString("hex");
      upsertSession(rec.user, rec.token, ipHash, uaHash);
      rec.lastSeen = now();
      persistUsers();

      authedUser = rec.user;
      setOnline(authedUser, socket.id);

      if (DISCORD_WEBHOOK_URL) {
        discordSendEmbed({
          title: "User Logged In",
          description: `User logged in: **${rec.user}**`,
          fields: [
            { name: "User", value: `\`${rec.user}\``, inline: true },
            { name: "Type", value: "login", inline: true },
            { name: "When", value: `<t:${Math.floor(now() / 1000)}:F>`, inline: false },
            { name: "Device Key", value: `\`${devKey}\``, inline: false },
            { name: "IP Hash", value: `\`${ipHash.slice(0, 16)}…\``, inline: true },
            { name: "UA Hash", value: `\`${uaHash.slice(0, 16)}…\``, inline: true },
            { name: "UA (short)", value: `\`${uaShort.replace(/`/g, "ˋ")}\``, inline: false },
          ],
          footer: "tonkotsu.online",
        });
      }

      socket.emit("loginSuccess", { username: rec.user, guest: false, token: rec.token, firstTime: false });
      broadcastOnlineCount(io);
      return;
    }

    // Create new
    const newCount = bumpDeviceCreationLimit(devKey);
    if (newCount > 4) {
      recordLogin(uName, false, ipHash, uaHash);
      return socket.emit("loginError", "Account creation limit reached (4 per day on this device).");
    }

    rec.passHash = await bcrypt.hash(pass, 12);
    rec.token = crypto.randomBytes(24).toString("hex");
    rec.status = "online";
    rec.createdAt ||= now();
    rec.lastSeen = now();
    rec.flags.beta = true;

    recordLogin(uName, true, ipHash, uaHash);
    upsertSession(rec.user, rec.token, ipHash, uaHash);
    persistUsers();

    authedUser = rec.user;
    setOnline(authedUser, socket.id);

    if (DISCORD_WEBHOOK_URL) {
      discordSendEmbed({
        title: "New Account Created",
        description: `New user created: **${rec.user}**`,
        fields: [
          { name: "User", value: `\`${rec.user}\``, inline: true },
          { name: "Type", value: "new_account", inline: true },
          { name: "When", value: `<t:${Math.floor(now() / 1000)}:F>`, inline: false },
          { name: "Device Key", value: `\`${devKey}\``, inline: false },
          { name: "IP Hash", value: `\`${ipHash.slice(0, 16)}…\``, inline: true },
          { name: "UA Hash", value: `\`${uaHash.slice(0, 16)}…\``, inline: true },
          { name: "UA (short)", value: `\`${uaShort.replace(/`/g, "ˋ")}\``, inline: false },
        ],
        footer: "tonkotsu.online",
      });
    }

    socket.emit("loginSuccess", { username: rec.user, guest: false, token: rec.token, firstTime: true });
    broadcastOnlineCount(io);
  });

  // Global history (new client expects ack callback)
  socket.on("global:history", ({ limit } = {}, cb) => {
    const lim = Math.max(5, Math.min(200, Number(limit || 80)));
    const items = Array.isArray(globalHistory) ? globalHistory.slice(-lim) : [];
    if (typeof cb === "function") cb({ ok: true, items });
  });

  // Legacy global history
  socket.on("requestGlobalHistory", () => {
    socket.emit("history", globalHistory);
  });

  // Global send (new client expects ack callback)
  socket.on("global:send", ({ text } = {}, cb) => {
    if (!requireAuth()) {
      const out = { ok: false, error: "Not authenticated." };
      if (typeof cb === "function") cb(out);
      return;
    }

    const out = handleGlobalSend({ username: authedUser, text, isFromSocket: true, socket });
    if (!out.ok) {
      socket.emit("sendError", { reason: out.error }); // legacy
      if (typeof cb === "function") cb({ ok: false, error: out.error });
      return;
    }
    if (typeof cb === "function") cb(out);
  });

  // Legacy global send
  socket.on("sendGlobal", ({ text }) => {
    if (!requireAuth()) return;
    const out = handleGlobalSend({ username: authedUser, text, isFromSocket: true, socket });
    if (!out.ok) socket.emit("sendError", { reason: out.error });
  });

  // Inbox badge (new client listens for notify:count)
  socket.on("inbox:get", () => {
    if (!requireAuth()) return;
    const u = ensureUser(authedUser);
    const c = countInbox(u);
    socket.emit("notify:count", { count: c.total }); // new
    socket.emit("inbox:badge", c); // legacy
  });

  socket.on("disconnect", () => {
    setOffline(socket.id);
    if (authedUser && users[authedUser]) {
      users[authedUser].lastSeen = now();
      persistUsers();
    }
    broadcastOnlineCount(io);
  });
});

/* ------------------------------ Boot -------------------------------------- */

server.listen(PORT, () => {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("WARNING: DISCORD_WEBHOOK_URL is not set. Webhook logs will not be sent.");
  }
  console.log(`Server listening on http://localhost:${PORT}`);
});

