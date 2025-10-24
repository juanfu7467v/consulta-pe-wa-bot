import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import qrcode from "qrcode";
import fs from "fs";
import path from "path";
// Importar agente HTTP/HTTPS de Node.js para mejorar la estabilidad del socket
import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";

dotenv.config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ------------------- GESTIÓN DE INACTIVIDAD (Para Fly.io) -------------------
// Se aumenta el timeout a 10 minutos para dar más tiempo antes de la suspensión
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos
let inactivityTimer;

const resetInactivityTimer = () => {
    if (inactivityTimer) {
        clearTimeout(inactivityTimer);
    }
    inactivityTimer = setTimeout(() => {
        console.log(`\n😴 Contenedor inactivo por ${INACTIVITY_TIMEOUT_MS / 60000} minutos. Se detendrá el proceso de Node.js para que Fly.io lo apague y ahorre recursos.\n`);
        // Detener el proceso para que Fly.io lo apague. El webhook de WA lo despertará.
        process.exit(0); 
    }, INACTIVITY_TIMEOUT_MS);
};

// Middleware para resetear el temporizador en cada request
app.use((req, res, next) => {
    resetInactivityTimer();
    next();
});

// Inicializar el temporizador al arrancar
resetInactivityTimer();
// ----------------------------------------------------------------------------


// ------------------- Archivos y Sesiones -------------------

// Directorio para las sesiones de Baileys
const SESSIONS_DIR = "./sessions";
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Archivo para guardar los datos de las sesiones de WhatsApp
const USERS_DATA_FILE = path.join(process.cwd(), "users_data.json");
if (!fs.existsSync(USERS_DATA_FILE)) {
    fs.writeFileSync(USERS_DATA_FILE, JSON.stringify({}));
}
const loadUserData = () => JSON.parse(fs.readFileSync(USERS_DATA_FILE, "utf-8"));
const saveUserData = (data) => fs.writeFileSync(USERS_DATA_FILE, JSON.stringify(data, null, 2));

const sessions = new Map();
const userStates = new Map(); // Para almacenar el estado de la conversación por usuario

// ------------------- Configuración y Constantes -------------------

let botPaused = false;
let activeAI = process.env.DEFAULT_AI || "gemini";
let welcomeMessage = "¡Hola! ¿Cómo puedo ayudarte hoy?";

// Configuración de prompts, ahora inicializados con el prompt largo y mejorado
let GEMINI_PROMPT = process.env.GEMINI_PROMPT || `Instrucciones maestras para el bot Consulta PE...`;
let COHERE_PROMPT = process.env.COHERE_PROMPT || "";
let OPENAI_PROMPT = process.env.OPENAI_PROMPT || "";

// Prompts y datos para el pago
const YAPE_NUMBER = process.env.YAPE_NUMBER || "929008609";
const QR_IMAGE_URL = process.env.LEMON_QR_IMAGE || "https://ejemplo.com/qr.png"; // ¡Debe ser una URL real!

const YAPE_PAYMENT_PROMPT = `¡Listo, leyenda! Elige la cantidad de poder que quieres, escanea el QR y paga directo por Yape.

*Monto:* S/{{monto}}
*Créditos:* {{creditos}}
*Yape:* ${YAPE_NUMBER}
*Titular:* José R. Cubas

Una vez que pagues, envía el comprobante y tu correo registrado en la app. Te activamos los créditos al toque. No pierdas tiempo.
`;

const PACKAGES = {
    '10': { amount: 10, credits: 60, qr_key: 'LEMON_QR_IMAGE', yape_num: 'YAPE_NUMBER' },
    '20': { amount: 20, credits: 125, qr_key: 'LEMON_QR_IMAGE', yape_num: 'YAPE_NUMBER' },
    '50': { amount: 50, credits: 330, qr_key: 'LEMON_QR_IMAGE', yape_num: 'YAPE_NUMBER' },
    '100': { amount: 100, credits: 700, qr_key: 'LEMON_QR_IMAGE', yape_num: 'YAPE_NUMBER' },
    '200': { amount: 200, credits: 1500, qr_key: 'LEMON_QR_IMAGE', yape_num: 'YAPE_NUMBER' },
};

