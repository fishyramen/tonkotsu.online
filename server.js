// server.js (ESM) — Render-ready, disk-ready persistence, invites-required groups, XP + bio saved per user
import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import process from "process";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

/**
 * -------------------------
 * Persistence (Render disk-ready)
 * -------------------------
 * If you add a Render Persistent Disk mounted at /data,
 * it will store to: /data/tonkotsu.json
 */
const DISK_FILE = process.env.TONKOTSU_DB_FILE || "/data/tonkotsu.json";

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveToDisk().catch(() => {});
  }, 700);
}
function safeJson(obj) {
  return JSON.stringify(obj, null, 2);
}

const db = {
  users: {},       // username -> record
  tokens: {},      // token -> username
  global: [],      // [{user,text,ts}]
  dms: {},         // "a|b" -> [{user,text,ts}]
  groups: {},      // gid -> {id,name,owner,members,msgs,active,pendingInvites}
  groupInvites: {},// username -> [{id, from, name, ts}]
  inbox: {}        // username -> [{type, text, ts, meta}]
};

function now() { return Date.now(); }
function normalizeUser(u) { return String(u || "").trim(); }
function dmKey(a, b) {
  const x = String(a), y = String(b);
  return (x.localeCompare(y) <= 0) ? `${x}|${y}` : `${y}|${x}`;
}

function usernameValid(u) {
  // no spaces, only letters/numbers/_/. and length 3-20
  return /^[A-Za-z0-9_.]{3,20}$/.test(u);
}

// Block obviously sexual/underage/violent extremist strings in usernames.
// (You asked “ban as much as possible” — we keep it category-based, not a slur list.)
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

// Hard hide harmful messages (category-based)
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

// Password hashing
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

// XP
function xpNext(level) {
  const base = 120;
  const growth = Math.floor(base * Math.pow(Math.max(1, level), 1.5));
  return Math.max(base, growth);
}
function addXP(userRec, amount) {
  if (!userRec || userRec.guest) return { leveledUp: false };
  if (!userRec.xp) userRec.xp = { level: 1, xp: 0, next: xpNext(1) };
  userRec.xp.xp += amount;

  let leveledUp = false;
  while (userRec.xp.xp >= userRec.xp.next) {
    userRec.xp.xp -= userRec.xp.next;
    userRec.xp.level += 1;
    userRec.xp.next = xpNext(userRec.xp.level);
    leveledUp = true;
  }
  return { leveledUp };
}

// User records
function ensureUser(username, password) {
  if (!db.users[username]) {
    db.users[username] = {
      username,
      pass: hashPass(password),
      createdAt: now(),
      guest: false,
      tutorialDone: false,
      bio: "",
      settings: {
        // keep it minimal; no theme switch here (you said keep it)
        reduceMotion: false,
        cursorMode: "pulse",    // off | pulse | trail
        sounds: true,
        hideMildProfanity: false,
        showBlocked: false      // if blocked users in global show as "hidden" or show actual text
      },
      social: {
        friends: [],
        incoming: [],
        outgoing: [],
        blocked: []
      },
      stats: { messages: 0 },
      xp: { level: 1, xp: 0, next: xpNext(1) },
      mutes: {
        global: false,
        dms: [],     // usernames muted
        groups: []   // group ids muted
      }
    };
  }
  if (!db.inbox[username]) db.inbox[username] = [];
  if (!db.groupInvites[username]) db.groupInvites[username] = [];
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
    bio: u.bio || ""
  };
}

// Online tracking
const socketToUser = new Map(); // socket.id -> username
const online = new Set();

function emitOnline() {
  const list = Array.from(online).sort().map(user => ({ user }));
  io.emit("onlineUsers", list);
}

function emitGroupsList(username) {
  const u = db.users[username];
  if (!u || u.guest) return;

  const groups = Object.values(db.groups)
    .filter(g => g.active && g.members.includes(username))
    .map(g => ({ id: g.id, name: g.name, owner: g.owner, members: g.members }));

  io.to(username).emit("groups:list", groups);
}

