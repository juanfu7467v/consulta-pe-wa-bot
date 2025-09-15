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

// ------------------- Gemini -------------------
const GEMINI_PROMPT = process.env.GEMINI_PROMPT || 
`Eres un asistente de IA de Consulta PE App, que envía mensajes automáticos. 
Eres servicial, creativo, inteligente y muy amigable. Siempre das una respuesta.`;

const consumirGemini = async (prompt) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      console.log("GEMINI_API_KEY no está configurada.");
      return null;
    }
    const model = "gemini-1.5-flash"; // Usar el modelo que funciona con tu clave
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
// Objeto JSON correctamente formateado
const respuestasPredefinidas = {
  "bienvenida e información general": "¡Hola, ¿en qué puedo ayudarte? Soy el asistente de la app Consulta PE, y estoy aquí para ayudarte a consultar datos de DNI, RUC, SOAT, y mucho más. Soy servicial, creativo, inteligente y muy amigable. ¡Siempre tendrás una respuesta de mi parte!",
  "comprar créditos": "Hola, crack 👋 Bienvenido al lado premium de Consulta PE.\nElige tu paquete de poder según cuánto quieras desbloquear:\n\nMONTO (S/)     CRÉDITOS\n10                         60\n20                         125\n50                         330\n100                       700\n200                       1500\n\n🎯 Importante: Los créditos no caducan. Lo que compras, es tuyo.\n\n[💰] Medios de pago disponibles:\nYape, lemon cahs, bim.",
  "datos de pago (yape)": "Buena elección, leyenda.\n📲 Yapea al 929 008 609\n📛 Titular: José R. Cubas\n\nCuando lo hagas, mándame el comprobante + tu correo dentro de la app, y te activo los créditos sin perder el tiempo.",
  "ya pagué y no tengo los créditos": "Pago recibido, crack 💸\nGracias por confiar en Consulta PE.\n\n📧 Envíame tu correo registrado en la app y en unos minutos vas a tener los créditos activos.\nNo desesperes, todo está bajo control. 🧠",
  "planes ilimitados": "Consulta sin límites todo el mes a un precio fijo. Elige el que más se acomoda a tus necesidades.\n\nDURACIÓN\n\nPRECIO SUGERIDO\n\nAHORRO ESTIMADO\n\n7 días\n\nS/55\n\n15 días\n\nS/85\n\nS/10\n\n1 mes\n\nS/120\n\nS/20\n\n1 mes y medio\n\nS/165\n\nS/30\n\n2 meses\n\nS/210\n\nS/50\n\n2 meses y medio\n\nS/300\n\nS/37",
  "descarga la app": "Obvio que sí. Aquí tienes los enlaces seguros y sin rodeos:\n\n🔗 Página oficial: https://www.socialcreator.com/consultapeapk\n🔗 Uptodown: https://com-masitaorex.uptodown.com/android\n🔗 Mediafire: https://www.mediafire.com/file/hv0t7opc8x6kejf/app2706889-uk81cm%25281%2529.apk/file\n🔗 APK Pure: https://apkpure.com/p/com.consulta.pe\n\nDescárgala, instálala y úsala como todo un jefe 💪",
  "consultas que no están dentro de la app.": "Claro que sí, máquina 💼\nEl servicio cuesta 5 soles. Haz el pago por Yape al 929008609 a nombre de José R. Cubas.\nDespués mándame el comprobante + el DNI o los datos a consultar, y el equipo se encarga de darte resultados reales. Aquí no jugamos.",
  "métodos de pago": "Te damos opciones como si fueras VIP:\n💰 Yape, Lemon Cash, Bim, PayPal, depósito directo.\n¿No tienes ninguna? Puedes pagar en una farmacia, agente bancario o pedirle el favor a un amigo.\n\n💡 Cuando uno quiere resultados, no pone excusas.",
  "acceso permanente": "Hola 👋 estimado usuario,\n\nEntendemos tu incomodidad. Es completamente válida.\nSe te ofreció acceso hasta octubre de 2025, y no vamos a negar eso. Pero, escúchalo bien: los accesos antiguos fueron desactivados por situaciones que escaparon de nuestras manos.\n¿La diferencia entre otros y nosotros? Que actuamos de inmediato, no esperamos a que el problema creciera. Reestructuramos todo el sistema y aceleramos los cambios estratégicos necesarios para seguir ofreciendo un servicio de nivel.\n\nTodo está respaldado por nuestros Términos y Condiciones, cláusula 11: “Terminación”. Ahí se aclara que podemos aplicar ajustes sin previo aviso cuando la situación lo requiera. Y esta era una de esas situaciones.\n\nEste cambio ya estaba en el mapa. Solo lo adelantamos. Porque nosotros no seguimos al resto: nos adelantamos. Siempre un paso adelante, nunca atrás.\n\nY porque valoramos tu presencia, te vamos a regalar 15 créditos gratuitos para que pruebes sin compromiso nuestros nuevos servicios.\nUna vez los uses, tú decides si quieres seguir en este camino con nosotros. Nadie te obliga. Pero si sabes elegir, sabes lo que conviene.\n\nGracias por seguir apostando por lo que realmente vale.\nEquipo de Soporte – Consulta PE",
  "duración del acceso": "Tus créditos son eternos, pero el acceso a los paquetes premium depende del plan que hayas activado.\n¿Se venció tu plan? Solo lo renuevas, al mismo precio.\n¿Perdiste el acceso? Mándame el comprobante y te lo reactivamos sin drama. Aquí no se deja a nadie atrás.",
  "por qué se paga?": "Porque lo bueno cuesta.\nLos pagos ayudan a mantener servidores, bases de datos y soporte activo.\nCon una sola compra, tienes acceso completo. Y sin límites por cada búsqueda como en otras apps mediocres.",
  "si continua con el mismo problema más de 2 beses": "⚠️ Tranquilo, sé que no obtuviste exactamente lo que esperabas… todavía.\n\nEstoy en fase de mejora constante, aprendiendo y evolucionando, como todo sistema que apunta a ser el mejor. Algunas cosas aún están fuera de mi alcance, pero no por mucho tiempo.\n\nYa envié una alerta directa al encargado de soporte, quien sí o sí te va a contactar para resolver esto como se debe. Aquí no dejamos nada a medias.\n\n💡 Lo importante es que estás siendo atendido y tu caso ya está siendo gestionado. Paciencia... todo lo bueno toma su tiempo, pero te aseguro que la solución está en camino.",
  "problemas con la app": "La app está optimizada, pero si algo no te cuadra, mándanos una captura + explicación rápida.\nTu experiencia nos importa y vamos a dejarla al 100%. 🛠️",
  "agradecimiento": "¡Nos encanta que te encante! 💚\nComparte la app con tus amigos, vecinos o hasta tu ex si quieres. Aquí está el link 👉https://www.socialcreator.com/consultapeapk\n¡Gracias por ser parte de los que sí resuelven!",
  "eliminar cuenta": "¿Te quieres ir? Bueno… no lo entendemos, pero ok.\nAbre tu perfil, entra a “Política de privacidad” y dale a “Darme de baja”.\nEso sí, te advertimos: el que se va, siempre regresa 😏",
  "preguntas fuera de tema": "🚨 Atención, crack:\nSoy el asistente oficial de Consulta PE y estoy diseñado para responder únicamente sobre los servicios que ofrece esta app.\n¿Quieres consultar un DNI, revisar vehículos, empresas, ver películas, saber si alguien está en la PNP o checar un sismo? Entonces estás en el lugar correcto.\nYo te guío. Tú dominas. 😎📲",
  "hola": ["¡Hola! ¿Cómo estás?", "¡Qué gusto saludarte!", "Hola, ¿en qué te ayudo?"],
  "ayuda": ["Claro, dime qué necesitas 🙌", "Estoy para ayudarte ✨", "¿Qué consulta tienes?"],
  "menu": [
    "1️⃣ Consultar DNI\n2️⃣ Consultar RUC\n3️⃣ Consultar SOAT",
    "Selecciona una opción: 1, 2 o 3"
  ],
  "1": ["Has elegido Consultar DNI. Por favor, envíame el número de DNI 🪪"],
  "2": ["Has elegido Consultar RUC. Envíame el RUC 📊"],
  "3": ["Has elegido Consultar SOAT. Envíame la placa 🚗"]
};