let respuestasPredefinidas = {};

const ADMIN_NUMBER = process.env.ADMIN_NUMBER;
const ADMIN_NUMBERS = [
    `${process.env.ADMIN_WA_NUMBER_1}@s.whatsapp.net`,
    `${process.env.ADMIN_WA_NUMBER_2}@s.whatsapp.net`
].filter(n => n.startsWith('51'));

// --- Patrones de Venta/Pago (para lógica sin IA) ---
const VENTA_PATTERNS = [
    "Quiero comprar créditos", "Necesito créditos", "Quiero el acceso", 
    "¿Dónde pago?", "¿Cómo compro eso?", "Me interesa la app completa", 
    "Dame acceso completo", "Hola, quiero comprar créditos para Consulta PE. ¿Me puedes dar información?"
];

const PAGO_PATTERNS = [
    "Cómo lo realizo el pago", "10", "20", "50", "100", "200", 
    "Paquete de 10", "Paquete de 20", "Paquete de 50", "Paquete de 100", 
    "Paquete de 200", "El de 10 soles", "A qué número yapeo o plineo", 
    "10 so nomás porfa", "60 creditos"
];

// Respuesta para la venta
const VENTA_RESPONSE = `🔥 Hola, crack 👋 Bienvenid@ al nivel premium de Consulta PE.
Aquí no todos llegan… pero tú sí. 

Ahora toca elegir qué tanto poder quieres desbloquear: 
💰 Paquetes disponibles:

MONTO (S/)	         CRÉDITOS

10	                               60 ⚡
20                             	 125 🚀
50	                               330 💎
100	                            700 👑
200	                            1500 🔥


✨ Ventaja premium: Tus créditos jamás caducan. Lo que compras, es tuyo para siempre.

🎁 Y porque me caes bien: Por la compra de cualquier paquete te voy a añadir  3 créditos extra de yapa.
`;

// ------------------- Funciones de Utilidad -------------------

