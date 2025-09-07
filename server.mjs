// server.mjs
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import qrcode from "qrcode";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }));

// In-memory store de sesiones y settings (sin DB)
const sessions = new Map(); 
// session structure:
// sessions.set(sessionId, {
//   sock, status: 'starting'|'qr'|'connected'|'disconnected'|'error',
//   qr: dataUrl|null,
//   settings: { welcomeText, enabled: true, businessHours: { start: "09:00", end: "18:00" } }
// });

/* ----------------- Helpers Gemini ----------------- */
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

/* ------------- Importar Baileys robusto ------------- */
let makeWASocket, useMultiFileAuthState, DisconnectReason;
try {
  // Top-level dynamic import para evitar problemas ESM/CJS
  const baileysModule = await import("@whiskeysockets/baileys").catch(e => {
    console.error("Error import baileys:", e.message || e);
    throw e;
  });
  // dependencia puede exportar default o named; manejar ambos casos
  const b = baileysModule.default && baileysModule.default.makeWASocket ? baileysModule.default : baileysModule;
  makeWASocket = b.makeWASocket || b.default || b;
  useMultiFileAuthState = b.useMultiFileAuthState || b.useMultiFileAuthState;
  DisconnectReason = b.DisconnectReason || b.DisconnectReason;
  if (!makeWASocket) throw new Error("No se pudo obtener makeWASocket desde baileys");
} catch (err) {
  console.error("Fallo importando baileys:", err?.message || err);
  // continuar; create endpoint fallará si no está instalado
}

/* --------------- Función crear socket --------------- */
const createAndConnectSocket = async (sessionId) => {
  if (!makeWASocket) throw new Error("Baileys no disponible en runtime");
  if (sessions.has(sessionId) && sessions.get(sessionId).sock) return sessions.get(sessionId).sock;

  // settings por defecto
  const defaultSettings = {
    welcomeText: "Hola, gracias por escribir. Te responderé pronto.",
    enabled: true,
    businessHours: { start: "00:00", end: "23:59" } // siempre activo por defecto
  };

  sessions.set(sessionId, { sock: null, status: "starting", qr: null, settings: defaultSettings });

  // useMultiFileAuthState guarda en carpeta /tmp/<sessionId> (archivos)
  const { state, saveCreds } = await useMultiFileAuthState(`/tmp/${sessionId}`);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    browser: ["ConsultaPE", "Chrome", "1.0"],
  });

  // guardar sock referencia
  sessions.get(sessionId).sock = sock;

  // guarda credenciales cuando cambian
  sock.ev.on("creds.update", async () => {
    try {
      await saveCreds();
    } catch (e) {
      console.error("Error saveCreds:", e?.message || e);
    }
  });

  // rechazar llamadas entrantes
  sock.ev.on("call", async (calls) => {
    for (const call of calls) {
      try {
        if (call.isGroup) continue;
        // some versions use different method names; try catch
        if (sock.rejectCall) await sock.rejectCall(call.id || call.key?.id || call.callId, call.from || call.participant || call.key?.remoteJid);
        // enviar mensaje indicando rechazo (no garantizado si no conectado)
        try { await sock.sendMessage(call.from || call.participant || call.key?.remoteJid, { text: "📵 No acepto llamadas en este número." }); } catch {}
      } catch (e) {
        console.warn("Error al rechazar llamada:", e?.message || e);
      }
    }
  });

  // connection.update -> QR y estados
  sock.ev.on("connection.update", async (update) => {
    try {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        const dataUrl = await qrcode.toDataURL(qr);
        const s = sessions.get(sessionId) || {};
        s.qr = dataUrl;
        s.status = "qr";
        sessions.set(sessionId, s);
        console.log("QR guardado para session", sessionId);
      }
      if (connection === "open") {
        const s = sessions.get(sessionId) || {};
        s.qr = null;
        s.status = "connected";
        sessions.set(sessionId, s);
        console.log("WhatsApp conectado para", sessionId);
      }
      if (connection === "close") {
        const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.message;
        console.log("connection closed, reason:", reason);
        const s = sessions.get(sessionId) || {};
        s.status = "disconnected";
        sessions.set(sessionId, s);
        // intentar reconectar salvo logout
        if (DisconnectReason && lastDisconnect?.error?.output?.statusCode !== DisconnectReason?.loggedOut) {
          console.log("Reconectando session", sessionId);
          setTimeout(() => createAndConnectSocket(sessionId).catch(err => console.error("reconnect err", err?.message||err)), 2000);
        } else {
          console.log("Sesión logout para", sessionId);
        }
      }
    } catch (e) {
      console.error("Error en connection.update:", e?.message || e);
    }
  });

  // mensajes entrantes: comprobar horario + responder con Gemini
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const messages = m.messages || [];
      for (const msg of messages) {
        if (!msg.message || msg.key?.fromMe) continue;
        const from = msg.key.remoteJid;
        const body =
          msg.message.conversation ||
          msg.message?.extendedTextMessage?.text ||
          (msg.message?.imageMessage && msg.message?.imageMessage?.caption) ||
          "";

        if (!body) continue;
        console.log(`Mensaje de ${from}:`, body);

        // chequear settings horario
        const s = sessions.get(sessionId);
        const now = new Date();
        const [startH, startM] = (s.settings.businessHours.start || "00:00").split(":").map(Number);
        const [endH, endM] = (s.settings.businessHours.end || "23:59").split(":").map(Number);
        const startMinutes = startH * 60 + startM;
        const endMinutes = endH * 60 + endM;
        const curMinutes = now.getHours() * 60 + now.getMinutes();
        const inHours = startMinutes <= endMinutes ? (curMinutes >= startMinutes && curMinutes <= endMinutes) : (curMinutes >= startMinutes || curMinutes <= endMinutes);

        if (!s.settings.enabled) {
          console.log("Auto-respuestas deshabilitadas para session", sessionId);
          continue;
        }

        if (!inHours) {
          // Fuera de horario: opcional mensaje fuera de horario
          const outMsg = s.settings.outOfHoursText || "Fuera de horario. Te responderemos en horario de atención.";
          try { await sock.sendMessage(from, { text: outMsg }); } catch (e) {}
          continue;
        }

        // dentro de horario => generar respuesta con Gemini
        const reply = await consumirGemini(body) || s.settings.welcomeText || "Hola, gracias por tu mensaje.";
        try {
          await sock.sendMessage(from, { text: reply });
        } catch (e) {
          console.error("Error enviando respuesta:", e?.message || e);
        }
      }
    } catch (e) {
      console.error("Error en messages.upsert:", e?.message || e);
    }
  });

  return sock;
};

