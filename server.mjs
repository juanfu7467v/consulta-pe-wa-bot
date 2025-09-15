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

// Estado del bot
let botPaused = false;
let activeAI = process.env.DEFAULT_AI || "gemini";
let welcomeMessage = "¡Hola! ¿Cómo puedo ayudarte hoy?";

// Configuración de prompts, vacíos para ser configurados por el administrador
let GEMINI_PROMPT = "";
let COHERE_PROMPT = "";
let OPENAI_PROMPT = "";

// Respuestas locales y menús
let respuestasPredefinidas = {};

const ADMIN_NUMBER = process.env.ADMIN_NUMBER;

// ------------------- Gemini -------------------
const consumirGemini = async (prompt) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      console.log("GEMINI_API_KEY no está configurada.");
      return null;
    }
    const model = "gemini-1.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    const body = {
      contents: [
        {
          parts: [
            {
              text: `${GEMINI_PROMPT}\nUsuario: ${prompt}`
            }
          ]
        }
      ]
    };
    
    const response = await axios.post(url, body, { timeout: 15000 });
    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    
    return text ? text.trim() : null;
  } catch (err) {
    console.error("Error al consumir Gemini API:", err.response?.data || err.message);
    return null;
  }
};

// ------------------- Respuestas Locales -------------------
function obtenerRespuestaLocal(texto) {
  const key = texto.toLowerCase().trim();
  const respuesta = respuestasPredefinidas[key];
  if (respuesta) {
    return Array.isArray(respuesta) ? respuesta[Math.floor(Math.random() * respuesta.length)] : respuesta;
  }
  return null;
}

// ------------------- Importar Baileys -------------------
let makeWASocket, useMultiFileAuthState, DisconnectReason, proto;
try {
  const baileysModule = await import("@whiskeysockets/baileys");
  makeWASocket = baileysModule.makeWASocket;
  useMultiFileAuthState = baileysModule.useMultiFileAuthState;
  DisconnectReason = baileysModule.DisconnectReason;
  proto = baileysModule.proto;
} catch (err) {
  console.error("Error importando Baileys:", err.message || err);
}

// ------------------- Utilidades -------------------
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

const formatText = (text, style) => {
  switch (style) {
    case 'bold':
      return `*${text}*`;
    case 'italic':
      return `_${text}_`;
    case 'strike':
      return `~${text}~`;
    case 'mono':
      return '```' + text + '```';
    default:
      return text;
  }
};