const checkMatch = (text, patterns) => {
    const textWords = new Set(text.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    
    for (const pattern of patterns) {
        const patternWords = pattern.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        
        if (patternWords.length === 0) continue;
        
        let matches = 0;
        for (const pWord of patternWords) {
            if (textWords.has(pWord)) {
                matches++;
            }
        }
        
        // Coincidencia del 50%
        if (matches / patternWords.length >= 0.5) {
            return true;
        }
        // Coincidencia de números directos (si aplica)
        if (patternWords.length === 1 && textWords.has(patternWords[0])) {
            return true;
        }
    }
    return false;
};

// ------------------- Importar Baileys (ESM) -------------------
let makeWASocket, useMultiFileAuthState, DisconnectReason, proto, downloadContentFromMessage, get
try {
  const baileysModule = await import("@whiskeysockets/baileys");
  makeWASocket = baileysModule.makeWASocket;
  useMultiFileAuthState = baileysModule.useMultiFileAuthState;
  DisconnectReason = baileysModule.DisconnectReason;
  proto = baileysModule.proto;
  downloadContentFromMessage = baileysModule.downloadContentFromMessage;
  get = baileysModule.get
} catch (err) {
  console.error("Error importando Baileys:", err.message || err);
}

// ------------------- Utilidades de Socket -------------------
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

const forwardToAdmins = async (sock, message, customerNumber, type = "GENERAL") => {
  const forwardedMessage = `*REENVÍO AUTOMÁTICO - ${type}*
  
*Cliente:* wa.me/${customerNumber.replace("@s.whatsapp.net", "")}

*Mensaje del cliente:*
${message}
  
*Enviado por el Bot para atención inmediata.*`;

  for (const admin of ADMIN_NUMBERS) {
    if (admin) await sock.sendMessage(admin, { text: forwardedMessage });
  }
};

// ------------------- Crear Socket -------------------
const createAndConnectSocket = async (sessionId) => {
  if (!makeWASocket) throw new Error("Baileys no disponible");

  // Usar el directorio global de sesiones
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    // ******* CORRECCIÓN CRÍTICA PARA FLY.IO: Uso de un agente de conexión *******
    // Esto ayuda a estabilizar la conexión del WebSocket en entornos de contenedores
    // que a menudo tienen problemas de firewall o timeouts.
    const agent = new HttpsAgent({ keepAlive: true });
    
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["ConsultaPE", "Chrome", "2.0"],
    syncFullHistory: false,
    connectTimeoutMs: 30000, 
    agent: agent, // <-- Aplicamos el agente aquí
    // Mantener la conexión activa es clave en Fly.io
    keepAlive: true, 
    // ******* FIN DE CORRECCIÓN CRÍTICA *******
  });

  sessions.set(sessionId, { sock, status: "starting", qr: null, lastMessageTimestamp: 0 });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
        // ******* CORRECCIÓN IMPORTANTE: Generar QR accesible *******
        try {
            const dataUrl = await qrcode.toDataURL(qr);
            sessions.get(sessionId).qr = dataUrl;
            sessions.get(sessionId).status = "qr";
            console.log(`🔑 QR generado para sesión: ${sessionId}. Accede a /api/session/qr?sessionId=${sessionId}`);
        } catch (qrErr) {
            console.error("Error generando QR DataURL:", qrErr);
            sessions.get(sessionId).status = "error_qr";
        }
    }

    if (connection === "open") {
      sessions.get(sessionId).qr = null; // El QR ya no es necesario
      sessions.get(sessionId).status = "connected";
      console.log("✅ WhatsApp conectado:", sessionId);
      await saveCreds();
      
      // Guardar la vinculación en users_data.json
      const userData = loadUserData();
      userData[sessionId] = {
          status: "connected",
          timestamp: new Date().toISOString(),
          jid: sock.user.id 
      };
      saveUserData(userData);
      
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      sessions.get(sessionId).status = "disconnected";
      
      // ******* MEJORA DE RECONEXIÓN *******
      // Intenta reconectar a menos que sea un cierre por LOGGED_OUT (cierre explícito de WhatsApp).
      if (reason !== DisconnectReason.loggedOut) {
        console.log(`Reconectando (${sessionId}) por razón: ${reason || "desconocida"}...`);
        // Se usa una reconexión exponencial con límite de tiempo para evitar ciclos infinitos.
        setTimeout(() => createAndConnectSocket(sessionId), 5000 + Math.random() * 5000); // Espera aleatoria de 5 a 10s
      } else {
        console.log("Sesión cerrada por desconexión del usuario (Logged Out).");
        sessions.delete(sessionId);
        fs.rmSync(sessionDir, { recursive: true, force: true });
        
        // Eliminar de users_data.json
        const userData = loadUserData();
        delete userData[sessionId];
        saveUserData(userData);
      }
    }
  });

  sock.ev.on("call", async (calls) => {
    for (const call of calls) {
      if (call.status === 'offer' || call.status === 'ringing') {
        try {
          await sock.rejectCall(call.id, call.from);
          await sock.sendMessage(call.from, { text: "Hola, soy un asistente virtual y solo atiendo por mensaje de texto. Por favor, escribe tu consulta por aquí." });
        } catch (error) {
          console.error("Error al rechazar la llamada:", error);
        }
      }
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    resetInactivityTimer(); 
    
    for (const msg of m.messages || []) {
      if (!msg.message || msg.key.fromMe) continue;
      
      const from = msg.key.remoteJid;
      const customerNumber = from;
      
      let body = "";
      // Lógica simplificada de obtención de cuerpo del mensaje
      if (msg.message.conversation) {
        body = msg.message.conversation;
      } else if (msg.message.extendedTextMessage?.text) {
        body = msg.message.extendedTextMessage.text;
      }
      
      if (!body) continue;

      // Lógica de comandos de administrador (simplificado)
      if (from.startsWith(process.env.ADMIN_WA_NUMBER_1) || from.startsWith(process.env.ADMIN_WA_NUMBER_2)) {
          if (body.toLowerCase() === '!pausa') {
              botPaused = true;
              await sock.sendMessage(from, { text: "🤖 Bot en *PAUSA* (solo responde comandos admin)." });
              continue;
          } else if (body.toLowerCase() === '!reanudar') {
              botPaused = false;
              await sock.sendMessage(from, { text: "🤖 Bot *REANUDADO* y listo para atender clientes." });
              continue;
          }
      }


      if (botPaused) return;
      
      // Lógica de Venta Automática (SIN IA - Prioridad Máxima)
      if (checkMatch(body, VENTA_PATTERNS)) {
          await sock.sendMessage(from, { text: VENTA_RESPONSE });
          continue; 
      }

      // Lógica de Pago Automático (SIN IA - Prioridad Máxima)
      let paqueteElegido = null;
      const lowerCaseBody = body.toLowerCase().trim();

      for (const [key, value] of Object.entries(PACKAGES)) {
          if (lowerCaseBody === key || checkMatch(body, [`paquete de ${key}`, `${key} soles`, `${value.credits} creditos`])) {
              paqueteElegido = value;
              break;
          }
      }

      if (paqueteElegido || checkMatch(body, PAGO_PATTERNS)) {
          if (!paqueteElegido) {
              await sock.sendMessage(from, { text: `Para darte los datos de pago, por favor, *indica el monto exacto* (10, 20, 50, 100 o 200) que deseas comprar. ¡Así te envío el QR al toque! 😉` });
              continue;
          }
          
          try {
              // Cargar la imagen del QR (usando la URL de entorno)
              const qrImageBuffer = await axios.get(QR_IMAGE_URL, { responseType: 'arraybuffer' });
              const qrImage = Buffer.from(qrImageBuffer.data, 'binary');

              // Generar el mensaje de texto
              const textMessage = YAPE_PAYMENT_PROMPT
                  .replace('{{monto}}', paqueteElegido.amount)
                  .replace('{{creditos}}', paqueteElegido.credits);
              
              // Enviar la imagen y el texto en un solo mensaje
              await sock.sendMessage(from, {
                  image: qrImage,
                  caption: textMessage
              });
              continue; 
          } catch (error) {
              console.error("Error al enviar el mensaje con QR:", error.message);
              // ******* MEJORA DE MENSAJE DE ERROR *******
              // Si falla al cargar la imagen, se envía solo el texto para no detener el flujo.
              if (paqueteElegido) {
                  const fallbackText = YAPE_PAYMENT_PROMPT
                      .replace('{{monto}}', paqueteElegido.amount)
                      .replace('{{creditos}}', paqueteElegido.credits)
                      .concat(`\n\n⚠️ *Aviso:* No se pudo cargar el QR. Si necesitas el QR, intenta más tarde o solicita a un administrador.`);
                  await sock.sendMessage(from, { text: fallbackText });
              } else {
                  await sock.sendMessage(from, { text: "Lo siento, hubo un problema al generar los datos de pago. Por favor, contacta a soporte si el problema persiste." });
              }
              continue;
          }
      }
      
      // Lógica de "comprobante de pago" y reenvío a admin (ASUMIDA AQUÍ)
      if (msg.message.imageMessage || body.toLowerCase().includes("comprobante") || body.toLowerCase().includes("pago realizado")) {
          // Si es un comprobante, reenviar a admins
          // (Aquí iría la lógica completa de detección de imágenes y reenvío)
          await forwardToAdmins(sock, `Posible comprobante de pago: ${body}`, customerNumber, "COMPROBANTE");
          await sock.sendMessage(from, { text: "¡Recibido! Estamos verificando tu pago. En breve, un administrador te confirmará la activación de tus créditos. Por favor, espera unos minutos. ⏳" });
          continue;
      }
      
      // ------------------- LÓGICA DE IA (si no hubo coincidencia local/venta) -------------------
      // Aquí iría la llamada a la IA si no se ha resuelto el mensaje localmente.
      // const aiResponse = await consumirGemini(body, from, userStates);
      // await sock.sendMessage(from, { text: aiResponse });
      await sock.sendMessage(from, { text: welcomeMessage });
    }
  });

  return sock;
};

