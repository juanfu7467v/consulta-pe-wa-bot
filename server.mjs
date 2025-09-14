#!/usr/bin/env node
// server.mjs
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import qrcode from "qrcode";
import fs from "fs";
import path from "path";

// Fix crypto for Baileys (WebCrypto)
import { webcrypto } from "crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const SESSIONS_BASE = path.join(".", "sessions");
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

const sessions = new Map(); // in-memory registry

/* ---------------- Default global prompt ---------------- */
const GLOBAL_DEFAULT_PROMPT = `Bienvenida e Información General
Eres un asistente de la app Consulta PE. Puedo ayudarte a consultar DNI, RUC, SOAT, multas, y también conversar de películas o juegos.
Soy servicial, creativo, inteligente y muy amigable. Siempre tendrás una respuesta.`;

/* ---------------- Helpers ---------------- */
const readJSON = (p, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
};
const writeJSON = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2));

/* ---------------- AI Integrations ---------------- */
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

async function consumirCohere(promptText) {
  try {
    const key = process.env.COHERE_API_KEY;
    if (!key) return null;
    const url = "https://api.cohere.ai/v1/chat";
    const body = { model: "command-r-plus", messages: [{ role: "user", content: promptText }] };
    const r = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      timeout: 20000,
    });
    return r.data?.text || r.data?.message || r.data?.output?.[0] || null;
  } catch (err) {
    console.error("Error Cohere:", err?.response?.data || err?.message);
    return null;
  }
}

async function consumirOpenAI(promptText, systemPrompt = GLOBAL_DEFAULT_PROMPT) {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    const url = "https://api.openai.com/v1/chat/completions";
    const body = {
      model: "gpt-5-mini",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: promptText }],
      max_tokens: 800,
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

/* ---------------- Local responses matching ---------------- */
function matchLocal(message, localResponses, matchMode = "exact") {
  const text = (message || "").trim();
  if (!text) return null;

  if (matchMode === "exact") {
    const key = text.toLowerCase();
    if (localResponses[key]) {
      const arr = Array.isArray(localResponses[key]) ? localResponses[key] : [localResponses[key]];
      return arr[Math.floor(Math.random() * arr.length)];
    }
    return null;
  }

  if (matchMode === "pattern") {
    const low = text.toLowerCase();
    for (const k of Object.keys(localResponses)) {
      if (low.includes(k.toLowerCase())) {
        const arr = Array.isArray(localResponses[k]) ? localResponses[k] : [localResponses[k]];
        return arr[Math.floor(Math.random() * arr.length)];
      }
    }
    return null;
  }

  if (matchMode === "expert") {
    for (const k of Object.keys(localResponses)) {
      if (k.startsWith("/") && k.lastIndexOf("/") > 0) {
        try {
          const lastSlash = k.lastIndexOf("/");
          const pattern = k.slice(1, lastSlash);
          const flags = k.slice(lastSlash + 1);
          const re = new RegExp(pattern, flags || "i");
          if (re.test(text)) {
            const arr = Array.isArray(localResponses[k]) ? localResponses[k] : [localResponses[k]];
            return arr[Math.floor(Math.random() * arr.length)];
          }
        } catch {}
      }
    }
  }
  return null;
}

/* ---------------- Import Baileys ---------------- */
let makeWASocket, useMultiFileAuthState, DisconnectReason;
try {
  const baileys = await import("@whiskeysockets/baileys");
  makeWASocket = baileys.makeWASocket;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
} catch (err) {
  console.error("Error importando Baileys:", err?.message || err);
}

