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
    // Cohere payload may vary; this is a simple call — adapta si tu plan requiere otro formato
    const body = { model: "command-r-plus", messages: [{ role: "user", content: promptText }] };
    const r = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      timeout: 20000,
    });
    // adjust depending on response format:
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
      model: "gpt-5-mini", // cambia si quieres otro modelo
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
// matchMode: 'exact' | 'pattern' | 'expert'
// expert = case-insensitive regex with word boundaries & fallback partial
function matchLocal(message, localResponses, matchMode = "exact") {
  const text = (message || "").trim();
  if (!text) return null;

  // exact
  if (matchMode === "exact") {
    const key = text.toLowerCase();
    if (localResponses[key]) {
      const arr = Array.isArray(localResponses[key]) ? localResponses[key] : [localResponses[key]];
      return arr[Math.floor(Math.random() * arr.length)];
    }
    return null;
  }

  // pattern: simple substring matches (case-insensitive) across keys
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

  // expert: try regex from keys first; then token overlap
  if (matchMode === "expert") {
    // keys that look like regex (start and end with /)
    for (const k of Object.keys(localResponses)) {
      // if key like "/hola|buenos/i"
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
    // fallback: token overlap scoring
    const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
    let best = null;
    let bestScore = 0;
    for (const k of Object.keys(localResponses)) {
      const kTokens = k.toLowerCase().split(/\W+/).filter(Boolean);
      if (!kTokens.length) continue;
      const overlap = kTokens.filter(t => tokens.includes(t)).length;
      const score = overlap / Math.max(kTokens.length, tokens.length);
      if (score > bestScore && score > 0.3) { // threshold
        bestScore = score;
        best = k;
      }
    }
    if (best) {
      const arr = Array.isArray(localResponses[best]) ? localResponses[best] : [localResponses[best]];
      return arr[Math.floor(Math.random() * arr.length)];
    }
    return null;
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

  // load settings (or create defaults)
  const settingsPath = path.join(sessionDir, "settings.json");
  const defaultSettings = {
    prompt: GLOBAL_DEFAULT_PROMPT,
    localResponses: { ...{ hola: ["¡Hola! ¿Cómo estás?"], ayuda: ["Dime qué necesitas"] } },
    matchMode: "exact",
    welcomeMessage: "¡Hola! Soy tu asistente Consulta PE.",
    localEnabled: true,
    sourceIndicator: false,
    cooldownSeconds: 10 // cooldown per chat to avoid loops
  };
  let settings = readJSON(settingsPath, defaultSettings);
  // ensure keys exist
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
    chats: new Map() // per remote chat metadata (lastUserMessage, lastReply, lastReplyAt)
  });

  // save creds best-effort
  sock.ev.on("creds.update", async () => {
    try { await saveCreds(); } catch (e) { console.warn("saveCreds err:", e?.message || e); }
  });

  sock.ev.on("connection.update", async (update) => {
    try {
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
        // save
        try { await saveCreds(); } catch {}
      }
      if (connection === "close") {
        session.status = "disconnected";
        const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.name || lastDisconnect?.error;
        console.log("connection closed", reason);
        // try reconnect except logged out
        if (DisconnectReason && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => createAndConnectSocket(sessionId).catch(e => console.error("reconnect err", e?.message || e)), 2000);
        } else {
          console.log("permanent logout for", sessionId);
        }
      }
      sessions.set(sessionId, session);
    } catch (e) {
      console.error("connection.update handler error:", e?.message || e);
    }
  });

  // messages.upsert handler
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const arr = m.messages || [];
      for (const msg of arr) {
        if (!msg.message || msg.key?.fromMe) continue;
        const from = msg.key.remoteJid;
        const session = sessions.get(sessionId);
        if (!session) continue;

        // extract textual content
        const body =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          (msg.message?.imageMessage && msg.message.imageMessage.caption) ||
          (msg.message?.documentMessage && msg.message.documentMessage.fileName) ||
          "";

        if (!body) continue;

        // per-chat metadata
        const chats = session.chats;
        const meta = chats.get(from) || { lastUserMessage: null, lastReply: null, lastReplyAt: 0 };
        const now = Date.now();

        // Dedup / cooldown: only respond if user changed message OR cooldown passed
        const cooldownMs = (session.settings?.cooldownSeconds || 10) * 1000;
        if (meta.lastUserMessage && meta.lastUserMessage === body && (now - meta.lastReplyAt) < cooldownMs) {
          console.log("Skipping repeated message (cooldown):", from, body);
          // update lastUserMessage timestamp
          meta.lastUserMessage = body;
          chats.set(from, meta);
          continue;
        }

        meta.lastUserMessage = body; // update

        // Natural wait to avoid instant-bot behavior
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        await wait(700 + Math.random() * 1300);

        // Resolution order:
        // if localEnabled: attempt local match per configured matchMode
        let reply = null;
        let usedSource = null;

        // welcome flow: if this is first message ever from chat, optionally send welcome then continue
        if (!meta.seenWelcome) {
          meta.seenWelcome = true;
          if (session.settings?.welcomeMessage) {
            try {
              await sock.sendMessage(from, { text: session.settings.welcomeMessage });
            } catch (e) { console.warn("welcome send err", e?.message || e); }
            // continue to also answer the incoming message (or skip? we will continue)
          }
        }

        // Try local responses if enabled
        if (session.settings.localEnabled) {
          const local = session.settings.localResponses || {};
          const mm = session.settings.matchMode || "exact";
          const localMatch = matchLocal(body, local, mm);
          if (localMatch) {
            reply = localMatch;
            usedSource = "local";
          }
        }

        // If no local or local disabled, try AI chain
        if (!reply) {
          // Build prompt: prefer session-specific prompt if exists
          const promptToUse = `${session.settings.prompt || GLOBAL_DEFAULT_PROMPT}\nUsuario: ${body}`;

          // Try Gemini then Cohere then OpenAI (configurable order could be added)
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
          // final fallback
          reply = "Lo siento, no tengo una respuesta ahora mismo.";
          usedSource = usedSource || "fallback";
        }

        // If sourceIndicator enabled, append small tag
        if (session.settings.sourceIndicator) {
          reply = `${reply}\n\n(Fuente: ${usedSource || "desconocida"})`;
        }

        // Avoid sending the exact same reply repeatedly in a short window
        if (meta.lastReply && meta.lastReply === reply && (now - meta.lastReplyAt) < cooldownMs) {
          console.log("Skipping duplicate reply to avoid loop:", from);
          meta.lastReplyAt = now; // update time anyway
          chats.set(from, meta);
          continue;
        }

        // Send reply (split paragraphs if long)
        const parts = (reply || "").split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
        if (parts.length > 1) {
          for (const p of parts) {
            await wait(300 + Math.random() * 800);
            await sock.sendMessage(from, { text: p });
          }
        } else {
          await sock.sendMessage(from, { text: reply });
        }

        // update meta
        meta.lastReply = reply;
        meta.lastReplyAt = Date.now();
        chats.set(from, meta);

        console.log("Respondido a", from, "source:", usedSource);
      }
    } catch (e) {
      console.error("messages.upsert error:", e?.message || e);
    }
  });

  return sock;
};

