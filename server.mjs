#!/usr/bin/env node
// server.mjs
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import qrcode from "qrcode";
import fs from "fs";
import path from "path";

// Fix for crypto missing in some node envs (Baileys needs WebCrypto)
import { webcrypto } from "crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const SESSIONS_BASE = path.join(".", "sessions");
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

const sessions = new Map(); // in-memory index of sessions

/* ---------------- Gemini / Prompt y respuestas ---------------- */
const DEFAULT_PROMPT = `Eres un asistente de IA de Consulta PE App, que envía mensajes automáticos.
Eres servicial, creativo, inteligente y muy amigable. Siempre das una respuesta.`;

async function consumirGemini(promptText) {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${key}`;
    const body = { contents: [{ parts: [{ text: promptText }] }] };
    const r = await axios.post(url, body, { timeout: 20000 });
    return r.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (err) {
    console.error("Error Gemini:", err?.response?.data || err?.message || err);
    return null;
  }
}

/* ---------------- Respuestas locales (fallback) ---------------- */
const FALLBACK = {
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

function obtenerRespuestaLocal(texto, sessionSettings) {
  const key = (texto || "").toLowerCase().trim();
  const local = sessionSettings?.localResponses || FALLBACK;
  if (local[key]) {
    const r = local[key];
    return Array.isArray(r) ? r[Math.floor(Math.random() * r.length)] : r;
  }
  return "Lo siento, no entendí 🤔. Escribe 'menu' para ver opciones.";
}

/* ------------- Importar Baileys ------------- */
let makeWASocket, useMultiFileAuthState, DisconnectReason;
try {
  const baileys = await import("@whiskeysockets/baileys");
  makeWASocket = baileys.makeWASocket;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
} catch (err) {
  console.error("Error importando Baileys:", err?.message || err);
}

/* --------------- Crear y Conectar Socket --------------- */
const createAndConnectSocket = async (sessionId) => {
  if (!makeWASocket) throw new Error("Baileys no disponible");
  const sessionDir = path.join(SESSIONS_BASE, sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  // load settings file if exists
  const settingsPath = path.join(sessionDir, "settings.json");
  let settings = { prompt: DEFAULT_PROMPT, localResponses: FALLBACK };
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
  } else {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["ConsultaPE", "Chrome", "2.0"],
    syncFullHistory: false
  });

  sessions.set(sessionId, { sock, status: "starting", qr: null, settings, sessionDir });

  sock.ev.on("creds.update", async () => {
    try { await saveCreds(); } catch (e) { console.warn("saveCreds err:", e?.message || e); }
  });

  // connection updates: QR, open, close
  sock.ev.on("connection.update", async (update) => {
    try {
      console.log("connection.update:", JSON.stringify(update));
      const { connection, lastDisconnect, qr } = update;
      const s = sessions.get(sessionId) || {};
      if (qr) {
        s.qr = await qrcode.toDataURL(qr);
        s.status = "qr";
        sessions.set(sessionId, s);
        console.log("QR generado para", sessionId);
      }
      if (connection === "open") {
        s.qr = null;
        s.status = "connected";
        sessions.set(sessionId, s);
        console.log("Conectado:", sessionId);
        try { await saveCreds(); } catch {}
      }
      if (connection === "close") {
        s.status = "disconnected";
        sessions.set(sessionId, s);
        const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.name || lastDisconnect?.error;
        console.log("Conexion cerrada:", reason);
        if (DisconnectReason && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
          console.log("Reconectando en 2s", sessionId);
          setTimeout(() => createAndConnectSocket(sessionId).catch(e => console.error("reconnect err", e?.message || e)), 2000);
        } else {
          console.log("Logout permanente para", sessionId);
        }
      }
    } catch (e) {
      console.error("connection.update handler error:", e?.message || e);
    }
  });

  // mensajes entrantes: responder con Gemini o fallback
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const messages = m.messages || [];
      for (const msg of messages) {
        if (!msg.message || msg.key?.fromMe) continue;
        const from = msg.key.remoteJid;
        const body =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          (msg.message?.imageMessage && msg.message.imageMessage.caption) ||
          (msg.message?.documentMessage && msg.message.documentMessage.fileName) ||
          "";
        if (!body) continue;

        console.log("Mensaje recibido", from, "->", body);

        // natural wait
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        await wait(800 + Math.random() * 1500);

        // pick prompt from session settings
        const s = sessions.get(sessionId);
        const promptToUse = (s?.settings?.prompt) ? `${s.settings.prompt}\nUsuario: ${body}` : `${DEFAULT_PROMPT}\nUsuario: ${body}`;

        let reply = null;
        if (process.env.GEMINI_API_KEY) {
          reply = await consumirGemini(promptToUse);
        }
        if (!reply) reply = obtenerRespuestaLocal(body, s?.settings);

        // split into sensible parts
        const parts = reply.split(/\n|,|\.{2,}|;/).map(p => p.trim()).filter(Boolean);
        if (parts.length > 1) {
          for (const p of parts) { await wait(500 + Math.random() * 1200); await sock.sendMessage(from, { text: p }); }
        } else {
          await sock.sendMessage(from, { text: reply });
        }
        console.log("Respondido a", from);
      }
    } catch (e) {
      console.error("messages.upsert error:", e?.message || e);
    }
  });

  return sock;
};

/* ---------------- API Endpoints (GET friendly) ---------------- */

// Crear sesión
app.get("/api/session/create", async (req, res) => {
  try {
    const sessionId = req.query.sessionId || `session_${Date.now()}`;
    if (!sessions.has(sessionId)) {
      await createAndConnectSocket(sessionId);
      await new Promise(r => setTimeout(r, 200)); // small delay so QR may generate
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

// Guardar prompt (GET: prompt param opcionalmente urlencoded) -> guarda en settings.json
app.get("/api/session/prompt/set", (req, res) => {
  try {
    const { sessionId, prompt } = req.query;
    if (!sessionId) return res.status(400).json({ ok: false, error: "Falta sessionId" });
    const s = sessions.get(sessionId);
    if (!s) return res.status(404).json({ ok: false, error: "Session no encontrada" });
    s.settings = s.settings || {};
    s.settings.prompt = prompt || s.settings.prompt || DEFAULT_PROMPT;
    fs.writeFileSync(path.join(s.sessionDir, "settings.json"), JSON.stringify(s.settings, null, 2));
    sessions.set(sessionId, s);
    res.json({ ok: true });
  } catch (e) {
    console.error("Error set prompt:", e?.message || e);
    res.status(500).json({ ok: false, error: "Error guardando prompt" });
  }
});

// Guardar respuestas locales (JSON string in param 'local') -> stored
app.get("/api/session/localResponses/set", (req, res) => {
  try {
    const { sessionId, local } = req.query;
    if (!sessionId || !local) return res.status(400).json({ ok: false, error: "Faltan params" });
    const s = sessions.get(sessionId);
    if (!s) return res.status(404).json({ ok: false, error: "Session no encontrada" });
    try {
      const parsed = JSON.parse(local);
      s.settings = s.settings || {};
      s.settings.localResponses = parsed;
      fs.writeFileSync(path.join(s.sessionDir, "settings.json"), JSON.stringify(s.settings, null, 2));
      sessions.set(sessionId, s);
      res.json({ ok: true });
    } catch (e) {
      return res.status(400).json({ ok: false, error: "local no es JSON válido" });
    }
  } catch (e) {
    console.error("Error set localResponses:", e?.message || e);
    res.status(500).json({ ok: false, error: "Error guardando respuestas locales" });
  }
});

/*
  Envío manual (GET para AppCreator24). Params:
   - sessionId
   - to (ej: 51987654321@s.whatsapp.net)
   - type (text | image | document | audio | contact | buttons | list | event)
   - text (para type=text or caption)
   - url (url pública para image/document/audio)
   - filename (nombre para documentos)
   - title / footer (para buttons/list)
   - buttons (JSON string -> [{id:"b1",text:"Sí"}])
   - listSections (JSON string -> [{title:"Sección", rows:[{id:"r1",title:"Op1",description:"..." }]}])
   - vcard (string vCard content for contact)
*/
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
    // try parse JSON params
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
        // vcard string required
        const vcard = req.query.vcard;
        if (!vcard) return res.status(400).json({ ok: false, error: "Contact necesita vcard" });
        message = { contacts: { displayName: req.query.displayName || "Contacto", contacts: [{ vcard }] } };
        break;
      case "buttons":
        {
          // buttons param JSON: [{id:"b1",text:"Sí"},{id:"b2",text:"No"}]
          const buttonsParam = safeParse(req.query.buttons || "null");
          const buttons = Array.isArray(buttonsParam) ? buttonsParam.map((b, i) => ({ buttonId: b.id || `btn${i}`, buttonText: { displayText: b.text || `Btn${i}` }, type: 1 })) : null;
          if (!buttons) return res.status(400).json({ ok: false, error: "Buttons necesita JSON en param buttons" });
          message = { text: bodyText || title || "Botones", footerText: footer || "", buttons };
        }
        break;
      case "list":
        {
          // listSections param: JSON string of sections
          const sections = safeParse(req.query.listSections || "null");
          if (!sections) return res.status(400).json({ ok: false, error: "List necesita listSections JSON" });
          message = {
            title: title || "Lista",
            text: bodyText || "Selecciona una opción",
            footer: footer || "",
            buttonText: req.query.buttonText || "Ver opciones",
            sections
          };
        }
        break;
      case "event":
        // simple event-style: send text with a header (title) and body
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

// Resetear sesión (elimina credenciales -> nuevo QR)
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

app.get("/", (req, res) => res.json({ ok: true, msg: "ConsultaPE WA Bot activo 🚀" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server en puerto ${PORT}`));