// ------------------- Endpoints -------------------

app.get("/api/health", (req, res) => {
    resetInactivityTimer();
    // Muestra el estado de la primera sesión para el health check
    const firstSessionId = Object.keys(loadUserData())[0];
    const firstSessionStatus = sessions.get(firstSessionId)?.status || "inactive";

    res.json({ 
        ok: true, 
        status: "alive", 
        wa_status: firstSessionStatus,
        time: new Date().toISOString() 
    });
});

app.get("/api/session/create", async (req, res) => {
    resetInactivityTimer();
    const sessionId = req.query.sessionId || `main_session_${Date.now()}`;
    
    // Si la sesión existe, no la crees de nuevo, simplemente informa su estado.
    if (sessions.has(sessionId) && sessions.get(sessionId).status !== "disconnected") {
         const currentSession = sessions.get(sessionId);
         return res.json({ ok: true, sessionId, status: currentSession.status, message: "Sesión ya está activa o en proceso." });
    }

    try {
        await createAndConnectSocket(sessionId);
        // Esperar un momento para la generación inicial del QR
        await wait(2000); // Aumento a 2s para dar más tiempo al socket inicial
        const s = sessions.get(sessionId);
        res.json({ 
            ok: true, 
            sessionId, 
            status: s?.status,
            qr_link: s?.status === 'qr' ? `/api/session/qr?sessionId=${sessionId}` : null,
            message: s?.status === 'qr' ? 'Sesión creada. Usa el link o el endpoint /api/session/qr para obtener el QR.' : 'Sesión creada. Esperando conexión (puede demorar un momento).'
        });
    } catch (err) {
         res.status(500).json({ ok: false, error: "Error al crear la sesión: " + err.message });
    }
});