function emitInbox(username) {
  const u = db.users[username];
  if (!u || u.guest) return;

  const items = (db.inbox[username] || []).slice(0, 50);
  const friendReqs = u.social.incoming || [];
  const groupInvs = db.groupInvites[username] || [];

  // Inbox is only: mentions, group invites, friend requests
  // We store mentions as items, but invites/requests are separate arrays for actions.
  io.to(username).emit("inbox:data", {
    mentions: items.filter(x => x.type === "mention"),
    groupInvites: groupInvs,
    friendRequests: friendReqs
  });

  const count = items.filter(x => x.type === "mention").length + groupInvs.length + friendReqs.length;
  io.to(username).emit("inbox:count", { count });
}

function pushMention(toUser, text, meta = {}) {
  if (!db.inbox[toUser]) db.inbox[toUser] = [];
  db.inbox[toUser].unshift({ type: "mention", text, ts: now(), meta });
  db.inbox[toUser] = db.inbox[toUser].slice(0, 50);
  emitInbox(toUser);
  scheduleSave();
}

function parseMentions(text) {
  // matches @username (same rules)
  const t = String(text || "");
  const rx = /@([A-Za-z0-9_.]{3,20})/g;
  const out = new Set();
  let m;
  while ((m = rx.exec(t))) out.add(m[1]);
  return Array.from(out);
}

async function loadFromDisk() {
  try {
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
      db.inbox = parsed.inbox || {};
    }
    console.log("[db] loaded", DISK_FILE);
  } catch (e) {
    console.log("[db] load failed", e?.message || e);
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
      groupInvites: db.groupInvites,
      inbox: db.inbox
    };
    await fs.promises.writeFile(DISK_FILE, safeJson(payload), "utf8");
  } catch {}
}

await loadFromDisk();