/* ---------------- API endpoints ---------------- */

// Crear sesión (GET) -> devuelve sessionId
app.get("/api/session/create", async (req, res) => {
  try {
    const sessionId = req.query.sessionId || `session_${Date.now()}`;
    // inicializar settings por defecto
    sessions.set(sessionId, { sock: null, status: "starting", qr: null, settings: {
      welcomeText: "Hola, gracias por escribir. Te responderé pronto.",
      outOfHoursText: "Estamos fuera de horario. Te responderemos luego.",
      enabled: true,
      businessHours: { start: "00:00", end: "23:59" }
    }});
    await createAndConnectSocket(sessionId);
    res.json({ ok: true, sessionId });
  } catch (e) {
    console.error("Error creando sesión:", e?.message || e);
    res.status(500).json({ ok: false, error: "Error creando sesión" });
  }
});

// Obtener QR / estado
app.get("/api/session/qr", async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ ok: false, error: "Falta sessionId" });
    const s = sessions.get(sessionId);
    if (!s) return res.status(404).json({ ok: false, error: "Session no encontrada" });
    res.json({ ok: true, qr: s.qr || null, status: s.status || "unknown", settings: s.settings });
  } catch (e) {
    console.error("Error al obtener QR:", e?.message || e);
    res.status(500).json({ ok: false, error: "Error al obtener QR" });
  }
});

// Configurar settings (welcomeText, outOfHoursText, enabled, businessHours)
app.post("/api/session/settings", async (req, res) => {
  try {
    const { sessionId, welcomeText, outOfHoursText, enabled, businessHours } = req.body;
    if (!sessionId) return res.status(400).json({ ok: false, error: "Falta sessionId" });
    const s = sessions.get(sessionId);
    if (!s) return res.status(404).json({ ok: false, error: "Session no encontrada" });
    s.settings = {
      welcomeText: typeof welcomeText === "string" ? welcomeText : s.settings.welcomeText,
      outOfHoursText: typeof outOfHoursText === "string" ? outOfHoursText : s.settings.outOfHoursText,
      enabled: typeof enabled === "boolean" ? enabled : s.settings.enabled,
      businessHours: businessHours || s.settings.businessHours,
    };
    sessions.set(sessionId, s);
    res.json({ ok: true, settings: s.settings });
  } catch (e) {
    console.error("Error settings:", e?.message || e);
    res.status(500).json({ ok: false, error: "Error guardando settings" });
  }
});

// Detener / desconectar sesión (intenta logout y eliminar socket)
app.post("/api/session/stop", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ ok: false, error: "Falta sessionId" });
    const s = sessions.get(sessionId);
    if (!s) return res.status(404).json({ ok: false, error: "Session no encontrada" });
    try {
      if (s.sock && s.sock.logout) await s.sock.logout();
      if (s.sock && s.sock.ev && s.sock.ev.removeAllListeners) {
        // best-effort close
        try { s.sock.ev.removeAllListeners(); } catch {}
      }
    } catch (e) {
      console.warn("Error al logout:", e?.message || e);
    }
    sessions.delete(sessionId);
    res.json({ ok: true });
  } catch (e) {
    console.error("Error stop:", e?.message || e);
    res.status(500).json({ ok: false, error: "Error deteniendo session" });
  }
});

// enviar mensaje manual (para pruebas)
app.post("/api/session/send", async (req, res) => {
  try {
    const { sessionId, to, text } = req.body;
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

app.get("/", (req, res) => res.json({ ok: true, mensaje: "Consulta PE - WhatsApp Bot (sin Firestore)" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server en puerto ${PORT}`));
