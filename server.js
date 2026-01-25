// server.js — tonkotsu.online (Render-friendly)
// Fixes:
// - no duplicate PORT declarations
// - cookie-parser optional (but supported)
// - /api/messages/send idempotency via clientId to prevent double-sends
// - online users list with presence; multi-tab does NOT count as multiple users
//
// NOTE: This server is a solid baseline. If you already have DB/user logic,
// you can merge the "send idempotency" + "presence uniqueness" pieces.

"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser"); // ensure installed
const { Server } = require("socket.io");
const crypto = require("crypto");

// -----------------------------
// Config
// -----------------------------
const PORT = Number(process.env.PORT || 3000); // declare ONCE
const ORIGIN = process.env.ORIGIN || ""; // optional CORS origin
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

// -----------------------------
// App setup
// -----------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: ORIGIN
    ? { origin: ORIGIN, methods: ["GET", "POST"], credentials: true }
    : { origin: true, methods: ["GET", "POST"], credentials: true },
});

// behind proxy on Render
app.set("trust proxy", 1);

app.use(cors(ORIGIN ? { origin: ORIGIN, credentials: true } : { origin: true, credentials: true }));
app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());

// static
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// -----------------------------
// Minimal in-memory store (replace with DB later)
// -----------------------------
const mem = {
  users: new Map(), // username -> user
  tokens: new Map(), // token -> username
  messages: {
    global: [], // {id, ts, text, user:{id,username,color}, scope:"global"}
    dm: new Map(), // peerKey -> array
    group: new Map(), // gid -> array
  },
  // idempotency: token+clientId -> {messageId, createdAt}
  sendIdem: new Map(),
  // presence: userId -> {mode, sockets:Set(socketId), lastSeen}
  presence: new Map(),
};

// helper: stable hash id
function id(prefix = "m") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function now() {
  return Date.now();
}

function pickColor(seed) {
  const s = String(seed || "user");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hues = [210, 190, 170, 140, 120, 100, 80, 260, 280, 300, 320, 340];
  const hue = hues[h % hues.length];
  return `hsl(${hue} 70% 62%)`;
}

function safeText(x) {
  return typeof x === "string" ? x : "";
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: "Missing token" });
  const username = mem.tokens.get(token);
  if (!username) return res.status(401).json({ ok: false, error: "Invalid token" });
  const user = mem.users.get(username);
  if (!user) return res.status(401).json({ ok: false, error: "Invalid session" });
  req.user = user;
  req.token = token;
  next();
}

// -----------------------------
// Auth endpoints (baseline)
// -----------------------------
app.post("/api/auth/login", (req, res) => {
  const username = safeText(req.body?.username).trim();
  const password = safeText(req.body?.password);

  if (!username || !password) return res.status(400).json({ ok: false, error: "Missing credentials" });

  // demo user store (replace with real hashing/db)
  let user = mem.users.get(username);
  if (!user) {
    // create account on first login (change if you want real signup)
    user = {
      id: id("u"),
      username,
      password, // DO NOT store plaintext in real app
      color: pickColor(username),
      createdAt: now(),
      lastSeen: now(),
      bio: "",
      badges: ["Early Access"],
    };
    mem.users.set(username, user);
  } else {
    if (user.password !== password) return res.status(401).json({ ok: false, error: "Wrong password" });
  }

  const token = id("tk");
  mem.tokens.set(token, username);
  user.lastSeen = now();

  res.json({ ok: true, token, user: sanitizeUser(user) });
});

app.post("/api/auth/guest", (req, res) => {
  const username = `guest_${crypto.randomBytes(3).toString("hex")}`;
  const user = {
    id: id("u"),
    username,
    password: "",
    color: pickColor(username),
    createdAt: now(),
    lastSeen: now(),
    bio: "",
    badges: ["Guest", "Early Access"],
  };
  mem.users.set(username, user);

  const token = id("tk");
  mem.tokens.set(token, username);

  res.json({ ok: true, token, user: sanitizeUser(user) });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  mem.tokens.delete(req.token);
  res.json({ ok: true });
});

