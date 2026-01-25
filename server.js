// server.js — tonkotsu.online backend (Express + Socket.IO)
// - Private-by-default app; GLOBAL chat is intentionally public + logged (Discord webhook)
// - REST auth (create on first login; strict auth after)
// - Socket auth via Bearer token
// - Anti-abuse: cooldown, link cooldown, banned words => shadow mute
// - Bot-ident logging: hashed IP/UA + device key (hashed)
// - /status page data endpoint
//
// Render: set env DISCORD_WEBHOOK_URL to your webhook URL
// Optional env: PORT, TRUST_PROXY=1

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const express = require("express");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");

/* ----------------------------- Config ----------------------------- */

const PORT = process.env.PORT || 3000;
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

// IMPORTANT: do not hardcode this in production; keep env var in Render.
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

// Cooldowns
const COOLDOWN_GUEST_MS = 5000;
const COOLDOWN_USER_MS = 3000;

// Link cooldown (server-enforced)
const LINK_COOLDOWN_MS = 5 * 60 * 1000;

// Shadow mute duration for severe prohibited content
const SHADOW_MUTE_MS = 10 * 60 * 1000;

// Data files
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const GLOBAL_FILE = path.join(DATA_DIR, "global.json");

/* ----------------------------- Utilities ----------------------------- */

function now() {
  return Date.now();
}

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

function sha256(s) {
  return crypto.createHash("sha256").update(String(s || "")).digest("hex");
}

function safeStr(s, max = 1200) {
  const t = String(s || "");
  return t.length > max ? t.slice(0, max) : t;
}

function isValidUser(u) {
  return /^[A-Za-z0-9]{4,20}$/.test(String(u || "").trim());
}

function isValidPass(p) {
  return /^[A-Za-z0-9]{4,32}$/.test(String(p || "").trim());
}

function isGuestName(u) {
  return /^guest_[a-f0-9]{6}$/i.test(String(u || ""));
}

function getClientIp(reqOrSocketHeaders, fallbackAddr) {
  const xf = reqOrSocketHeaders["x-forwarded-for"];
  const raw = Array.isArray(xf) ? xf[0] : xf || fallbackAddr || "";
  return String(raw).split(",")[0].trim();
}

function getUA(reqOrSocketHeaders) {
  return String(reqOrSocketHeaders["user-agent"] || "");
}

function deviceKey(ip, ua) {
  return sha256(`${ip}::${ua}`).slice(0, 32);
}

/* ----------------------------- Discord Webhook (no deps) ----------------------------- */

const webhookQueue = [];
let webhookBusy = false;

function enqueueWebhook(payload) {
  if (!DISCORD_WEBHOOK_URL) return;
  webhookQueue.push(payload);
  if (!webhookBusy) drainWebhookQueue().catch(() => {});
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function drainWebhookQueue() {
  webhookBusy = true;
  while (webhookQueue.length) {
    const payload = webhookQueue.shift();
    try {
      await postDiscordWebhook(payload);
    } catch {
      // drop and continue; do not block server
    }
    await sleep(350);
  }
  webhookBusy = false;
}

function discordContentSafe(s) {
  let t = String(s || "");
  t = t.replace(/@everyone/g, "@\u200Beveryone").replace(/@here/g, "@\u200Bhere");
  if (t.length > 1800) t = t.slice(0, 1800) + "…";
  return t;
}

function discordSendText(content) {
  enqueueWebhook({ content: discordContentSafe(content) });
}

function discordSendEmbed({ title, description, fields = [], footer } = {}) {
  const embed = {
    title: safeStr(title, 256),
    description: safeStr(description, 4096),
    fields: (fields || []).slice(0, 25).map((f) => ({
      name: safeStr(f?.name, 256),
      value: safeStr(f?.value, 1024),
      inline: !!f?.inline,
    })),
  };
  if (footer) embed.footer = { text: safeStr(footer, 2048) };
  enqueueWebhook({ embeds: [embed] });
}

function postDiscordWebhook(payload) {
  return new Promise((resolve, reject) => {
    if (!DISCORD_WEBHOOK_URL) return resolve();

    let u;
    try {
      u = new URL(DISCORD_WEBHOOK_URL);
    } catch (e) {
      return resolve(); // invalid url; silently ignore
    }

    const body = Buffer.from(JSON.stringify(payload || {}), "utf8");

    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + (u.search || ""),
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", async () => {
          if (res.statusCode === 429) {
            // best-effort retry
            let retryMs = 1500;
            try {
              const j = JSON.parse(data || "{}");
              if (typeof j?.retry_after === "number") retryMs = Math.ceil(j.retry_after * 1000);
            } catch {}
            await sleep(Math.min(15000, Math.max(500, retryMs)));
            webhookQueue.unshift(payload);
            return resolve();
          }
          return resolve();
        });
      }
    );

    req.on("error", () => resolve());
    req.write(body);
    req.end();
  });
}

