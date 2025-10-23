// server/index.js (CommonJS for Windows beginners)
const path = require("path");
const fs = require("fs");
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const dotenv = require("dotenv");
const { PrismaClient } = require("@prisma/client");

dotenv.config();
const prisma = new PrismaClient();

const app = express();
app.use(cors());                // in production, restrict origins
app.use(express.json());

// --- Static uploads (demo only) ---
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});
app.use("/uploads", express.static(uploadDir));

// --- HTTP server + Socket.IO ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

// Helper: auth middleware for REST
function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { uid, email }
    next();
  } catch (e) {
    return res.status(401).json({ error: "unauthorized" });
  }
}

// --- Auth routes ---
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password, displayName } = req.body;
    if (!email || !password || !displayName) {
      return res.status(400).json({ error: "email, password, displayName required" });
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: "email already registered" });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, passwordHash, displayName },
    });
    const token = jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: user.id, email, displayName: user.displayName } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: "invalid_credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "invalid_credentials" });

    const token = jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: user.id, email, displayName: user.displayName } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/me", authMiddleware, async (req, res) => {
  const me = await prisma.user.findUnique({ where: { id: req.user.uid } });
  res.json({ id: me.id, email: me.email, displayName: me.displayName, lastSeenAt: me.lastSeenAt });
});

// --- User search (simple) ---
app.get("/users/search", authMiddleware, async (req, res) => {
  const q = String(req.query.q || "").toLowerCase();
  if (!q) return res.json([]);
  const users = await prisma.user.findMany();
  const filtered = users
    .filter(u => u.email.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q))
    .map(u => ({ id: u.id, email: u.email, displayName: u.displayName }));
  res.json(filtered);
});

// --- Conversations (get-or-create for direct chats) ---
app.post("/conversations", authMiddleware, async (req, res) => {
  try {
    const { memberIds = [], isGroup = false, title = null } = req.body;
    console.log("[POST /conversations]", { by: req.user.uid, memberIds, isGroup, title });

    // Normalize member set (include requester)
    const uniqueMemberIds = Array.from(new Set([req.user.uid, ...memberIds]));

    // If this is a direct chat (1-to-1), try to reuse an existing one
    if (!isGroup) {
      if (uniqueMemberIds.length !== 2) {
        return res.status(400).json({ error: "direct chat must have exactly 2 members" });
      }
      const [u1, u2] = uniqueMemberIds;

      // Find any non-group conversation with BOTH users…
      const existing = await prisma.conversation.findFirst({
        where: {
          isGroup: false,
          AND: [
            { memberships: { some: { userId: u1 } } },
            { memberships: { some: { userId: u2 } } },
          ],
        },
        include: { memberships: true },
      });

      // …and ensure no extra members
      if (existing && existing.memberships.length === 2) {
        return res.json(existing);
      }
    }

    // Otherwise create new conversation (group or new direct)
    const convo = await prisma.conversation.create({
      data: {
        isGroup,
        title,
        memberships: {
          create: uniqueMemberIds.map(uid => ({ userId: uid })),
        },
      },
      include: { memberships: true },
    });

    res.json(convo);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/conversations", authMiddleware, async (req, res) => {
  const convos = await prisma.membership.findMany({
    where: { userId: req.user.uid },
    include: { conversation: true },
  });
  res.json(convos.map(m => m.conversation));
});

// --- Messages ---
app.get("/messages", authMiddleware, async (req, res) => {
  const { cid, before, limit = 50 } = req.query;
  if (!cid) return res.status(400).json({ error: "cid required" });

  const where = { conversationId: String(cid) };
  if (before) where.id = { lt: String(before) };
  const messages = await prisma.message.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Number(limit),
  });
  res.json(messages.reverse());
});

// --- Uploads (demo only; use S3 in production) ---
app.post("/upload", authMiddleware, upload.single("file"), (req, res) => {
  res.json({ fileUrl: `/uploads/${req.file.filename}` });
});

// --- Web Push subscription (placeholder; front-end later) ---
app.post("/push/subscribe", authMiddleware, async (req, res) => {
  await prisma.subscription.upsert({
    where: { userId: req.user.uid },
    update: { json: req.body },
    create: { userId: req.user.uid, json: req.body },
  });
  res.sendStatus(201);
});

// --- Socket.IO auth ---
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token || "";
    socket.user = jwt.verify(token, JWT_SECRET); // { uid, email }
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});

// --- Socket.IO events ---
io.on("connection", (socket) => {
  const uid = socket.user.uid;
  socket.join(`user:${uid}`);
  io.emit("presence", { userId: uid, state: "online", lastSeenAt: new Date().toISOString() });

  socket.on("join_conversation", ({ cid }) => {
    if (!cid) return;
    socket.join(`cid:${cid}`);
  });

  socket.on("leave_conversation", ({ cid }) => {
    if (!cid) return;
    socket.leave(`cid:${cid}`);
  });

  socket.on("typing", ({ cid, isTyping }) => {
    if (!cid) return;
    socket.to(`cid:${cid}`).emit("typing", { cid, userId: uid, isTyping: !!isTyping });
  });

  socket.on("send_message", async ({ cid, kind, text, fileUrl }) => {
    if (!cid || !kind) return;
    console.log("[send_message]", { from: uid, cid, kind, text });

    const msg = await prisma.message.create({
      data: { conversationId: cid, authorId: uid, kind, text: text || null, fileUrl: fileUrl || null },
    });
    io.to(`cid:${cid}`).emit("message_created", msg);
  });

  socket.on("ack_delivered", async ({ cid, msgId }) => {
    if (!cid || !msgId) return;
    const msg = await prisma.message.findUnique({ where: { id: msgId } });
    const deliveredTo = Array.isArray(msg.deliveredTo) ? msg.deliveredTo : [];
    if (!deliveredTo.includes(uid)) deliveredTo.push(uid);
    await prisma.message.update({ where: { id: msgId }, data: { deliveredTo } });
    io.to(`cid:${cid}`).emit("message_updated", { msgId, deliveredTo });
  });

  socket.on("ack_read", async ({ cid, msgId }) => {
    if (!cid || !msgId) return;
    const msg = await prisma.message.findUnique({ where: { id: msgId } });
    const readBy = Array.isArray(msg.readBy) ? msg.readBy : [];
    if (!readBy.includes(uid)) readBy.push(uid);
    await prisma.message.update({ where: { id: msgId }, data: { readBy } });
    io.to(`cid:${cid}`).emit("message_updated", { msgId, readBy });
  });

  socket.on("disconnect", async () => {
    await prisma.user.update({
      where: { id: uid },
      data: { lastSeenAt: new Date() },
    });
    io.emit("presence", { userId: uid, state: "offline", lastSeenAt: new Date().toISOString() });
  });
});

// --- Start server ---
server.listen(PORT, () => {
  console.log(`API+WS running on http://localhost:${PORT}`);
});
