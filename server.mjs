import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import qrcode from "qrcode";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }));

const sessions = new Map();

/* ---------------- Gemini ---------------- */
const consumirGemini = async (prompt) => {
  try {
    if (!process.env.GEMINI_API_KEY) return "Gemini API key no configurada.";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const body = { contents: [{ parts: [{ text: prompt }] }] };
    const r = await axios.post(url, body, { timeout: 15000 });
    return r.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Sin respuesta de Gemini";
  } catch (err) {
    console.error("Error Gemini:", err?.response?.data || err.message);
    return null;
  }
};

/* ------------- Importar Baileys ------------- */
let makeWASocket, useMultiFileAuthState, DisconnectReason;
try {
  const baileysModule = await import("@whiskeysockets/baileys");
  makeWASocket = baileysModule.makeWASocket;
  useMultiFileAuthState = baileysModule.useMultiFileAuthState;
  DisconnectReason = baileysModule.DisconnectReason;
} catch (err) {
  console.error("Error importando Baileys:", err.message || err);
}

/* --------------- Crear Socket --------------- */
const createAndConnectSocket = async (sessionId) => {
  if (!makeWASocket) throw new Error("Baileys no disponible");

  const { state, saveCreds } = await useMultiFileAuthState(`/tmp/${sessionId}`);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["ConsultaPE", "Chrome", "1.0"],
  });

  sessions.set(sessionId, { sock, status: "starting", qr: null });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      const dataUrl = await qrcode.toDataURL(qr);
      sessions.get(sessionId).qr = dataUrl;
      sessions.get(sessionId).status = "qr";
    }
    if (connection === "open") {
      sessions.get(sessionId).qr = null;
      sessions.get(sessionId).status = "connected";
      console.log("✅ WhatsApp conectado:", sessionId);
    }
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      sessions.get(sessionId).status = "disconnected";
      if (reason !== DisconnectReason.loggedOut) {
        console.log("Reconectando:", sessionId);
        setTimeout(() => createAndConnectSocket(sessionId), 2000);
      }
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    for (const msg of m.messages || []) {
      if (!msg.message || msg.key.fromMe) continue;
      const from = msg.key.remoteJid;
      const body = msg.message.conversation || msg.message?.extendedTextMessage?.text || "";
      if (!body) continue;

      console.log("📩", from, ":", body);
      const reply = await consumirGemini(body) || "Hola, gracias por tu mensaje.";
      await sock.sendMessage(from, { text: reply });
    }
  });

  return sock;
};

/* ---------------- Endpoints ---------------- */

// Crear sesión
app.get("/api/session/create", async (req, res) => {
  const sessionId = req.query.sessionId || `session_${Date.now()}`;
  await createAndConnectSocket(sessionId);
  res.json({ ok: true, sessionId });
});

// Obtener QR
app.get("/api/session/qr", (req, res) => {
  const { sessionId } = req.query;
  if (!sessions.has(sessionId)) return res.status(404).json({ ok: false, error: "Session no encontrada" });
  const s = sessions.get(sessionId);
  res.json({ ok: true, qr: s.qr, status: s.status });
});

// Enviar mensaje
app.post("/api/session/send", async (req, res) => {
  const { sessionId, to, text } = req.body;
  const s = sessions.get(sessionId);
  if (!s || !s.sock) return res.status(404).json({ ok: false, error: "Session no encontrada" });
  await s.sock.sendMessage(to, { text });
  res.json({ ok: true });
});

app.get("/", (req, res) => res.json({ ok: true, msg: "ConsultaPE WA Bot activo" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server en puerto ${PORT}`));