/* ----------------------------- Storage ----------------------------- */

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let users = readJson(USERS_FILE, {}); // { username: { username, passHash, token, createdAt, lastSeen, ... } }
let globalHistory = readJson(GLOBAL_FILE, []); // [{id,user,text,ts}]

function persistUsers() {
  writeJson(USERS_FILE, users);
}
function persistGlobal() {
  writeJson(GLOBAL_FILE, globalHistory);
}

/* ----------------------------- Moderation / Anti-abuse ----------------------------- */

// NOTE: expand as you want; this is a starter "severe" set for shadow-mute.
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
    "\\bloli\\b",
    "\\bunderage\\b",
    "\\bincest\\b",
    "\\brape\\b",
    "\\bbeastiality\\b",
  ].join("|"),
  "i"
);

// Block porn/18+ links entirely (server-side)
const BLOCKED_LINK_RX = new RegExp(
  [
    "porn",
    "pornhub",
    "xvideos",
    "xnxx",
    "redtube",
    "youporn",
    "hentai",
    "rule34",
    "onlyfans",
    "fansly",
    "nsfw",
    "sex",
    "camgirl",
    "chaturbate",
    "cam4",
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

function containsUrl(text) {
  return /\bhttps?:\/\//i.test(String(text || ""));
}

/* Rate state (in-memory; resets on restart) */
const rate = new Map(); // username => { nextAllowed, lastLinkAt, shadowMuteUntil }

function getRate(username) {
  if (!rate.has(username)) rate.set(username, { nextAllowed: 0, lastLinkAt: 0, shadowMuteUntil: 0 });
  return rate.get(username);
}

function cooldownFor(username) {
  return isGuestName(username) ? COOLDOWN_GUEST_MS : COOLDOWN_USER_MS;
}

/* ----------------------------- Express App ----------------------------- */

const app = express();
app.set("trust proxy", TRUST_PROXY ? 1 : 0);

app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ ok: true }));

/* Simple status endpoint for /status page */
const startedAt = now();
app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.floor((now() - startedAt) / 1000),
    online: onlineUsersCount(),
    lastRestart: startedAt,
  });
});

/* Bot telemetry "hello" (non-blocking) */
app.post("/api/telemetry/hello", (req, res) => {
  // Intentionally minimal; server can add heuristics later.
  res.json({ ok: true });
});

/* ----------------------------- Auth (REST) ----------------------------- */

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

function safeUserPublic(rec) {
  const level = Number(rec?.stats?.level || 1);
  const badges = [];
  if (rec?.flags?.beta) badges.push("Early User");
  if (level >= 10) badges.push("Lv 10");
  if (level >= 25) badges.push("Lv 25");
  if (level >= 50) badges.push("Lv 50");

  return {
    id: rec.id,
    username: rec.username,
    createdAt: rec.createdAt,
    lastSeen: rec.lastSeen,
    level,
    badges,
  };
}

function ensureUser(username) {
  if (!users[username]) {
    users[username] = {
      id: sha256(`${username}::${crypto.randomBytes(8).toString("hex")}`).slice(0, 16),
      username,
      passHash: null,
      token: null,
      createdAt: now(),
      lastSeen: now(),
      stats: { level: 1, xp: 0, messages: 0 },
      flags: { beta: true },
    };
  }
  return users[username];
}

function authFromReq(req) {
  const h = String(req.headers.authorization || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  const tok = m ? m[1] : "";
  if (!tok) return null;
  const rec = Object.values(users).find((u) => u && u.token === tok && u.passHash);
  return rec || null;
}

function logJoinToDiscord({ username, type, req }) {
  const ip = getClientIp(req.headers, req.ip);
  const ua = getUA(req.headers);
  const dev = deviceKey(ip, ua);

  const fields = [
    { name: "User", value: `\`${username}\``, inline: true },
    { name: "Type", value: type, inline: true },
    { name: "When", value: `<t:${Math.floor(now() / 1000)}:F>`, inline: false },
    { name: "Device Key", value: `\`${dev}\``, inline: false },
    { name: "IP Hash", value: `\`${sha256(ip).slice(0, 16)}…\``, inline: true },
    { name: "UA Hash", value: `\`${sha256(ua).slice(0, 16)}…\``, inline: true },
    { name: "UA (short)", value: `\`${safeStr(ua, 110).replace(/`/g, "ˋ")}\``, inline: false },
  ];

  discordSendEmbed({
    title: type === "new_account" ? "New Account Created" : type === "guest" ? "New Guest Joined" : "User Logged In",
    description:
      type === "new_account"
        ? `New user created: **${username}**`
        : type === "guest"
        ? `Guest session created: **${username}**`
        : `User logged in: **${username}**`,
    fields,
    footer: "tonkotsu.online",
  });
}