app.get("/api/users/me", requireAuth, (req, res) => {
  res.json({ ok: true, user: sanitizeUser(req.user) });
});

function sanitizeUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    color: u.color,
    createdAt: u.createdAt,
    lastSeen: u.lastSeen,
    bio: u.bio || "",
    badges: Array.isArray(u.badges) ? u.badges : [],
  };
}

// -----------------------------
// Bootstrap (client expects this)
// -----------------------------
app.get("/api/state/bootstrap", requireAuth, (req, res) => {
  const onlineUsers = getOnlineUsersList();
  res.json({
    ok: true,
    global: { messages: mem.messages.global.slice(-120), cursor: null, hasMore: false },
    friends: [], // wire later
    dms: [], // wire later
    groups: [], // wire later
    groupThreads: [], // wire later
    whatsNew: [], // wire later
    lastRead: { global: null, dm: {}, group: {} },
    onlineCount: onlineUsers.length,
    onlineUsers,
  });
});

// -----------------------------
// Messages fetch (baseline)
// -----------------------------
app.get("/api/messages/global", requireAuth, (req, res) => {
  const limit = clampNum(req.query.limit, 1, 200, 80);
  res.json({ ok: true, messages: mem.messages.global.slice(-limit), cursor: null, hasMore: false });
});

app.get("/api/messages/dm/:peerId", requireAuth, (req, res) => {
  // placeholder until you implement DMs server-side
  const peerId = safeText(req.params.peerId);
  const key = dmKey(req.user.id, peerId);
  const msgs = mem.messages.dm.get(key) || [];
  const limit = clampNum(req.query.limit, 1, 200, 80);
  res.json({ ok: true, messages: msgs.slice(-limit), cursor: null, hasMore: false, peer: { id: peerId, username: "User" } });
});

app.get("/api/messages/group/:gid", requireAuth, (req, res) => {
  // placeholder until you implement groups server-side
  const gid = safeText(req.params.gid);
  const msgs = mem.messages.group.get(gid) || [];
  const limit = clampNum(req.query.limit, 1, 250, 90);
  res.json({ ok: true, messages: msgs.slice(-limit), cursor: null, hasMore: false, group: { id: gid, name: "Group Chat" } });
});

function dmKey(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? `${x}:${y}` : `${y}:${x}`;
}