function obtenerRespuestaLocal(texto) {
  const key = texto.toLowerCase().trim();
  const respuesta = respuestasPredefinidas[key];
  if (respuesta) {
    return Array.isArray(respuesta) ? respuesta[Math.floor(Math.random() * respuesta.length)] : respuesta;
  }
  return "Lo siento, no entendí 🤔. Escribe 'menu' para ver opciones.";
}

// ------------------- Importar Baileys -------------------
let makeWASocket, useMultiFileAuthState, DisconnectReason;
try {
  const baileysModule = await import("@whiskeysockets/baileys");
  makeWASocket = baileysModule.makeWASocket;
  useMultiFileAuthState = baileysModule.useMultiFileAuthState;
  DisconnectReason = baileysModule.DisconnectReason;
} catch (err) {
  console.error("Error importando Baileys:", err.message || err);
}

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
      if (!body) continue;

      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      await wait(1000 + Math.random() * 2000);

      let reply = null;

      // Intentar con las respuestas locales primero
      const localReply = obtenerRespuestaLocal(body);
      if (localReply !== "Lo siento, no entendí 🤔. Escribe 'menu' para ver opciones.") {
          reply = localReply;
      } else if (process.env.GEMINI_API_KEY) {
          reply = await consumirGemini(body);
      }
      
      if (!reply) {
          reply = "Lo siento, no pude encontrar una respuesta. Por favor, intenta más tarde o escribe 'menu'.";
      }

      if (reply.includes(",")) {
        const partes = reply.split(",").map(p => p.trim());
        for (const p of partes) {
          await wait(800 + Math.random() * 1200);
          await sock.sendMessage(from, { text: p });
        }
      } else {
        await sock.sendMessage(from, { text: reply });
      }
    }
  });

  return sock;
};

// ------------------- Endpoints -------------------
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
  try {
    await s.sock.sendMessage(to, { text });
    res.json({ ok: true, message: "Mensaje enviado ✅" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Resetear sesión
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