app.post("/api/auth/login", async (req, res) => {
  try {
    const guest = !!req.body?.guest;

    if (guest) {
      const name = `guest_${crypto.randomBytes(3).toString("hex")}`;
      const rec = ensureUser(name);
      rec.passHash = null;
      rec.token = null;
      rec.lastSeen = now();
      persistUsers();

      logJoinToDiscord({ username: name, type: "guest", req });

      return res.json({
        ok: true,
        guest: true,
        token: null,
        isNew: true,
        user: safeUserPublic(rec),
      });
    }

    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "").trim();

    if (!isValidUser(username)) return res.status(400).json({ ok: false, error: "Username must be 4–20 letters/numbers." });
    if (!isValidPass(password)) return res.status(400).json({ ok: false, error: "Password must be 4–32 letters/numbers." });

    const rec = ensureUser(username);
    const existed = !!rec.passHash;

    if (!existed) {
      // Create account on first login
      rec.passHash = await bcrypt.hash(password, 12);
      rec.token = makeToken();
      rec.createdAt = rec.createdAt || now();
      rec.lastSeen = now();
      persistUsers();

      logJoinToDiscord({ username, type: "new_account", req });

      return res.json({
        ok: true,
        token: rec.token,
        isNew: true,
        user: safeUserPublic(rec),
      });
    }

    // Strict auth after
    const ok = await bcrypt.compare(password, rec.passHash).catch(() => false);
    if (!ok) return res.status(401).json({ ok: false, error: "Incorrect password." });

    rec.token = makeToken();
    rec.lastSeen = now();
    persistUsers();

    logJoinToDiscord({ username, type: "login", req });

    return res.json({
      ok: true,
      token: rec.token,
      isNew: false,
      user: safeUserPublic(rec),
    });
  } catch {
    return res.status(500).json({ ok: false, error: "Login failed." });
  }
});

app.get("/api/me", (req, res) => {
  const rec = authFromReq(req);
  if (!rec) return res.status(401).json({ ok: false, error: "Unauthorized." });
  rec.lastSeen = now();
  persistUsers();
  res.json({ ok: true, user: safeUserPublic(rec) });
});

/* Global history (public feed) */
app.get("/api/global/history", (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 80));
  const items = globalHistory.slice(-limit);
  res.json({ ok: true, items });
});

/* Global send (REST fallback) */
app.post("/api/global/send", (req, res) => {
  const rec = authFromReq(req);
  if (!rec) return res.status(401).json({ ok: false, error: "Unauthorized." });

  const username = rec.username;
  const text = safeStr(String(req.body?.text || "").trim(), 1200);
  if (!text) return res.status(400).json({ ok: false, error: "Empty message." });

  const out = handleGlobalSend({ username, text, ip: getClientIp(req.headers, req.ip), ua: getUA(req.headers) });
  if (!out.ok) return res.status(400).json(out);
  return res.json(out);
});

/* ----------------------------- Socket.IO ----------------------------- */

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

function socketAuth(socket) {
  const tok = String(socket.handshake.auth?.token || "");
  if (!tok) return null;
  const rec = Object.values(users).find((u) => u && u.token === tok && u.passHash);
  return rec || null;
}

/* Online tracking */
const socketsByUser = new Map(); // username => Set(socket.id)
const userBySocket = new Map(); // socket.id => username

function setOnline(username, sid) {
  if (!socketsByUser.has(username)) socketsByUser.set(username, new Set());
  socketsByUser.get(username).add(sid);
  userBySocket.set(sid, username);
}

function setOffline(sid) {
  const u = userBySocket.get(sid);
  if (!u) return;
  userBySocket.delete(sid);
  const set = socketsByUser.get(u);
  if (set) {
    set.delete(sid);
    if (set.size === 0) socketsByUser.delete(u);
  }
}

function onlineUsersCount() {
  // unique users
  return socketsByUser.size;
}

function broadcastOnline() {
  io.emit("online:update", { online: onlineUsersCount() });
}

/* Global message pipeline (shared by socket/rest) */
function pushGlobal(msg) {
  globalHistory.push(msg);
  if (globalHistory.length > 350) globalHistory.shift();
  persistGlobal();
}