app.get("/api/session/qr", (req, res) => {
    resetInactivityTimer();
    const { sessionId } = req.query;
    if (!sessions.has(sessionId)) return res.status(404).json({ ok: false, error: "Session no encontrada" });
    
    const s = sessions.get(sessionId);
    
    if (s.status === "qr" && s.qr) {
        // Devolver el JSON con la DataURL para que el frontend la renderice.
        res.json({ ok: true, qr: s.qr, status: s.status });
    } else if (s.status === "connected") {
        res.json({ ok: true, qr: null, status: "connected", message: "La sesión ya está vinculada." });
    } else {
        res.json({ ok: true, qr: null, status: s.status, message: "QR no disponible. Estado actual: " + s.status });
    }
});

app.get("/api/session/reset", async (req, res) => {
    resetInactivityTimer();
    const { sessionId } = req.query;
    const sessionDir = path.join(SESSIONS_DIR, sessionId); // Usa el directorio correcto
    try {
      if (sessions.has(sessionId)) {
        const { sock } = sessions.get(sessionId);
        // Usar sock.end() para cerrar la conexión de Baileys de forma limpia
        if (sock) await sock.end(); 
        sessions.delete(sessionId);
        
        // Eliminar de users_data.json
        const userData = loadUserData();
        delete userData[sessionId];
        saveUserData(userData);
      }
      if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
      res.json({ ok: true, message: "Sesión eliminada. Vuelve a crearla para obtener un nuevo QR." });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
});

app.get("/", (req, res) => {
    resetInactivityTimer();
    res.json({ ok: true, msg: "ConsultaPE WA Bot activo 🚀" });
});

// --- ENDPOINT (GET): Reenvío de Nuevo Usuario ---
app.get("/api/webhook/new-user", async (req, res) => {
    resetInactivityTimer();
    const { correo, referido_por } = req.query;
    
    if (!correo) {
        return res.status(400).json({ ok: false, error: "Falta el campo 'correo' en la query." });
    }

    const userData = loadUserData();
    const firstSessionId = Object.keys(userData)[0];
    let activeSession = sessions.get(firstSessionId);
    
    if (!activeSession && firstSessionId) {
        // Intentar reactivar si la sesión está registrada pero no activa en memoria
        console.log(`Intentando reactivar sesión ${firstSessionId} para webhook...`);
        try {
            await createAndConnectSocket(firstSessionId);
            await wait(3000); // Esperar a que intente conectar
            activeSession = sessions.get(firstSessionId);
        } catch (err) {
            console.error("Error al reactivar sesión para webhook:", err);
        }
    }

    if (!activeSession || activeSession.status !== "connected") {
        return res.status(503).json({ ok: false, error: "Bot de WhatsApp no conectado para reenviar." });
    }

    const message = `*🚨 NUEVO REGISTRO EN LA APP 🚨*
*Correo:* ${correo}
*Referido por:* ${referido_por || 'N/A'}

_Acción: Contactar y ofrecer paquete de créditos._`;

    try {
        for (const admin of ADMIN_NUMBERS) {
            if (admin) await activeSession.sock.sendMessage(admin, { text: message });
        }
        res.json({ ok: true, message: "Datos de nuevo usuario reenviados a los encargados." });
    } catch (error) {
        console.error("Error al reenviar datos de nuevo usuario:", error);
        res.status(500).json({ ok: false, error: "Error al enviar mensaje por WhatsApp." });
    }
});

// --- ENDPOINT (GET): Reenvío de Pago Automático ---
app.get("/api/webhook/payment-received", async (req, res) => {
    resetInactivityTimer();
    const data = req.query;
    
    const requiredFields = ["Nombre Titular Yape", "Correo Electrónico", "WhatsApp", "Monto Pagado (S/)", "Estado", "Créditos Otorgados", "Usuario Firebase UID"];
    const missingFields = requiredFields.filter(field => !data[field]);

    if (missingFields.length > 0) {
        return res.status(400).json({ ok: false, error: `Faltan campos obligatorios en la query: ${missingFields.join(', ')}` });
    }
    
    const userData = loadUserData();
    const firstSessionId = Object.keys(userData)[0];
    let activeSession = sessions.get(firstSessionId);

    if (!activeSession && firstSessionId) {
        // Intentar reactivar si la sesión está registrada pero no activa en memoria
        console.log(`Intentando reactivar sesión ${firstSessionId} para webhook...`);
        try {
            await createAndConnectSocket(firstSessionId);
            await wait(3000); // Esperar a que intente conectar
            activeSession = sessions.get(firstSessionId);
        } catch (err) {
            console.error("Error al reactivar sesión para webhook:", err);
        }
    }

    if (!activeSession || activeSession.status !== "connected") {
        return res.status(503).json({ ok: false, error: "Bot de WhatsApp no conectado para reenviar." });
    }

    const message = `*✅ PAGO RECIBIDO AUTOMÁTICAMENTE ✅*

*Titular:* ${data["Nombre Titular Yape"]}
*Monto:* S/${data["Monto Pagado (S/)"]}
*Créditos:* ${data["Créditos Otorgados"]}
*Estado:* ${data["Estado"]}

*Contacto:* wa.me/${data["WhatsApp"]}
*Correo:* ${data["Correo Electrónico"]}
*UID:* ${data["Usuario Firebase UID"]}
*Fecha Pago:* ${data["Fecha Pago"] || 'N/A'}
*Fecha Registro App:* ${data["Fecha Registro App"] || 'N/A'}
*ID:* ${data["ID"] || 'N/A'}`;

    try {
        for (const admin of ADMIN_NUMBERS) {
            if (admin) await activeSession.sock.sendMessage(admin, { text: message });
        }
        
        res.json({ ok: true, message: "Datos de pago reenviados y procesados." });
    } catch (error) {
        console.error("Error al reenviar datos de pago:", error);
        res.status(500).json({ ok: false, error: "Error al enviar mensaje por WhatsApp." });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server en puerto ${PORT}`));
