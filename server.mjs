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
app.use(express.json());

// --- GESTIÓN DE INACTIVIDAD (Para Fly.io) ---
const INACTIVITY_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutos
let inactivityTimer;

const resetInactivityTimer = () => {
    if (inactivityTimer) {
        clearTimeout(inactivityTimer);
    }
    inactivityTimer = setTimeout(() => {
        console.log(`\n😴 Contenedor inactivo por ${INACTIVITY_TIMEOUT_MS / 60000} minutos. Simulando apagado para ahorro de recursos...\n`);
        // En Fly.io, simplemente no respondes a nuevos requests.
        // Aquí simulamos un exit para detener el proceso, lo que haría que Fly.io lo apague.
        // ¡ADVERTENCIA! Si usas esto localmente, detendrá el proceso. En Fly.io, el proxy
        // se encargará de despertar el contenedor si llega un mensaje de WhatsApp.
        // process.exit(0); 
    }, INACTIVITY_TIMEOUT_MS);
};

// Middleware para resetear el temporizador en cada request
app.use((req, res, next) => {
    resetInactivityTimer();
    next();
});

// Inicializar el temporizador al arrancar
resetInactivityTimer();
// ---------------------------------------------


// Archivo para guardar los datos de las sesiones de WhatsApp
const USERS_DATA_FILE = path.join(process.cwd(), "users_data.json");
if (!fs.existsSync(USERS_DATA_FILE)) {
    fs.writeFileSync(USERS_DATA_FILE, JSON.stringify({}));
}
const loadUserData = () => JSON.parse(fs.readFileSync(USERS_DATA_FILE, "utf-8"));
const saveUserData = (data) => fs.writeFileSync(USERS_DATA_FILE, JSON.stringify(data, null, 2));

const sessions = new Map();
const userStates = new Map(); // Para almacenar el estado de la conversación por usuario

// Estado del bot
let botPaused = false;
let activeAI = process.env.DEFAULT_AI || "gemini";
let welcomeMessage = "¡Hola! ¿Cómo puedo ayudarte hoy?";

// Configuración de prompts, ahora inicializados con el prompt largo y mejorado
let GEMINI_PROMPT = `Instrucciones maestras para el bot Consulta PE... [PROMPT COMPLETO]`; // Dejado truncado por espacio
let COHERE_PROMPT = "";
let OPENAI_PROMPT = "";

// Prompts y datos para el pago (Asegúrate de configurar en .env)
const YAPE_NUMBER = process.env.YAPE_NUMBER || "929008609";
const QR_IMAGE_URL = process.env.LEMON_QR_IMAGE || "https://ejemplo.com/qr.png"; // Debe ser una URL real

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

// Respuestas locales y menús
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

// --- Funciones de Utilidad ---

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

// --- API y Herramientas (omitidas por brevedad, asume que están definidas como en el prompt original) ---
// const geminiVisionApi = ...
// const geminiTextApi = ...
// const googleSpeechToTextApi = ...
// const consumirGemini = ...
// const consumirCohere = ...

// ------------------- Importar Baileys -------------------
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

// ------------------- Utilidades -------------------
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
      
      // Guardar la vinculación en users_data.json
      const userData = loadUserData();
      userData[sessionId] = {
          status: "connected",
          timestamp: new Date().toISOString(),
          // Se asume que el JID del bot es su propio número si está conectado
          jid: sock.user.id 
      };
      saveUserData(userData);

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
    resetInactivityTimer(); // Reiniciar el temporizador al recibir un mensaje
    
    for (const msg of m.messages || []) {
      if (!msg.message || msg.key.fromMe) continue;
      
      const from = msg.key.remoteJid;
      const customerNumber = from;
      
      let body = "";
      // ... (Lógica de obtención de body, transcripción y análisis de imagen omitida)
      // (ASUMIMOS QUE 'body' CONTIENE EL TEXTO DEL CLIENTE)
      
      if (!body) continue;

      // ... (Lógica de comandos de administrador omitida)

      if (botPaused) return;
      
      // Lógica de Venta Automática (SIN IA - Prioridad Máxima)
      if (checkMatch(body, VENTA_PATTERNS)) {
          await sock.sendMessage(from, { text: VENTA_RESPONSE });
          continue; // Detener el procesamiento
      }

      // Lógica de Pago Automático (SIN IA - Prioridad Máxima)
      let paqueteElegido = null;
      const lowerCaseBody = body.toLowerCase().trim();

      // Buscar coincidencia de paquete por monto o nombre
      for (const [key, value] of Object.entries(PACKAGES)) {
          if (lowerCaseBody === key || checkMatch(body, [`paquete de ${key}`, `${key} soles`, `${value.credits} creditos`])) {
              paqueteElegido = value;
              break;
          }
      }

      if (paqueteElegido || checkMatch(body, PAGO_PATTERNS)) {
          // Si hubo coincidencia de patrón de pago pero no se especificó monto, se envía un mensaje genérico.
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
              continue; // Detener el procesamiento
          } catch (error) {
              console.error("Error al enviar el mensaje con QR:", error.message);
              await sock.sendMessage(from, { text: "Lo siento, hubo un problema al generar los datos de pago. Por favor, asegúrate de haber configurado el QR. Si el problema persiste, contacta a soporte." });
              continue;
          }
      }
      
      // ... (Lógica de "comprobante de pago" y reenvío a admin)
      // ... (Lógica de IA si no hubo coincidencia local/venta)
    }
  });

  return sock;
};