// ------------------- Crear Socket -------------------
const createAndConnectSocket = async (sessionId) => {
  if (!makeWASocket) throw new Error("Baileys no disponible");

  const sessionDir = path.join("./sessions", sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["ConsultaPE", "Chrome", "2.0"],
    syncFullHistory: false
  });

  sessions.set(sessionId, { sock, status: "starting", qr: null, lastMessageTimestamp: 0 });

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
      } else {
        console.log("Sesión cerrada por desconexión del usuario.");
        sessions.delete(sessionId);
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    for (const msg of m.messages || []) {
      if (!msg.message || msg.key.fromMe) continue;
      
      const from = msg.key.remoteJid;
      const body = msg.message.conversation || msg.message?.extendedTextMessage?.text || "";

      // Evitar responder a mensajes de estado
      if (from.endsWith("@s.whatsapp.net") && !from.endsWith("@g.us")) {
          // Si es el primer mensaje de la conversación, enviar el mensaje de bienvenida
          if (sessions.get(sessionId).lastMessageTimestamp === 0) {
              await sock.sendMessage(from, { text: welcomeMessage });
              sessions.get(sessionId).lastMessageTimestamp = Date.now();
          }
      }

      if (!body) continue;

      // Comando de administrador
      const is_admin = from.startsWith(ADMIN_NUMBER);
      if (is_admin && body.startsWith("/")) {
        const parts = body.substring(1).split("|").map(p => p.trim());
        const command = parts[0].split(" ")[0];
        const arg = parts[0].split(" ").slice(1).join(" ");
        
        switch (command) {
          case "pause":
            botPaused = true;
            await sock.sendMessage(from, { text: "✅ Bot pausado. No responderé a los mensajes." });
            break;
          case "resume":
            botPaused = false;
            await sock.sendMessage(from, { text: "✅ Bot reanudado. Volveré a responder." });
            break;
          case "useai":
            if (["gemini", "cohere", "openai", "local"].includes(arg)) {
              activeAI = arg;
              await sock.sendMessage(from, { text: `✅ Ahora estoy usando: ${activeAI}.` });
            } else {
              await sock.sendMessage(from, { text: "❌ Comando inválido. Usa: /useai <gemini|cohere|openai|local>" });
            }
            break;
          case "setgeminiprompt":
            GEMINI_PROMPT = arg;
            await sock.sendMessage(from, { text: "✅ Prompt de Gemini actualizado." });
            break;
          case "setcohereprompt":
            COHERE_PROMPT = arg;
            await sock.sendMessage(from, { text: "✅ Prompt de Cohere actualizado." });
            break;
          case "setopenaiprompt":
            OPENAI_PROMPT = arg;
            await sock.sendMessage(from, { text: "✅ Prompt de OpenAI actualizado." });
            break;
          case "addlocal":
            if (parts.length >= 2) {
              respuestasPredefinidas[parts[0].replace("addlocal ", "").toLowerCase()] = parts[1];
              await sock.sendMessage(from, { text: `✅ Respuesta local para '${parts[0].replace("addlocal ", "")}' agregada.` });
            } else {
              await sock.sendMessage(from, { text: "❌ Comando inválido. Usa: /addlocal <pregunta> | <respuesta>" });
            }
            break;
          case "editlocal":
            if (parts.length >= 2) {
              respuestasPredefinidas[parts[0].replace("editlocal ", "").toLowerCase()] = parts[1];
              await sock.sendMessage(from, { text: `✅ Respuesta local para '${parts[0].replace("editlocal ", "")}' editada.` });
            } else {
              await sock.sendMessage(from, { text: "❌ Comando inválido. Usa: /editlocal <pregunta> | <nueva_respuesta>" });
            }
            break;
          case "deletelocal":
            const keyToDelete = parts[0].replace("deletelocal ", "").toLowerCase();
            if (respuestasPredefinidas[keyToDelete]) {
              delete respuestasPredefinidas[keyToDelete];
              await sock.sendMessage(from, { text: `✅ Respuesta local para '${keyToDelete}' eliminada.` });
            } else {
              await sock.sendMessage(from, { text: "❌ La respuesta local no existe." });
            }
            break;
          case "setwelcome":
            welcomeMessage = arg;
            await sock.sendMessage(from, { text: "✅ Mensaje de bienvenida actualizado." });
            break;
          case "sendmedia":
            const [url, type, caption = ""] = parts.slice(1);
            if (!url || !type) {
                await sock.sendMessage(from, { text: "❌ Uso: /sendmedia | <url> | <tipo> | [caption]" });
                return;
            }
            try {
                const response = await axios.get(url, { responseType: 'arraybuffer' });
                const buffer = Buffer.from(response.data);
                const mediaMsg = { [type]: buffer, caption: caption };
                await sock.sendMessage(from, mediaMsg);
            } catch (error) {
                await sock.sendMessage(from, { text: "❌ Error al enviar el archivo." });
            }
            break;
          case "sendbulk":
            const [numbers, message] = parts.slice(1);
            if (!numbers || !message) {
                await sock.sendMessage(from, { text: "❌ Uso: /sendbulk | <num1,num2,...> | <mensaje>" });
                return;
            }
            const numberList = numbers.split(",").map(num => `${num}@s.whatsapp.net`);
            for (const number of numberList) {
                await sock.sendMessage(number, { text: message });
                await wait(1500);
            }
            await sock.sendMessage(from, { text: `✅ Mensaje enviado a ${numberList.length} contactos.` });
            break;
          case "status":
            await sock.sendMessage(from, { text: `
              📊 *Estado del Bot* 📊
              Estado de conexión: *${sessions.get(sessionId).status}*
              IA activa: *${activeAI}*
              Bot pausado: *${botPaused ? "Sí" : "No"}*
              Número de respuestas locales: *${Object.keys(respuestasPredefinidas).length}*
              Mensaje de bienvenida: *${welcomeMessage}*
            `});
            break;
          default:
            await sock.sendMessage(from, { text: "❌ Comando de administrador no reconocido." });
        }
        return; // Detener el procesamiento si es un comando de admin
      }

      if (botPaused) return;

      // Calcular tiempo de "composing" (escribiendo) dinámicamente
      const calculateTypingTime = (textLength) => {
        const msPerChar = 40; // milisegundos por caracter
        const maxTime = 5000; // Máximo 5 segundos de "escribiendo"
        return Math.min(textLength * msPerChar, maxTime);
      };

      await sock.sendPresenceUpdate("composing", from);
      
      let reply = null;

      // Priorizar respuestas locales si existen
      reply = obtenerRespuestaLocal(body);

      // Si no hay respuesta local, usar la IA activa
      if (!reply) {
        switch (activeAI) {
          case "gemini":
            reply = await consumirGemini(body);
            break;
          case "cohere":
            // Lógica para Cohere
            reply = "❌ No implementado aún. Por favor, usa /useai gemini";
            break;
          case "openai":
            // Lógica para OpenAI
            reply = "❌ No implementado aún. Por favor, usa /useai gemini";
            break;
          case "local":
            reply = "🤔 No se encontró respuesta local. El modo local está activo.";
            break;
          default:
            reply = "⚠️ Error: IA no reconocida. Por favor, contacta al administrador.";
            break;
        }
      }

      if (!reply) {
          reply = "Lo siento, no pude encontrar una respuesta. Por favor, intenta más tarde.";
      }

      // Finalizar "composing"
      await wait(calculateTypingTime(reply.length));
      await sock.sendPresenceUpdate("paused", from);

      // Dividir y enviar el mensaje
      const replyLength = reply.length;
      let parts = [reply];

      if (replyLength > 300) {
        parts = reply.match(/(.{1,300})/g);
        if (parts.length > 3) parts = parts.slice(0, 3);
      } else if (replyLength > 100) {
        parts = reply.match(/(.{1,150})/g);
      }
      
      for (const p of parts) {
        await sock.sendMessage(from, { text: p });
        await wait(1000 + Math.random() * 500); // Pequeña pausa entre mensajes divididos
      }
    }
  });

  return sock;
};

