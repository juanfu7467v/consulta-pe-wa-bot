// server.mjs
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";
import axios from "axios";
import qrcode from "qrcode";

// 👇 Importar Baileys correctamente (CommonJS -> ESM)
import baileys from "@whiskeysockets/baileys";
const {
  default: makeWASocket,
  useSingleFileAuthState,
  DisconnectReason,
} = baileys;

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// ---------------- FIREBASE ----------------
const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url:
    process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
  universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN,
};

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ---------------- Helpers Gemini ----------------
const consumirGemini = async (prompt) => {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const body = { contents: [{ parts: [{ text: prompt }] }] };
    const r = await axios.post(url, body);
    return r.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (err) {
    console.error("Error Gemini:", err?.response?.data || err.message);
    return null;
  }
};

// ---------------- Baileys session manager ----------------
const sockets = new Map();
const authCollection = db.collection("wa_auth");

const saveAuthStateToFirestore = async (userId, state) => {
  await authCollection.doc(userId).set({ state }, { merge: true });
};

const loadAuthStateFromFirestore = async (userId) => {
  const doc = await authCollection.doc(userId).get();
  if (!doc.exists) return null;
  return doc.data().state || null;
};

const createAndConnectSocket = async (userId) => {
  if (sockets.has(userId)) return sockets.get(userId);

  const storedState = await loadAuthStateFromFirestore(userId);
  const { state, saveState } = useSingleFileAuthState(`/tmp/${userId}.json`);

  if (storedState) {
    try {
      const fs = await import("fs");
      fs.writeFileSync(`/tmp/${userId}.json`, JSON.stringify(storedState));
    } catch (e) {
      console.warn("No pude escribir tmp auth file:", e?.message);
    }
  }

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
  });

  // 🔴 Rechazar llamadas
  sock.ev.on("call", async (calls) => {
    for (const call of calls) {
      if (call.isGroup) continue;
      await sock.rejectCall(call.id, call.from);
      console.log("Llamada rechazada de:", call.from);
      await sock.sendMessage(call.from, {
        text: "📵 Lo siento, no acepto llamadas en este número.",
      });
    }
  });

  sock.ev.on("creds.update", async () => {
    try {
      await saveState();
      const fs = await import("fs");
      const data = fs.readFileSync(`/tmp/${userId}.json`, "utf8");
      await saveAuthStateToFirestore(userId, JSON.parse(data));
    } catch (e) {
      console.error("Error guardando auth state:", e?.message);
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      const dataUrl = await qrcode.toDataURL(qr);
      await db.collection("sessions").doc(userId).set(
        { qr: dataUrl, status: "qr" },
        { merge: true }
      );
    }

    if (connection === "open") {
      console.log("WhatsApp conectado para", userId);
      await db.collection("sessions").doc(userId).set(
        {
          qr: null,
          status: "connected",
          connectedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        console.log("Reconectando...");
        createAndConnectSocket(userId);
      } else {
        console.log("Sesión cerrada para:", userId);
      }
    }
  });

  // 🔊 Mensajes
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const messages = m.messages || [];
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const from = msg.key.remoteJid;
        const text =
          msg.message.conversation ||
          msg.message?.extendedTextMessage?.text ||
          "";

        console.log("Mensaje recibido:", text);

        const reply = await consumirGemini(text || "Hola");
        await sock.sendMessage(from, {
          text: reply || "🤖 No entendí tu mensaje.",
        });

        await db
          .collection("usuarios")
          .doc(userId)
          .collection("chats")
          .add({
            from,
            text,
            reply,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
      }
    } catch (e) {
      console.error("Error procesando mensaje:", e?.message || e);
    }
  });

  sockets.set(userId, sock);
  return sock;
};

// ---------------- API endpoints ----------------
// ✅ Sesión con API Key en headers
app.post("/api/session/create", async (req, res) => {
  try {
    const token = req.headers["x-api-key"];
    if (!token)
      return res.status(400).json({ ok: false, error: "Token requerido" });

    const snapshot = await db
      .collection("usuarios")
      .where("apiKey", "==", token)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(401).json({ ok: false, error: "Token inválido" });
    }

    const userDoc = snapshot.docs[0];
    const userId = userDoc.id;

    await db
      .collection("sessions")
      .doc(userId)
      .set(
        {
          ownerId: userId,
          status: "starting",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    await createAndConnectSocket(userId);

    res.json({ ok: true, sessionId: userId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Error creando sesión" });
  }
});

// ✅ Obtener QR de sesión
app.get("/api/session/qr", async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId)
      return res.status(400).json({ ok: false, error: "Falta sessionId" });

    const doc = await db.collection("sessions").doc(sessionId).get();
    if (!doc.exists)
      return res.status(404).json({ ok: false, error: "Session no encontrada" });

    const data = doc.data();
    res.json({
      ok: true,
      qr: data.qr || null,
      status: data.status || "unknown",
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Error al obtener QR" });
  }
});

app.get("/", (req, res) =>
  res.json({ ok: true, mensaje: "Consulta PE - Wilderbot backend público" })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server en puerto ${PORT}`));
