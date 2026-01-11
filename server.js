// ==========================
// tonkotsu.online server.js
// ==========================

const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ==========================
// Static files
// ==========================
app.use(express.static(path.join(__dirname, "public")));

// ==========================
// Data paths
// ==========================
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const GLOBAL_FILE = path.join(DATA_DIR, "global.json");
const DMS_FILE = path.join(DATA_DIR, "dms.json");
const GROUPS_FILE = path.join(DATA_DIR, "groups.json");

// ==========================
// Helpers
// ==========================
function ensureFile(file, fallback) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
  }
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ==========================
// Init data
// ==========================
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

ensureFile(USERS_FILE, {});
ensureFile(GLOBAL_FILE, []);
ensureFile(DMS_FILE, {});
ensureFile(GROUPS_FILE, {});

// ==========================
// In-memory cache
// ==========================
let USERS = readJSON(USERS_FILE);
let GLOBAL = readJSON(GLOBAL_FILE);
let DMS = readJSON(DMS_FILE);
let GROUPS = readJSON(GROUPS_FILE);

// ==========================
// Connected users
// ==========================
const ONLINE = new Map(); // socket.id → username

// ==========================
// Socket.IO
// ==========================
io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  // ---------- LOGIN ----------
  socket.on("login", ({ username, password, guest }) => {
    if (guest) {
      const guestName = `Guest${Math.floor(Math.random() * 9999)}`;
      ONLINE.set(socket.id, guestName);
      socket.emit("loginSuccess", {
        username: guestName,
        guest: true,
      });
      io.emit("onlineUsers", Array.from(ONLINE.values()));
      return;
    }

    if (!username || !password) {
      socket.emit("loginError", "Missing credentials");
      return;
    }

    if (!USERS[username]) {
      USERS[username] = {
        password,
        friends: [],
        settings: {},
      };
      writeJSON(USERS_FILE, USERS);
    } else if (USERS[username].password !== password) {
      socket.emit("loginError", "Wrong password");
      return;
    }

    ONLINE.set(socket.id, username);

    socket.emit("loginSuccess", {
      username,
      guest: false,
    });

    io.emit("onlineUsers", Array.from(ONLINE.values()));
  });

  // ---------- LOGOUT / DISCONNECT ----------
  socket.on("disconnect", () => {
    ONLINE.delete(socket.id);
    io.emit("onlineUsers", Array.from(ONLINE.values()));
  });

  // ---------- GLOBAL HISTORY ----------
  socket.on("requestGlobalHistory", () => {
    socket.emit("history", GLOBAL);
  });

  // ---------- SEND GLOBAL MESSAGE ----------
  socket.on("sendGlobal", (msg) => {
    if (!msg || !msg.user || !msg.text) return;

    if (!msg.time || Number.isNaN(msg.time)) {
      msg.time = Date.now();
    }

    GLOBAL.push(msg);
    writeJSON(GLOBAL_FILE, GLOBAL);

    io.emit("globalMessage", msg);
  });

  // ---------- DMS ----------
  socket.on("sendDM", ({ from, to, text }) => {
    if (!from || !to || !text) return;

    const key = [from, to].sort().join("|");
    if (!DMS[key]) DMS[key] = [];

    const msg = {
      from,
      to,
      text,
      time: Date.now(),
    };

    DMS[key].push(msg);
    writeJSON(DMS_FILE, DMS);

    io.emit("dmMessage", msg);
  });

  socket.on("requestDMHistory", ({ a, b }) => {
    const key = [a, b].sort().join("|");
    socket.emit("dmHistory", DMS[key] || []);
  });

  // ---------- GROUPS ----------
  socket.on("createGroup", ({ name, owner }) => {
    const id = "g_" + Date.now();

    GROUPS[id] = {
      id,
      name,
      owner,
      members: [owner],
      messages: [],
    };

    writeJSON(GROUPS_FILE, GROUPS);
    socket.emit("groupCreated", GROUPS[id]);
  });

  socket.on("sendGroupMessage", ({ groupId, user, text }) => {
    const g = GROUPS[groupId];
    if (!g || !g.members.includes(user)) return;

    const msg = { user, text, time: Date.now() };
    g.messages.push(msg);
    writeJSON(GROUPS_FILE, GROUPS);

    io.emit("groupMessage", { groupId, msg });
  });

  socket.on("requestGroupHistory", (groupId) => {
    const g = GROUPS[groupId];
    if (g) socket.emit("groupHistory", g.messages);
  });
});

// ==========================
// Start server
// ==========================
server.listen(PORT, () => {
  console.log(`tonkotsu.online running on port ${PORT}`);
});