/* ---------------- API Endpoints (GET-friendly for AppCreator24) ---------------- */

/* --- session lifecycle --- */
// create (or return existing)
app.get("/api/session/create", async (req, res) => {
  try {
    const sessionId = req.query.sessionId || `session_${Date.now()}`;
    if (!sessions.has(sessionId)) {
      await createAndConnectSocket(sessionId);
      // small delay so QR may generate
      await new Promise(r => setTimeout(r, 200));
    }
    res.json({ ok: true, sessionId });
  } catch (e) {
    console.error("create session err", e?.message || e);
    res.status(500).json({ ok: false, error: "Error creando sesión" });
  }
});

// get QR / status
app.get("/api/session/qr", (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ ok: false, error: "Falta sessionId" });
  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ ok: false, error: "Session no encontrada" });
  res.json({ ok: true, qr: s.qr || null, status: s.status || "unknown" });
});

// set prompt (session)
app.get("/api/session/prompt/set", (req, res) => {
  try {
    const { sessionId, prompt } = req.query;
    if (!sessionId) return res.status(400).json({ ok: false, error: "Falta sessionId" });
    const s = sessions.get(sessionId);
    if (!s) return res.status(404).json({ ok: false, error: "Session no encontrada" });
    s.settings = s.settings || {};
    s.settings.prompt = prompt || s.settings.prompt || GLOBAL_DEFAULT_PROMPT;
    writeJSON(path.join(s.sessionDir, "settings.json"), s.settings);
    sessions.set(sessionId, s);
    res.json({ ok: true });
  } catch (e) {
    console.error("set prompt error", e?.message || e);
    res.status(500).json({ ok: false, error: "Error guardando prompt" });
  }
});

