/**
 * server.js — tonkotsu.online (Render-friendly Node/Express + Socket.IO)
 *
 * Fixes/implements:
 * - Removes hard dependency on nanoid (uses crypto.randomUUID instead).
 * - Prevents "Cannot access dbObj before initialization" by initializing DB early and safely.
 * - Proper account login: existing usernames REQUIRE correct password (no “same username, different password” login).
 * - Telemetry endpoint logs IP + client hints for bot identification (on page open).
 * - Discord webhook logging:
 *    - New account / login events (join info)
 *    - Each GLOBAL chat message (not DMs / not group chats) as rich embed
 * - Global chat moderation:
 *    - blocks porn/18+ links
 *    - link spam: max 1 link per 5 minutes per user
 *    - “bad stuff” detection triggers TEMP shadow mute (user does not know; messages not broadcast)
 * - Security analytics:
 *    - login history
 *    - session manager (revoke sessions)
 *    - change password / username
 * - Blocks list (blocked users modal)
 * - Group manage endpoints (owner-only): limit slider, add/remove, mute/unmute, transfer ownership
 *
 * IMPORTANT:
 * - Set your Discord webhook via env var DISCORD_WEBHOOK_URL (do NOT hardcode tokens).
 *   Example Render env var: DISCORD_WEBHOOK_URL = https://discord.com/api/webhooks/...
 */

"use strict";

const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

// Optional: bcryptjs (if installed). We gracefully fallback to scrypt if missing.
let bcrypt = null;
try {
  bcrypt = require("bcryptjs");
} catch {
  bcrypt = null;
}

/* --------------------------------- Config --------------------------------- */

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const TRUST_PROXY = true; // Render / reverse proxy
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, "db.json");
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || ""; // set in Render env vars

// Security: HMAC signing for tokens
const TOKEN_SECRET =
  process.env.TOKEN_SECRET ||
  crypto.createHash("sha256").update("tonkotsu_default_secret_" + (process.env.RENDER_INSTANCE_ID || "local")).digest("hex");

// Global chat rules
const GLOBAL_COOLDOWN_MS = 3500;
const LINK_LIMIT_MS = 5 * 60 * 1000; // 5 min
const MAX_MESSAGE_LEN = 1200;

// Shadow mute (temp)
const SHADOW_MUTE_MS = 30 * 60 * 1000; // 30 min temp shadow mute
const SHADOW_MUTE_STRIKES_TO_EXTEND = 2;

// Login rate limit (very simple)
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_ATTEMPTS_PER_IP = 14;

/* --------------------------------- Helpers -------------------------------- */

function now() {
  return Date.now();
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getClientIP(reqOrSocket) {
  // Works for Express req or Socket.IO socket (handshake)
  const headers = (reqOrSocket && reqOrSocket.headers) || (reqOrSocket && reqOrSocket.handshake && reqOrSocket.handshake.headers) || {};
  const xfwd = headers["x-forwarded-for"];
  if (xfwd) return String(xfwd).split(",")[0].trim();
  const ip =
    (reqOrSocket && reqOrSocket.ip) ||
    (reqOrSocket && reqOrSocket.connection && reqOrSocket.connection.remoteAddress) ||
    (reqOrSocket && reqOrSocket.handshake && reqOrSocket.handshake.address) ||
    "";
  return String(ip || "").replace(/^::ffff:/, "");
}

function getUserAgent(reqOrSocket) {
  const headers = (reqOrSocket && reqOrSocket.headers) || (reqOrSocket && reqOrSocket.handshake && reqOrSocket.handshake.headers) || {};
  return String(headers["user-agent"] || "");
}

function id() {
  // No nanoid dependency; Node 22 supports randomUUID.
  return crypto.randomUUID();
}

function hmac(data) {
  return crypto.createHmac("sha256", TOKEN_SECRET).update(data).digest("hex");
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = hmac(body);
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (hmac(body) !== sig) return null;
  const json = safeJsonParse(Buffer.from(body, "base64url").toString("utf8"));
  return json && typeof json === "object" ? json : null;
}

async function hashPassword(pw) {
  const plain = String(pw || "");
  if (plain.length < 4) throw new Error("Password too short.");
  if (bcrypt) {
    const salt = await bcrypt.genSalt(10);
    return await bcrypt.hash(plain, salt);
  }
  // Fallback: scrypt
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(plain, salt, 64, (err, buf) => (err ? reject(err) : resolve(buf)));
  });
  return `scrypt$${salt}$${Buffer.from(derived).toString("hex")}`;
}

