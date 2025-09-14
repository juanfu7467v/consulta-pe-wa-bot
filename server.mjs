#!/usr/bin/env node
// server.mjs
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import qrcode from "qrcode";
import fs from "fs";
import path from "path";

// Fix crypto para Baileys
import { webcrypto } from "crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const SESSIONS_BASE = path.join(".", "sessions");
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

const sessions = new Map();

/* ------------------- IA Integrations ------------------- */
const DEFAULT_PROMPT = `Bienvenida e Información General
Eres un asistente de la app Consulta PE. 
Puedo ayudarte a consultar DNI, RUC, SOAT, multas, y también conversar de películas o juegos. 
Soy servicial, creativo, inteligente y muy amigable. Siempre tendrás una respuesta.`;

// Gemini
async function consumirGemini(promptText) {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${key}`;
    const body = { contents: [{ parts: [{ text: promptText }] }] };
    const r = await axios.post(url, body, { timeout: 20000 });
    return r.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (err) {
    console.error("Error Gemini:", err?.response?.data || err?.message);
    return null;
  }
}

// Cohere Command R+
async function consumirCohere(promptText) {
  try {
    const key = process.env.COHERE_API_KEY;
    if (!key) return null;
    const url = "https://api.cohere.ai/v1/chat";
    const body = { model: "command-r-plus", message: promptText };
    const r = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      timeout: 20000,
    });
    return r.data?.text || null;
  } catch (err) {
    console.error("Error Cohere:", err?.response?.data || err?.message);
    return null;
  }
}

// OpenAI (GPT-5 mini por defecto)
async function consumirOpenAI(promptText) {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    const url = "https://api.openai.com/v1/chat/completions";
    const body = {
      model: "gpt-5-mini",
      messages: [{ role: "system", content: DEFAULT_PROMPT }, { role: "user", content: promptText }],
    };
    const r = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      timeout: 20000,
    });
    return r.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error("Error OpenAI:", err?.response?.data || err?.message);
    return null;
  }
}

/* ---------------- Fallback local ---------------- */
const FALLBACK = {
  hola: ["¡Hola! ¿Cómo estás?", "¡Qué gusto saludarte!", "Hola, ¿en qué te ayudo?"],
  ayuda: ["Claro, dime qué necesitas 🙌", "Estoy para ayudarte ✨"],
  menu: ["1️⃣ Consultar DNI\n2️⃣ Consultar RUC\n3️⃣ Consultar SOAT"],
};

function obtenerRespuestaLocal(txt) {
  const key = (txt || "").toLowerCase().trim();
  if (FALLBACK[key]) {
    const r = FALLBACK[key];
    return Array.isArray(r) ? r[Math.floor(Math.random() * r.length)] : r;
  }
  return "No entendí 🤔, escribe 'menu' para ver opciones.";
}

/* ---------------- Importar Baileys ---------------- */
let makeWASocket, useMultiFileAuthState, DisconnectReason;
try {
  const baileys = await import("@whiskeysockets/baileys");
  makeWASocket = baileys.makeWASocket;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
} catch (err) {
  console.error("Error importando Baileys:", err?.message);
}

/* ---------------- Crear Socket ---------------- */
const createAndConnectSocket = async (sessionId) => {
  const sessionDir = path.join(SESSIONS_BASE, sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["ConsultaPE", "Chrome", "2.0"],
  });

  sessions.set(sessionId, { sock, status: "starting", qr: null });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const s = sessions.get(sessionId);
    if (qr) {
      s.qr = await qrcode.toDataURL(qr);
      s.status = "qr";
    }
    if (connection === "open") {
      s.qr = null;
      s.status = "connected";
    }
    if (connection === "close") {
      s.status = "disconnected";
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        setTimeout(() => createAndConnectSocket(sessionId), 2000);
      }
    }
    sessions.set(sessionId, s);
  });

  // Incoming messages
  sock.ev.on("messages.upsert", async (m) => {
    for (const msg of m.messages) {
      if (!msg.message || msg.key?.fromMe) continue;
      const from = msg.key.remoteJid;
      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.documentMessage?.fileName ||
        "";

      if (!body) continue;

      const prompt = `${DEFAULT_PROMPT}\nUsuario: ${body}`;
      let reply = null;

      // Orden de prueba: Gemini → Cohere → OpenAI
      reply = await consumirGemini(prompt);
      if (!reply) reply = await consumirCohere(prompt);
      if (!reply) reply = await consumirOpenAI(prompt);
      if (!reply) reply = obtenerRespuestaLocal(body);

      await sock.sendMessage(from, { text: reply });
    }
  });

  return sock;
};

/* ---------------- API GET Endpoints ---------------- */

// Crear sesión
app.get("/api/session/create", async (req, res) => {
  const sessionId = req.query.sessionId || `session_${Date.now()}`;
  if (!sessions.has(sessionId)) {
    await createAndConnectSocket(sessionId);
  }
  res.json({ ok: true, sessionId });
});

// Obtener QR
app.get("/api/session/qr", (req, res) => {
  const s = sessions.get(req.query.sessionId);
  if (!s) return res.status(404).json({ ok: false, error: "No encontrada" });
  res.json({ ok: true, qr: s.qr, status: s.status });
});

// Envío manual
app.get("/api/session/send", async (req, res) => {
  try {
    const { sessionId, to, type = "text" } = req.query;
    const s = sessions.get(sessionId);
    if (!s) return res.status(404).json({ ok: false, error: "No conectada" });

    let msg = null;
    switch (type) {
      case "text":
        msg = { text: req.query.text || "" };
        break;
      case "image":
        msg = { image: { url: req.query.url }, caption: req.query.text };
        break;
      case "document":
        msg = { document: { url: req.query.url }, fileName: req.query.filename };
        break;
      case "audio":
        msg = { audio: { url: req.query.url }, ptt: req.query.ptt === "true" };
        break;
      case "contact":
        msg = { contacts: { displayName: req.query.displayName || "Contacto", contacts: [{ vcard: req.query.vcard }] } };
        break;
      case "buttons":
        msg = {
          text: req.query.text || "Opciones",
          buttons: JSON.parse(req.query.buttons || "[]").map((b, i) => ({
            buttonId: b.id || `b${i}`,
            buttonText: { displayText: b.text || `Btn${i}` },
            type: 1,
          })),
        };
        break;
      case "list":
        msg = {
          title: req.query.title || "Lista",
          text: req.query.text || "Selecciona",
          buttonText: req.query.buttonText || "Ver",
          sections: JSON.parse(req.query.listSections || "[]"),
        };
        break;
      case "event":
        msg = { text: `${req.query.title || "Evento"}\n\n${req.query.text || ""}` };
        break;
      default:
        return res.status(400).json({ ok: false, error: "Tipo no soportado" });
    }

    await s.sock.sendMessage(to, msg);
    res.json({ ok: true });
  } catch (e) {
    console.error("send error:", e.message);
    res.status(500).json({ ok: false, error: "Error enviando" });
  }
});

// Resetear sesión
app.get("/api/session/reset", (req, res) => {
  const { sessionId } = req.query;
  const dir = path.join(SESSIONS_BASE, sessionId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  sessions.delete(sessionId);
  res.json({ ok: true, msg: "Sesión eliminada" });
});

// Healthcheck (para UptimeRobot o Fly.io)
app.get("/api/health", (req, res) => {
  res.json({ ok: true, status: "alive", timestamp: new Date().toISOString() });
});

// Root
app.get("/", (req, res) => res.json({ ok: true, msg: "ConsultaPE WA Bot activo 🚀" }));

/* ---------------- Start Server ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Server en puerto", PORT));