function clampNum(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// -----------------------------
// Send message (idempotent) + cooldown demo
// -----------------------------
app.post("/api/messages/send", requireAuth, (req, res) => {
  const scope = safeText(req.body?.scope);
  const targetId = req.body?.targetId ? safeText(req.body.targetId) : null;
  const text = safeText(req.body?.text).trim();
  const clientId = safeText(req.body?.clientId).trim();

  if (!text) return res.status(400).json({ ok: false, error: "Empty message" });
  if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId" });

  // idempotency key: token + clientId
  const idemKey = `${req.token}:${clientId}`;
  const hit = mem.sendIdem.get(idemKey);
  if (hit) {
    // return the existing message (prevents double-send)
    const msg = findMessageById(hit.messageId);
    if (msg) return res.json({ ok: true, message: msg });
    // if not found, fall through (rare)
  }

  // Basic cooldown demo: 2s per message
  const cooldownMs = 2000;
  // If you want per-user cooldown, store lastSentAt on user
  const lastSentAt = req.user._lastSentAt || 0;
  const elapsed = now() - lastSentAt;
  if (elapsed < cooldownMs) {
    const until = now() + (cooldownMs - elapsed);
    return res.status(429).json({ ok: false, error: "Cooldown", cooldownUntil: until, cooldownMs });
  }
  req.user._lastSentAt = now();

  const message = {
    id: id("msg"),
    ts: now(),
    text,
    scope,
    targetId: targetId || null,
    user: { id: req.user.id, username: req.user.username, color: req.user.color, badges: req.user.badges || [] },
  };

  // store
  if (scope === "global") {
    mem.messages.global.push(message);
    mem.messages.global = mem.messages.global.slice(-2000);
  } else if (scope === "dm" && targetId) {
    const key = dmKey(req.user.id, targetId);
    const arr = mem.messages.dm.get(key) || [];
    arr.push(message);
    mem.messages.dm.set(key, arr.slice(-2000));
  } else if (scope === "group" && targetId) {
    const arr = mem.messages.group.get(targetId) || [];
    arr.push(message);
    mem.messages.group.set(targetId, arr.slice(-4000));
  } else {
    return res.status(400).json({ ok: false, error: "Invalid scope/targetId" });
  }

  // save idempotency record for 60s
  mem.sendIdem.set(idemKey, { messageId: message.id, createdAt: now() });

  // broadcast
  io.emit("message:new", message);

  res.json({
    ok: true,
    message,
    cooldownUntil: now() + cooldownMs,
    cooldownMs,
  });
});

function findMessageById(messageId) {
  // Only searches global + recent DM/Group; good enough for idempotency window.
  for (const m of mem.messages.global) if (m.id === messageId) return m;
  for (const arr of mem.messages.dm.values()) for (const m of arr) if (m.id === messageId) return m;
  for (const arr of mem.messages.group.values()) for (const m of arr) if (m.id === messageId) return m;
  return null;
}

// cleanup idempotency map
setInterval(() => {
  const cutoff = now() - 60_000;
  for (const [k, v] of mem.sendIdem.entries()) {
    if (!v || v.createdAt < cutoff) mem.sendIdem.delete(k);
  }
}, 15_000);

// -----------------------------
// Socket presence: uniqueness across tabs
// -----------------------------
io.use((socket, next) => {
  // token from socket.handshake.auth.token
  const token = safeText(socket.handshake?.auth?.token).trim();
  if (!token) return next(new Error("Missing token"));
  const username = mem.tokens.get(token);
  if (!username) return next(new Error("Invalid token"));
  const user = mem.users.get(username);
  if (!user) return next(new Error("Invalid user"));
  socket.data.user = user;
  socket.data.token = token;
  next();
});

io.on("connection", (socket) => {
  const user = socket.data.user;
  const uid = user.id;

  // attach socket to user's presence record
  let pr = mem.presence.get(uid);
  if (!pr) {
    pr = { mode: "online", sockets: new Set(), lastSeen: now() };
    mem.presence.set(uid, pr);
  }
  pr.sockets.add(socket.id);
  pr.lastSeen = now();

  // broadcast online users
  broadcastOnline();

  socket.on("presence:set", (p) => {
    const mode = safeText(p?.mode).trim() || "online";
    const pr2 = mem.presence.get(uid);
    if (pr2) {
      pr2.mode = mode;
      pr2.lastSeen = now();
      broadcastOnline();
    }
  });

  socket.on("disconnect", () => {
    const pr2 = mem.presence.get(uid);
    if (pr2) {
      pr2.sockets.delete(socket.id);
      pr2.lastSeen = now();
      // if no more sockets, user is offline
      if (pr2.sockets.size === 0) {
        mem.presence.delete(uid);
        // update lastSeen on user
        user.lastSeen = now();
      }
      broadcastOnline();
    }
  });
});

function getOnlineUsersList() {
  const out = [];
  for (const [uid, pr] of mem.presence.entries()) {
    // find user by id
    const u = [...mem.users.values()].find((x) => x.id === uid);
    if (!u) continue;
    out.push({ id: u.id, username: u.username, mode: pr.mode || "online" });
  }
  // stable sort
  out.sort((a, b) => a.username.localeCompare(b.username));
  return out;
}

function broadcastOnline() {
  const users = getOnlineUsersList();
  io.emit("users:online", { count: users.length, users });
}

// -----------------------------
// Start
// -----------------------------
server.listen(PORT, () => {
  console.log(`tonkotsu server listening on :${PORT}`);
});