// set local responses JSON (param local = JSON-string)
app.get("/api/session/localResponses/set", (req, res) => {
  try {
    const { sessionId, local } = req.query;
    if (!sessionId || !local) return res.status(400).json({ ok: false, error: "Faltan params" });
    const s = sessions.get(sessionId);
    if (!s) return res.status(404).json({ ok: false, error: "Session no encontrada" });
    let parsed;
    try { parsed = JSON.parse(local); } catch (e) { return res.status(400).json({ ok: false, error: "local no es JSON válido" }); }
    s.settings = s.settings || {};
    s.settings.localResponses = parsed;
    writeJSON(path.join(s.sessionDir, "settings.json"), s.settings);
    sessions.set(sessionId, s);
    res.json({ ok: true });
  } catch (e) {
    console.error("set localResponses err", e?.message || e);
    res.status(500).json({ ok: false, error: "Error guardando respuestas locales" });
  }
});

// set matchMode (exact|pattern|expert)
app.get("/api/session/matchmode/set", (req, res) => {
  try {
    const { sessionId, mode } = req.query;
    if (!sessionId || !mode) return res.status(400).json({ ok: false, error: "Faltan params" });
    const s = sessions.get(sessionId);
    if (!s) return res.status(404).json({ ok: false, error: "Session no encontrada" });
    if (!["exact", "pattern", "expert"].includes(mode)) return res.status(400).json({ ok: false, error: "mode inválido" });
    s.settings = s.settings || {};
    s.settings.matchMode = mode;
    writeJSON(path.join(s.sessionDir, "settings.json"), s.settings);
    sessions.set(sessionId, s);
    res.json({ ok: true });
  } catch (e) {
    console.error("set matchmode err", e?.message || e);
    res.status(500).json({ ok: false, error: "Error guardando matchmode" });
  }
});

// set welcome message
app.get("/api/session/welcome/set", (req, res) => {
  try {
    const { sessionId, welcome } = req.query;
    if (!sessionId) return res.status(400).json({ ok: false, error: "Faltan params" });
    const s = sessions.get(sessionId);
    if (!s) return res.status(404).json({ ok: false, error: "Session no encontrada" });
    s.settings = s.settings || {};
    s.settings.welcomeMessage = welcome || "";
    writeJSON(path.join(s.sessionDir, "settings.json"), s.settings);
    sessions.set(sessionId, s);
    res.json({ ok: true });
  } catch (e) {
    console.error("set welcome err", e?.message || e);
    res.status(500).json({ ok: false, error: "Error guardando welcome" });
  }
});

// enable/disable local responses
app.get("/api/session/local/enable", (req, res) => {
  try {
    const { sessionId, enable } = req.query;
    if (!sessionId || typeof enable === "undefined") return res.status(400).json({ ok: false, error: "Faltan params" });
    const s = sessions.get(sessionId);
    if (!s) return res.status(404).json({ ok: false, error: "Session no encontrada" });
    s.settings = s.settings || {};
    s.settings.localEnabled = (enable === "true" || enable === "1");
    writeJSON(path.join(s.sessionDir, "settings.json"), s.settings);
    sessions.set(sessionId, s);
    res.json({ ok: true });
  } catch (e) {
    console.error("local enable err", e?.message || e);
    res.status(500).json({ ok: false, error: "Error guardando localEnabled" });
  }
});

// enable/disable source indicator
app.get("/api/session/sourceIndicator/set", (req, res) => {
  try {
    const { sessionId, enable } = req.query;
    if (!sessionId || typeof enable === "undefined") return res.status(400).json({ ok: false, error: "Faltan params" });
    const s = sessions.get(sessionId);
    if (!s) return res.status(404).json({ ok: false, error: "Session no encontrada" });
    s.settings = s.settings || {};
    s.settings.sourceIndicator = (enable === "true" || enable === "1");
    writeJSON(path.join(s.sessionDir, "settings.json"), s.settings);
    sessions.set(sessionId, s);
    res.json({ ok: true });
  } catch (e) {
    console.error("sourceIndicator err", e?.message || e);
    res.status(500).json({ ok: false, error: "Error guardando sourceIndicator" });
  }
});