// ------------------- Endpoints -------------------
app.get("/api/session/create", async (req, res) => {
  const sessionId = req.query.sessionId || `session_${Date.now()}`;
  if (!sessions.has(sessionId)) await createAndConnectSocket(sessionId);
  res.json({ ok: true, sessionId });
});

app.get("/api/session/qr", (req, res) => {
  const { sessionId } = req.query;
  if (!sessions.has(sessionId)) return res.status(404).json({ ok: false, error: "Session no encontrada" });
  const s = sessions.get(sessionId);
  res.json({ ok: true, qr: s.qr, status: s.status });
});

app.get("/api/session/send", async (req, res) => {
  const { sessionId, to, text, is_admin_command } = req.query;
  const s = sessions.get(sessionId);
  if (!s || !s.sock) return res.status(404).json({ ok: false, error: "Session no encontrada" });
  try {
    if (is_admin_command === "true") {
      // Reutilizar la lógica de comandos de administrador
      await s.sock.sendMessage(to, { text: text });
      res.json({ ok: true, message: "Comando enviado para procesamiento ✅" });
    } else {
      await s.sock.sendMessage(to, { text });
      res.json({ ok: true, message: "Mensaje enviado ✅" });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/session/reset", async (req, res) => {
  const { sessionId } = req.query;
  const sessionDir = path.join("./sessions", sessionId);
  try {
    if (sessions.has(sessionId)) {
      const { sock } = sessions.get(sessionId);
      if (sock) await sock.end();
      sessions.delete(sessionId);
    }
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    res.json({ ok: true, message: "Sesión eliminada, vuelve a crearla para obtener QR" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/", (req, res) => res.json({ ok: true, msg: "ConsultaPE WA Bot activo 🚀" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server en puerto ${PORT}`));
