// server.mjs
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";
import axios from "axios";
import qrcode from "qrcode";
import { default as makeWASocket, useSingleFileAuthState } from "@adiwajshing/baileys";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// ---------------- FIREBASE ----------------
const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
  universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN,
};

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ---------------- Gemini Helper ----------------
const consumirGemini = async (prompt) => {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const body = { contents: [{ parts: [{ text: prompt }] }] };
    const r = await axios.post(url, body);
    return r.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Lo siento, no pude responder.";
  } catch (err) {
    console.error("Error Gemini:", err?.response?.data || err.message);
    return "Ocurrió un error al procesar tu mensaje.";
  }
};

// ---------------- WhatsApp Session Manager ----------------
const sockets = new Map();

const createAndConnectSocket = async (sessionId = "default") => {
  if (sockets.has(sessionId)) return sockets.get(sessionId);

  const { state, saveState } = useSingleFileAuthState(`/tmp/${sessionId}.json`);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on("creds.update", saveState);

  sock.ev.on("connection.update", async ({ connection, qr }) => {
    if (qr) {
      const dataUrl = await qrcode.toDataURL(qr);
      await db.collection("sessions").doc(sessionId).set({ qr: dataUrl, status: "qr" }, { merge: true });
    }
    if (connection === "open") {
      console.log("✅ WhatsApp conectado");
      await db.collection("sessions").doc(sessionId).set({ qr: null, status: "connected" }, { merge: true });
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    for (const msg of m.messages || []) {
      if (!msg.message || msg.key.fromMe) continue;
      const from = msg.key.remoteJid;
      const text = msg.message.conversation || msg.message?.extendedTextMessage?.text || "";

      const reply = await consumirGemini(text || "Hola 👋");
      await sock.sendMessage(from, { text: reply });

      await db.collection("chats").add({
        from,
        text,
        reply,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  });

  sockets.set(sessionId, sock);
  return sock;
};

// ---------------- API Endpoints ----------------

// Inicia sesión automáticamente sin API key
app.get("/api/connect", async (req, res) => {
  try {
    const sessionId = "default"; // una sola sesión global
    await createAndConnectSocket(sessionId);
    const doc = await db.collection("sessions").doc(sessionId).get();
    const data = doc.data() || {};
    res.json({ ok: true, qr: data.qr || null, status: data.status || "esperando QR" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Error al iniciar sesión" });
  }
});

// Página principal: muestra QR directamente
app.get("/", async (req, res) => {
  const doc = await db.collection("sessions").doc("default").get();
  const data = doc.data() || {};
  if (data.qr) {
    res.send(`
      <h1>Conectar WhatsApp - Consulta PE</h1>
      <p>Escanea este código QR con tu WhatsApp:</p>
      <img src="${data.qr}" width="300"/>
    `);
  } else {
    res.send(`
      <h1>Conectar WhatsApp - Consulta PE</h1>
      <p>Estado: ${data.status || "Desconectado"}</p>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server corriendo en puerto ${PORT}`));
