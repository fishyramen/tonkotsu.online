/**
 * server.js — tonkotsu.online
 * Persistent chat: accounts + passwords + global + DMs + groups + settings.
 *
 * Folder structure:
 *  - server.js
 *  - package.json
 *  - public/
 *      - index.html
 *      - script.js
 *  - data/              <-- created automatically if missing (and ignored by git)
 *      - users.json
 *      - global.json
 *      - dms.json
 *      - groups.json
 *      - social.json
 */

"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

/* ---------------- app ---------------- */
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e6 });

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ---------------- data dir (persistent if you mount disk) ---------------- */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(DATA_DIR);

const FILES = {
  users: path.join(DATA_DIR, "users.json"),
  global: path.join(DATA_DIR, "global.json"),
  dms: path.join(DATA_DIR, "dms.json"),
  groups: path.join(DATA_DIR, "groups.json"),
  social: path.join(DATA_DIR, "social.json"),
};

function writeAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) writeAtomic(file, fallback);
    const raw = fs.readFileSync(file, "utf8");
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error("readJSON error:", file, e);
    return fallback;
  }
}

/* ---------------- load data ---------------- */
let USERS = readJSON(FILES.users, {});     // username -> { passHash, salt, createdAt, color, settings, muted }
let GLOBAL = readJSON(FILES.global, []);   // [{id,user,text,ts,color}]
let DMS = readJSON(FILES.dms, {});         // key "a__b" -> [{id,from,to,text,ts}]
let GROUPS = readJSON(FILES.groups, {});   // groupId -> { id, name, owner, members[], createdAt, msgs[] }
let SOCIAL = readJSON(FILES.social, {});   // username -> { friends[], incoming[], outgoing[], unread:{}, allowRequests }

/* ---------------- sanity cleanup ---------------- */
const NOW = Date.now();
const MIN_TS = new Date("2020-01-01T00:00:00Z").getTime();
function validTs(x) {
  return Number.isFinite(x) && x >= MIN_TS && x <= (NOW + 86400000);
}
// remove old broken timestamps (your request)
GLOBAL = (Array.isArray(GLOBAL) ? GLOBAL : []).filter(m => m && validTs(m.ts));
for (const k of Object.keys(DMS)) {
  DMS[k] = (Array.isArray(DMS[k]) ? DMS[k] : []).filter(m => m && validTs(m.ts));
}
for (const gid of Object.keys(GROUPS)) {
  const g = GROUPS[gid];
  if (!g || !g.id || !Array.isArray(g.members)) {
    delete GROUPS[gid];
    continue;
  }
  g.msgs = (Array.isArray(g.msgs) ? g.msgs : []).filter(m => m && validTs(m.ts));
}
writeAtomic(FILES.global, GLOBAL);
writeAtomic(FILES.dms, DMS);
writeAtomic(FILES.groups, GROUPS);

/* ---------------- helpers ---------------- */
function now() { return Date.now(); }
function id() { return crypto.randomBytes(10).toString("hex") + "-" + now().toString(36); }
function normUser(u) { return String(u || "").trim(); }
function isGuest(u) { return /^Guest\d{4,10}$/.test(String(u || "")); }

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}
function hashPassword(pass, salt) {
  return sha256(`${salt}:${pass}:${salt}`);
}

function colorFromName(name) {
  // stable bright-ish color
  const h = sha256(name).slice(0, 6);
  let r = parseInt(h.slice(0, 2), 16);
  let g = parseInt(h.slice(2, 4), 16);
  let b = parseInt(h.slice(4, 6), 16);
  r = Math.min(255, Math.floor((r + 255) / 2));
  g = Math.min(255, Math.floor((g + 255) / 2));
  b = Math.min(255, Math.floor((b + 255) / 2));
  return `rgb(${r},${g},${b})`;
}

function ensureSocial(u) {
  if (!SOCIAL[u]) {
    SOCIAL[u] = { friends: [], incoming: [], outgoing: [], unread: {}, allowRequests: true };
    writeAtomic(FILES.social, SOCIAL);
  }
  return SOCIAL[u];
}

function dmKey(a, b) {
  const x = String(a), y = String(b);
  return x < y ? `${x}__${y}` : `${y}__${x}`;
}