// ------------------- Endpoints -------------------

app.get("/api/health", (req, res) => {
    resetInactivityTimer();
    res.json({ ok: true, status: "alive", time: new Date().toISOString() });
});

app.get("/api/session/create", async (req, res) => {
    resetInactivityTimer();
    const sessionId = req.query.sessionId || `session_${Date.now()}`;
    if (!sessions.has(sessionId)) await createAndConnectSocket(sessionId);
    res.json({ ok: true, sessionId });
});

app.get("/api/session/qr", (req, res) => {
    resetInactivityTimer();
    const { sessionId } = req.query;
    if (!sessions.has(sessionId)) return res.status(404).json({ ok: false, error: "Session no encontrada" });
    const s = sessions.get(sessionId);
    res.json({ ok: true, qr: s.qr, status: s.status });
});

app.get("/api/session/reset", async (req, res) => {
    resetInactivityTimer();
    const { sessionId } = req.query;
    const sessionDir = path.join("./sessions", sessionId);
    try {
      if (sessions.has(sessionId)) {
        const { sock } = sessions.get(sessionId);
        if (sock) await sock.end();
        sessions.delete(sessionId);
        
        // Eliminar de users_data.json
        const userData = loadUserData();
        delete userData[sessionId];
        saveUserData(userData);
      }
      if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
      res.json({ ok: true, message: "Sesión eliminada, vuelve a crearla para obtener QR" });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
});

app.get("/", (req, res) => {
    resetInactivityTimer();
    res.json({ ok: true, msg: "ConsultaPE WA Bot activo 🚀" });
});

// --- NUEVO ENDPOINT (GET): Reenvío de Nuevo Usuario ---
app.get("/api/webhook/new-user", async (req, res) => {
    resetInactivityTimer();
    // Usar req.query para obtener datos en un GET
    const { correo, referido_por } = req.query;
    
    if (!correo) {
        return res.status(400).json({ ok: false, error: "Falta el campo 'correo' en la query." });
    }

    // Asegurar que la sesión esté cargada (en Fly.io, se cargaría al despertar)
    const userData = loadUserData();
    const firstSessionId = Object.keys(userData)[0]; // Obtener el ID de la primera sesión guardada
    const session = sessions.get(firstSessionId);
    
    // Si la sesión no está en Map (sesión activa), intentar crearla desde users_data
    if (!session && firstSessionId) {
        console.log(`Intentando reactivar sesión ${firstSessionId}...`);
        await createAndConnectSocket(firstSessionId);
        // Esperar un momento para la conexión
        await wait(2000); 
    }
    const activeSession = sessions.get(firstSessionId);

    if (!activeSession || activeSession.status !== "connected") {
        return res.status(503).json({ ok: false, error: "Bot de WhatsApp no conectado o reactivado para reenviar." });
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

// --- NUEVO ENDPOINT (GET): Reenvío de Pago Automático ---
app.get("/api/webhook/payment-received", async (req, res) => {
    resetInactivityTimer();
    // Usar req.query para obtener datos en un GET
    const data = req.query;
    
    const requiredFields = ["Nombre Titular Yape", "Correo Electrónico", "WhatsApp", "Monto Pagado (S/)", "Estado", "Créditos Otorgados", "Usuario Firebase UID"];
    const missingFields = requiredFields.filter(field => !data[field]);

    if (missingFields.length > 0) {
        // En un GET, es mejor devolver 200 si es un test, o 400 si se espera que la data sea completa
        return res.status(400).json({ ok: false, error: `Faltan campos obligatorios en la query: ${missingFields.join(', ')}` });
    }
    
    // Asegurar que la sesión esté cargada (en Fly.io, se cargaría al despertar)
    const userData = loadUserData();
    const firstSessionId = Object.keys(userData)[0]; // Obtener el ID de la primera sesión guardada
    const session = sessions.get(firstSessionId);

    // Si la sesión no está en Map (sesión activa), intentar crearla desde users_data
    if (!session && firstSessionId) {
        console.log(`Intentando reactivar sesión ${firstSessionId}...`);
        await createAndConnectSocket(firstSessionId);
        // Esperar un momento para la conexión
        await wait(2000); 
    }
    const activeSession = sessions.get(firstSessionId);

    if (!activeSession || activeSession.status !== "connected") {
        return res.status(503).json({ ok: false, error: "Bot de WhatsApp no conectado o reactivado para reenviar." });
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
        // Opcional: Enviar una confirmación al cliente si el número de WhatsApp está en formato JID.
        // await activeSession.sock.sendMessage(`${data["WhatsApp"]}@s.whatsapp.net`, { text: "¡Tu pago ha sido procesado y tus créditos están siendo activados! 🎉" });
        
        res.json({ ok: true, message: "Datos de pago reenviados y procesados." });
    } catch (error) {
        console.error("Error al reenviar datos de pago:", error);
        res.status(500).json({ ok: false, error: "Error al enviar mensaje por WhatsApp." });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server en puerto ${PORT}`));
