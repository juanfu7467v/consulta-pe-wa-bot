#!/usr/bin/env node
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import qrcode from "qrcode";
import fs from "fs";
import path from "path";

// --- Fix para el error "crypto is not defined" en algunos entornos (Baileys usa WebCrypto) ---
import { webcrypto } from "crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const SESSIONS_BASE = path.join(".", "sessions"); // carpeta de sesiones
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

const sessions = new Map();

/* ---------------- Gemini ---------------- */
const GEMINI_PROMPT = process.env.GEMINI_PROMPT ||
`Eres un asistente de IA de Consulta PE App, que envía mensajes automáticos.
Eres servicial, creativo, inteligente y muy amigable. Siempre das una respuesta.`;

const consumirGemini = async (usuarioPrompt) => {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      console.log("⚠️ GEMINI_API_KEY no configurada — usando respuestas locales");
      return null;
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${key}`;
    const body = { contents: [{ parts: [{ text: `${GEMINI_PROMPT}\nUsuario: ${usuarioPrompt}` }] }] };
    const r = await axios.post(url, body, { timeout: 20000 });
    return r.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (err) {
    console.error("Error Gemini:", err?.response?.data || err?.message || err);
    return null;
  }
};

/* ---------------- Respuestas locales (fallback) ---------------- */
const respuestasPredefinidas = {
  hola: ["¡Hola! ¿Cómo estás?", "¡Qué gusto saludarte!", "Hola, ¿en qué te ayudo?"],
  ayuda: ["Claro, dime qué necesitas 🙌", "Estoy para ayudarte ✨", "¿Qué consulta tienes?"],
  menu: [
    "1️⃣ Consultar DNI\n2️⃣ Consultar RUC\n3️⃣ Consultar SOAT",
    "Selecciona una opción: 1, 2 o 3"
  ],
  "1": ["Has elegido Consultar DNI. Por favor, envíame el número de DNI 🪪"],
  "2": ["Has elegido Consultar RUC. Envíame el RUC 📊"],
  "3": ["Has elegido Consultar SOAT. Envíame la placa 🚗"]
};

function obtenerRespuestaLocal(texto) {
  const key = (texto || "").toLowerCase().trim();
  if (respuestasPredefinidas[key]) {
    const r = respuestasPredefinidas[key];
    return Array.isArray(r) ? r[Math.floor(Math.random() * r.length)] : r;
  }
  return "Lo siento, no entendí 🤔. Escribe 'menu' para ver opciones.";
}

/* ------------- Importar Baileys ------------- */
let makeWASocket, useMultiFileAuthState, DisconnectReason;
try {
  const baileys = await import("@whiskeysockets/baileys");
  // API v6 exports
  makeWASocket = baileys.makeWASocket;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
} catch (err) {
  console.error("Error importando Baileys (asegura dependencia @whiskeysockets/baileys):", err?.message || err);
}

/* --------------- Crear y conectar socket --------------- */
const createAndConnectSocket = async (sessionId) => {
  if (!makeWASocket) throw new Error("Baileys no disponible en runtime");

  const sessionDir = path.join(SESSIONS_BASE, sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["ConsultaPE", "Chrome", "2.0"],
    syncFullHistory: false,
    // si quieres logs más verbosos:
    // logger: require('pino')({ level: 'info' })
  });

  sessions.set(sessionId, { sock, status: "starting", qr: null });

  // guardar credenciales cuando cambian (best-effort)
  sock.ev.on("creds.update", async () => {
    try { await saveCreds(); } catch (e) { console.warn("saveCreds err:", e?.message || e); }
  });

  sock.ev.on("connection.update", async (update) => {
    try {
      console.log("connection.update:", JSON.stringify(update));
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const dataUrl = await qrcode.toDataURL(qr);
        const s = sessions.get(sessionId) || {};
        s.qr = dataUrl;
        s.status = "qr";
        sessions.set(sessionId, s);
        console.log("QR generado para session:", sessionId);
      }

      if (connection === "open") {
        const s = sessions.get(sessionId) || {};
        s.qr = null;
        s.status = "connected";
        sessions.set(sessionId, s);
        console.log("✅ WhatsApp conectado:", sessionId);
        // guardar credenciales en abierto
        try { await saveCreds(); } catch (e) { console.warn("saveCreds err:", e?.message || e); }
      }

      if (connection === "close") {
        const s = sessions.get(sessionId) || {};
        s.status = "disconnected";
        sessions.set(sessionId, s);
        const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.name || lastDisconnect?.error;
        console.log("connection closed, reason:", reason);
        // intentar reconectar salvo logout
        if (DisconnectReason && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
          console.log("Intentando reconectar en 2s ->", sessionId);
          setTimeout(() => createAndConnectSocket(sessionId).catch(err => console.error("reconnect err", err?.message || err)), 2000);
        } else {
          console.log("Sesión logout permanente para", sessionId);
        }
      }
    } catch (e) {
      console.error("Error en connection.update handler:", e?.message || e);
    }
  });

  // Mensajes entrantes
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const messages = m.messages || [];
      for (const msg of messages) {
        if (!msg.message || msg.key?.fromMe) continue;
        const from = msg.key.remoteJid;
        // extraer texto (varias formas)
        const body =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          (msg.message?.imageMessage && msg.message?.imageMessage?.caption) ||
          (msg.message?.documentMessage && msg.message?.documentMessage?.fileName) ||
          "";
        if (!body) continue;

        console.log("📩 Mensaje recibido de", from, "->", body);

        // espera natural para no parecer bot instantáneo
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await wait(800 + Math.random() * 1500);

        // intentar Gemini
        let reply = null;
        if (process.env.GEMINI_API_KEY) {
          reply = await consumirGemini(body);
        }
        if (!reply) reply = obtenerRespuestaLocal(body);

        // si respuesta contiene saltos o comas, enviar en partes
        const parts = reply.split(/\n|,|\.{2,}|;/).map(p => p.trim()).filter(Boolean);
        if (parts.length > 1) {
          for (const p of parts) {
            await wait(500 + Math.random() * 1200);
            await sock.sendMessage(from, { text: p });
          }
        } else {
          await sock.sendMessage(from, { text: reply });
        }

        console.log("↪️ Respondido a", from);
      }
    } catch (e) {
      console.error("Error en messages.upsert:", e?.message || e);
    }
  });

  return sock;
};

/* ---------------- API (GET friendly para AppCreator24) ---------------- */

// Crear sesión (si ya existe, devuelve)
app.get("/api/session/create", async (req, res) => {
  try {
    const sessionId = req.query.sessionId || `session_${Date.now()}`;
    if (!sessions.has(sessionId)) {
      await createAndConnectSocket(sessionId);
      // esperar 200ms para que la conexión empiece y el evento qr pueda emitirse
      await new Promise(r => setTimeout(r, 200));
    }
    res.json({ ok: true, sessionId });
  } catch (e) {
    console.error("Error create session:", e?.message || e);
    res.status(500).json({ ok: false, error: "Error creando sesión" });
  }
});

// Obtener QR / estado
app.get("/api/session/qr", (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ ok: false, error: "Falta sessionId" });
  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ ok: false, error: "Session no encontrada" });
  res.json({ ok: true, qr: s.qr || null, status: s.status || "unknown" });
});

// Enviar mensaje manual (GET para AppCreator24)
app.get("/api/session/send", async (req, res) => {
  try {
    const { sessionId, to, text } = req.query;
    if (!sessionId || !to || !text) return res.status(400).json({ ok: false, error: "Faltan params" });
    const s = sessions.get(sessionId);
    if (!s || !s.sock) return res.status(404).json({ ok: false, error: "Session no encontrada o no conectada" });
    await s.sock.sendMessage(to, { text });
    res.json({ ok: true });
  } catch (e) {
    console.error("Error send:", e?.message || e);
    res.status(500).json({ ok: false, error: "Error enviando mensaje" });
  }
});

// Resetear sesión (elimina credenciales -> nuevo QR)
app.get("/api/session/reset", async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ ok: false, error: "Falta sessionId" });
    const sessionDir = path.join(SESSIONS_BASE, sessionId);
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    const s = sessions.get(sessionId);
    if (s?.sock && s.sock.logout) {
      try { await s.sock.logout(); } catch (e) { /* ignore */ }
    }
    sessions.delete(sessionId);
    res.json({ ok: true, message: "Sesión eliminada, vuelve a crearla para obtener QR" });
  } catch (e) {
    console.error("Error reset:", e?.message || e);
    res.status(500).json({ ok: false, error: "Error reseteando sesión" });
  }
});

app.get("/", (req, res) => res.json({ ok: true, msg: "ConsultaPE WA Bot activo 🚀" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server en puerto ${PORT}`));