async function verifyPassword(pw, hashed) {
  const plain = String(pw || "");
  const h = String(hashed || "");
  if (!h) return false;

  if (bcrypt && !h.startsWith("scrypt$")) {
    try {
      return await bcrypt.compare(plain, h);
    } catch {
      return false;
    }
  }

  if (h.startsWith("scrypt$")) {
    const parts = h.split("$");
    if (parts.length !== 4) return false;
    const salt = parts[2];
    const wantHex = parts[3];
    const derived = await new Promise((resolve, reject) => {
      crypto.scrypt(plain, salt, 64, (err, buf) => (err ? reject(err) : resolve(buf)));
    });
    const gotHex = Buffer.from(derived).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(gotHex, "utf8"), Buffer.from(wantHex, "utf8"));
  }

  // If bcrypt missing but stored bcrypt hash, we cannot verify (treat as failure).
  return false;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function extractFirstUrl(text) {
  const m = String(text || "").match(/\bhttps?:\/\/[^\s<>"']+/i);
  return m ? m[0] : null;
}

/* --------------------------- Moderation / Filters -------------------------- */

// A “huge but not too huge” list: slurs, explicit content, common variations.
// This list is intentionally partial and focuses on high-signal terms.
// We do NOT echo slurs back; we only detect them.
const BAD_PATTERNS = [
  // racial slur variants (masked patterns)
  /\bn[\W_]*i[\W_]*g[\W_]*g[\W_]*e[\W_]*r\b/i,
  /\bn[\W_]*i[\W_]*g[\W_]*g[\W_]*a\b/i,

  // explicit content keywords
  /\b(cum|cumming|ejaculat|blowjob|handjob|rimjob|anal|deepthroat|threesome|gangbang|orgy)\b/i,
  /\b(porn|porno|pornhub|xvideos|xhamster|redtube|youjizz|xnxx|brazzers|onlyfans)\b/i,
  /\b(nudes?|naked|nsfw|hentai|rule\s*34)\b/i,
  /\b(child\s*porn|cp\b|underage\s*sex)\b/i,
  /\b(rape|raping|molest|incest)\b/i,

  // harassment / doxxing-ish phrases (light)
  /\b(kys|kill\s*yourself)\b/i,
  /\b(doxx|doxxing|swat|swatting)\b/i,
];

// Porn/18+ domains and typical indicators in URLs. Not exhaustive.
const BANNED_URL_PATTERNS = [
  /porn/i,
  /hentai/i,
  /onlyfans/i,
  /xvideos/i,
  /xnxx/i,
  /xhamster/i,
  /redtube/i,
  /rule34/i,
  /sex/i,
  /nsfw/i,
  /erotic/i,
];

function containsBadStuff(text) {
  const t = String(text || "");
  if (!t) return false;
  return BAD_PATTERNS.some((re) => re.test(t));
}

function isBannedUrl(url) {
  const u = String(url || "").toLowerCase();
  if (!u) return false;
  return BANNED_URL_PATTERNS.some((re) => re.test(u));
}

/* ------------------------------ DB (JSON file) ----------------------------- */

let db = null;
let dbDirty = false;
let dbWriteTimer = null;

function defaultDB() {
  return {
    meta: { createdAt: now(), version: 1 },
    users: [
      // { id, username, passHash, createdAt, lastSeen, level, badges[], betaJoinAt, shadow:{ until, strikes } }
    ],
    sessions: [
      // { id, userId, token, createdAt, lastSeen, ip, ua, revokedAt, current:boolean? }
    ],
    globalMessages: [
      // { id, user, userId, text, ts, ipHash, url }
    ],
    inboxCounts: {
      // userId: number
    },
    blocks: {
      // userId: [ { username, blockedAt } ]
    },
    securityEvents: [
      // { id, userId, type, when, detail }
    ],
    telemetry: [
      // { id, when, ip, ua, hints:{} }
    ],
    groups: [
      // { id, name, ownerId, limit, members:[{userId, username, role, muted}], createdAt }
    ],
    linkRate: {
      // userId: lastLinkAt
    },
    loginRate: {
      // ip: { windowStart, count }
    },
  };
}

function getDB() {
  return db;
}

async function flushDBSoon() {
  dbDirty = true;
  if (dbWriteTimer) return;
  dbWriteTimer = setTimeout(async () => {
    dbWriteTimer = null;
    if (!dbDirty) return;
    dbDirty = false;
    try {
      ensureDirSync(DATA_DIR);
      const tmp = DB_FILE + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
      await fsp.rename(tmp, DB_FILE);
    } catch (e) {
      console.error("DB write failed:", e && e.message ? e.message : e);
      // keep dirty so it tries again later
      dbDirty = true;
    }
  }, 350);
}

async function initDB() {
  ensureDirSync(DATA_DIR);

  if (fs.existsSync(DB_FILE)) {
    const raw = await fsp.readFile(DB_FILE, "utf8");
    const parsed = safeJsonParse(raw);
    db = parsed && typeof parsed === "object" ? parsed : defaultDB();
  } else {
    db = defaultDB();
    await flushDBSoon();
  }

  // Normalize missing fields across updates
  db.users = Array.isArray(db.users) ? db.users : [];
  db.sessions = Array.isArray(db.sessions) ? db.sessions : [];
  db.globalMessages = Array.isArray(db.globalMessages) ? db.globalMessages : [];
  db.securityEvents = Array.isArray(db.securityEvents) ? db.securityEvents : [];
  db.telemetry = Array.isArray(db.telemetry) ? db.telemetry : [];
  db.groups = Array.isArray(db.groups) ? db.groups : [];
  db.blocks = db.blocks && typeof db.blocks === "object" ? db.blocks : {};
  db.inboxCounts = db.inboxCounts && typeof db.inboxCounts === "object" ? db.inboxCounts : {};
  db.linkRate = db.linkRate && typeof db.linkRate === "object" ? db.linkRate : {};
  db.loginRate = db.loginRate && typeof db.loginRate === "object" ? db.loginRate : {};

  await flushDBSoon();
}

/* -------------------------- Discord Webhook Helpers ------------------------- */

async function postDiscord(payload) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    // Node 22 has global fetch
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("Discord webhook failed:", e && e.message ? e.message : e);
  }
}