/* ---------------- Create & connect socket (per session) ---------------- */
const createAndConnectSocket = async (sessionId) => {
  if (!makeWASocket) throw new Error("Baileys no disponible");

  const sessionDir = path.join(SESSIONS_BASE, sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const settingsPath = path.join(sessionDir, "settings.json");
  const defaultSettings = {
    prompt: GLOBAL_DEFAULT_PROMPT,
    localResponses: { ...{ hola: ["¡Hola! ¿Cómo estás?"], ayuda: ["Dime qué necesitas"] } },
    matchMode: "exact",
    welcomeMessage: "¡Hola! Soy tu asistente Consulta PE.",
    localEnabled: true,
    sourceIndicator: false,
    cooldownSeconds: 10
  };
  let settings = readJSON(settingsPath, defaultSettings);
  settings = { ...defaultSettings, ...settings };
  writeJSON(settingsPath, settings);

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["ConsultaPE", "Chrome", "2.0"],
    syncFullHistory: false
  });

  sessions.set(sessionId, {
    sock,
    status: "starting",
    qr: null,
    settings,
    sessionDir,
    chats: new Map()
  });

  sock.ev.on("creds.update", async () => {
    try { await saveCreds(); } catch {}
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const session = sessions.get(sessionId);
    if (!session) return;
    if (qr) {
      session.qr = await qrcode.toDataURL(qr);
      session.status = "qr";
    }
    if (connection === "open") {
      session.qr = null;
      session.status = "connected";
      try { await saveCreds(); } catch {}
    }
    if (connection === "close") {
      session.status = "disconnected";
      const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.name;
      if (DisconnectReason && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
        setTimeout(() => createAndConnectSocket(sessionId), 2000);
      }
    }
    sessions.set(sessionId, session);
  });

  /* -------- Manejador de mensajes -------- */
  sock.ev.on("messages.upsert", async (m) => {
    const arr = m.messages || [];
    for (const msg of arr) {
      if (!msg.message || msg.key?.fromMe) continue;
      const from = msg.key.remoteJid;
      const session = sessions.get(sessionId);
      if (!session) continue;

      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        (msg.message?.imageMessage && msg.message.imageMessage.caption) ||
        (msg.message?.documentMessage && msg.message.documentMessage.fileName) ||
        "";

      if (!body) continue;

      const chats = session.chats;
      const meta = chats.get(from) || { lastUserMessage: null, lastReply: null, lastReplyAt: 0 };
      const now = Date.now();

      const cooldownMs = (session.settings?.cooldownSeconds || 10) * 1000;
      if (meta.lastUserMessage && meta.lastUserMessage === body && (now - meta.lastReplyAt) < cooldownMs) {
        meta.lastUserMessage = body;
        chats.set(from, meta);
        continue;
      }

      meta.lastUserMessage = body;

      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      await wait(700 + Math.random() * 1300);

      let reply = null;
      let usedSource = null;

      if (!meta.seenWelcome) {
        meta.seenWelcome = true;
        if (session.settings?.welcomeMessage) {
          await sock.sendMessage(from, { text: session.settings.welcomeMessage });
        }
      }

      if (session.settings.localEnabled) {
        const local = session.settings.localResponses || {};
        const mm = session.settings.matchMode || "exact";
        const localMatch = matchLocal(body, local, mm);
        if (localMatch) {
          reply = localMatch;
          usedSource = "local";
        }
      }

      if (!reply) {
        const promptToUse = `${session.settings.prompt || GLOBAL_DEFAULT_PROMPT}\nUsuario: ${body}`;
        reply = await consumirGemini(promptToUse);
        if (reply) usedSource = "gemini";
        if (!reply) {
          reply = await consumirCohere(promptToUse);
          if (reply) usedSource = "cohere";
        }
        if (!reply) {
          reply = await consumirOpenAI(body, session.settings.prompt || GLOBAL_DEFAULT_PROMPT);
          if (reply) usedSource = "openai";
        }
      }

      if (!reply) {
        reply = "Lo siento, no tengo una respuesta ahora mismo.";
        usedSource = usedSource || "fallback";
      }

      if (session.settings.sourceIndicator) {
        reply = `${reply}\n\n(Fuente: ${usedSource || "desconocida"})`;
      }

      if (meta.lastReply && meta.lastReply === reply && (now - meta.lastReplyAt) < cooldownMs) {
        meta.lastReplyAt = now;
        chats.set(from, meta);
        continue;
      }

      /* --------- NUEVO: efecto "escribiendo" --------- */
      try {
        await sock.sendPresenceUpdate("composing", from);
        await wait(1500 + Math.random() * 1500);
        await sock.sendPresenceUpdate("paused", from);
      } catch (e) {
        console.warn("Error presence:", e?.message || e);
      }

      const parts = (reply || "").split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
      if (parts.length > 1) {
        for (const p of parts) {
          await wait(300 + Math.random() * 800);
          await sock.sendMessage(from, { text: p });
        }
      } else {
        await sock.sendMessage(from, { text: reply });
      }

      meta.lastReply = reply;
      meta.lastReplyAt = Date.now();
      chats.set(from, meta);

      console.log("Respondido a", from, "source:", usedSource);
    }
  });

  return sock;
};

/* ---------------- API Endpoints ---------------- */
// (todo lo tuyo sigue igual aquí abajo, no lo borro)

app.get("/api/session/create", async (req, res) => {
  try {
    const sessionId = req.query.sessionId || `session_${Date.now()}`;
    if (!sessions.has(sessionId)) {
      await createAndConnectSocket(sessionId);
      await new Promise(r => setTimeout(r, 200));
    }
    res.json({ ok: true, sessionId });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Error creando sesión" });
  }
});

// ... (tus endpoints tal cual)

app.get("/api/health", (req, res) => {
  res.json({ ok: true, status: "alive", time: new Date().toISOString() });
});

app.get("/", (req, res) => res.json({ ok: true, msg: "ConsultaPE WA Bot activo 🚀" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server en puerto ${PORT}`));