function isSevereBad(text) {
  const t = String(text || "");
  if (SEVERE_BAD_RX.test(t)) return true;
  const urls = extractUrls(t);
  for (const u of urls) {
    if (BLOCKED_LINK_RX.test(u)) return true;
  }
  return false;
}

function handleGlobalSend({ username, text, ip, ua }) {
  const r = getRate(username);

  // Shadow mute window
  if (r.shadowMuteUntil && now() < r.shadowMuteUntil) {
    // Sender sees success but message is not broadcast
    return { ok: true, shadow: true, cooldownMs: cooldownFor(username) };
  }

  // Severe prohibited content => shadow mute
  if (isSevereBad(text)) {
    r.shadowMuteUntil = now() + SHADOW_MUTE_MS;
    return { ok: true, shadow: true, cooldownMs: cooldownFor(username) };
  }

  // Cooldown
  const cd = cooldownFor(username);
  if (now() < (r.nextAllowed || 0)) {
    const left = Math.max(0, r.nextAllowed - now());
    return { ok: false, error: `Cooldown active (${Math.ceil(left / 1000)}s left).` };
  }
  r.nextAllowed = now() + cd;

  // Link cooldown + blocklist
  if (containsUrl(text)) {
    const urls = extractUrls(text);
    for (const u of urls) {
      if (BLOCKED_LINK_RX.test(u)) {
        r.shadowMuteUntil = now() + SHADOW_MUTE_MS;
        return { ok: true, shadow: true, cooldownMs: cd };
      }
    }
    const last = Number(r.lastLinkAt || 0);
    if (last && now() - last < LINK_COOLDOWN_MS) {
      const left = Math.ceil((LINK_COOLDOWN_MS - (now() - last)) / 1000);
      return { ok: false, error: `Link cooldown: wait ${left}s.` };
    }
    r.lastLinkAt = now();
  }

  const msg = {
    id: sha256(`${username}::${now()}::${crypto.randomBytes(6).toString("hex")}`).slice(0, 16),
    user: username,
    text: safeStr(text, 1200),
    ts: now(),
  };

  pushGlobal(msg);

  // Discord logging (GLOBAL ONLY)
  discordSendEmbed({
    title: "Global Message",
    description: safeStr(msg.text, 1800),
    fields: [
      { name: "User", value: `\`${msg.user}\``, inline: true },
      { name: "Time", value: `<t:${Math.floor(msg.ts / 1000)}:F>`, inline: true },
      { name: "User ID", value: `\`${users[msg.user]?.id || "—"}\``, inline: false },
      { name: "Fingerprint", value: `\`${sha256(`${ip}::${ua}`).slice(0, 16)}…\``, inline: false },
    ],
    footer: "tonkotsu.online • global is public",
  });

  // Broadcast to everyone
  io.emit("global:msg", msg);

  // Also support legacy name if older clients are around
  io.emit("globalMessage", msg);

  return { ok: true, shadow: false, cooldownMs: cd, msg };
}

/* Socket events */
io.on("connection", (socket) => {
  const rec = socketAuth(socket);
  const authed = !!rec;

  const ip = getClientIp(socket.handshake.headers, socket.handshake.address);
  const ua = getUA(socket.handshake.headers);

  if (authed) {
    setOnline(rec.username, socket.id);
    rec.lastSeen = now();
    persistUsers();
    broadcastOnline();
  }

  socket.on("disconnect", () => {
    setOffline(socket.id);
    broadcastOnline();
  });

  socket.on("online:get", () => {
    socket.emit("online:update", { online: onlineUsersCount() });
  });

  // Provide history via callback and via event
  socket.on("global:history", (payload, cb) => {
    const limit = Math.max(1, Math.min(200, Number(payload?.limit) || 80));
    const items = globalHistory.slice(-limit);
    if (typeof cb === "function") cb({ ok: true, items });
    socket.emit("global:history", { items }); // optional extra
  });

  socket.on("global:send", (payload, cb) => {
    if (!authed) {
      if (typeof cb === "function") cb({ ok: false, error: "Unauthorized." });
      return;
    }
    const text = safeStr(String(payload?.text || "").trim(), 1200);
    if (!text) {
      if (typeof cb === "function") cb({ ok: false, error: "Empty message." });
      return;
    }
    const out = handleGlobalSend({ username: rec.username, text, ip, ua });
    if (typeof cb === "function") cb(out);
    if (!out.ok) socket.emit("sendError", { reason: out.error || "Send failed." });
  });
});

/* ----------------------------- Boot ----------------------------- */

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

