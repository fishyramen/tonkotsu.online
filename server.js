// server.js — tonkotsu.online backend (Express + Socket.IO)
// Compact black UI is handled in /public/index.html (no styles.css).
//
// This server fixes:
// - Cannot GET / (serves /public/index.html and SPA fallback)
// - Login not working (REST auth endpoints that match client fetch())
// - Single-session-per-account enforcement
// - One-account-per-day enforcement (per device key + ip hash)
// - Global-only default messaging (Global is public + logged to Discord webhook)
// - Auto-mod (global), link rules, shadow mute (global), applies to edits too
// - Report message -> Discord webhook embed
// - Admin ban tools (IP-hash / deviceKey / username) via ADMIN_KEY endpoints
// - Group chats (owner-only: invite/add/remove/rename/limit/cooldown/transfer)
// - Typing indicators + read markers scaffolding for global / dm / group
//
// Deploy notes (Render):
// - Set env: DISCORD_WEBHOOK_URL, ADMIN_KEY
// - Node 18+ recommended (native fetch not required; we use https fallback).
// - Ensure repo has /public/index.html and /public/script.js
//
// Data is stored in ./data/*.json (simple JSON persistence for beta)

"use strict";

/* --------------------------------- Imports -------------------------------- */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");

/* ------------------------------ Environment -------------------------------- */

const PORT = Number(process.env.PORT || 3000);
const DISCORD_WEBHOOK_URL = String(process.env.DISCORD_WEBHOOK_URL || "").trim();
const ADMIN_KEY = String(process.env.ADMIN_KEY || "").trim();

// Safety: if webhook is empty, logging silently no-ops.
const WEBHOOK_ENABLED = !!DISCORD_WEBHOOK_URL;

// Trust proxy is REQUIRED on Render (x-forwarded-for is your client IP)
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS || 1);

/* ------------------------------ File Storage -------------------------------- */

const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

const FILES = {
  users: path.join(DATA_DIR, "users.json"),
  global: path.join(DATA_DIR, "global.json"),
  groups: path.join(DATA_DIR, "groups.json"),
  dms: path.join(DATA_DIR, "dms.json"),
  reports: path.join(DATA_DIR, "reports.json"),
  bans: path.join(DATA_DIR, "bans.json"),
  deviceDaily: path.join(DATA_DIR, "device_daily.json"),
  reads: path.join(DATA_DIR, "reads.json"),
  typing: path.join(DATA_DIR, "typing.json"), // optional persistence
};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// atomic-ish write (tmp then rename)
function writeJsonSafe(file, obj) {
  const tmp = `${file}.tmp`;
  const out = JSON.stringify(obj, null, 2);
  fs.writeFileSync(tmp, out, "utf8");
  fs.renameSync(tmp, file);
}

/* --------------------------- In-memory DB (beta) --------------------------- */

let dbUsers = readJsonSafe(FILES.users, {}); // { username: userRec }
let dbGlobal = readJsonSafe(FILES.global, []); // [{id,user,text,ts,editedAt?,deleted?}]
let dbGroups = readJsonSafe(FILES.groups, {}); // { gid: groupRec }
let dbDMs = readJsonSafe(FILES.dms, {}); // { key: [msg...] } where key = "a|b"
let dbReports = readJsonSafe(FILES.reports, []); // [{...}]
let dbBans = readJsonSafe(FILES.bans, { ipHash: [], deviceKey: [], user: [] });
let dbDeviceDaily = readJsonSafe(FILES.deviceDaily, {}); // { dayKey: { deviceKey: count } }
let dbReads = readJsonSafe(FILES.reads, {}); // { username: { threadKey: lastReadId } }

/* ------------------------------- Persistence ------------------------------- */

function persistUsers() {
  writeJsonSafe(FILES.users, dbUsers);
}
function persistGlobal() {
  writeJsonSafe(FILES.global, dbGlobal);
}
function persistGroups() {
  writeJsonSafe(FILES.groups, dbGroups);
}
function persistDMs() {
  writeJsonSafe(FILES.dms, dbDMs);
}
function persistReports() {
  writeJsonSafe(FILES.reports, dbReports);
}
function persistBans() {
  writeJsonSafe(FILES.bans, dbBans);
}
function persistDeviceDaily() {
  writeJsonSafe(FILES.deviceDaily, dbDeviceDaily);
}
function persistReads() {
  writeJsonSafe(FILES.reads, dbReads);
}

/* --------------------------------- Helpers -------------------------------- */

function now() {
  return Date.now();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function safeStr(s, max = 1200) {
  const t = String(s || "");
  if (t.length <= max) return t;
  return t.slice(0, max);
}

function utcDayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function normalizeUsername(u) {
  return String(u || "").trim();
}

function isValidUsername(u) {
  // 4-20, letters/numbers only
  return /^[A-Za-z0-9]{4,20}$/.test(String(u || ""));
}

function isValidPassword(p) {
  // beta policy: 4-64, allow more than letters/numbers (so real passwords work)
  // still block absurdly long
  const s = String(p || "");
  if (s.length < 4 || s.length > 64) return false;
  // prevent whitespace-only
  if (!s.trim()) return false;
  return true;
}

function isGuest(username) {
  return /^Guest\d{4,6}$/.test(String(username || ""));
}

function dmKey(a, b) {
  const A = String(a);
  const B = String(b);
  return A < B ? `${A}|${B}` : `${B}|${A}`;
}

/* ------------------------------ Webhook Sender ----------------------------- */

function webhookPostJson(urlStr, payload) {
  return new Promise((resolve) => {
    if (!WEBHOOK_ENABLED) return resolve({ ok: true, disabled: true });

    let url;
    try {
      url = new URL(urlStr);
    } catch {
      return resolve({ ok: false, error: "Invalid webhook URL" });
    }

    const data = Buffer.from(JSON.stringify(payload || {}));
    const opts = {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname + (url.search || ""),
      headers: {
        "content-type": "application/json",
        "content-length": data.length,
      },
    };

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        // Discord rate-limit: 429 gives JSON with retry_after
        if (res.statusCode === 429) {
          let retryMs = 1500;
          try {
            const j = JSON.parse(body || "{}");
            if (typeof j.retry_after === "number") retryMs = Math.ceil(j.retry_after * 1000);
          } catch {}
          return resolve({ ok: false, rateLimited: true, retryMs });
        }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body });
      });
    });

    req.on("error", () => resolve({ ok: false, error: "request_failed" }));
    req.write(data);
    req.end();
  });
}

const webhookQueue = [];
let webhookBusy = false;

function enqueueWebhook(payload) {
  if (!WEBHOOK_ENABLED) return;
  webhookQueue.push(payload);
  if (!webhookBusy) void drainWebhookQueue();
}

