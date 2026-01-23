// server.js (ESM) — Render-ready, disk-ready persistence, compact app UI support, bots, statuses, cooldowns
import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

/**
 * -------------------------
 * Persistence (Render disk-ready)
 * -------------------------
 * If you attach a Render Persistent Disk mounted at /data,
 * it will store to: /data/tonkotsu.json
 */
const DISK_FILE = process.env.TONKOTSU_DB_FILE || "/data/tonkotsu.json";

function safeJson(obj) {
  return JSON.stringify(obj, null, 2);
}

const db = {
  users: {},        // username -> user record
  tokens: {},       // token -> username
  global: [],       // [{user,text,ts}]
  dms: {},          // "a|b" -> [{user,text,ts}]
  groups: {},       // gid -> {id,name,owner,members:[...], msgs:[...], active:boolean, pendingInvites:[...]}
  groupInvites: {}  // username -> [{id, from, name, ts}]
};

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveToDisk().catch(() => {});
  }, 650);
}

async function loadFromDisk() {
  try {
    const dir = path.dirname(DISK_FILE);
    if (!fs.existsSync(dir)) return;
    if (!fs.existsSync(DISK_FILE)) return;

    const raw = await fs.promises.readFile(DISK_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (parsed && typeof parsed === "object") {
      db.users = parsed.users || db.users;
      db.tokens = parsed.tokens || {};
      db.global = parsed.global || [];
      db.dms = parsed.dms || {};
      db.groups = parsed.groups || {};
      db.groupInvites = parsed.groupInvites || {};
    }
    console.log("[db] loaded", DISK_FILE);
  } catch (e) {
    console.log("[db] load failed:", e?.message || e);
  }
}

async function saveToDisk() {
  try {
    const dir = path.dirname(DISK_FILE);
    if (!fs.existsSync(dir)) return;
    const payload = {
      users: db.users,
      tokens: db.tokens,
      global: db.global,
      dms: db.dms,
      groups: db.groups,
      groupInvites: db.groupInvites
    };
    await fs.promises.writeFile(DISK_FILE, safeJson(payload), "utf8");
  } catch {
    // ignore
  }
}

await loadFromDisk();

/* -------------------------
   Helpers
------------------------- */
function now() { return Date.now(); }
function normalizeUser(u) { return String(u || "").trim(); }

function dmKey(a, b) {
  const x = String(a), y = String(b);
  return (x.localeCompare(y) <= 0) ? `${x}|${y}` : `${y}|${x}`;
}

function usernameValid(u) {
  return /^[A-Za-z0-9_.]{3,20}$/.test(u);
}

const USERNAME_BLOCK_PATTERNS = [
  /porn|onlyfans|nude|nsfw|sex|xxx/i,
  /child|minor|underage/i,
  /rape|rapist/i,
  /hitler|nazi/i
];

function badUsername(u) {
  const s = String(u || "");
  return USERNAME_BLOCK_PATTERNS.some(rx => rx.test(s));
}

const HARD_BLOCK_PATTERNS = [
  /\b(kys|kill\s+yourself)\b/i,
  /\b(i('?m| am)?\s+going\s+to\s+kill|i('?m| am)?\s+gonna\s+kill)\b/i,
  /\b(send\s+nudes|nude\s+pics)\b/i,
  /\b(dox|doxx|address|phone\s*number)\b/i
];

function shouldHardHide(text) {
  const t = String(text || "");
  return HARD_BLOCK_PATTERNS.some(rx => rx.test(t));
}

function hashPass(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.pbkdf2Sync(String(pw), salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${derived}`;
}

function checkPass(pw, stored) {
  const [salt, derived] = String(stored || "").split(":");
  if (!salt || !derived) return false;
  const test = crypto.pbkdf2Sync(String(pw), salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(test), Buffer.from(derived));
}

function newToken() { return crypto.randomBytes(24).toString("hex"); }

function xpNext(level) {
  const base = 120;
  const growth = Math.floor(base * Math.pow(Math.max(1, level), 1.45));
  return Math.max(base, growth);
}

function addXP(userRec, amount) {
  if (!userRec || userRec.guest) return;
  if (!userRec.xp) userRec.xp = { level: 1, xp: 0, next: xpNext(1) };
  userRec.xp.xp += amount;

  while (userRec.xp.xp >= userRec.xp.next) {
    userRec.xp.xp -= userRec.xp.next;
    userRec.xp.level += 1;
    userRec.xp.next = xpNext(userRec.xp.level);
  }
}

/* -------------------------
   Reserved “real-looking” bots
   - You cannot register/login as these usernames
------------------------- */
const RESERVED_BOT_NAMES = new Set([
  "oregon6767", "theowner", "zippyfn", "mikachu", "voidd", "lilsam",
  "xavier09", "idkbro", "noxity", "bruhmoment", "sarahxoxo",
  "jaylen", "ghosted", "vex", "angel", "kairo", "miya", "marz", "danny"
]);

function isReservedName(u) {
  return RESERVED_BOT_NAMES.has(String(u || "").toLowerCase());
}

function ensureUser(username, password) {
  if (!db.users[username]) {
    db.users[username] = {
      username,
      pass: hashPass(password),
      createdAt: now(),
      guest: false,
      bio: "",
      status: "online", // online | idle | dnd | invisible
      settings: {
        density: 0.18,     // compact
        sidebar: 0.24,     // narrow
        cursorMode: "trail", // off | dot | trail
        sounds: true,
        reduceAnimations: false
      },
      social: {
        friends: [],
        incoming: [],
        outgoing: [],
        blocked: []
      },
      stats: { messages: 0 },
      xp: { level: 1, xp: 0, next: xpNext(1) },
      // client-side only uses these to avoid “red pings” for global
      notifications: { mentions: 0 }
    };
  }
  return db.users[username];
}

function publicProfile(username) {
  const u = db.users[username];
  if (!u) return null;
  if (u.guest) return { user: username, guest: true };

  return {
    user: username,
    guest: false,
    createdAt: u.createdAt,
    level: u.xp?.level ?? 1,
    xp: u.xp?.xp ?? 0,
    next: u.xp?.next ?? xpNext(1),
    messages: u.stats?.messages ?? 0,
    bio: String(u.bio || "").slice(0, 200),
    status: u.status || "online"
  };
}

/* -------------------------
   Online tracking
------------------------- */
const socketToUser = new Map(); // socket.id -> username
const online = new Set();       // usernames (excluding invisible)
const statusByUser = new Map(); // username -> status

function effectiveOnlineList() {
  // Hide invisible users from online list
  const list = Array.from(statusByUser.entries())
    .filter(([u, st]) => st !== "invisible")
    .map(([u, st]) => ({ user: u, status: st }))
    .sort((a, b) => a.user.localeCompare(b.user));
  return list;
}

function emitOnline() {
  io.emit("onlineUsers", effectiveOnlineList());
}

function emitSocial(username) {
  const u = db.users[username];
  if (!u || u.guest) return;

  io.to(username).emit("social:update", u.social);

  const invites = db.groupInvites[username] || [];
  io.to(username).emit("inbox:update", {
    friendRequests: u.social.incoming.length,
    groupInvites: invites.length,
    mentions: u.notifications?.mentions ?? 0
  });
}

function emitGroupsList(username) {
  const u = db.users[username];
  if (!u || u.guest) return;

  const groups = Object.values(db.groups)
    .filter(g => g.active && g.members.includes(username))
    .map(g => ({ id: g.id, name: g.name, owner: g.owner, members: g.members }));

  io.to(username).emit("groups:list", groups);
}

function getOrCreateDM(key) {
  if (!db.dms[key]) db.dms[key] = [];
  return db.dms[key];
}

/* -------------------------
   Bots: “realistic chat load”
   - Server-side so ALL users see the same messages
   - Random join/leave (status toggles) + occasional guests
------------------------- */
const BOT_NAMES = Array.from(RESERVED_BOT_NAMES);

const BOT_LINES = [
  "wsg chat",
  "nah this actually clean",
  "why is my wifi tweaking rn",
  "bro who made this",
  "ok lowkey nice",
  "anyone here fr?",
  "bruh moment",
  "yo this site got potential",
  "ngl this is smooth",
  "tf is this",
  "i gotta go wash dishes rq",
  "brb i’ll be back",
  "gtg",
  "hold on my phone dying",
  "wait how do i add ppl",
  "someone dm me",
  "this cursor is crazy",
  "yo @Guest3406 just press login",
  "why is everyone so quiet",
  "this feels like early discord vibes"
];

const BOT_LEAVE_LINES = [
  "gtg",
  "brb",
  "gotta go eat rq",
  "i’ll be back",
  "gotta do something rq",
  "ok i’m out",
  "later chat",
  "i gotta hop off"
];

function ensureBotUser(name) {
  if (!db.users[name]) {
    db.users[name] = {
      username: name,
      pass: null, // cannot login
      createdAt: now() - Math.floor(Math.random() * 1000 * 60 * 60 * 24 * 180),
      guest: false,
      bio: "",
      status: "online",
      settings: { density: 0.18, sidebar: 0.24, cursorMode: "off", sounds: false, reduceAnimations: true },
      social: { friends: [], incoming: [], outgoing: [], blocked: [] },
      stats: { messages: Math.floor(Math.random() * 200) },
      xp: { level: Math.floor(Math.random() * 15) + 1, xp: 0, next: 120 },
      notifications: { mentions: 0 }
    };
  }
  statusByUser.set(name, "online");
}

function botJoinAll() {
  for (const name of BOT_NAMES.slice(0, 12)) {
    ensureBotUser(name);
    online.add(name);
  }
  emitOnline();
}

function botRandomTalk() {
  // pick an “online” bot
  const candidates = BOT_NAMES.filter(n => statusByUser.get(n) && statusByUser.get(n) !== "invisible");
  if (!candidates.length) return;

  const name = candidates[Math.floor(Math.random() * candidates.length)];
  const text = BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)];

  const msg = { user: name, text, ts: now() };
  db.global.push(msg);
  if (db.global.length > 350) db.global.shift();
  io.emit("globalMessage", msg);

  // bots gain tiny XP too (for leaderboard realism)
  const u = db.users[name];
  if (u) {
    u.stats.messages = (u.stats.messages || 0) + 1;
    addXP(u, 2);
  }
  scheduleSave();
}

function botRandomPresence() {
  // occasionally a bot “leaves” (becomes invisible), then returns
  const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
  if (!db.users[name]) ensureBotUser(name);

  const st = statusByUser.get(name) || "online";
  const flip = Math.random();

  if (flip < 0.45 && st !== "invisible") {
    // leave
    statusByUser.set(name, "invisible");
    online.delete(name);

    // optional leaving line (not every time)
    if (Math.random() < 0.35) {
      const leaveText = BOT_LEAVE_LINES[Math.floor(Math.random() * BOT_LEAVE_LINES.length)];
      const msg = { user: name, text: leaveText, ts: now() };
      db.global.push(msg);
      if (db.global.length > 350) db.global.shift();
      io.emit("globalMessage", msg);
    }
  } else if (flip > 0.55 && st === "invisible") {
    // come back
    statusByUser.set(name, "online");
    online.add(name);
  }
  emitOnline();
  scheduleSave();
}

function botOccasionalGuest() {
  if (Math.random() < 0.45) return;
  const digits = (Math.random() < 0.5)
    ? String(Math.floor(1000 + Math.random() * 9000))
    : String(Math.floor(10000 + Math.random() * 90000));
  const g = `Guest${digits}`;

  // guest says something simple
  const guestLines = ["how do i", "anyone got tips", "wsg", "yo", "why is this kinda cool"];
  const msg = { user: g, text: guestLines[Math.floor(Math.random() * guestLines.length)], ts: now() };
  db.global.push(msg);
  if (db.global.length > 350) db.global.shift();
  io.emit("globalMessage", msg);

  // a bot replies with @mention sometimes
  if (Math.random() < 0.6) {
    const bot = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    if (!db.users[bot]) ensureBotUser(bot);
    const reply = `@${g} just click login top left`;
    const msg2 = { user: bot, text: reply, ts: now() };
    db.global.push(msg2);
    if (db.global.length > 350) db.global.shift();
    io.emit("globalMessage", msg2);
  }

  scheduleSave();
}

// Start bot system
setTimeout(() => {
  botJoinAll();
  // talk loop
  setInterval(botRandomTalk, 9000 + Math.floor(Math.random() * 7000));
  // presence loop
  setInterval(botRandomPresence, 14000 + Math.floor(Math.random() * 10000));
  // guest loop
  setInterval(botOccasionalGuest, 17000 + Math.floor(Math.random() * 12000));
}, 1500);

/* -------------------------
   Socket events
------------------------- */
io.on("connection", (socket) => {
  function currentUser() {
    return socketToUser.get(socket.id) || null;
  }
  function isGuestUserName(name) {
    return /^Guest\d{4,5}$/.test(String(name));
  }
  function requireAuth() {
    const u = currentUser();
    if (!u) return null;
    if (isGuestUserName(u)) return null;
    return u;
  }

  // resume
  socket.on("resume", ({ token } = {}) => {
    const t = String(token || "");
    const username = db.tokens[t];
    if (!username || !db.users[username]) {
      socket.emit("resumeFail");
      return;
    }

    socketToUser.set(socket.id, username);
    socket.join(username);

    const userRec = db.users[username];

    // status
    const st = userRec.status || "online";
    statusByUser.set(username, st);
    if (st !== "invisible") online.add(username);
    emitOnline();

    socket.emit("loginSuccess", {
      username,
      guest: false,
      token: t,
      settings: userRec.settings,
      social: userRec.social,
      xp: userRec.xp,
      bio: userRec.bio || "",
      status: st
    });

    emitSocial(username);
    emitGroupsList(username);
    socket.emit("global:init", { last: db.global.slice(-220) });
  });

  // login
  socket.on("login", ({ username, password, guest } = {}) => {
    if (guest) {
      const digits = (Math.random() < 0.5)
        ? String(Math.floor(1000 + Math.random() * 9000))
        : String(Math.floor(10000 + Math.random() * 90000));
      const g = `Guest${digits}`;

      socketToUser.set(socket.id, g);

      socket.emit("loginSuccess", {
        username: g,
        guest: true,
        token: null,
        settings: {
          density: 0.18,
          sidebar: 0.24,
          cursorMode: "trail",
          sounds: true,
          reduceAnimations: false
        },
        social: { friends: [], incoming: [], outgoing: [], blocked: [] },
        xp: null,
        bio: "",
        status: "online"
      });

      // guests are visible in online list as “online”
      statusByUser.set(g, "online");
      online.add(g);
      emitOnline();

      socket.emit("global:init", { last: db.global.slice(-220) });
      return;
    }

    const u = normalizeUser(username);
    const p = String(password || "");

    if (!usernameValid(u) || badUsername(u)) {
      socket.emit("loginError", "Username not allowed. Use letters/numbers/_/. only (3-20).");
      return;
    }
    if (isReservedName(u)) {
      socket.emit("loginError", "That username is reserved.");
      return;
    }
    if (!p || p.length < 4) {
      socket.emit("loginError", "Password too short.");
      return;
    }

    const existing = db.users[u];
    if (!existing) {
      ensureUser(u, p);
      scheduleSave();
    } else {
      if (!existing.pass || !checkPass(p, existing.pass)) {
        socket.emit("loginError", "Wrong password.");
        return;
      }
    }

    const token = newToken();
    db.tokens[token] = u;

    socketToUser.set(socket.id, u);
    socket.join(u);

    const userRec = db.users[u];
    const st = userRec.status || "online";
    statusByUser.set(u, st);
    if (st !== "invisible") online.add(u);

    emitOnline();

    socket.emit("loginSuccess", {
      username: u,
      guest: false,
      token,
      settings: userRec.settings,
      social: userRec.social,
      xp: userRec.xp,
      bio: userRec.bio || "",
      status: st
    });

    emitSocial(u);
    emitGroupsList(u);
    socket.emit("global:init", { last: db.global.slice(-220) });

    scheduleSave();
  });

  socket.on("disconnect", () => {
    const u = currentUser();
    socketToUser.delete(socket.id);

    if (u) {
      // If user fully disconnected, remove from online list unless they have other sockets.
      // Simplified: mark offline for guests; for accounts, keep status but remove from online.
      online.delete(u);
      emitOnline();
    }
  });

  /* -------------------------
     Status
  ------------------------- */
  socket.on("status:set", ({ status } = {}) => {
    const u = currentUser();
    if (!u) return;

    const allowed = new Set(["online", "idle", "dnd", "invisible"]);
    const st = allowed.has(status) ? status : "online";

    statusByUser.set(u, st);

    // persist only for real accounts
    if (!isGuestUserName(u) && db.users[u]) {
      db.users[u].status = st;
      scheduleSave();
    }

    if (st === "invisible") online.delete(u);
    else online.add(u);

    emitOnline();

    // for user only
    socket.emit("status:update", { status: st });
  });

  /* -------------------------
     Settings
  ------------------------- */
  socket.on("settings:update", (settings) => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];
    if (!u) return;

    const s = settings || {};
    const cursorAllowed = new Set(["off", "dot", "trail"]);

    u.settings = {
      density: Number.isFinite(s.density) ? Math.max(0.12, Math.min(0.28, s.density)) : 0.18,
      sidebar: Number.isFinite(s.sidebar) ? Math.max(0.20, Math.min(0.32, s.sidebar)) : 0.24,
      cursorMode: cursorAllowed.has(s.cursorMode) ? s.cursorMode : (u.settings.cursorMode || "trail"),
      sounds: s.sounds !== false,
      reduceAnimations: !!s.reduceAnimations
    };

    socket.emit("settings", u.settings);
    scheduleSave();
  });

  /* -------------------------
     Bio
  ------------------------- */
  socket.on("bio:update", ({ bio } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];
    if (!u) return;

    u.bio = String(bio || "").slice(0, 200);
    socket.emit("bio:update", { bio: u.bio });
    scheduleSave();
  });

  /* -------------------------
     Profile
  ------------------------- */
  socket.on("profile:get", ({ user } = {}) => {
    const target = normalizeUser(user);
    if (!target) return;

    if (/^Guest\d{4,5}$/.test(target)) {
      socket.emit("profile:data", { user: target, guest: true });
      return;
    }

    const p = publicProfile(target);
    if (!p) {
      socket.emit("profile:data", { user: target, missing: true });
      return;
    }
    socket.emit("profile:data", p);
  });

  /* -------------------------
     Leaderboard (XP)
  ------------------------- */
  socket.on("leaderboard:get", () => {
    const all = Object.values(db.users)
      .filter(u => u && !u.guest && u.pass) // real accounts only
      .map(u => ({
        user: u.username,
        level: u.xp?.level ?? 1,
        messages: u.stats?.messages ?? 0
      }))
      .sort((a, b) => (b.level - a.level) || (b.messages - a.messages) || a.user.localeCompare(b.user))
      .slice(0, 25);

    socket.emit("leaderboard:data", all);
  });

  /* -------------------------
     Social (friends + block)
  ------------------------- */
  socket.on("social:sync", () => {
    const username = requireAuth();
    if (!username) return;
    emitSocial(username);
  });

  socket.on("friend:request", ({ to } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(to);
    if (!db.users[target] || !db.users[target].pass) {
      socket.emit("sendError", { reason: "User not found." });
      return;
    }
    if (target === username) {
      socket.emit("sendError", { reason: "You can’t friend yourself." });
      return;
    }

    const me = db.users[username];
    const them = db.users[target];

    if (me.social.blocked.includes(target) || them.social.blocked.includes(username)) {
      socket.emit("sendError", { reason: "Blocked." });
      return;
    }
    if (me.social.friends.includes(target)) {
      socket.emit("sendError", { reason: "Already friends." });
      return;
    }
    if (me.social.outgoing.includes(target)) {
      socket.emit("sendError", { reason: "Request already sent." });
      return;
    }

    me.social.outgoing.push(target);
    them.social.incoming.push(username);

    emitSocial(username);
    emitSocial(target);
    scheduleSave();
  });

  socket.on("friend:accept", ({ from } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const src = normalizeUser(from);
    const me = db.users[username];
    const them = db.users[src];
    if (!them) return;

    me.social.incoming = me.social.incoming.filter(x => x !== src);
    them.social.outgoing = them.social.outgoing.filter(x => x !== username);

    if (!me.social.friends.includes(src)) me.social.friends.push(src);
    if (!them.social.friends.includes(username)) them.social.friends.push(username);

    emitSocial(username);
    emitSocial(src);
    scheduleSave();
  });

  socket.on("friend:decline", ({ from } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const src = normalizeUser(from);
    const me = db.users[username];
    const them = db.users[src];
    if (!them) return;

    me.social.incoming = me.social.incoming.filter(x => x !== src);
    them.social.outgoing = them.social.outgoing.filter(x => x !== username);

    emitSocial(username);
    emitSocial(src);
    scheduleSave();
  });

  socket.on("friend:remove", ({ user } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(user);
    const me = db.users[username];
    const them = db.users[target];
    if (!them) return;

    me.social.friends = me.social.friends.filter(x => x !== target);
    them.social.friends = them.social.friends.filter(x => x !== username);

    emitSocial(username);
    emitSocial(target);
    scheduleSave();
  });

  socket.on("user:block", ({ user } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(user);
    if (!db.users[target]) {
      socket.emit("sendError", { reason: "User not found." });
      return;
    }

    const me = db.users[username];
    if (!me.social.blocked.includes(target)) me.social.blocked.push(target);

    // remove friendship & pending
    me.social.friends = me.social.friends.filter(x => x !== target);
    me.social.incoming = me.social.incoming.filter(x => x !== target);
    me.social.outgoing = me.social.outgoing.filter(x => x !== target);

    const them = db.users[target];
    if (them?.social) {
      them.social.friends = them.social.friends.filter(x => x !== username);
      them.social.incoming = them.social.incoming.filter(x => x !== username);
      them.social.outgoing = them.social.outgoing.filter(x => x !== username);
    }

    emitSocial(username);
    emitSocial(target);
    scheduleSave();
  });

  socket.on("user:unblock", ({ user } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const target = normalizeUser(user);
    const me = db.users[username];
    me.social.blocked = me.social.blocked.filter(x => x !== target);
    emitSocial(username);
    scheduleSave();
  });

  /* -------------------------
     Inbox
     - mentions, group invites, friend requests only
     - no “sections” on the client; client just renders a list
  ------------------------- */
  socket.on("inbox:get", () => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];

    socket.emit("inbox:data", {
      friendRequests: u.social.incoming || [],
      groupInvites: db.groupInvites[username] || [],
      mentions: u.notifications?.mentions ?? 0
    });
  });

  socket.on("mentions:clear", () => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];
    u.notifications.mentions = 0;
    emitSocial(username);
    scheduleSave();
  });

  /* -------------------------
     Global chat history + send
     - server does not enforce cooldown (client does),
       but you can add server-side if needed.
  ------------------------- */
  socket.on("sendGlobal", ({ text, ts } = {}) => {
    const sender = currentUser();
    if (!sender) return;

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { user: sender, text: safeText, ts: Number(ts) || now() };
    db.global.push(msg);
    if (db.global.length > 350) db.global.shift();

    // Mention detection for real accounts: @username
    // (Guests do not get inbox mentions)
    for (const [uname, rec] of Object.entries(db.users)) {
      if (!rec || rec.guest) continue;
      if (!rec.pass) continue;
      const rx = new RegExp(`@${uname}\\b`, "i");
      if (rx.test(safeText)) {
        rec.notifications = rec.notifications || { mentions: 0 };
        rec.notifications.mentions = Math.min(99, (rec.notifications.mentions || 0) + 1);
        emitSocial(uname);
      }
    }

    io.emit("globalMessage", msg);

    // XP for real accounts only
    if (!/^Guest/.test(sender) && db.users[sender] && db.users[sender].pass) {
      db.users[sender].stats.messages = (db.users[sender].stats.messages || 0) + 1;
      addXP(db.users[sender], 7);
      io.to(sender).emit("xp:update", db.users[sender].xp);
      scheduleSave();
    }
  });

  /* -------------------------
     DM history + send
     - respects blocking
     - if you “unadd” someone, client hides DM list but server keeps history
  ------------------------- */
  socket.on("dm:history", ({ withUser } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const other = normalizeUser(withUser);
    if (!db.users[other] || !db.users[other].pass) {
      socket.emit("dm:history", { withUser: other, msgs: [] });
      return;
    }

    const key = dmKey(username, other);
    const msgs = (db.dms[key] || []).slice(-220);
    socket.emit("dm:history", { withUser: other, msgs });
  });

  socket.on("dm:send", ({ to, text } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(to);
    if (!db.users[target] || !db.users[target].pass) {
      socket.emit("sendError", { reason: "User not found." });
      return;
    }

    const me = db.users[username];
    const them = db.users[target];

    if (me.social.blocked.includes(target) || them.social.blocked.includes(username)) {
      socket.emit("sendError", { reason: "You can’t message this user." });
      return;
    }

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { user: username, text: safeText, ts: now() };

    const key = dmKey(username, target);
    const list = getOrCreateDM(key);
    list.push(msg);
    if (list.length > 300) list.shift();

    io.to(username).emit("dm:message", { from: target, msg });
    io.to(target).emit("dm:message", { from: username, msg });

    me.stats.messages = (me.stats.messages || 0) + 1;
    addXP(me, 10);
    io.to(username).emit("xp:update", me.xp);

    scheduleSave();
  });

  /* -------------------------
     Groups: invites required to “activate”
  ------------------------- */
  socket.on("groups:list", () => {
    const username = requireAuth();
    if (!username) return;
    emitGroupsList(username);
  });

  socket.on("group:createRequest", ({ name, invites } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const list = Array.isArray(invites) ? invites.map(normalizeUser) : [];
    const uniqueInvites = Array.from(new Set(list))
      .filter(u => u && u !== username && db.users[u] && db.users[u].pass);

    if (uniqueInvites.length < 1) {
      socket.emit("sendError", { reason: "Invite at least 1 person to create a group." });
      return;
    }

    const gname = String(name || "").trim().slice(0, 40) || "Unnamed Group";
    const gid = crypto.randomBytes(6).toString("hex");

    db.groups[gid] = {
      id: gid,
      name: gname,
      owner: username,
      members: [username],
      msgs: [],
      active: false,
      pendingInvites: uniqueInvites
    };

    for (const u of uniqueInvites) {
      if (!db.groupInvites[u]) db.groupInvites[u] = [];
      db.groupInvites[u].unshift({ id: gid, from: username, name: gname, ts: now() });
      db.groupInvites[u] = db.groupInvites[u].slice(0, 60);
      emitSocial(u);
    }

    socket.emit("group:requestCreated", { id: gid, name: gname, invites: uniqueInvites });
    scheduleSave();
  });

  socket.on("groupInvite:accept", ({ id } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(id || "");
    const g = db.groups[gid];
    if (!g) return;

    db.groupInvites[username] = (db.groupInvites[username] || []).filter(x => x.id !== gid);
    if (!g.members.includes(username)) g.members.push(username);

    if (!g.active) g.active = true;

    g.pendingInvites = (g.pendingInvites || []).filter(x => x !== username);

    for (const member of g.members) {
      io.to(member).emit("group:meta", {
        groupId: gid,
        meta: { id: gid, name: g.name, owner: g.owner, members: g.members }
      });
      emitGroupsList(member);
    }

    emitSocial(username);
    scheduleSave();
  });

  socket.on("groupInvite:decline", ({ id } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(id || "");
    const g = db.groups[gid];
    if (g?.pendingInvites) g.pendingInvites = g.pendingInvites.filter(x => x !== username);

    db.groupInvites[username] = (db.groupInvites[username] || []).filter(x => x.id !== gid);
    emitSocial(username);
    scheduleSave();
  });

  socket.on("group:history", ({ groupId } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || !g.members.includes(username)) {
      socket.emit("sendError", { reason: "No access to group." });
      return;
    }

    socket.emit("group:history", {
      groupId: gid,
      meta: { id: gid, name: g.name, owner: g.owner, members: g.members },
      msgs: g.msgs.slice(-260)
    });
  });

  socket.on("group:send", ({ groupId, text } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || !g.members.includes(username)) {
      socket.emit("sendError", { reason: "No access to group." });
      return;
    }

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { user: username, text: safeText, ts: now() };
    g.msgs.push(msg);
    if (g.msgs.length > 380) g.msgs.shift();

    for (const member of g.members) {
      io.to(member).emit("group:message", { groupId: gid, msg });
    }

    const me = db.users[username];
    me.stats.messages = (me.stats.messages || 0) + 1;
    addXP(me, 9);
    io.to(username).emit("xp:update", me.xp);

    scheduleSave();
  });

  socket.on("group:rename", ({ groupId, name } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || g.owner !== username) {
      socket.emit("sendError", { reason: "Only owner can rename." });
      return;
    }

    g.name = String(name || "").trim().slice(0, 40) || "Unnamed Group";

    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
      emitGroupsList(m);
    }
    scheduleSave();
  });

  socket.on("group:transferOwner", ({ groupId, newOwner } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const target = normalizeUser(newOwner);
    const g = db.groups[gid];

    if (!g || !g.active || g.owner !== username) {
      socket.emit("sendError", { reason: "Only owner can transfer." });
      return;
    }
    if (!g.members.includes(target)) {
      socket.emit("sendError", { reason: "New owner must be a member." });
      return;
    }

    g.owner = target;
    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
    }
    scheduleSave();
  });

  socket.on("group:addMember", ({ groupId, user } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const target = normalizeUser(user);
    const g = db.groups[gid];

    if (!g || !g.active || g.owner !== username) {
      socket.emit("sendError", { reason: "Only owner can add members." });
      return;
    }
    if (!db.users[target] || !db.users[target].pass) {
      socket.emit("sendError", { reason: "User not found." });
      return;
    }

    if (!g.members.includes(target)) g.members.push(target);

    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
      emitGroupsList(m);
    }
    scheduleSave();
  });

  socket.on("group:removeMember", ({ groupId, user } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const target = normalizeUser(user);
    const g = db.groups[gid];

    if (!g || !g.active || g.owner !== username) {
      socket.emit("sendError", { reason: "Only owner can remove members." });
      return;
    }
    if (target === g.owner) {
      socket.emit("sendError", { reason: "Owner can’t be removed." });
      return;
    }

    g.members = g.members.filter(x => x !== target);
    io.to(target).emit("group:left", { groupId: gid });

    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
      emitGroupsList(m);
    }
    emitGroupsList(target);
    scheduleSave();
  });

  socket.on("group:leave", ({ groupId } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || !g.members.includes(username)) return;

    if (g.owner === username) {
      // owner leaving deletes
      const members = [...g.members];
      delete db.groups[gid];
      for (const m of members) {
        io.to(m).emit("group:deleted", { groupId: gid });
        emitGroupsList(m);
      }
      scheduleSave();
      return;
    }

    g.members = g.members.filter(x => x !== username);
    io.to(username).emit("group:left", { groupId: gid });

    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
      emitGroupsList(m);
    }
    emitGroupsList(username);
    scheduleSave();
  });

  socket.on("group:delete", ({ groupId } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || g.owner !== username) {
      socket.emit("sendError", { reason: "Only owner can delete group." });
      return;
    }

    const members = [...g.members];
    delete db.groups[gid];
    for (const m of members) {
      io.to(m).emit("group:deleted", { groupId: gid });
      emitGroupsList(m);
    }
    scheduleSave();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));