// Socket
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

  // resume token
  socket.on("resume", ({ token } = {}) => {
    const t = String(token || "");
    const username = db.tokens[t];
    if (!username || !db.users[username]) {
      socket.emit("resumeFail");
      return;
    }

    socketToUser.set(socket.id, username);
    socket.join(username);
    online.add(username);
    emitOnline();

    const userRec = db.users[username];

    socket.emit("loginSuccess", {
      username,
      guest: false,
      token: t,
      settings: userRec.settings,
      social: userRec.social,
      xp: userRec.xp,
      mutes: userRec.mutes,
      tutorialDone: !!userRec.tutorialDone
    });

    emitInbox(username);
    emitGroupsList(username);
    socket.emit("leaderboard:data", getLeaderboard());
  });

  // login
  socket.on("login", ({ username, password, guest } = {}) => {
    if (guest) {
      // Guest ID must be 4-5 digits
      const digits = (Math.random() < 0.5)
        ? String(Math.floor(1000 + Math.random() * 9000))
        : String(Math.floor(10000 + Math.random() * 90000));
      const g = `Guest${digits}`;

      socketToUser.set(socket.id, g);
      socket.emit("loginSuccess", {
        username: g,
        guest: true,
        settings: {
          reduceMotion: false,
          cursorMode: "pulse",
          sounds: true,
          hideMildProfanity: false,
          showBlocked: false
        },
        social: { friends: [], incoming: [], outgoing: [], blocked: [] },
        xp: null,
        mutes: { global: false, dms: [], groups: [] },
        tutorialDone: true
      });

      // guests still appear online list
      online.add(g);
      emitOnline();
      return;
    }

    const u = normalizeUser(username);
    const p = String(password || "");

    if (!usernameValid(u) || badUsername(u)) {
      socket.emit("loginError", "Username not allowed. Use letters/numbers/_/. only (3-20). No spaces.");
      return;
    }
    if (!p || p.length < 4) {
      socket.emit("loginError", "Password too short.");
      return;
    }

    const existing = db.users[u];
    if (!existing) {
      ensureUser(u, p);
    } else {
      if (!checkPass(p, existing.pass)) {
        socket.emit("loginError", "Wrong password.");
        return;
      }
    }

    const token = newToken();
    db.tokens[token] = u;

    socketToUser.set(socket.id, u);
    socket.join(u);
    online.add(u);
    emitOnline();

    const userRec = db.users[u];

    socket.emit("loginSuccess", {
      username: u,
      guest: false,
      token,
      settings: userRec.settings,
      social: userRec.social,
      xp: userRec.xp,
      mutes: userRec.mutes,
      tutorialDone: !!userRec.tutorialDone
    });

    emitInbox(u);
    emitGroupsList(u);
    socket.emit("leaderboard:data", getLeaderboard());

    scheduleSave();
  });

  socket.on("logout", () => {
    const u = currentUser();
    socketToUser.delete(socket.id);
    if (u) {
      online.delete(u);
      emitOnline();
    }
  });

  socket.on("disconnect", () => {
    const u = currentUser();
    socketToUser.delete(socket.id);
    if (u) {
      online.delete(u);
      emitOnline();
    }
  });

  // tutorial done
  socket.on("tutorial:setDone", ({ done } = {}) => {
    const username = requireAuth();
    if (!username) return;
    db.users[username].tutorialDone = !!done;
    scheduleSave();
  });

  // settings (SAVE only)
  socket.on("settings:update", (settings) => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];
    if (!u) return;

    const s = settings || {};
    u.settings = {
      reduceMotion: !!s.reduceMotion,
      cursorMode: ["off", "pulse", "trail"].includes(s.cursorMode) ? s.cursorMode : "pulse",
      sounds: s.sounds !== false,
      hideMildProfanity: !!s.hideMildProfanity,
      showBlocked: !!s.showBlocked
    };

    socket.emit("settings", u.settings);
    scheduleSave();
  });

  // mutes
  socket.on("mutes:update", (mutes) => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];
    if (!u) return;

    const m = mutes || {};
    u.mutes = {
      global: !!m.global,
      dms: Array.isArray(m.dms) ? m.dms.slice(0, 200) : [],
      groups: Array.isArray(m.groups) ? m.groups.slice(0, 200) : []
    };

    socket.emit("mutes", u.mutes);
    scheduleSave();
  });

  // profile
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

  // bio update
  socket.on("bio:update", ({ bio } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];
    const b = String(bio || "").slice(0, 180);
    u.bio = b;
    scheduleSave();
    socket.emit("profile:data", publicProfile(username));
  });

  // leaderboard
  function getLeaderboard() {
    const arr = Object.values(db.users)
      .filter(u => !u.guest && u.xp && Number.isFinite(u.xp.level))
      .map(u => ({ user: u.username, level: u.xp.level, messages: u.stats?.messages ?? 0 }))
      .sort((a, b) => (b.level - a.level) || (b.messages - a.messages))
      .slice(0, 50);
    return arr;
  }
  socket.on("leaderboard:get", () => {
    socket.emit("leaderboard:data", getLeaderboard());
  });

  // social / friends / block
  socket.on("friend:request", ({ to } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(to);
    if (!db.users[target]) return socket.emit("sendError", { reason: "User not found." });
    if (target === username) return socket.emit("sendError", { reason: "You can’t friend yourself." });

    const me = db.users[username];
    const them = db.users[target];

    if (me.social.blocked.includes(target) || them.social.blocked.includes(username)) {
      return socket.emit("sendError", { reason: "Blocked." });
    }

    if (me.social.friends.includes(target)) return socket.emit("sendError", { reason: "Already friends." });
    if (me.social.outgoing.includes(target)) return socket.emit("sendError", { reason: "Request already sent." });

    me.social.outgoing.push(target);
    them.social.incoming.push(username);

    emitInbox(target);
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

    emitInbox(username);
    emitInbox(src);
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

    emitInbox(username);
    emitInbox(src);
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

    scheduleSave();
  });

  socket.on("user:block", ({ user } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(user);
    if (!db.users[target]) return socket.emit("sendError", { reason: "User not found." });

    const me = db.users[username];
    if (!me.social.blocked.includes(target)) me.social.blocked.push(target);

    // remove friendship & pending
    me.social.friends = me.social.friends.filter(x => x !== target);
    me.social.incoming = me.social.incoming.filter(x => x !== target);
    me.social.outgoing = me.social.outgoing.filter(x => x !== target);

    const them = db.users[target];
    them.social.friends = them.social.friends.filter(x => x !== username);
    them.social.incoming = them.social.incoming.filter(x => x !== username);
    them.social.outgoing = them.social.outgoing.filter(x => x !== username);

    scheduleSave();
  });

  socket.on("user:unblock", ({ user } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const target = normalizeUser(user);
    const me = db.users[username];
    me.social.blocked = me.social.blocked.filter(x => x !== target);
    scheduleSave();
  });

  // Inbox
  socket.on("inbox:get", () => {
    const username = requireAuth();
    if (!username) return;
    emitInbox(username);
  });

  socket.on("inbox:clearMentions", () => {
    const username = requireAuth();
    if (!username) return;
    db.inbox[username] = (db.inbox[username] || []).filter(x => x.type !== "mention");
    emitInbox(username);
    scheduleSave();
  });

  // Global
  socket.on("requestGlobalHistory", () => {
    socket.emit("history", db.global.slice(-200));
  });

  socket.on("sendGlobal", ({ text, ts } = {}) => {
    const sender = currentUser();
    if (!sender) return;

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { user: sender, text: safeText, ts: Number(ts) || now() };
    db.global.push(msg);
    if (db.global.length > 400) db.global.shift();

    io.emit("globalMessage", msg);

    // mentions -> inbox
    const mentions = parseMentions(safeText);
    for (const u of mentions) {
      if (!db.users[u]) continue;
      pushMention(u, `${sender} mentioned you in Global`, { from: sender, where: "global" });
    }

    if (!/^Guest/.test(sender) && db.users[sender]) {
      const rec = db.users[sender];
      rec.stats.messages += 1;
      const { leveledUp } = addXP(rec, 8);
      io.to(sender).emit("xp:update", rec.xp);
      if (leveledUp) io.to(sender).emit("xp:levelup", { level: rec.xp.level });
      io.emit("leaderboard:data", getLeaderboard());
      scheduleSave();
    }
  });

  // DMs
  socket.on("dm:history", ({ withUser } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const other = normalizeUser(withUser);
    if (!db.users[other]) return socket.emit("dm:history", { withUser: other, msgs: [] });

    const key = dmKey(username, other);
    const msgs = (db.dms[key] || []).slice(-200);
    socket.emit("dm:history", { withUser: other, msgs });
  });

  socket.on("dm:send", ({ to, text } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(to);
    if (!db.users[target]) return socket.emit("sendError", { reason: "User not found." });

    const me = db.users[username];
    const them = db.users[target];

    if (me.social.blocked.includes(target) || them.social.blocked.includes(username)) {
      return socket.emit("sendError", { reason: "You can’t message this user." });
    }

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { user: username, text: safeText, ts: now() };

    const key = dmKey(username, target);
    if (!db.dms[key]) db.dms[key] = [];
    db.dms[key].push(msg);
    if (db.dms[key].length > 300) db.dms[key].shift();

    io.to(username).emit("dm:message", { from: target, msg });
    io.to(target).emit("dm:message", { from: username, msg });

    me.stats.messages += 1;
    const { leveledUp } = addXP(me, 10);
    io.to(username).emit("xp:update", me.xp);
    if (leveledUp) io.to(username).emit("xp:levelup", { level: me.xp.level });

    // mention in DM -> inbox
    const mentions = parseMentions(safeText);
    for (const u of mentions) {
      if (!db.users[u]) continue;
      pushMention(u, `${username} mentioned you in DMs`, { from: username, where: "dm" });
    }

    io.emit("leaderboard:data", getLeaderboard());
    scheduleSave();
  });

  // Groups
  socket.on("groups:list", () => {
    const username = requireAuth();
    if (!username) return;
    emitGroupsList(username);
  });

  // Create group requires invites >= 1
  socket.on("group:createRequest", ({ name, invites } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const list = Array.isArray(invites) ? invites.map(normalizeUser) : [];
    const uniqueInvites = Array.from(new Set(list))
      .filter(u => u && u !== username && db.users[u]);

    if (uniqueInvites.length < 1) {
      return socket.emit("sendError", { reason: "Invite at least 1 person to create a group." });
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

    // push invite into each user's groupInvites inbox
    for (const u of uniqueInvites) {
      if (!db.groupInvites[u]) db.groupInvites[u] = [];
      db.groupInvites[u].unshift({ id: gid, from: username, name: gname, ts: now() });
      db.groupInvites[u] = db.groupInvites[u].slice(0, 50);
      emitInbox(u);
    }

    // owner gets a heads-up, but group doesn't show until someone accepts
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

    // notify members + update lists
    for (const member of g.members) {
      io.to(member).emit("group:meta", {
        groupId: gid,
        name: g.name,
        owner: g.owner,
        members: g.members
      });
      emitGroupsList(member);
      emitInbox(member);
    }

    scheduleSave();
  });

  socket.on("groupInvite:decline", ({ id } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(id || "");
    const g = db.groups[gid];
    if (g?.pendingInvites) g.pendingInvites = g.pendingInvites.filter(x => x !== username);

    db.groupInvites[username] = (db.groupInvites[username] || []).filter(x => x.id !== gid);

    emitInbox(username);
    scheduleSave();
  });

  socket.on("group:history", ({ groupId } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || !g.members.includes(username)) {
      return socket.emit("sendError", { reason: "No access to group." });
    }

    socket.emit("group:history", {
      groupId: gid,
      meta: { id: gid, name: g.name, owner: g.owner, members: g.members },
      msgs: g.msgs.slice(-250)
    });
  });

  socket.on("group:send", ({ groupId, text } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || !g.members.includes(username)) {
      return socket.emit("sendError", { reason: "No access to group." });
    }

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { user: username, text: safeText, ts: now() };
    g.msgs.push(msg);
    if (g.msgs.length > 350) g.msgs.shift();

    for (const member of g.members) {
      io.to(member).emit("group:message", { groupId: gid, msg });
    }

    const me = db.users[username];
    me.stats.messages += 1;
    const { leveledUp } = addXP(me, 9);
    io.to(username).emit("xp:update", me.xp);
    if (leveledUp) io.to(username).emit("xp:levelup", { level: me.xp.level });

    // mentions -> inbox
    const mentions = parseMentions(safeText);
    for (const u of mentions) {
      if (!db.users[u]) continue;
      pushMention(u, `${username} mentioned you in a Group`, { from: username, where: "group" });
    }

    io.emit("leaderboard:data", getLeaderboard());
    scheduleSave();
  });

  socket.on("group:addMember", ({ groupId, user } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const target = normalizeUser(user);
    const g = db.groups[gid];

    if (!g || !g.active || g.owner !== username) {
      return socket.emit("sendError", { reason: "Only owner can add members." });
    }
    if (!db.users[target]) return socket.emit("sendError", { reason: "User not found." });
    if (!g.members.includes(target)) g.members.push(target);

    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, name: g.name, owner: g.owner, members: g.members });
      emitGroupsList(m);
    }
    emitInbox(target);
    scheduleSave();
  });

  socket.on("group:removeMember", ({ groupId, user } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const target = normalizeUser(user);
    const g = db.groups[gid];

    if (!g || !g.active || g.owner !== username) {
      return socket.emit("sendError", { reason: "Only owner can remove members." });
    }
    if (target === g.owner) return socket.emit("sendError", { reason: "Owner can’t be removed." });

    g.members = g.members.filter(x => x !== target);
    io.to(target).emit("group:left", { groupId: gid });

    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, name: g.name, owner: g.owner, members: g.members });
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
      io.to(m).emit("group:meta", { groupId: gid, name: g.name, owner: g.owner, members: g.members });
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
      return socket.emit("sendError", { reason: "Only owner can delete group." });
    }

    const members = [...g.members];
    delete db.groups[gid];
    for (const m of members) {
      io.to(m).emit("group:deleted", { groupId: gid });
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
      return socket.emit("sendError", { reason: "Only owner can transfer." });
    }
    if (!g.members.includes(target)) {
      return socket.emit("sendError", { reason: "New owner must be a member." });
    }

    g.owner = target;
    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, name: g.name, owner: g.owner, members: g.members });
    }
    scheduleSave();
  });

  socket.on("group:rename", ({ groupId, name } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || g.owner !== username) {
      return socket.emit("sendError", { reason: "Only owner can rename." });
    }

    const n = String(name || "").trim().slice(0, 40) || "Unnamed Group";
    g.name = n;
    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, name: g.name, owner: g.owner, members: g.members });
      emitGroupsList(m);
    }
    scheduleSave();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));