async function drainWebhookQueue() {
  webhookBusy = true;
  while (webhookQueue.length) {
    const payload = webhookQueue.shift();
    const res = await webhookPostJson(DISCORD_WEBHOOK_URL, payload);
    if (res && res.rateLimited && res.retryMs) {
      // requeue once and sleep
      webhookQueue.unshift(payload);
      await new Promise((r) => setTimeout(r, clamp(res.retryMs, 500, 15000)));
    } else {
      // gentle pacing to reduce rate limits
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  webhookBusy = false;
}

function discordSafeText(s) {
  let t = String(s || "");
  // prevent @everyone / @here
  t = t.replace(/@everyone/g, "@\u200Beveryone").replace(/@here/g, "@\u200Bhere");
  // keep messages bounded
  if (t.length > 1800) t = t.slice(0, 1800) + "…";
  return t;
}

function discordSendText(content) {
  enqueueWebhook({ content: discordSafeText(content) });
}

function discordSendEmbed(embed) {
  const safe = embed || {};
  const e = {
    title: safeStr(safe.title || "", 256),
    description: safeStr(safe.description || "", 4096),
    fields: Array.isArray(safe.fields)
      ? safe.fields.slice(0, 25).map((f) => ({
          name: safeStr(f.name || "", 256),
          value: safeStr(f.value || "", 1024),
          inline: !!f.inline,
        }))
      : [],
  };
  if (safe.footer) e.footer = { text: safeStr(safe.footer, 2048) };
  if (safe.timestamp) e.timestamp = safe.timestamp;
  enqueueWebhook({ embeds: [e] });
}

/* ------------------------------ Request Identity --------------------------- */

function getClientIP(req) {
  // trust proxy set => req.ip should be the client
  return String(req.ip || "").trim();
}

function getClientUA(req) {
  return String(req.headers["user-agent"] || "").trim();
}

function ipHashFromReq(req) {
  const ip = getClientIP(req) || "";
  return sha256Hex(ip);
}

function deviceKeyFromReq(req) {
  // stable-ish bot detection key (hashed)
  const ip = getClientIP(req) || "";
  const ua = getClientUA(req) || "";
  return sha256Hex(`${ip}::${ua}`).slice(0, 32);
}

function socketIpHash(socket) {
  const xf = socket.handshake.headers["x-forwarded-for"];
  const ip = (Array.isArray(xf) ? xf[0] : xf || socket.handshake.address || "").split(",")[0].trim();
  return sha256Hex(ip || "");
}

function socketDeviceKey(socket) {
  const xf = socket.handshake.headers["x-forwarded-for"];
  const ip = (Array.isArray(xf) ? xf[0] : xf || socket.handshake.address || "").split(",")[0].trim();
  const ua = String(socket.handshake.headers["user-agent"] || "");
  return sha256Hex(`${ip}::${ua}`).slice(0, 32);
}

function isBannedByHashes({ ipHash, deviceKey, username }) {
  const ipList = Array.isArray(dbBans.ipHash) ? dbBans.ipHash : [];
  const dkList = Array.isArray(dbBans.deviceKey) ? dbBans.deviceKey : [];
  const uList = Array.isArray(dbBans.user) ? dbBans.user : [];
  if (username && uList.includes(String(username))) return { banned: true, reason: "user" };
  if (ipHash && ipList.includes(String(ipHash))) return { banned: true, reason: "ipHash" };
  if (deviceKey && dkList.includes(String(deviceKey))) return { banned: true, reason: "deviceKey" };
  return { banned: false };
}

/* ---------------------------- User Model Defaults -------------------------- */

function defaultSettings() {
  return {
    // experience
    compact: true,
    fontScale: 1.0, // 0.9 - 1.25
    reducedMotion: false,
    highContrast: false,
    focusRings: true,
    // sound
    soundEnabled: true,
    soundVolume: 0.6,
    mentionSound: true,
    messageSound: true,
    // cursor
    cursorEnabled: true, // default ON per request
    cursorSize: 18, // bigger default
    cursorTrail: 0.35, // 0..1
    // content filtering in private chats
    privateFilterLevel: 0, // 0 off, 1 mild, 2 strict
  };
}

function defaultUserRec(username) {
  return {
    id: nanoid(10),
    username,
    createdAt: now(),
    lastSeen: now(),
    passHash: null,
    token: null, // single active session token
    status: "online", // online|idle|dnd|invisible
    badges: ["BETA", "EARLY USER"],
    level: 1,
    xp: 0,
    messageCount: 0,
    // security tracking
    security: {
      lastLoginAt: null,
      lastIpHash: null,
      lastDeviceKey: null,
      loginHistory: [], // [{ts, ipHash, deviceKey, ok}]
    },
    settings: defaultSettings(),
    friends: [], // friends list
    blocked: [], // blocked usernames
  };
}

function ensureUser(username) {
  const u = String(username);
  if (!dbUsers[u]) dbUsers[u] = defaultUserRec(u);
  // patch missing defaults
  dbUsers[u].settings = { ...defaultSettings(), ...(dbUsers[u].settings || {}) };
  dbUsers[u].friends = Array.isArray(dbUsers[u].friends) ? dbUsers[u].friends : [];
  dbUsers[u].blocked = Array.isArray(dbUsers[u].blocked) ? dbUsers[u].blocked : [];
  dbUsers[u].badges = Array.isArray(dbUsers[u].badges) ? dbUsers[u].badges : ["BETA"];
  dbUsers[u].security = dbUsers[u].security || { loginHistory: [] };
  dbUsers[u].security.loginHistory = Array.isArray(dbUsers[u].security.loginHistory) ? dbUsers[u].security.loginHistory : [];
  return dbUsers[u];
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    status: u.status,
    createdAt: u.createdAt,
    lastSeen: u.lastSeen,
    badges: u.badges || [],
    level: u.level || 1,
  };
}

/* ------------------------------ Account Limits ----------------------------- */

function bumpOneAccountPerDay(deviceKey) {
  const day = utcDayKey();
  dbDeviceDaily[day] = dbDeviceDaily[day] || {};
  dbDeviceDaily[day][deviceKey] = (dbDeviceDaily[day][deviceKey] || 0) + 1;
  persistDeviceDaily();
  return dbDeviceDaily[day][deviceKey];
}

function creationsToday(deviceKey) {
  const day = utcDayKey();
  const rec = dbDeviceDaily[day] || {};
  return rec[deviceKey] || 0;
}

/* ------------------------------ Auto-mod (Global) -------------------------- */

// Global is STRICT: block explicit 18+ links and severe slurs.
// Mild profanity like "shit" can be allowed (you requested small words allowed).
// We implement: severe list triggers shadow mute; explicit porn links blocked.
const GLOBAL_BLOCKED_LINK_RX = new RegExp(
  [
    "pornhub",
    "xvideos",
    "xnxx",
    "redtube",
    "youporn",
    "hentai",
    "rule34",
    "onlyfans",
    "fansly",
    "sexcam",
    "cam4",
    "chaturbate",
    "spankbang",
    "erome",
  ].join("|"),
  "i"
);

// Severe hate/explicit content list (expandable)
const GLOBAL_SEVERE_RX = new RegExp(
  [
    "\\bn[i1]gg(?:a|er)\\b",
    "\\bchink\\b",
    "\\bkike\\b",
    "\\bfag(?:got)?\\b",
    "\\btrann(?:y|ies)\\b",
    "\\bwetback\\b",
    "\\bspic\\b",
    "\\bretard\\b",
    "\\bchild\\s*porn\\b",
    "\\bcp\\b",
    "\\bloli\\b",
    "\\bunderage\\b",
    "\\brape\\b",
    "\\bincest\\b",
    "\\bbeastiality\\b",
    "\\bcreampie\\b",
    "\\bgore\\b",
    "\\bsnuff\\b",
  ].join("|"),
  "i"
);

function extractUrls(text) {
  const t = String(text || "");
  const rx = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
  const out = [];
  let m;
  while ((m = rx.exec(t)) !== null) out.push(m[0]);
  return out;
}

function hasAnyUrl(text) {
  return /(https?:\/\/)/i.test(String(text || ""));
}

// shadow mute (global) time
const SHADOW_MUTE_MS = 10 * 60 * 1000;

// per-user global state for automod/rate-limit
const globalState = new Map(); // username -> { nextAllowedTs, shadowUntilTs, lastMsgNorm, lastLinkAtTs, recent[] }

function normMsg(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function baseCooldownSeconds(username) {
  // guests slower
  if (isGuest(username)) return 5;
  return 3;
}

function dynamicCooldownSeconds(username) {
  const st = globalState.get(username);
  const base = baseCooldownSeconds(username);
  if (!st) return base;

  const cutoff = now() - 10000;
  st.recent = (st.recent || []).filter((t) => t >= cutoff);
  const n = st.recent.length;

  const penalty = n >= 9 ? 3.0 : n >= 7 ? 2.0 : n >= 5 ? 1.0 : 0;
  return clamp(base + penalty, 1.5, 12);
}

function touchRecent(username) {
  const st = globalState.get(username) || {
    nextAllowedTs: 0,
    shadowUntilTs: 0,
    lastMsgNorm: "",
    lastLinkAtTs: 0,
    recent: [],
  };
  st.recent.push(now());
  globalState.set(username, st);
  return st;
}

function globalAutoModCheck(text) {
  const t = String(text || "");

  // severe words => shadow mute
  if (GLOBAL_SEVERE_RX.test(t)) return { ok: false, action: "shadow", reason: "severe_word" };

  // porn/18+ links => shadow mute
  if (hasAnyUrl(t)) {
    const urls = extractUrls(t);
    for (const u of urls) {
      if (GLOBAL_BLOCKED_LINK_RX.test(u)) return { ok: false, action: "shadow", reason: "blocked_link" };
    }
  }

  // OK
  return { ok: true };
}

/* ------------------------------ Message Storage ---------------------------- */

function pushGlobalMessage(msg) {
  dbGlobal.push(msg);
  // keep last 400
  if (dbGlobal.length > 400) dbGlobal.splice(0, dbGlobal.length - 400);
  persistGlobal();
}

function findGlobalMessage(id) {
  return dbGlobal.find((m) => m && m.id === id) || null;
}

/* ------------------------------ Groups Model ------------------------------- */

function defaultGroup(owner, name) {
  return {
    id: nanoid(10),
    name: safeStr(name, 32) || "Group Chat",
    createdAt: now(),
    updatedAt: now(),
    owner,
    members: [owner],
    limit: 10,
    cooldownSec: 3,
    rules: "Be respectful.",
    invitesEnabled: true,
    inviteCode: nanoid(12),
    // read markers for group can be tracked in dbReads
    // message store for beta:
    messages: [], // [{id,user,text,ts,editedAt?,deleted?}]
    typing: {}, // { username: ts } ephemeral
  };
}

function ensureGroup(g) {
  if (!g) return null;
  g.members = Array.isArray(g.members) ? g.members : [];
  g.messages = Array.isArray(g.messages) ? g.messages : [];
  g.limit = clamp(Number(g.limit || 10), 2, 50);
  g.cooldownSec = clamp(Number(g.cooldownSec || 3), 1.5, 12);
  g.rules = safeStr(g.rules || "Be respectful.", 2000);
  g.invitesEnabled = g.invitesEnabled !== false;
  g.inviteCode = String(g.inviteCode || nanoid(12));
  g.typing = g.typing || {};
  return g;
}

function getGroup(gid) {
  const g = dbGroups[String(gid)];
  return ensureGroup(g);
}

function saveGroup(g) {
  g.updatedAt = now();
  dbGroups[g.id] = g;
  persistGroups();
}

function groupThreadKey(gid) {
  return `group:${String(gid)}`;
}

/* ------------------------------ DM Model ----------------------------------- */

function ensureDM(a, b) {
  const key = dmKey(a, b);
  if (!dbDMs[key]) dbDMs[key] = [];
  return { key, arr: dbDMs[key] };
}

function pushDMMessage(a, b, msg) {
  const dm = ensureDM(a, b);
  dm.arr.push(msg);
  if (dm.arr.length > 300) dm.arr.splice(0, dm.arr.length - 300);
  persistDMs();
}

/* ------------------------------ Read Markers ------------------------------- */

function getLastRead(username, threadKey) {
  const u = dbReads[String(username)] || {};
  return u[String(threadKey)] || null;
}

function setLastRead(username, threadKey, msgId) {
  dbReads[String(username)] = dbReads[String(username)] || {};
  dbReads[String(username)][String(threadKey)] = String(msgId);
  persistReads();
}

/* ------------------------------ Online Tracking ---------------------------- */

const socketsByUser = new Map(); // username -> Set(socketId)
const userBySocketId = new Map(); // socketId -> username

function addOnline(username, socketId) {
  if (!socketsByUser.has(username)) socketsByUser.set(username, new Set());
  socketsByUser.get(username).add(socketId);
  userBySocketId.set(socketId, username);
}

function removeOnline(socketId) {
  const u = userBySocketId.get(socketId);
  if (!u) return;
  userBySocketId.delete(socketId);
  const set = socketsByUser.get(u);
  if (set) {
    set.delete(socketId);
    if (set.size === 0) socketsByUser.delete(u);
  }
}

function emitToUser(username, evt, payload) {
  const set = socketsByUser.get(username);
  if (!set) return;
  for (const sid of set) io.to(sid).emit(evt, payload);
}

function onlineCount() {
  // count unique users connected (not sockets)
  return socketsByUser.size;
}

/* ------------------------------ Single Session ----------------------------- */

function revokeOtherSessions(username, keepToken) {
  // Since we store a single active token per user, any other token is invalid automatically.
  // We also notify active sockets for this username to re-check token.
  emitToUser(username, "auth:revoked", { reason: "new_login" });
  // No further action needed; sockets will be kicked if they use old token.
  // (We enforce auth checks on sensitive socket events.)
}

/* ------------------------------ Badges & XP ------------------------------- */

function xpNeeded(level) {
  const L = clamp(Number(level || 1), 1, 999);
  return Math.floor(120 + L * 65 + L * L * 12);
}

function awardXP(username, amount) {
  const u = ensureUser(username);
  if (!u || isGuest(u.username)) return null;

  u.messageCount = (u.messageCount || 0) + 1;
  u.xp = (u.xp || 0) + Number(amount || 0);

  let leveled = false;
  while (u.xp >= xpNeeded(u.level)) {
    u.xp -= xpNeeded(u.level);
    u.level += 1;
    leveled = true;
  }

  // milestone badges
  if (u.level >= 10 && !u.badges.includes("LV 10")) u.badges.push("LV 10");
  if (u.level >= 25 && !u.badges.includes("LV 25")) u.badges.push("LV 25");
  if (u.level >= 50 && !u.badges.includes("LV 50")) u.badges.push("LV 50");

  persistUsers();
  return { leveled, level: u.level, xp: u.xp, next: xpNeeded(u.level), messages: u.messageCount };
}

/* ------------------------------ Express App -------------------------------- */

const app = express();
app.set("trust proxy", TRUST_PROXY_HOPS);
app.use(express.json({ limit: "1mb" }));

// Basic health
app.get("/health", (_req, res) => res.json({ ok: true, t: now() }));

// Serve static
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

// Fix: Cannot GET /
app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// SPA fallback (optional but helps if you add routes later)
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

/* ----------------------------- REST Auth Helpers --------------------------- */

function readBearerToken(req) {
  const h = String(req.headers.authorization || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function authMiddleware(req, res, next) {
  const tok = readBearerToken(req);
  if (!tok) return res.status(401).json({ ok: false, error: "unauthorized" });

  const username = Object.keys(dbUsers).find((u) => dbUsers[u] && dbUsers[u].token === tok) || null;
  if (!username) return res.status(401).json({ ok: false, error: "unauthorized" });

  const userRec = ensureUser(username);
  // banned check
  const ipHash = ipHashFromReq(req);
  const deviceKey = deviceKeyFromReq(req);
  const ban = isBannedByHashes({ ipHash, deviceKey, username });
  if (ban.banned) return res.status(403).json({ ok: false, error: "banned" });

  req.user = userRec;
  req.authToken = tok;
  next();
}

function adminMiddleware(req, res, next) {
  const k = String(req.headers["x-admin-key"] || req.query.adminKey || "");
  if (!ADMIN_KEY || k !== ADMIN_KEY) return res.status(403).json({ ok: false, error: "forbidden" });
  next();
}

/* ------------------------------ REST: Auth/Login --------------------------- */

app.post("/api/auth/login", async (req, res) => {
  const ipHash = ipHashFromReq(req);
  const deviceKey = deviceKeyFromReq(req);

  // Ban check
  const ban = isBannedByHashes({ ipHash, deviceKey, username: null });
  if (ban.banned) return res.status(403).json({ ok: false, error: "banned" });

  const username = normalizeUsername(req.body && req.body.username);
  const password = String((req.body && req.body.password) || "");
  const guest = !!(req.body && req.body.guest);

  // guest login
  if (guest) {
    // Guests are allowed but still subject to bans
    let gname = null;
    for (let i = 0; i < 120; i++) {
      const n = 1000 + Math.floor(Math.random() * 9000);
      const cand = `Guest${n}`;
      if (!dbUsers[cand]) {
        gname = cand;
        break;
      }
    }
    if (!gname) return res.status(503).json({ ok: false, error: "guest_unavailable" });

    const gu = ensureUser(gname);
    gu.passHash = null;
    gu.token = null;
    gu.status = "online";
    gu.lastSeen = now();

    // login history
    gu.security.lastLoginAt = now();
    gu.security.lastIpHash = ipHash;
    gu.security.lastDeviceKey = deviceKey;
    gu.security.loginHistory.unshift({ ts: now(), ipHash, deviceKey, ok: true });
    gu.security.loginHistory = gu.security.loginHistory.slice(0, 50);
    persistUsers();

    // webhook join log (guest)
    if (WEBHOOK_ENABLED) {
      discordSendEmbed({
        title: "New Guest Joined",
        description: `Guest session created: **${gu.username}**`,
        fields: [
          { name: "User", value: `\`${gu.username}\``, inline: true },
          { name: "Type", value: "guest", inline: true },
          { name: "When", value: `<t:${Math.floor(now() / 1000)}:F>`, inline: false },
          { name: "Device Key", value: `\`${deviceKey}\``, inline: false },
          { name: "IP Hash", value: `\`${ipHash.slice(0, 16)}…\``, inline: true },
        ],
        footer: "tonkotsu.online",
      });
    }

    return res.json({
      ok: true,
      token: null,
      isNew: false,
      user: publicUser(gu),
      guest: true,
      settings: gu.settings,
    });
  }

  // account login/create
  if (!isValidUsername(username)) return res.status(400).json({ ok: false, error: "invalid_username" });
  if (!isValidPassword(password)) return res.status(400).json({ ok: false, error: "invalid_password" });

  const existing = dbUsers[username] && dbUsers[username].passHash;

  // One-account-per-day (creation only)
  if (!existing) {
    const c = creationsToday(deviceKey);
    if (c >= 1) {
      // strict: 1 account per day per device
      return res.status(429).json({ ok: false, error: "account_creation_limit" });
    }
  }

  const u = ensureUser(username);

  // If account exists, password must match
  if (u.passHash) {
    const ok = await bcrypt.compare(password, u.passHash).catch(() => false);
    u.security.loginHistory.unshift({ ts: now(), ipHash, deviceKey, ok: !!ok });
    u.security.loginHistory = u.security.loginHistory.slice(0, 50);

    if (!ok) {
      persistUsers();
      return res.status(401).json({ ok: false, error: "incorrect_password" });
    }

    // Single session: rotate token
    const oldToken = u.token;
    u.token = crypto.randomBytes(24).toString("hex");
    u.status = "online";
    u.lastSeen = now();
    u.security.lastLoginAt = now();
    u.security.lastIpHash = ipHash;
    u.security.lastDeviceKey = deviceKey;

    persistUsers();

    if (oldToken && oldToken !== u.token) {
      revokeOtherSessions(u.username, u.token);
    }

    // webhook login
    if (WEBHOOK_ENABLED) {
      discordSendEmbed({
        title: "User Logged In",
        description: `User logged in: **${u.username}**`,
        fields: [
          { name: "User", value: `\`${u.username}\``, inline: true },
          { name: "Type", value: "login", inline: true },
          { name: "When", value: `<t:${Math.floor(now() / 1000)}:F>`, inline: false },
          { name: "Device Key", value: `\`${deviceKey}\``, inline: false },
          { name: "IP Hash", value: `\`${ipHash.slice(0, 16)}…\``, inline: true },
        ],
        footer: "tonkotsu.online",
      });
    }

    return res.json({
      ok: true,
      token: u.token,
      isNew: false,
      guest: false,
      user: publicUser(u),
      settings: u.settings,
    });
  }

  // Create new account
  const newCount = bumpOneAccountPerDay(deviceKey);
  if (newCount > 1) {
    // safety: if double-bumped
    return res.status(429).json({ ok: false, error: "account_creation_limit" });
  }

  u.passHash = await bcrypt.hash(password, 12);
  u.token = crypto.randomBytes(24).toString("hex");
  u.status = "online";
  u.createdAt = u.createdAt || now();
  u.lastSeen = now();

  u.security.lastLoginAt = now();
  u.security.lastIpHash = ipHash;
  u.security.lastDeviceKey = deviceKey;
  u.security.loginHistory.unshift({ ts: now(), ipHash, deviceKey, ok: true });
  u.security.loginHistory = u.security.loginHistory.slice(0, 50);

  // badges already include beta; keep
  persistUsers();

  // webhook join log (new account)
  if (WEBHOOK_ENABLED) {
    discordSendEmbed({
      title: "New Account Created",
      description: `New user created: **${u.username}**`,
      fields: [
        { name: "User", value: `\`${u.username}\``, inline: true },
        { name: "Type", value: "new_account", inline: true },
        { name: "When", value: `<t:${Math.floor(now() / 1000)}:F>`, inline: false },
        { name: "Device Key", value: `\`${deviceKey}\``, inline: false },
        { name: "IP Hash", value: `\`${ipHash.slice(0, 16)}…\``, inline: true },
      ],
      footer: "tonkotsu.online",
    });
  }

  return res.json({
    ok: true,
    token: u.token,
    isNew: true,
    guest: false,
    user: publicUser(u),
    settings: u.settings,
  });
});

/* ------------------------------ REST: Me/Profile --------------------------- */

app.get("/api/me", authMiddleware, (req, res) => {
  const u = req.user;
  u.lastSeen = now();
  persistUsers();

  return res.json({
    ok: true,
    user: publicUser(u),
    settings: u.settings,
    stats: {
      level: u.level,
      xp: u.xp,
      next: xpNeeded(u.level),
      messages: u.messageCount,
      createdAt: u.createdAt,
      lastSeen: u.lastSeen,
    },
  });
});

/* ------------------------------ REST: Settings ----------------------------- */

app.get("/api/settings", authMiddleware, (req, res) => {
  return res.json({ ok: true, settings: req.user.settings });
});

app.post("/api/settings", authMiddleware, (req, res) => {
  const u = req.user;
  const s = req.body && req.body.settings ? req.body.settings : req.body;

  const d = defaultSettings();
  // copy only known keys & types
  for (const k of Object.keys(d)) {
    if (typeof s?.[k] === typeof d[k]) u.settings[k] = s[k];
  }

  // clamp numeric settings
  u.settings.fontScale = clamp(Number(u.settings.fontScale || 1), 0.85, 1.35);
  u.settings.soundVolume = clamp(Number(u.settings.soundVolume || 0.6), 0, 1);
  u.settings.cursorSize = clamp(Number(u.settings.cursorSize || 18), 12, 34);
  u.settings.cursorTrail = clamp(Number(u.settings.cursorTrail || 0.35), 0, 1);
  u.settings.privateFilterLevel = clamp(Number(u.settings.privateFilterLevel || 0), 0, 2);

  persistUsers();
  return res.json({ ok: true, settings: u.settings });
});

/* ------------------------------ REST: Global Chat -------------------------- */

app.get("/api/global/history", authMiddleware, (req, res) => {
  const limit = clamp(Number(req.query.limit || 80), 10, 200);
  const items = dbGlobal.slice(-limit);
  return res.json({ ok: true, items });
});

app.post("/api/global/send", authMiddleware, (req, res) => {
  const u = req.user;
  const text = safeStr((req.body && req.body.text) || "", 1200).trim();
  if (!text) return res.status(400).json({ ok: false, error: "empty" });

  // banned check again
  const ipHash = ipHashFromReq(req);
  const deviceKey = deviceKeyFromReq(req);
  const ban = isBannedByHashes({ ipHash, deviceKey, username: u.username });
  if (ban.banned) return res.status(403).json({ ok: false, error: "banned" });

  // per-user state
  const st = touchRecent(u.username);

  // shadow mute active
  if (st.shadowUntilTs && now() < st.shadowUntilTs) {
    // pretend ok (shadow)
    const msg = { id: nanoid(12), user: u.username, text, ts: now(), shadow: true };
    // do NOT broadcast; do NOT log globally; but user sees it via ack
    return res.json({
      ok: true,
      shadow: true,
      msg,
      cooldownMs: Math.floor(dynamicCooldownSeconds(u.username) * 1000),
    });
  }

  // cooldown
  const cdSec = dynamicCooldownSeconds(u.username);
  if (now() < (st.nextAllowedTs || 0)) {
    const leftMs = Math.max(0, (st.nextAllowedTs || 0) - now());
    return res.status(429).json({ ok: false, error: "cooldown", leftMs, cooldownMs: Math.floor(cdSec * 1000) });
  }

  // automod (global strict)
  const mod = globalAutoModCheck(text);
  if (!mod.ok && mod.action === "shadow") {
    st.shadowUntilTs = now() + SHADOW_MUTE_MS;
    globalState.set(u.username, st);

    // log shadow mute to webhook
    if (WEBHOOK_ENABLED) {
      discordSendEmbed({
        title: "Auto-mod Shadow Mute (Global)",
        description: `User shadow-muted in Global.`,
        fields: [
          { name: "User", value: `\`${u.username}\``, inline: true },
          { name: "Reason", value: `\`${mod.reason}\``, inline: true },
          { name: "Duration", value: `\`${Math.floor(SHADOW_MUTE_MS / 60000)}m\``, inline: true },
          { name: "Message", value: discordSafeText(text), inline: false },
          { name: "IP Hash", value: `\`${ipHash.slice(0, 16)}…\``, inline: true },
          { name: "Device Key", value: `\`${deviceKey}\``, inline: true },
        ],
        footer: "tonkotsu.online",
      });
    }

    // pretend delivered to sender (shadow)
    return res.json({
      ok: true,
      shadow: true,
      msg: { id: nanoid(12), user: u.username, text, ts: now(), shadow: true },
      cooldownMs: Math.floor(cdSec * 1000),
    });
  }

  // anti-repeat
  const nm = normMsg(text);
  if (nm && nm === st.lastMsgNorm) {
    // allow but with extra penalty (soft)
    st.nextAllowedTs = now() + Math.floor((cdSec + 1.5) * 1000);
  } else {
    st.nextAllowedTs = now() + Math.floor(cdSec * 1000);
  }
  st.lastMsgNorm = nm;
  globalState.set(u.username, st);

  // store + broadcast
  const msg = { id: nanoid(12), user: u.username, text, ts: now() };
  pushGlobalMessage(msg);

  // webhook global log (public feed)
  if (WEBHOOK_ENABLED) {
    discordSendEmbed({
      title: "Global Message",
      description: `**${u.username}** posted in Global`,
      fields: [
        { name: "User", value: `\`${u.username}\``, inline: true },
        { name: "Message ID", value: `\`${msg.id}\``, inline: true },
        { name: "When", value: `<t:${Math.floor(msg.ts / 1000)}:F>`, inline: false },
        { name: "Content", value: discordSafeText(text), inline: false },
        { name: "IP Hash", value: `\`${ipHash.slice(0, 16)}…\``, inline: true },
        { name: "Device Key", value: `\`${deviceKey}\``, inline: true },
      ],
      footer: "tonkotsu.online",
    });
  }

  // XP
  awardXP(u.username, 6);

  // realtime
  io.emit("global:msg", msg);
  io.emit("online:update", { online: onlineCount() });

  return res.json({ ok: true, msg, cooldownMs: Math.floor(cdSec * 1000) });
});

/* --------------------------- REST: Global Edit/Delete ---------------------- */

app.post("/api/global/edit", authMiddleware, (req, res) => {
  const u = req.user;
  const id = String((req.body && req.body.id) || "");
  const newText = safeStr((req.body && req.body.text) || "", 1200).trim();
  if (!id || !newText) return res.status(400).json({ ok: false, error: "bad_request" });

  const msg = findGlobalMessage(id);
  if (!msg) return res.status(404).json({ ok: false, error: "not_found" });
  if (msg.user !== u.username) return res.status(403).json({ ok: false, error: "forbidden" });

  const ageMs = now() - Number(msg.ts || 0);
  if (ageMs > 60 * 1000) return res.status(429).json({ ok: false, error: "edit_window_expired" });

  // apply automod to edits too
  const mod = globalAutoModCheck(newText);
  if (!mod.ok && mod.action === "shadow") {
    // edits that violate -> reject hard (simpler) OR shadow mute.
    // For global: reject edit to keep the log stable.
    return res.status(400).json({ ok: false, error: "edit_blocked" });
  }

  msg.text = newText;
  msg.editedAt = now();
  persistGlobal();

  io.emit("global:edit", { id: msg.id, text: msg.text, editedAt: msg.editedAt });
  return res.json({ ok: true });
});

app.post("/api/global/delete", authMiddleware, (req, res) => {
  const u = req.user;
  const id = String((req.body && req.body.id) || "");
  if (!id) return res.status(400).json({ ok: false, error: "bad_request" });

  const msg = findGlobalMessage(id);
  if (!msg) return res.status(404).json({ ok: false, error: "not_found" });
  if (msg.user !== u.username) return res.status(403).json({ ok: false, error: "forbidden" });

  const ageMs = now() - Number(msg.ts || 0);
  if (ageMs > 60 * 1000) return res.status(429).json({ ok: false, error: "delete_window_expired" });

  msg.deleted = true;
  msg.text = "[deleted]";
  msg.deletedAt = now();
  persistGlobal();

  io.emit("global:delete", { id: msg.id, deletedAt: msg.deletedAt });
  return res.json({ ok: true });
});

/* ------------------------------ REST: Report ------------------------------- */

app.post("/api/report", authMiddleware, (req, res) => {
  const reporter = req.user.username;
  const scope = String((req.body && req.body.scope) || "global"); // global|dm|group
  const messageId = String((req.body && req.body.messageId) || "");
  const targetUser = String((req.body && req.body.targetUser) || "");
  const reason = safeStr((req.body && req.body.reason) || "reported", 200);

  const ipHash = ipHashFromReq(req);
  const deviceKey = deviceKeyFromReq(req);

  const rec = {
    id: nanoid(12),
    ts: now(),
    reporter,
    scope,
    messageId,
    targetUser,
    reason,
    ipHash,
    deviceKey,
  };

  dbReports.unshift(rec);
  dbReports = dbReports.slice(0, 500);
  persistReports();

  // Attempt to attach content context
  let content = "";
  if (scope === "global" && messageId) {
    const m = findGlobalMessage(messageId);
    if (m) content = m.text;
  }

  if (WEBHOOK_ENABLED) {
    discordSendEmbed({
      title: "Message Report",
      description: `A message was reported.`,
      fields: [
        { name: "Reporter", value: `\`${reporter}\``, inline: true },
        { name: "Scope", value: `\`${scope}\``, inline: true },
        { name: "Message ID", value: `\`${messageId || "—"}\``, inline: false },
        { name: "Target User", value: `\`${targetUser || "—"}\``, inline: true },
        { name: "Reason", value: `\`${reason}\``, inline: true },
        { name: "Content", value: content ? discordSafeText(content) : "—", inline: false },
        { name: "IP Hash", value: `\`${ipHash.slice(0, 16)}…\``, inline: true },
        { name: "Device Key", value: `\`${deviceKey}\``, inline: true },
      ],
      footer: "tonkotsu.online",
    });
  }

  return res.json({ ok: true, id: rec.id });
});

/* ------------------------------ REST: Admin Bans --------------------------- */

app.get("/api/admin/bans", adminMiddleware, (_req, res) => {
  return res.json({ ok: true, bans: dbBans });
});

app.post("/api/admin/ban", adminMiddleware, (req, res) => {
  const kind = String((req.body && req.body.kind) || "ipHash"); // ipHash|deviceKey|user
  const value = String((req.body && req.body.value) || "").trim();
  if (!value) return res.status(400).json({ ok: false, error: "missing_value" });

  dbBans.ipHash = Array.isArray(dbBans.ipHash) ? dbBans.ipHash : [];
  dbBans.deviceKey = Array.isArray(dbBans.deviceKey) ? dbBans.deviceKey : [];
  dbBans.user = Array.isArray(dbBans.user) ? dbBans.user : [];

  if (kind === "ipHash") {
    if (!dbBans.ipHash.includes(value)) dbBans.ipHash.push(value);
  } else if (kind === "deviceKey") {
    if (!dbBans.deviceKey.includes(value)) dbBans.deviceKey.push(value);
  } else if (kind === "user") {
    if (!dbBans.user.includes(value)) dbBans.user.push(value);
  } else {
    return res.status(400).json({ ok: false, error: "bad_kind" });
  }

  persistBans();

  if (WEBHOOK_ENABLED) {
    discordSendEmbed({
      title: "Admin Ban Applied",
      description: "A ban was added via admin endpoint.",
      fields: [
        { name: "Kind", value: `\`${kind}\``, inline: true },
        { name: "Value", value: `\`${value}\``, inline: false },
        { name: "When", value: `<t:${Math.floor(now() / 1000)}:F>`, inline: false },
      ],
      footer: "tonkotsu.online",
    });
  }

  return res.json({ ok: true, bans: dbBans });
});

app.post("/api/admin/unban", adminMiddleware, (req, res) => {
  const kind = String((req.body && req.body.kind) || "ipHash");
  const value = String((req.body && req.body.value) || "").trim();
  if (!value) return res.status(400).json({ ok: false, error: "missing_value" });

  dbBans.ipHash = Array.isArray(dbBans.ipHash) ? dbBans.ipHash : [];
  dbBans.deviceKey = Array.isArray(dbBans.deviceKey) ? dbBans.deviceKey : [];
  dbBans.user = Array.isArray(dbBans.user) ? dbBans.user : [];

  if (kind === "ipHash") dbBans.ipHash = dbBans.ipHash.filter((x) => x !== value);
  else if (kind === "deviceKey") dbBans.deviceKey = dbBans.deviceKey.filter((x) => x !== value);
  else if (kind === "user") dbBans.user = dbBans.user.filter((x) => x !== value);
  else return res.status(400).json({ ok: false, error: "bad_kind" });

  persistBans();
  return res.json({ ok: true, bans: dbBans });
});

/* ------------------------------ REST: Group Chats -------------------------- */

app.post("/api/groups/create", authMiddleware, (req, res) => {
  const u = req.user.username;
  const name = safeStr((req.body && req.body.name) || "Group Chat", 32);

  const g = defaultGroup(u, name);
  saveGroup(g);

  return res.json({ ok: true, group: { id: g.id, name: g.name, owner: g.owner, members: g.members, limit: g.limit, cooldownSec: g.cooldownSec } });
});

app.get("/api/groups/list", authMiddleware, (req, res) => {
  const u = req.user.username;
  const items = Object.values(dbGroups)
    .map(ensureGroup)
    .filter((g) => g && g.members.includes(u))
    .map((g) => ({
      id: g.id,
      name: g.name,
      owner: g.owner,
      membersCount: g.members.length,
      limit: g.limit,
      cooldownSec: g.cooldownSec,
    }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return res.json({ ok: true, items });
});

app.get("/api/groups/:gid", authMiddleware, (req, res) => {
  const u = req.user.username;
  const g = getGroup(req.params.gid);
  if (!g) return res.status(404).json({ ok: false, error: "not_found" });
  if (!g.members.includes(u)) return res.status(403).json({ ok: false, error: "forbidden" });

  return res.json({
    ok: true,
    group: {
      id: g.id,
      name: g.name,
      owner: g.owner,
      members: g.members,
      limit: g.limit,
      cooldownSec: g.cooldownSec,
      rules: g.rules,
      invitesEnabled: g.invitesEnabled,
      inviteCode: g.inviteCode,
    },
    isOwner: g.owner === u,
  });
});

app.post("/api/groups/:gid/rename", authMiddleware, (req, res) => {
  const u = req.user.username;
  const g = getGroup(req.params.gid);
  if (!g) return res.status(404).json({ ok: false, error: "not_found" });
  if (g.owner !== u) return res.status(403).json({ ok: false, error: "owner_only" });

  g.name = safeStr((req.body && req.body.name) || g.name, 32);
  saveGroup(g);
  io.to(groupThreadKey(g.id)).emit("group:update", { id: g.id, name: g.name });
  return res.json({ ok: true });
});

app.post("/api/groups/:gid/limit", authMiddleware, (req, res) => {
  const u = req.user.username;
  const g = getGroup(req.params.gid);
  if (!g) return res.status(404).json({ ok: false, error: "not_found" });
  if (g.owner !== u) return res.status(403).json({ ok: false, error: "owner_only" });

  const limit = clamp(Number((req.body && req.body.limit) || g.limit), 2, 50);
  // cannot set below current members
  if (limit < g.members.length) return res.status(400).json({ ok: false, error: "limit_below_members" });

  g.limit = limit;
  saveGroup(g);
  io.to(groupThreadKey(g.id)).emit("group:update", { id: g.id, limit: g.limit });
  return res.json({ ok: true });
});

app.post("/api/groups/:gid/cooldown", authMiddleware, (req, res) => {
  const u = req.user.username;
  const g = getGroup(req.params.gid);
  if (!g) return res.status(404).json({ ok: false, error: "not_found" });
  if (g.owner !== u) return res.status(403).json({ ok: false, error: "owner_only" });

  const cd = clamp(Number((req.body && req.body.cooldownSec) || g.cooldownSec), 1.5, 12);
  g.cooldownSec = cd;
  saveGroup(g);
  io.to(groupThreadKey(g.id)).emit("group:update", { id: g.id, cooldownSec: g.cooldownSec });
  return res.json({ ok: true });
});

app.post("/api/groups/:gid/rules", authMiddleware, (req, res) => {
  const u = req.user.username;
  const g = getGroup(req.params.gid);
  if (!g) return res.status(404).json({ ok: false, error: "not_found" });
  if (g.owner !== u) return res.status(403).json({ ok: false, error: "owner_only" });

  g.rules = safeStr((req.body && req.body.rules) || g.rules, 2000);
  saveGroup(g);
  io.to(groupThreadKey(g.id)).emit("group:update", { id: g.id, rules: g.rules });
  return res.json({ ok: true });
});

app.post("/api/groups/:gid/invite/toggle", authMiddleware, (req, res) => {
  const u = req.user.username;
  const g = getGroup(req.params.gid);
  if (!g) return res.status(404).json({ ok: false, error: "not_found" });
  if (g.owner !== u) return res.status(403).json({ ok: false, error: "owner_only" });

  g.invitesEnabled = !!(req.body && req.body.enabled);
  if (req.body && req.body.rotate === true) g.inviteCode = nanoid(12);
  saveGroup(g);

  return res.json({ ok: true, invitesEnabled: g.invitesEnabled, inviteCode: g.inviteCode });
});

app.post("/api/groups/join", authMiddleware, (req, res) => {
  const u = req.user.username;
  const code = String((req.body && req.body.inviteCode) || "").trim();
  if (!code) return res.status(400).json({ ok: false, error: "missing_code" });

  const g = Object.values(dbGroups).map(ensureGroup).find((x) => x && x.inviteCode === code);
  if (!g) return res.status(404).json({ ok: false, error: "invalid_code" });
  if (!g.invitesEnabled) return res.status(403).json({ ok: false, error: "invites_disabled" });

  if (g.members.includes(u)) return res.json({ ok: true, already: true, id: g.id });

  if (g.members.length >= g.limit) return res.status(403).json({ ok: false, error: "group_full" });

  g.members.push(u);
  saveGroup(g);
  io.to(groupThreadKey(g.id)).emit("group:member", { id: g.id, action: "join", user: u });
  return res.json({ ok: true, id: g.id });
});

app.post("/api/groups/:gid/members/add", authMiddleware, (req, res) => {
  const owner = req.user.username;
  const g = getGroup(req.params.gid);
  if (!g) return res.status(404).json({ ok: false, error: "not_found" });
  if (g.owner !== owner) return res.status(403).json({ ok: false, error: "owner_only" });

  const target = normalizeUsername(req.body && req.body.username);
  if (!isValidUsername(target) || !dbUsers[target] || !dbUsers[target].passHash) return res.status(404).json({ ok: false, error: "user_not_found" });
  if (g.members.includes(target)) return res.json({ ok: true, already: true });

  if (g.members.length >= g.limit) return res.status(403).json({ ok: false, error: "group_full" });

  g.members.push(target);
  saveGroup(g);

  io.to(groupThreadKey(g.id)).emit("group:member", { id: g.id, action: "add", user: target });
  return res.json({ ok: true });
});

app.post("/api/groups/:gid/members/remove", authMiddleware, (req, res) => {
  const owner = req.user.username;
  const g = getGroup(req.params.gid);
  if (!g) return res.status(404).json({ ok: false, error: "not_found" });
  if (g.owner !== owner) return res.status(403).json({ ok: false, error: "owner_only" });

  const target = normalizeUsername(req.body && req.body.username);
  if (!target) return res.status(400).json({ ok: false, error: "missing_user" });
  if (target === owner) return res.status(400).json({ ok: false, error: "cannot_remove_owner" });

  g.members = g.members.filter((x) => x !== target);
  saveGroup(g);

  io.to(groupThreadKey(g.id)).emit("group:member", { id: g.id, action: "remove", user: target });
  return res.json({ ok: true });
});

app.post("/api/groups/:gid/transfer", authMiddleware, (req, res) => {
  const owner = req.user.username;
  const g = getGroup(req.params.gid);
  if (!g) return res.status(404).json({ ok: false, error: "not_found" });
  if (g.owner !== owner) return res.status(403).json({ ok: false, error: "owner_only" });

  const target = normalizeUsername(req.body && req.body.username);
  if (!isValidUsername(target) || !g.members.includes(target)) return res.status(400).json({ ok: false, error: "target_must_be_member" });

  g.owner = target;
  saveGroup(g);

  io.to(groupThreadKey(g.id)).emit("group:update", { id: g.id, owner: g.owner });
  return res.json({ ok: true });
});

app.get("/api/groups/:gid/history", authMiddleware, (req, res) => {
  const u = req.user.username;
  const g = getGroup(req.params.gid);
  if (!g) return res.status(404).json({ ok: false, error: "not_found" });
  if (!g.members.includes(u)) return res.status(403).json({ ok: false, error: "forbidden" });

  const limit = clamp(Number(req.query.limit || 80), 10, 200);
  const items = g.messages.slice(-limit);
  return res.json({ ok: true, items });
});

app.post("/api/groups/:gid/send", authMiddleware, (req, res) => {
  const u = req.user.username;
  const g = getGroup(req.params.gid);
  if (!g) return res.status(404).json({ ok: false, error: "not_found" });
  if (!g.members.includes(u)) return res.status(403).json({ ok: false, error: "forbidden" });

  const text = safeStr((req.body && req.body.text) || "", 1200).trim();
  if (!text) return res.status(400).json({ ok: false, error: "empty" });

  // basic cooldown per group per user
  g._cooldowns = g._cooldowns || {};
  const lastTs = Number(g._cooldowns[u] || 0);
  const cdMs = Math.floor(clamp(g.cooldownSec, 1.5, 12) * 1000);
  if (now() - lastTs < cdMs) {
    return res.status(429).json({ ok: false, error: "cooldown", leftMs: cdMs - (now() - lastTs), cooldownMs: cdMs });
  }
  g._cooldowns[u] = now();

  // private chats: no webhook logging; optional client filter only (server does not block by default)
  const msg = { id: nanoid(12), user: u, text, ts: now() };
  g.messages.push(msg);
  if (g.messages.length > 300) g.messages.splice(0, g.messages.length - 300);
  saveGroup(g);

  io.to(groupThreadKey(g.id)).emit("group:msg", { gid: g.id, msg });
  awardXP(u, 4);

  return res.json({ ok: true, msg, cooldownMs: cdMs });
});

/* ------------------------------ REST: DM (beta) ---------------------------- */

app.get("/api/dm/history", authMiddleware, (req, res) => {
  const u = req.user.username;
  const other = normalizeUsername(req.query.user);
  if (!isValidUsername(other)) return res.status(400).json({ ok: false, error: "bad_user" });
  if (!dbUsers[other] || !dbUsers[other].passHash) return res.status(404).json({ ok: false, error: "not_found" });
  if (u === other) return res.status(400).json({ ok: false, error: "bad_user" });

  const k = dmKey(u, other);
  const arr = dbDMs[k] || [];
  const limit = clamp(Number(req.query.limit || 80), 10, 200);
  return res.json({ ok: true, items: arr.slice(-limit) });
});

app.post("/api/dm/send", authMiddleware, (req, res) => {
  const u = req.user.username;
  const other = normalizeUsername(req.body && req.body.user);
  if (!isValidUsername(other)) return res.status(400).json({ ok: false, error: "bad_user" });
  if (!dbUsers[other] || !dbUsers[other].passHash) return res.status(404).json({ ok: false, error: "not_found" });
  if (u === other) return res.status(400).json({ ok: false, error: "bad_user" });

  // blocked checks
  const me = ensureUser(u);
  const ot = ensureUser(other);
  if ((me.blocked || []).includes(other)) return res.status(403).json({ ok: false, error: "blocked" });
  if ((ot.blocked || []).includes(u)) return res.status(403).json({ ok: false, error: "blocked" });

  const text = safeStr((req.body && req.body.text) || "", 1200).trim();
  if (!text) return res.status(400).json({ ok: false, error: "empty" });

  const msg = { id: nanoid(12), user: u, text, ts: now() };
  pushDMMessage(u, other, msg);

  // realtime to both sides
  const thread = `dm:${dmKey(u, other)}`;
  io.to(thread).emit("dm:msg", { key: dmKey(u, other), msg });
  awardXP(u, 3);

  return res.json({ ok: true, msg });
});

/* ------------------------------ REST: Friends ------------------------------ */

app.get("/api/friends", authMiddleware, (req, res) => {
  const u = req.user;
  return res.json({ ok: true, items: u.friends || [] });
});

app.post("/api/friends/add", authMiddleware, (req, res) => {
  const me = req.user;
  const target = normalizeUsername(req.body && req.body.user);
  if (!isValidUsername(target) || !dbUsers[target] || !dbUsers[target].passHash) return res.status(404).json({ ok: false, error: "not_found" });
  if (target === me.username) return res.status(400).json({ ok: false, error: "bad_user" });

  me.friends = me.friends || [];
  if (!me.friends.includes(target)) me.friends.push(target);

  // mutual add for beta simplicity (no request flow here)
  const ot = ensureUser(target);
  ot.friends = ot.friends || [];
  if (!ot.friends.includes(me.username)) ot.friends.push(me.username);

  persistUsers();
  return res.json({ ok: true });
});

app.post("/api/block", authMiddleware, (req, res) => {
  const me = req.user;
  const target = normalizeUsername(req.body && req.body.user);
  if (!isValidUsername(target) || target === me.username) return res.status(400).json({ ok: false, error: "bad_user" });

  me.blocked = me.blocked || [];
  if (!me.blocked.includes(target)) me.blocked.push(target);
  // also remove from friends
  me.friends = (me.friends || []).filter((x) => x !== target);

  persistUsers();
  return res.json({ ok: true });
});

app.post("/api/unblock", authMiddleware, (req, res) => {
  const me = req.user;
  const target = normalizeUsername(req.body && req.body.user);
  me.blocked = (me.blocked || []).filter((x) => x !== target);
  persistUsers();
  return res.json({ ok: true });
});

/* ------------------------------ REST: Status ------------------------------- */

app.post("/api/status", authMiddleware, (req, res) => {
  const u = req.user;
  const s = String((req.body && req.body.status) || "");
  const allowed = new Set(["online", "idle", "dnd", "invisible"]);
  if (!allowed.has(s)) return res.status(400).json({ ok: false, error: "bad_status" });

  u.status = s;
  u.lastSeen = now();
  persistUsers();

  io.emit("presence:update", { user: u.username, status: u.status });
  return res.json({ ok: true, status: u.status });
});

/* ------------------------------ HTTP Server + IO --------------------------- */

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

/* ------------------------------ Socket Auth -------------------------------- */

// Socket auth: client passes {auth:{token}}.
// Guest has null token: allow connection but limited to public presence.
io.use((socket, next) => {
  const tok = String((socket.handshake.auth && socket.handshake.auth.token) || "");
  const ipHash = socketIpHash(socket);
  const deviceKey = socketDeviceKey(socket);

  const ban = isBannedByHashes({ ipHash, deviceKey, username: null });
  if (ban.banned) return next(new Error("banned"));

  if (!tok) {
    socket.data.user = null;
    socket.data.guest = true;
    socket.data.ipHash = ipHash;
    socket.data.deviceKey = deviceKey;
    return next();
  }

  const username = Object.keys(dbUsers).find((u) => dbUsers[u] && dbUsers[u].token === tok) || null;
  if (!username) return next(new Error("unauthorized"));

  const urec = ensureUser(username);
  const ban2 = isBannedByHashes({ ipHash, deviceKey, username: urec.username });
  if (ban2.banned) return next(new Error("banned"));

  socket.data.user = urec.username;
  socket.data.guest = isGuest(urec.username);
  socket.data.ipHash = ipHash;
  socket.data.deviceKey = deviceKey;
  return next();
});

/* ------------------------------ Typing State ------------------------------- */

function typingKeyFor(ctx) {
  // ctx: {type:'global'|'dm'|'group', id}
  if (!ctx || !ctx.type) return "global";
  if (ctx.type === "global") return "global";
  if (ctx.type === "group") return `group:${ctx.id}`;
  if (ctx.type === "dm") return `dm:${ctx.id}`;
  return "global";
}

// ephemeral typing map: key -> { user -> lastTs }
const typingMap = new Map();

/* ------------------------------ Socket Handlers ---------------------------- */

io.on("connection", (socket) => {
  const username = socket.data.user; // null for guest sockets connected without token
  const guest = !!socket.data.guest;

  // Track online (only if authed user)
  if (username) {
    addOnline(username, socket.id);
    io.emit("online:update", { online: onlineCount() });
  }

  socket.on("disconnect", () => {
    removeOnline(socket.id);
    io.emit("online:update", { online: onlineCount() });
  });

  function requireAuth() {
    return !!username && !!dbUsers[username];
  }

  // Join threads so realtime works:
  // - global thread implicit
  // - dm/group threads join explicitly via events from client
  socket.join("global");

  socket.on("online:get", () => {
    io.emit("online:update", { online: onlineCount() });
  });

  /* -------- Global history + send (socket variants) to match client -------- */

  socket.on("global:history", (payload, ack) => {
    if (!requireAuth()) return typeof ack === "function" ? ack({ ok: false, error: "unauthorized" }) : null;
    const limit = clamp(Number(payload && payload.limit ? payload.limit : 80), 10, 200);
    const items = dbGlobal.slice(-limit);
    if (typeof ack === "function") ack({ ok: true, items });
  });

  socket.on("global:send", (payload, ack) => {
    if (!requireAuth()) return typeof ack === "function" ? ack({ ok: false, error: "unauthorized" }) : null;

    // Reuse REST logic by calling internal pieces (simplified copy)
    const u = ensureUser(username);
    const text = safeStr(payload && payload.text ? payload.text : "", 1200).trim();
    if (!text) return typeof ack === "function" ? ack({ ok: false, error: "empty" }) : null;

    const ipHash = socket.data.ipHash;
    const deviceKey = socket.data.deviceKey;

    const ban = isBannedByHashes({ ipHash, deviceKey, username: u.username });
    if (ban.banned) return typeof ack === "function" ? ack({ ok: false, error: "banned" }) : null;

    const st = touchRecent(u.username);
    if (st.shadowUntilTs && now() < st.shadowUntilTs) {
      const msg = { id: nanoid(12), user: u.username, text, ts: now(), shadow: true };
      return typeof ack === "function"
        ? ack({ ok: true, shadow: true, msg, cooldownMs: Math.floor(dynamicCooldownSeconds(u.username) * 1000) })
        : null;
    }

    const cdSec = dynamicCooldownSeconds(u.username);
    if (now() < (st.nextAllowedTs || 0)) {
      const leftMs = Math.max(0, (st.nextAllowedTs || 0) - now());
      return typeof ack === "function" ? ack({ ok: false, error: "cooldown", leftMs, cooldownMs: Math.floor(cdSec * 1000) }) : null;
    }

    const mod = globalAutoModCheck(text);
    if (!mod.ok && mod.action === "shadow") {
      st.shadowUntilTs = now() + SHADOW_MUTE_MS;
      globalState.set(u.username, st);

      if (WEBHOOK_ENABLED) {
        discordSendEmbed({
          title: "Auto-mod Shadow Mute (Global)",
          description: `User shadow-muted in Global.`,
          fields: [
            { name: "User", value: `\`${u.username}\``, inline: true },
            { name: "Reason", value: `\`${mod.reason}\``, inline: true },
            { name: "Duration", value: `\`${Math.floor(SHADOW_MUTE_MS / 60000)}m\``, inline: true },
            { name: "Message", value: discordSafeText(text), inline: false },
            { name: "IP Hash", value: `\`${ipHash.slice(0, 16)}…\``, inline: true },
            { name: "Device Key", value: `\`${deviceKey}\``, inline: true },
          ],
          footer: "tonkotsu.online",
        });
      }

      const msg = { id: nanoid(12), user: u.username, text, ts: now(), shadow: true };
      return typeof ack === "function" ? ack({ ok: true, shadow: true, msg, cooldownMs: Math.floor(cdSec * 1000) }) : null;
    }

    const nm = normMsg(text);
    st.nextAllowedTs = now() + Math.floor((nm && nm === st.lastMsgNorm ? cdSec + 1.5 : cdSec) * 1000);
    st.lastMsgNorm = nm;
    globalState.set(u.username, st);

    const msg = { id: nanoid(12), user: u.username, text, ts: now() };
    pushGlobalMessage(msg);

    if (WEBHOOK_ENABLED) {
      discordSendEmbed({
        title: "Global Message",
        description: `**${u.username}** posted in Global`,
        fields: [
          { name: "User", value: `\`${u.username}\``, inline: true },
          { name: "Message ID", value: `\`${msg.id}\``, inline: true },
          { name: "When", value: `<t:${Math.floor(msg.ts / 1000)}:F>`, inline: false },
          { name: "Content", value: discordSafeText(text), inline: false },
          { name: "IP Hash", value: `\`${ipHash.slice(0, 16)}…\``, inline: true },
          { name: "Device Key", value: `\`${deviceKey}\``, inline: true },
        ],
        footer: "tonkotsu.online",
      });
    }

    awardXP(u.username, 6);
    io.emit("global:msg", msg);
    io.emit("online:update", { online: onlineCount() });

    if (typeof ack === "function") ack({ ok: true, msg, cooldownMs: Math.floor(cdSec * 1000) });
  });

  /* ------------------------- Typing (global/dm/group) ----------------------- */

  socket.on("typing:start", (payload) => {
    if (!requireAuth()) return;
    const ctx = payload && payload.ctx ? payload.ctx : { type: "global", id: "global" };
    const key = typingKeyFor(ctx);

    const map = typingMap.get(key) || {};
    map[username] = now();
    typingMap.set(key, map);

    if (ctx.type === "global") io.to("global").emit("typing:update", { ctx: { type: "global", id: "global" }, users: Object.keys(map).slice(0, 10) });
    else if (ctx.type === "group") io.to(groupThreadKey(ctx.id)).emit("typing:update", { ctx, users: Object.keys(map).slice(0, 10) });
    else if (ctx.type === "dm") io.to(`dm:${ctx.id}`).emit("typing:update", { ctx, users: Object.keys(map).slice(0, 10) });
  });

  socket.on("typing:stop", (payload) => {
    if (!requireAuth()) return;
    const ctx = payload && payload.ctx ? payload.ctx : { type: "global", id: "global" };
    const key = typingKeyFor(ctx);

    const map = typingMap.get(key) || {};
    delete map[username];
    typingMap.set(key, map);

    if (ctx.type === "global") io.to("global").emit("typing:update", { ctx: { type: "global", id: "global" }, users: Object.keys(map).slice(0, 10) });
    else if (ctx.type === "group") io.to(groupThreadKey(ctx.id)).emit("typing:update", { ctx, users: Object.keys(map).slice(0, 10) });
    else if (ctx.type === "dm") io.to(`dm:${ctx.id}`).emit("typing:update", { ctx, users: Object.keys(map).slice(0, 10) });
  });

  // Cleanup stale typing every 3s
  // (runs per socket connection; cheap enough for beta)
  const typingCleaner = setInterval(() => {
    const cutoff = now() - 5000;
    for (const [key, map] of typingMap.entries()) {
      let changed = false;
      for (const u of Object.keys(map || {})) {
        if (map[u] < cutoff) {
          delete map[u];
          changed = true;
        }
      }
      if (changed) typingMap.set(key, map);
    }
  }, 3000);

  socket.on("disconnect", () => {
    clearInterval(typingCleaner);
  });

  /* --------------------------- Read markers (all) --------------------------- */

  socket.on("read:mark", (payload) => {
    if (!requireAuth()) return;
    const threadKey = String(payload && payload.threadKey ? payload.threadKey : "");
    const msgId = String(payload && payload.msgId ? payload.msgId : "");
    if (!threadKey || !msgId) return;
    setLastRead(username, threadKey, msgId);
    socket.emit("read:ack", { threadKey, msgId });
  });

  socket.on("read:get", (payload, ack) => {
    if (!requireAuth()) return typeof ack === "function" ? ack({ ok: false }) : null;
    const threadKey = String(payload && payload.threadKey ? payload.threadKey : "");
    if (!threadKey) return typeof ack === "function" ? ack({ ok: false }) : null;
    const id = getLastRead(username, threadKey);
    if (typeof ack === "function") ack({ ok: true, msgId: id });
  });

  /* --------------------------- Join DM / Group Threads ---------------------- */

  socket.on("dm:join", (payload, ack) => {
    if (!requireAuth()) return typeof ack === "function" ? ack({ ok: false, error: "unauthorized" }) : null;
    const other = normalizeUsername(payload && payload.user);
    if (!isValidUsername(other) || !dbUsers[other] || !dbUsers[other].passHash) {
      return typeof ack === "function" ? ack({ ok: false, error: "not_found" }) : null;
    }
    const key = dmKey(username, other);
    socket.join(`dm:${key}`);
    if (typeof ack === "function") ack({ ok: true, key });
  });

  socket.on("group:join", (payload, ack) => {
    if (!requireAuth()) return typeof ack === "function" ? ack({ ok: false, error: "unauthorized" }) : null;
    const gid = String(payload && payload.gid ? payload.gid : "");
    const g = getGroup(gid);
    if (!g) return typeof ack === "function" ? ack({ ok: false, error: "not_found" }) : null;
    if (!g.members.includes(username)) return typeof ack === "function" ? ack({ ok: false, error: "forbidden" }) : null;

    socket.join(groupThreadKey(g.id));
    if (typeof ack === "function") ack({ ok: true });
  });

  /* --------------------------------- Presence ------------------------------ */

  socket.on("presence:set", (payload) => {
    if (!requireAuth()) return;
    const s = String(payload && payload.status ? payload.status : "");
    const allowed = new Set(["online", "idle", "dnd", "invisible"]);
    if (!allowed.has(s)) return;

    const u = ensureUser(username);
    u.status = s;
    u.lastSeen = now();
    persistUsers();

    io.emit("presence:update", { user: u.username, status: u.status });
  });
});

/* --------------------------------- Boot ----------------------------------- */

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