// set cooldown seconds
app.get("/api/session/cooldown/set", (req, res) => {
  try {
    const { sessionId, seconds } = req.query;
    if (!sessionId || typeof seconds === "undefined") return res.status(400).json({ ok: false, error: "Faltan params" });
    const s = sessions.get(sessionId);
    if (!s) return res.status(404).json({ ok: false, error: "Session no encontrada" });
    const sec = parseInt(seconds, 10);
    if (isNaN(sec) || sec < 0) return res.status(400).json({ ok: false, error: "seconds inválido" });
    s.settings = s.settings || {};
    s.settings.cooldownSeconds = sec;
    writeJSON(path.join(s.sessionDir, "settings.json"), s.settings);
    sessions.set(sessionId, s);
    res.json({ ok: true });
  } catch (e) {
    console.error("cooldown set err", e?.message || e);
    res.status(500).json({ ok: false, error: "Error guardando cooldown" });
  }
});

/* Envío manual avanzado (GET friendly) */
app.get("/api/session/send", async (req, res) => {
  try {
    const { sessionId, to, type = "text" } = req.query;
    if (!sessionId || !to) return res.status(400).json({ ok: false, error: "Faltan sessionId o to" });
    const s = sessions.get(sessionId);
    if (!s || !s.sock) return res.status(404).json({ ok: false, error: "Session no encontrada o no conectada" });

    const bodyText = req.query.text || "";
    const url = req.query.url;
    const filename = req.query.filename;
    const title = req.query.title || "";
    const footer = req.query.footer || "";
    const safeParse = (str) => { try { return JSON.parse(str); } catch { return null; } };

    let message = null;
    switch (type) {
      case "text":
        message = { text: bodyText };
        break;
      case "image":
        if (!url) return res.status(400).json({ ok: false, error: "Image necesita url" });
        message = { image: { url }, caption: bodyText };
        break;
      case "document":
        if (!url) return res.status(400).json({ ok: false, error: "Document necesita url" });
        message = { document: { url }, fileName: filename || path.basename(url) };
        if (bodyText) message.caption = bodyText;
        break;
      case "audio":
        if (!url) return res.status(400).json({ ok: false, error: "Audio necesita url" });
        message = { audio: { url }, ptt: req.query.ptt === "true" ? true : false };
        break;
      case "contact":
        const vcard = req.query.vcard;
        if (!vcard) return res.status(400).json({ ok: false, error: "Contact necesita vcard" });
        message = { contacts: { displayName: req.query.displayName || "Contacto", contacts: [{ vcard }] } };
        break;
      case "buttons":
        {
          const buttonsParam = safeParse(req.query.buttons || "null");
          const buttons = Array.isArray(buttonsParam) ? buttonsParam.map((b, i) => ({ buttonId: b.id || `btn${i}`, buttonText: { displayText: b.text || `Btn${i}` }, type: 1 })) : null;
          if (!buttons) return res.status(400).json({ ok: false, error: "Buttons necesita JSON en param buttons" });
          message = { text: bodyText || title || "Botones", footerText: footer || "", buttons };
        }
        break;
      case "list":
        {
          const sections = safeParse(req.query.listSections || "null");
          if (!sections) return res.status(400).json({ ok: false, error: "List necesita listSections JSON" });
          message = { title: title || "Lista", text: bodyText || "Selecciona una opción", footer: footer || "", buttonText: req.query.buttonText || "Ver opciones", sections };
        }
        break;
      case "event":
        message = { text: `${title ? (title + "\n\n") : ""}${bodyText}` };
        break;
      default:
        return res.status(400).json({ ok: false, error: "type no soportado" });
    }

    await s.sock.sendMessage(to, message);
    res.json({ ok: true, sent: true });
  } catch (e) {
    console.error("Error send:", e?.message || e);
    res.status(500).json({ ok: false, error: "Error enviando mensaje" });
  }
});

// reset session (delete creds & settings)
app.get("/api/session/reset", async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ ok: false, error: "Falta sessionId" });
    const sessionDir = path.join(SESSIONS_BASE, sessionId);
    const s = sessions.get(sessionId);
    if (s?.sock && s.sock.logout) {
      try { await s.sock.logout(); } catch {}
    }
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    sessions.delete(sessionId);
    res.json({ ok: true, message: "Sesión eliminada, vuelve a crearla para obtener QR" });
  } catch (err) {
    console.error("Error reset:", err?.message || err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// healthcheck for UptimeRobot / fly
app.get("/api/health", (req, res) => {
  res.json({ ok: true, status: "alive", time: new Date().toISOString() });
});

// root
app.get("/", (req, res) => res.json({ ok: true, msg: "ConsultaPE WA Bot activo 🚀" }));

/* ---------------- Start server ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server en puerto ${PORT}`));
