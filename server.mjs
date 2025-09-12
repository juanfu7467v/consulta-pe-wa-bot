// server.mjs  
import express from "express";  
import cors from "cors";  
import dotenv from "dotenv";  
import axios from "axios";  
import qrcode from "qrcode";  
import fs from "fs";  
import path from "path";  
  
dotenv.config();  
  
const app = express();  
app.use(cors({ origin: "*" }));  
  
const sessions = new Map();  
  
/* ---------------- Gemini ---------------- */  
const GEMINI_PROMPT = process.env.GEMINI_PROMPT ||   
`Eres un asistente de IA de Consulta PE App, que envía mensajes automáticos.   
Eres servicial, creativo, inteligente y muy amigable. Siempre das una respuesta.`;  
  
const consumirGemini = async (prompt) => {  
  try {  
    if (!process.env.GEMINI_API_KEY) return null;  
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`;  
    const body = { contents: [{ parts: [{ text: `${GEMINI_PROMPT}\nUsuario: ${prompt}` }] }] };  
    const r = await axios.post(url, body, { timeout: 15000 });  
    return r.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;  
  } catch (err) {  
    console.error("Error Gemini:", err?.response?.data || err.message);  
    return null;  
  }  
};  
  
/* ---------------- Respuestas sin Gemini ---------------- */  
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
  const key = texto.toLowerCase().trim();  
  if (respuestasPredefinidas[key]) {  
    const r = respuestasPredefinidas[key];  
    return Array.isArray(r) ? r[Math.floor(Math.random() * r.length)] : r;  
  }  
  return "Lo siento, no entendí 🤔. Escribe 'menu' para ver opciones.";  
}  
  
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
  
  const sessionDir = path.join("./sessions", sessionId);  
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });  
  
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);  
  
  const sock = makeWASocket({  
    auth: state,  
    printQRInTerminal: false,  
    browser: ["ConsultaPE", "Chrome", "2.0"], // estable para WA Business  
    syncFullHistory: false // evita desincronización que expulsa la sesión  
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
      await saveCreds();  
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
  
      // Espera natural  
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));  
      await wait(1000 + Math.random() * 2000);  
  
      // Responder con Gemini si existe API KEY, sino con respuestas locales  
      let reply = null;  
      if (process.env.GEMINI_API_KEY) {  
        reply = await consumirGemini(body);  
      }  
      if (!reply) reply = obtenerRespuestaLocal(body);  
  
      // Si la respuesta es múltiple (separada por comas)  
      if (reply.includes(",")) {  
        const partes = reply.split(",");  
        for (const p of partes) {  
          await wait(800 + Math.random() * 1200);  
          await sock.sendMessage(from, { text: p.trim() });  
        }  
      } else {  
        await sock.sendMessage(from, { text: reply });  
      }  
    }  
  });  
  
  return sock;  
};  
  
/* ---------------- Endpoints ---------------- */  
  
// Crear sesión  
app.get("/api/session/create", async (req, res) => {  
  const sessionId = req.query.sessionId || `session_${Date.now()}`;  
  if (!sessions.has(sessionId)) await createAndConnectSocket(sessionId);  
  res.json({ ok: true, sessionId });  
});  
  
// Obtener QR  
app.get("/api/session/qr", (req, res) => {  
  const { sessionId } = req.query;  
  if (!sessions.has(sessionId)) return res.status(404).json({ ok: false, error: "Session no encontrada" });  
  const s = sessions.get(sessionId);  
  res.json({ ok: true, qr: s.qr, status: s.status });  
});  
  
// Enviar mensaje manual  
app.get("/api/session/send", async (req, res) => {  
  const { sessionId, to, text } = req.query;  
  const s = sessions.get(sessionId);  
  if (!s || !s.sock) return res.status(404).json({ ok: false, error: "Session no encontrada" });  
  await s.sock.sendMessage(to, { text });  
  res.json({ ok: true, message: "Mensaje enviado ✅" });  
});  
  
// Resetear sesión  
app.get("/api/session/reset", async (req, res) => {  
  const { sessionId } = req.query;  
  const sessionDir = path.join("./sessions", sessionId);  
  try {  
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });  
    sessions.delete(sessionId);  
    res.json({ ok: true, message: "Sesión eliminada, vuelve a crearla para obtener QR" });  
  } catch (err) {  
    res.status(500).json({ ok: false, error: err.message });  
  }  
});  
  
app.get("/", (req, res) => res.json({ ok: true, msg: "ConsultaPE WA Bot activo 🚀" }));  
  
const PORT = process.env.PORT || 3000;  
app.listen(PORT, () => console.log(`🚀 Server en puerto ${PORT}`));  