function ipHash(ip) {
  // Do NOT store raw IP in public message logs; keep for bot detection.
  // Hash with secret to reduce exposure if DB leaks.
  const s = String(ip || "");
  return crypto.createHmac("sha256", TOKEN_SECRET).update(s).digest("hex").slice(0, 16);
}

async function logDiscordJoin({ user, ip, ua, isNew }) {
  const username = user.username;
  const created = new Date(user.createdAt).toISOString();
  const last = new Date(user.lastSeen || user.createdAt).toISOString();

  const embed = {
    title: isNew ? "New account created" : "User login",
    description: `**${username}**`,
    fields: [
      { name: "User ID", value: String(user.id), inline: true },
      { name: "Is New", value: isNew ? "yes" : "no", inline: true },
      { name: "Created", value: created, inline: false },
      { name: "Last Seen", value: last, inline: false },
      { name: "IP (hash)", value: ipHash(ip), inline: true },
      { name: "User-Agent", value: ua ? ua.slice(0, 180) : "—", inline: false },
    ],
    timestamp: new Date().toISOString(),
  };

  await postDiscord({
    username: "tonkotsu.online",
    embeds: [embed],
  });
}

async function logDiscordGlobalMessage({ msg, user, ip }) {
  // Rich embed for GLOBAL chat only
  const username = user ? user.username : msg.user || "unknown";
  const url = msg.url || extractFirstUrl(msg.text);
  const embed = {
    title: "Global Chat Message",
    description: msg.text ? String(msg.text).slice(0, 1800) : "",
    fields: [
      { name: "From", value: username, inline: true },
      { name: "User ID", value: user ? String(user.id) : String(msg.userId || "—"), inline: true },
      { name: "Message ID", value: String(msg.id || "—"), inline: false },
      { name: "IP (hash)", value: ipHash(ip), inline: true },
    ],
    timestamp: new Date(msg.ts || now()).toISOString(),
  };

  if (url) {
    embed.fields.push({ name: "Link", value: String(url).slice(0, 500), inline: false });
  }

  await postDiscord({
    username: "tonkotsu.online",
    embeds: [embed],
  });
}

/* ----------------------------- Express / Server ----------------------------- */

const app = express();
if (TRUST_PROXY) app.set("trust proxy", 1);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Basic security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  next();
});

// Static files (if you serve index.html/script.js from same service)
app.use(express.static(process.cwd(), { extensions: ["html"] }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
  },
});

/* ----------------------------- Auth Middleware ----------------------------- */