function trimArray(arr, max) {
  if (arr.length > max) arr.splice(0, arr.length - max);
}

/* ---------------- global moderation (global only) ----------------
   This blocks severe hate slurs + threats. DMs are optional filter on client. */
const BLOCK_PATTERNS = [
  // n-word variants (obfuscated) - defensive moderation only
  /n[\W_]*i[\W_]*g[\W_]*g[\W_]*e[\W_]*r/i,
  /n[\W_]*i[\W_]*g[\W_]*g[\W_]*a/i,
  // common death threat phrasing
  /\b(i'?ll|i will)\s+(kill|murder)\s+you\b/i,
  /\b(kill\s+yourself|kys)\b/i,
  /\b(i'?m\s+going\s+to\s+kill\s+you)\b/i,
];

function violatesGlobal(text) {
  const t = String(text || "");
  if (!t.trim()) return "Empty message.";
  for (const re of BLOCK_PATTERNS) {
    if (re.test(t)) return "Message blocked (global chat rules).";
  }
  return null;
}

/* ---------------- live maps ---------------- */
const ONLINE = new Map();      // socket.id -> username
const USER_SOCKETS = new Map();// username -> Set(socket.id)

function pushToUser(user, event, payload) {
  const set = USER_SOCKETS.get(user);
  if (!set) return;
  for (const sid of set) io.to(sid).emit(event, payload);
}

function onlinePayload() {
  const seen = new Set();
  const out = [];
  for (const [, user] of ONLINE) {
    if (seen.has(user)) continue;
    seen.add(user);
    out.push({
      user,
      color: USERS[user]?.color || colorFromName(user),
      guest: isGuest(user),
    });
  }
  out.sort((a, b) => a.user.localeCompare(b.user));
  return out;
}

function broadcastOnline() {
  io.emit("onlineUsers", onlinePayload());
}

function defaultSettings() {
  return {
    sound: true,
    volume: 0.18,
    muteAll: false,
    muteGlobal: true,         // ✅ default OFF for global ping (your request)
    toast: true,
    reduceMotion: false,
    showTimestamps: true,
    autoscroll: true,
    enterToSend: true,
    customCursor: true,
    dmProfanityFilter: false, // DMs less strict; user can toggle hiding on client
  };
}

function getUserState(user) {
  const soc = ensureSocial(user);
  return {
    me: user,
    color: USERS[user]?.color || colorFromName(user),
    friends: soc.friends || [],
    incoming: soc.incoming || [],
    outgoing: soc.outgoing || [],
    unread: soc.unread || {},
    settings: USERS[user]?.settings || defaultSettings(),
    groups: Object.values(GROUPS)
      .filter(g => g && Array.isArray(g.members) && g.members.includes(user))
      .map(g => ({ id: g.id, name: g.name, owner: g.owner })),
  };
}

function saveAll() {
  writeAtomic(FILES.users, USERS);
  writeAtomic(FILES.global, GLOBAL);
  writeAtomic(FILES.dms, DMS);
  writeAtomic(FILES.groups, GROUPS);
  writeAtomic(FILES.social, SOCIAL);
}

/* ---------------- sockets ---------------- */
io.on("connection", (socket) => {
  socket.data.user = null;

  socket.on("login", ({ user, pass }) => {
    try {
      let u = normUser(user);
      const p = String(pass || "");

      const wantsGuest = (!u && !p);

      // account login must have BOTH, guest has NONE
      if (!wantsGuest && ((u && !p) || (!u && p))) {
        socket.emit("loginError", "Use username + password together, or leave both blank for Guest.");
        return;
      }

      if (wantsGuest) {
        u = "Guest" + Math.floor(1000 + Math.random() * 9000000);
      }

      if (u.length < 2 || u.length > 20) {
        socket.emit("loginError", "Username must be 2–20 characters.");
        return;
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(u)) {
        socket.emit("loginError", "Username can use letters, numbers, . _ -");
        return;
      }

      const guest = isGuest(u);

      if (!guest) {
        // create or verify account
        if (!USERS[u]) {
          const salt = crypto.randomBytes(8).toString("hex");
          USERS[u] = {
            createdAt: now(),
            salt,
            passHash: hashPassword(p, salt),
            color: colorFromName(u),
            settings: defaultSettings(),
          };
          ensureSocial(u);
          saveAll();
        } else {
          const rec = USERS[u];
          if (!rec.salt || !rec.passHash) {
            // repair old record
            const salt = crypto.randomBytes(8).toString("hex");
            rec.salt = salt;
            rec.passHash = hashPassword(p, salt);
            rec.color = rec.color || colorFromName(u);
            rec.settings = rec.settings || defaultSettings();
            ensureSocial(u);
            saveAll();
          } else {
            const hp = hashPassword(p, rec.salt);
            if (hp !== rec.passHash) {
              socket.emit("loginError", "Wrong password for that username.");
              return;
            }
          }
        }
      }

      // bind session
      socket.data.user = u;
      ONLINE.set(socket.id, u);
      if (!USER_SOCKETS.has(u)) USER_SOCKETS.set(u, new Set());
      USER_SOCKETS.get(u).add(socket.id);

      socket.emit("loginSuccess", {
        user: u,
        guest,
        color: USERS[u]?.color || colorFromName(u),
        state: guest ? null : getUserState(u),
      });

      // send history (global)
      socket.emit("globalHistory", GLOBAL);

      broadcastOnline();
    } catch (e) {
      console.error("login error:", e);
      socket.emit("loginError", "Login failed. Try again.");
    }
  });

  socket.on("logout", () => {
    // client just reloads; server cleanup happens on disconnect
    socket.disconnect(true);
  });

  /* ---- GLOBAL CHAT ---- */
  socket.on("sendGlobal", ({ text }) => {
    const u = socket.data.user;
    if (!u) return;

    const msg = String(text || "").trim();
    const violation = violatesGlobal(msg);
    if (violation) {
      socket.emit("actionError", { scope: "global", msg: violation });
      return;
    }

    const payload = {
      id: id(),
      user: u,
      text: msg.slice(0, 900),
      ts: now(),
      color: USERS[u]?.color || colorFromName(u),
    };

    GLOBAL.push(payload);
    trimArray(GLOBAL, 450);
    writeAtomic(FILES.global, GLOBAL);

    io.emit("globalMsg", payload);
  });

  /* ---- DMS ---- */
  socket.on("openDM", ({ withUser }) => {
    const me = socket.data.user;
    if (!me) return;
    if (isGuest(me)) {
      socket.emit("dmError", "Guests can’t use DMs.");
      return;
    }

    const other = normUser(withUser);
    if (!other || !USERS[other]) {
      socket.emit("dmError", "User not found.");
      return;
    }

    // clear unread
    const s = ensureSocial(me);
    s.unread[other] = 0;
    writeAtomic(FILES.social, SOCIAL);
    pushToUser(me, "state", getUserState(me));

    const key = dmKey(me, other);
    const msgs = Array.isArray(DMS[key]) ? DMS[key] : [];
    socket.emit("dmHistory", {
      withUser: other,
      msgs,
      colors: {
        [me]: USERS[me]?.color || colorFromName(me),
        [other]: USERS[other]?.color || colorFromName(other),
      },
    });
  });

  socket.on("sendDM", ({ to, text }) => {
    const from = socket.data.user;
    if (!from) return;
    if (isGuest(from)) {
      socket.emit("dmError", "Guests can’t use DMs.");
      return;
    }

    const target = normUser(to);
    if (!target || !USERS[target] || target === from) {
      socket.emit("dmError", "Invalid DM target.");
      return;
    }

    const msg = String(text || "").trim();
    if (!msg) return;

    const key = dmKey(from, target);
    if (!Array.isArray(DMS[key])) DMS[key] = [];

    const payload = { id: id(), from, to: target, text: msg.slice(0, 1200), ts: now() };
    DMS[key].push(payload);
    trimArray(DMS[key], 500);
    writeAtomic(FILES.dms, DMS);

    // unread for target
    const st = ensureSocial(target);
    st.unread[from] = (st.unread[from] || 0) + 1;
    writeAtomic(FILES.social, SOCIAL);

    pushToUser(target, "state", getUserState(target));
    pushToUser(from, "dmMsg", payload);
    pushToUser(target, "dmMsg", payload);
  });

  /* ---- FRIEND REQUESTS (kept for groups gating / social) ---- */
  socket.on("sendFriendRequest", ({ user: target }) => {
    const from = socket.data.user;
    if (!from || isGuest(from)) return;

    const to = normUser(target);
    if (!to || to === from || !USERS[to]) {
      socket.emit("actionError", { scope: "social", msg: "User not found." });
      return;
    }

    const sf = ensureSocial(from);
    const st = ensureSocial(to);

    if ((USERS[to]?.settings?.allowRequests === false) || (st.allowRequests === false)) {
      socket.emit("actionError", { scope: "social", msg: "They’re not accepting requests." });
      return;
    }
    if (sf.friends.includes(to)) {
      socket.emit("actionError", { scope: "social", msg: "Already friends." });
      return;
    }
    if (!sf.outgoing.includes(to)) sf.outgoing.push(to);
    if (!st.incoming.includes(from)) st.incoming.push(from);

    writeAtomic(FILES.social, SOCIAL);
    pushToUser(from, "state", getUserState(from));
    pushToUser(to, "state", getUserState(to));
    pushToUser(from, "toast", { type: "ok", msg: "Friend request sent." });
    pushToUser(to, "toast", { type: "info", msg: "New friend request." });
  });

  socket.on("acceptFriend", ({ user: other }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) return;

    const u = normUser(other);
    if (!u || !USERS[u]) return;

    const sm = ensureSocial(me);
    const so = ensureSocial(u);

    sm.incoming = (sm.incoming || []).filter(x => x !== u);
    so.outgoing = (so.outgoing || []).filter(x => x !== me);

    if (!sm.friends.includes(u)) sm.friends.push(u);
    if (!so.friends.includes(me)) so.friends.push(me);

    writeAtomic(FILES.social, SOCIAL);
    pushToUser(me, "state", getUserState(me));
    pushToUser(u, "state", getUserState(u));
    pushToUser(me, "toast", { type: "ok", msg: "Friend request accepted." });
    pushToUser(u, "toast", { type: "ok", msg: `${me} accepted your request.` });
  });

  socket.on("declineFriend", ({ user: other }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) return;

    const u = normUser(other);
    if (!u || !USERS[u]) return;

    const sm = ensureSocial(me);
    const so = ensureSocial(u);

    sm.incoming = (sm.incoming || []).filter(x => x !== u);
    so.outgoing = (so.outgoing || []).filter(x => x !== me);

    writeAtomic(FILES.social, SOCIAL);
    pushToUser(me, "state", getUserState(me));
    pushToUser(u, "state", getUserState(u));
    pushToUser(me, "toast", { type: "info", msg: "Request declined." });
  });

  /* ---- GROUPS ---- */
  socket.on("createGroup", ({ name, members }) => {
    const owner = socket.data.user;
    if (!owner || isGuest(owner)) return;

    const cleanName = String(name || "").trim().slice(0, 40);
    if (!cleanName) {
      socket.emit("actionError", { scope: "groups", msg: "Group name required." });
      return;
    }

    const soc = ensureSocial(owner);
    const list = Array.isArray(members) ? members.map(normUser).filter(Boolean) : [];
    const uniq = [...new Set(list)].filter(u => USERS[u] && u !== owner);

    // owner can only add friends
    const allowed = uniq.filter(u => (soc.friends || []).includes(u));

    const gid = "g_" + id();
    GROUPS[gid] = {
      id: gid,
      name: cleanName,
      owner,
      members: [owner, ...allowed],
      createdAt: now(),
      msgs: [],
    };
    writeAtomic(FILES.groups, GROUPS);

    // update state for all members
    for (const m of GROUPS[gid].members) {
      pushToUser(m, "state", getUserState(m));
      pushToUser(m, "toast", { type: "ok", msg: `Added to group: ${cleanName}` });
    }
  });

  socket.on("openGroup", ({ groupId }) => {
    const me = socket.data.user;
    if (!me) return;
    if (isGuest(me)) {
      socket.emit("groupError", "Guests can’t use groups.");
      return;
    }

    const g = GROUPS[groupId];
    if (!g || !Array.isArray(g.members) || !g.members.includes(me)) {
      socket.emit("groupError", "Group not found.");
      return;
    }

    socket.emit("groupHistory", {
      group: { id: g.id, name: g.name, owner: g.owner, members: g.members },
      msgs: g.msgs || [],
    });
  });

  socket.on("sendGroup", ({ groupId, text }) => {
    const me = socket.data.user;
    if (!me) return;
    if (isGuest(me)) return;

    const g = GROUPS[groupId];
    if (!g || !Array.isArray(g.members) || !g.members.includes(me)) return;

    const msg = String(text || "").trim();
    if (!msg) return;

    const payload = {
      id: id(),
      from: me,
      text: msg.slice(0, 1200),
      ts: now(),
      color: USERS[me]?.color || colorFromName(me),
      groupId,
    };

    g.msgs = Array.isArray(g.msgs) ? g.msgs : [];
    g.msgs.push(payload);
    trimArray(g.msgs, 600);
    writeAtomic(FILES.groups, GROUPS);

    for (const m of g.members) pushToUser(m, "groupMsg", payload);
  });

  socket.on("groupManage", ({ groupId, action, payload }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) return;

    const g = GROUPS[groupId];
    if (!g) return;

    // only owner can manage
    if (g.owner !== me) {
      socket.emit("actionError", { scope: "groups", msg: "Only the owner can manage this group." });
      return;
    }

    const p = payload || {};

    if (action === "rename") {
      const nn = String(p.name || "").trim().slice(0, 40);
      if (!nn) return;
      g.name = nn;
      writeAtomic(FILES.groups, GROUPS);
    }

    if (action === "add") {
      const who = normUser(p.user);
      if (!who || !USERS[who]) return;

      // owner can only add friends
      const soc = ensureSocial(me);
      if (!(soc.friends || []).includes(who)) {
        socket.emit("actionError", { scope: "groups", msg: "You can only add friends." });
        return;
      }
      if (!g.members.includes(who)) g.members.push(who);
      writeAtomic(FILES.groups, GROUPS);
      pushToUser(who, "state", getUserState(who));
      pushToUser(who, "toast", { type: "ok", msg: `Added to group: ${g.name}` });
    }

    if (action === "remove") {
      const who = normUser(p.user);
      if (!who || who === me) return;
      g.members = (g.members || []).filter(x => x !== who);
      writeAtomic(FILES.groups, GROUPS);
      pushToUser(who, "state", getUserState(who));
    }

    if (action === "transferOwner") {
      const who = normUser(p.user);
      if (!who || !g.members.includes(who)) return;
      g.owner = who;
      writeAtomic(FILES.groups, GROUPS);
    }

    if (action === "delete") {
      const members = g.members || [];
      delete GROUPS[groupId];
      writeAtomic(FILES.groups, GROUPS);
      for (const m of members) pushToUser(m, "state", getUserState(m));
      return;
    }

    // apply instantly for members
    for (const m of (g.members || [])) {
      pushToUser(m, "state", getUserState(m));
    }
  });

  /* ---- SETTINGS ---- */
  socket.on("updateSettings", (s) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) return;

    if (!USERS[me]) return;
    USERS[me].settings = { ...(USERS[me].settings || defaultSettings()), ...(s || {}) };
    writeAtomic(FILES.users, USERS);
    pushToUser(me, "state", getUserState(me));
    pushToUser(me, "toast", { type: "ok", msg: "Settings saved." });
  });

  /* ---- disconnect ---- */
  socket.on("disconnect", () => {
    const u = ONLINE.get(socket.id);
    ONLINE.delete(socket.id);

    if (u && USER_SOCKETS.has(u)) {
      USER_SOCKETS.get(u).delete(socket.id);
      if (USER_SOCKETS.get(u).size === 0) USER_SOCKETS.delete(u);
    }

    broadcastOnline();
  });
});

/* ---------------- listen ---------------- */
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server listening on ${PORT}`);
  console.log(`📁 Using DATA_DIR: ${DATA_DIR}`);
});

socket.on("requestGlobalHistory", () => {
  socket.emit("history", GLOBAL); // or whatever your global array is named
});