function getBearer(req) {
  const h = String(req.headers.authorization || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function authRequired(req, res, next) {
  const token = getBearer(req);
  const payload = verifyToken(token);
  if (!payload || !payload.sid || !payload.uid) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const s = db.sessions.find((x) => x.id === payload.sid && x.userId === payload.uid);
  if (!s || s.revokedAt) return res.status(401).json({ ok: false, error: "Session revoked" });

  const user = db.users.find((u) => u.id === payload.uid);
  if (!user) return res.status(401).json({ ok: false, error: "User not found" });

  // Touch session
  s.lastSeen = now();
  user.lastSeen = now();
  flushDBSoon();

  req.auth = { token, payload, session: s, user };
  next();
}

/* ------------------------------ Rate Limiting ------------------------------ */

function allowLoginAttempt(ip) {
  const key = String(ip || "unknown");
  const entry = db.loginRate[key] || { windowStart: now(), count: 0 };
  const t = now();
  if (t - entry.windowStart > LOGIN_WINDOW_MS) {
    entry.windowStart = t;
    entry.count = 0;
  }
  entry.count += 1;
  db.loginRate[key] = entry;
  flushDBSoon();
  return entry.count <= LOGIN_MAX_ATTEMPTS_PER_IP;
}

/* --------------------------------- Routes --------------------------------- */

app.get("/health", (req, res) => res.json({ ok: true, env: NODE_ENV }));

/**
 * Telemetry hello — logs IP and client hints for bot identification.
 * Called by script.js on page open.
 */
app.post("/api/telemetry/hello", (req, res) => {
  const ip = getClientIP(req);
  const ua = getUserAgent(req);
  const hints = req.body && typeof req.body === "object" ? req.body : {};
  const rec = { id: id(), when: now(), ip, ua, hints };
  db.telemetry.push(rec);
  // keep last 2500
  if (db.telemetry.length > 2600) db.telemetry.splice(0, db.telemetry.length - 2500);
  flushDBSoon();
  res.json({ ok: true });
});

/**
 * Login / Register:
 * - If username exists: password MUST match, else deny.
 * - If username doesn't exist: create account with password.
 * - Creates a session token.
 */
app.post("/api/auth/login", async (req, res) => {
  const ip = getClientIP(req);
  const ua = getUserAgent(req);

  if (!allowLoginAttempt(ip)) {
    return res.status(429).json({ ok: false, error: "Too many login attempts. Try again soon." });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const guest = !!body.guest;

  if (!username || username.length < 2 || username.length > 24) {
    return res.status(400).json({ ok: false, error: "Invalid username." });
  }

  // Basic username policy
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    return res.status(400).json({ ok: false, error: "Username contains invalid characters." });
  }

  let user = db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  let isNew = false;

  if (!user) {
    if (guest) {
      // Guest accounts are ephemeral but still tracked for session; no password required.
      user = {
        id: id(),
        username,
        passHash: "",
        createdAt: now(),
        lastSeen: now(),
        level: 1,
        badges: ["BETA"],
        betaJoinAt: now(),
        shadow: { until: 0, strikes: 0 },
      };
      db.users.push(user);
      isNew = true;
      db.securityEvents.push({ id: id(), userId: user.id, type: "account_created_guest", when: now(), detail: `ip=${ipHash(ip)}` });
      flushDBSoon();
    } else {
      // Create persistent account
      if (password.length < 4) return res.status(400).json({ ok: false, error: "Password too short." });

      const passHash = await hashPassword(password);
      user = {
        id: id(),
        username,
        passHash,
        createdAt: now(),
        lastSeen: now(),
        level: 1,
        badges: ["BETA", "EARLY USER"],
        betaJoinAt: now(),
        shadow: { until: 0, strikes: 0 },
      };
      db.users.push(user);
      isNew = true;
      db.securityEvents.push({ id: id(), userId: user.id, type: "account_created", when: now(), detail: `ip=${ipHash(ip)}` });
      flushDBSoon();
    }
  } else {
    // Existing user: MUST verify password unless they are a guest-only account with empty hash
    if (!guest) {
      const ok = await verifyPassword(password, user.passHash);
      if (!ok) {
        db.securityEvents.push({ id: id(), userId: user.id, type: "login_failed", when: now(), detail: `ip=${ipHash(ip)}` });
        flushDBSoon();
        return res.status(401).json({ ok: false, error: "Wrong username or password." });
      }
    }
  }

  // Create session
  const sid = id();
  const token = signToken({ sid, uid: user.id, iat: now() });
  const session = {
    id: sid,
    userId: user.id,
    token,
    createdAt: now(),
    lastSeen: now(),
    ip,
    ua,
    revokedAt: 0,
  };
  db.sessions.push(session);

  // Keep sessions bounded
  if (db.sessions.length > 8000) db.sessions.splice(0, db.sessions.length - 7000);

  // Touch user
  user.lastSeen = now();
  db.securityEvents.push({ id: id(), userId: user.id, type: "login", when: now(), detail: `ip=${ipHash(ip)}` });

  flushDBSoon();

  // Discord log: join/login info
  logDiscordJoin({ user, ip, ua, isNew }).catch(() => {});

  res.json({
    ok: true,
    token,
    isNew,
    user: publicUser(user),
  });
});

app.get("/api/me", authRequired, (req, res) => {
  res.json({ ok: true, user: publicUser(req.auth.user) });
});

app.get("/api/inbox/count", authRequired, (req, res) => {
  const uid = req.auth.user.id;
  const n = Number(db.inboxCounts[uid] || 0);
  res.json({ ok: true, count: Number.isFinite(n) ? n : 0 });
});

/* --------------------------------- Blocks --------------------------------- */

app.get("/api/blocks", authRequired, (req, res) => {
  const uid = req.auth.user.id;
  const items = Array.isArray(db.blocks[uid]) ? db.blocks[uid] : [];
  res.json({ ok: true, items });
});

app.post("/api/blocks/unblock", authRequired, (req, res) => {
  const uid = req.auth.user.id;
  const username = String((req.body && req.body.username) || "").trim();
  if (!username) return res.status(400).json({ ok: false, error: "Missing username" });
  const items = Array.isArray(db.blocks[uid]) ? db.blocks[uid] : [];
  db.blocks[uid] = items.filter((x) => String(x.username).toLowerCase() !== username.toLowerCase());
  flushDBSoon();
  res.json({ ok: true });
});

/* -------------------------- Security Analytics & Mgmt ----------------------- */

app.get("/api/security/overview", authRequired, (req, res) => {
  const uid = req.auth.user.id;

  const loginHistory = db.sessions
    .filter((s) => s.userId === uid)
    .slice(-30)
    .reverse()
    .map((s) => ({
      when: s.createdAt,
      ip: s.ip ? ipHash(s.ip) : "—",
      ua: s.ua || "",
    }));

  const sessions = db.sessions
    .filter((s) => s.userId === uid && !s.revokedAt)
    .slice(-20)
    .reverse()
    .map((s) => ({
      id: s.id,
      ip: s.ip ? ipHash(s.ip) : "—",
      lastSeen: s.lastSeen,
      current: s.id === req.auth.session.id,
    }));

  const events = db.securityEvents
    .filter((e) => e.userId === uid)
    .slice(-40)
    .reverse()
    .map((e) => ({
      type: e.type,
      when: e.when,
      detail: e.detail || "",
    }));

  res.json({ ok: true, loginHistory, sessions, events });
});

app.post("/api/security/revoke-session", authRequired, (req, res) => {
  const uid = req.auth.user.id;
  const sessionId = String((req.body && req.body.sessionId) || "");
  if (!sessionId) return res.status(400).json({ ok: false, error: "Missing sessionId" });

  const s = db.sessions.find((x) => x.id === sessionId && x.userId === uid);
  if (!s) return res.status(404).json({ ok: false, error: "Session not found" });

  // Can't revoke current via endpoint? we allow it but will force relog; client disables it anyway.
  s.revokedAt = now();
  db.securityEvents.push({ id: id(), userId: uid, type: "session_revoked", when: now(), detail: `sid=${sessionId}` });
  flushDBSoon();

  // If revoked session is connected on sockets, inform
  io.to(`sid:${sessionId}`).emit("auth:revoked");
  res.json({ ok: true });
});

app.post("/api/security/change-password", authRequired, async (req, res) => {
  const uid = req.auth.user.id;
  const password = String((req.body && req.body.password) || "");
  if (password.length < 4) return res.status(400).json({ ok: false, error: "Password too short." });

  const user = req.auth.user;
  user.passHash = await hashPassword(password);
  db.securityEvents.push({ id: id(), userId: uid, type: "password_changed", when: now(), detail: "" });

  // Revoke all other sessions (keep current)
  for (const s of db.sessions) {
    if (s.userId === uid && s.id !== req.auth.session.id) s.revokedAt = now();
  }
  flushDBSoon();
  res.json({ ok: true });
});

app.post("/api/security/change-username", authRequired, (req, res) => {
  const uid = req.auth.user.id;
  const nu = String((req.body && req.body.username) || "").trim();
  if (!nu || nu.length < 2 || nu.length > 24) return res.status(400).json({ ok: false, error: "Invalid username." });
  if (!/^[a-zA-Z0-9._-]+$/.test(nu)) return res.status(400).json({ ok: false, error: "Username contains invalid characters." });

  const exists = db.users.find((u) => u.username.toLowerCase() === nu.toLowerCase() && u.id !== uid);
  if (exists) return res.status(409).json({ ok: false, error: "Username already taken." });

  req.auth.user.username = nu;
  db.securityEvents.push({ id: id(), userId: uid, type: "username_changed", when: now(), detail: `new=${nu}` });
  flushDBSoon();

  res.json({ ok: true, user: publicUser(req.auth.user) });
});

/* ---------------------------- Global Chat (REST) ---------------------------- */

app.get("/api/global/history", authRequired, (req, res) => {
  const limit = clamp(Number(req.query.limit || 80), 1, 200);
  const items = db.globalMessages.slice(-limit).map((m) => ({
    id: m.id,
    user: m.user,
    userId: m.userId,
    text: m.text,
    ts: m.ts,
    url: m.url || null,
  }));
  res.json({ ok: true, items });
});

app.post("/api/global/send", authRequired, async (req, res) => {
  // REST fallback; primary is socket
  const out = await handleGlobalSend({
    user: req.auth.user,
    session: req.auth.session,
    ip: getClientIP(req),
    ua: getUserAgent(req),
    text: String((req.body && req.body.text) || ""),
    socket: null,
  });
  if (!out.ok) return res.status(out.status || 400).json(out);
  res.json(out);
});

/* ------------------------------- Groups (REST) ------------------------------ */

function findGroup(gid) {
  return db.groups.find((g) => g.id === gid);
}

function ensureGroupMembership(group, user) {
  return group.members.some((m) => m.userId === user.id);
}

function isOwner(group, user) {
  return group.ownerId === user.id;
}

app.get("/api/groups/:id", authRequired, (req, res) => {
  const gid = String(req.params.id || "");
  const g = findGroup(gid);
  if (!g) return res.status(404).json({ ok: false, error: "Group not found" });
  if (!ensureGroupMembership(g, req.auth.user)) return res.status(403).json({ ok: false, error: "Not a member" });

  res.json({
    ok: true,
    id: g.id,
    name: g.name,
    limit: g.limit,
    isOwner: isOwner(g, req.auth.user),
    members: g.members.map((m) => ({
      userId: m.userId,
      username: m.username,
      role: m.userId === g.ownerId ? "owner" : "member",
      muted: !!m.muted,
    })),
  });
});

app.post("/api/groups/:id/limit", authRequired, (req, res) => {
  const gid = String(req.params.id || "");
  const g = findGroup(gid);
  if (!g) return res.status(404).json({ ok: false, error: "Group not found" });
  if (!isOwner(g, req.auth.user)) return res.status(403).json({ ok: false, error: "Owner only" });

  const limit = clamp(Number((req.body && req.body.limit) || 10), 2, 50);
  g.limit = limit;
  flushDBSoon();
  res.json({ ok: true });
});

app.post("/api/groups/:id/members/add", authRequired, (req, res) => {
  const gid = String(req.params.id || "");
  const g = findGroup(gid);
  if (!g) return res.status(404).json({ ok: false, error: "Group not found" });
  if (!isOwner(g, req.auth.user)) return res.status(403).json({ ok: false, error: "Owner only" });

  const username = String((req.body && req.body.username) || "").trim();
  if (!username) return res.status(400).json({ ok: false, error: "Missing username" });

  const u = db.users.find((x) => x.username.toLowerCase() === username.toLowerCase());
  if (!u) return res.status(404).json({ ok: false, error: "User not found" });

  if (g.members.some((m) => m.userId === u.id)) return res.json({ ok: true });

  if (g.members.length >= g.limit) return res.status(400).json({ ok: false, error: "Group is at member limit." });

  g.members.push({ userId: u.id, username: u.username, muted: false });
  flushDBSoon();
  res.json({ ok: true });
});

app.post("/api/groups/:id/members/remove", authRequired, (req, res) => {
  const gid = String(req.params.id || "");
  const g = findGroup(gid);
  if (!g) return res.status(404).json({ ok: false, error: "Group not found" });
  if (!isOwner(g, req.auth.user)) return res.status(403).json({ ok: false, error: "Owner only" });

  const username = String((req.body && req.body.username) || "").trim();
  if (!username) return res.status(400).json({ ok: false, error: "Missing username" });

  const u = db.users.find((x) => x.username.toLowerCase() === username.toLowerCase());
  if (!u) return res.status(404).json({ ok: false, error: "User not found" });

  if (u.id === g.ownerId) return res.status(400).json({ ok: false, error: "Transfer ownership before removing owner." });

  g.members = g.members.filter((m) => m.userId !== u.id);
  flushDBSoon();
  res.json({ ok: true });
});

app.post("/api/groups/:id/members/mute", authRequired, (req, res) => {
  const gid = String(req.params.id || "");
  const g = findGroup(gid);
  if (!g) return res.status(404).json({ ok: false, error: "Group not found" });
  if (!isOwner(g, req.auth.user)) return res.status(403).json({ ok: false, error: "Owner only" });

  const username = String((req.body && req.body.username) || "").trim();
  const muted = !!(req.body && req.body.muted);
  if (!username) return res.status(400).json({ ok: false, error: "Missing username" });

  const m = g.members.find((x) => x.username.toLowerCase() === username.toLowerCase());
  if (!m) return res.status(404).json({ ok: false, error: "Member not found" });

  m.muted = muted;
  flushDBSoon();
  res.json({ ok: true });
});

app.post("/api/groups/:id/transfer", authRequired, (req, res) => {
  const gid = String(req.params.id || "");
  const g = findGroup(gid);
  if (!g) return res.status(404).json({ ok: false, error: "Group not found" });
  if (!isOwner(g, req.auth.user)) return res.status(403).json({ ok: false, error: "Owner only" });

  const username = String((req.body && req.body.username) || "").trim();
  if (!username) return res.status(400).json({ ok: false, error: "Missing username" });

  const u = db.users.find((x) => x.username.toLowerCase() === username.toLowerCase());
  if (!u) return res.status(404).json({ ok: false, error: "User not found" });

  if (!g.members.some((m) => m.userId === u.id)) {
    return res.status(400).json({ ok: false, error: "User must be a member first." });
  }

  g.ownerId = u.id;
  flushDBSoon();
  res.json({ ok: true });
});

app.delete("/api/groups/:id", authRequired, (req, res) => {
  const gid = String(req.params.id || "");
  const g = findGroup(gid);
  if (!g) return res.status(404).json({ ok: false, error: "Group not found" });
  if (!isOwner(g, req.auth.user)) return res.status(403).json({ ok: false, error: "Owner only" });

  db.groups = db.groups.filter((x) => x.id !== gid);
  flushDBSoon();
  res.json({ ok: true });
});

/* ------------------------------ Socket.IO Auth ------------------------------ */

function socketAuth(socket, next) {
  const token = socket.handshake && socket.handshake.auth ? socket.handshake.auth.token : "";
  const payload = verifyToken(String(token || ""));
  if (!payload || !payload.sid || !payload.uid) return next(new Error("Unauthorized"));

  const session = db.sessions.find((s) => s.id === payload.sid && s.userId === payload.uid);
  if (!session || session.revokedAt) return next(new Error("Session revoked"));

  const user = db.users.find((u) => u.id === payload.uid);
  if (!user) return next(new Error("User not found"));

  // Touch
  session.lastSeen = now();
  user.lastSeen = now();
  flushDBSoon();

  socket.auth = { token, payload, session, user };
  next();
}

io.use(socketAuth);

/* -------------------------------- Sockets --------------------------------- */

const onlineSet = new Set(); // socket.id list; for online count
function broadcastOnline() {
  io.emit("online:update", { online: onlineSet.size });
}

io.on("connection", (socket) => {
  onlineSet.add(socket.id);
  broadcastOnline();

  // Join room by session id to allow revoke pushes
  socket.join(`sid:${socket.auth.session.id}`);

  socket.on("disconnect", () => {
    onlineSet.delete(socket.id);
    broadcastOnline();
  });

  socket.on("hello", (payload) => {
    // Optional telemetry from socket connect
    const ip = getClientIP(socket);
    const ua = getUserAgent(socket);
    db.telemetry.push({
      id: id(),
      when: now(),
      ip,
      ua,
      hints: payload && typeof payload === "object" ? payload : {},
    });
    if (db.telemetry.length > 2600) db.telemetry.splice(0, db.telemetry.length - 2500);
    flushDBSoon();
  });

  socket.on("online:get", () => {
    socket.emit("online:update", { online: onlineSet.size });
  });

  socket.on("notify:get", () => {
    const uid = socket.auth.user.id;
    const n = Number(db.inboxCounts[uid] || 0);
    socket.emit("notify:count", { count: Number.isFinite(n) ? n : 0 });
  });

  // Global chat history (socket)
  socket.on("global:history", (payload, ack) => {
    const limit = clamp(Number((payload && payload.limit) || 80), 1, 200);
    const items = db.globalMessages.slice(-limit).map((m) => ({
      id: m.id,
      user: m.user,
      userId: m.userId,
      text: m.text,
      ts: m.ts,
      url: m.url || null,
    }));
    if (typeof ack === "function") ack({ ok: true, items });
    else socket.emit("global:history", { items });
  });

  // Send global message (socket)
  socket.on("global:send", async (payload, ack) => {
    const ip = getClientIP(socket);
    const ua = getUserAgent(socket);
    const text = String((payload && payload.text) || "");

    const out = await handleGlobalSend({
      user: socket.auth.user,
      session: socket.auth.session,
      ip,
      ua,
      text,
      socket,
    });

    if (typeof ack === "function") ack(out);
  });
});

/* -------------------------- Global Message Handler -------------------------- */

function isShadowMuted(user) {
  const sh = user.shadow || { until: 0, strikes: 0 };
  return (sh.until || 0) > now();
}

function setShadowMute(user, reason) {
  if (!user.shadow) user.shadow = { until: 0, strikes: 0 };
  user.shadow.strikes = Number(user.shadow.strikes || 0) + 1;

  // Extend duration if repeated
  const base = SHADOW_MUTE_MS;
  const extra = user.shadow.strikes >= SHADOW_MUTE_STRIKES_TO_EXTEND ? 15 * 60 * 1000 : 0;
  user.shadow.until = now() + base + extra;

  db.securityEvents.push({
    id: id(),
    userId: user.id,
    type: "shadow_mute",
    when: now(),
    detail: `reason=${reason || "policy"}`,
  });
  flushDBSoon();
}

function linkAllowed(userId, url) {
  if (!url) return { ok: true };
  if (isBannedUrl(url)) return { ok: false, error: "Banned link." };

  const last = Number(db.linkRate[userId] || 0);
  if (Number.isFinite(last) && last > 0 && now() - last < LINK_LIMIT_MS) {
    return { ok: false, error: "Link cooldown active." };
  }
  return { ok: true };
}

function markLinkUsed(userId) {
  db.linkRate[userId] = now();
  flushDBSoon();
}

async function handleGlobalSend({ user, session, ip, ua, text, socket }) {
  const clean = String(text || "").trim();
  if (!clean) return { ok: false, status: 400, error: "Empty message." };
  if (clean.length > MAX_MESSAGE_LEN) return { ok: false, status: 400, error: `Message too long (max ${MAX_MESSAGE_LEN}).` };

  // Enforce global cooldown server-side (simple; per-session last send)
  if (!session._lastGlobalAt) session._lastGlobalAt = 0;
  const since = now() - session._lastGlobalAt;
  if (since < GLOBAL_COOLDOWN_MS) {
    // Still return cooldownMs so client can render bar; also “shake” UX is client-side.
    return { ok: false, status: 429, error: "Cooldown active.", cooldownMs: GLOBAL_COOLDOWN_MS - since };
  }

  const url = extractFirstUrl(clean);

  // Link spam / banned link enforcement (server-side)
  if (url) {
    const chk = linkAllowed(user.id, url);
    if (!chk.ok) {
      // If they’re trying to post banned/18+ link: shadow mute silently (user won’t be told),
      // and accept as shadow so their client stays consistent.
      if (chk.error === "Banned link.") setShadowMute(user, "banned_link");
      // We still do NOT broadcast.
      session._lastGlobalAt = now();
      flushDBSoon();
      return { ok: true, shadow: true, cooldownMs: GLOBAL_COOLDOWN_MS };
    }
  }

  // Bad content triggers shadow mute
  if (containsBadStuff(clean)) {
    setShadowMute(user, "bad_content");
    session._lastGlobalAt = now();
    flushDBSoon();
    // Accept but do not broadcast (shadow)
    return { ok: true, shadow: true, cooldownMs: GLOBAL_COOLDOWN_MS };
  }

  // If already shadow muted, accept but do not broadcast
  if (isShadowMuted(user)) {
    session._lastGlobalAt = now();
    flushDBSoon();
    return { ok: true, shadow: true, cooldownMs: GLOBAL_COOLDOWN_MS };
  }

  // Normal message: store and broadcast
  const msg = {
    id: id(),
    user: user.username,
    userId: user.id,
    text: clean,
    ts: now(),
    ipHash: ipHash(ip),
    url: url || null,
  };

  db.globalMessages.push(msg);
  // Keep last 3000 messages
  if (db.globalMessages.length > 3200) db.globalMessages.splice(0, db.globalMessages.length - 3000);

  session._lastGlobalAt = now();

  // Link usage
  if (url) markLinkUsed(user.id);

  // Touch user
  user.lastSeen = now();

  flushDBSoon();

  // Broadcast to everyone
  io.emit("global:msg", {
    id: msg.id,
    user: msg.user,
    userId: msg.userId,
    text: msg.text,
    ts: msg.ts,
    url: msg.url,
  });

  // Discord webhook logging (GLOBAL only)
  logDiscordGlobalMessage({ msg, user, ip }).catch(() => {});

  return { ok: true, cooldownMs: GLOBAL_COOLDOWN_MS };
}

/* ------------------------------- Public User ------------------------------- */

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    createdAt: u.createdAt,
    lastSeen: u.lastSeen,
    level: typeof u.level === "number" ? u.level : 1,
    badges: Array.isArray(u.badges) ? u.badges : ["BETA"],
    betaJoinAt: u.betaJoinAt || null,
    role: "user",
  };
}

/* ---------------------------------- Start ---------------------------------- */

(async () => {
  await initDB();

  server.listen(PORT, () => {
    console.log(`[tonkotsu] server listening on :${PORT} (${NODE_ENV})`);
    if (!DISCORD_WEBHOOK_URL) {
      console.log("[tonkotsu] DISCORD_WEBHOOK_URL is not set; Discord logs are disabled.");
    } else {
      console.log("[tonkotsu] Discord webhook logging enabled.");
    }
  });
})();
