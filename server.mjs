// server.mjs
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";
import axios from "axios";
import qrcode from "qrcode";
import { default as makeWASocket, useSingleFileAuthState } from "@adiwajshing/baileys";

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
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
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
      console.warn("No pude escribir tmp auth file:", e.message);
    }
  }

  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on("creds.update", async () => {
    try {
      saveState();
      const fs = await import("fs");
      const data = fs.readFileSync(`/tmp/${userId}.json`, "utf8");
      await saveAuthStateToFirestore(userId, JSON.parse(data));
    } catch (e) {
      console.error("Error guardando auth state:", e.message);
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      const dataUrl = await qrcode.toDataURL(qr);
      await db
        .collection("sessions")
        .doc(userId)
        .set({ qr: dataUrl, status: "qr" }, { merge: true });
    }

    if (connection === "open") {
      console.log("WhatsApp conectado para", userId);
      await db
        .collection("sessions")
        .doc(userId)
        .set(
          {
            qr: null,
            status: "connected",
            connectedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
    }

    if (lastDisconnect?.error) {
      console.log("Desconectado:", lastDisconnect.error?.message);
      await db
        .collection("sessions")
        .doc(userId)
        .set(
          { status: "disconnected", lastDisconnect: JSON.stringify(lastDisconnect) },
          { merge: true }
        );
      if (sockets.has(userId)) {
        try {
          sockets.get(userId).end();
        } catch (e) {}
        sockets.delete(userId);
      }
    }
  });

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

        const userDoc = await db.collection("usuarios").doc(userId).get();
        const user = userDoc.exists ? { id: userDoc.id, ...userDoc.data() } : null;
        if (!user) return;

        const now = new Date();

        // Validar plan
        if (user.tipoPlan === "gratis") {
          const exp = user.expiraSesion ? user.expiraSesion.toDate() : null;
          if (!exp || now > exp) return;
        } else if (user.tipoPlan === "creditos") {
          if (!user.creditos || user.creditos <= 0) return;
          await db
            .collection("usuarios")
            .doc(user.id)
            .update({ creditos: admin.firestore.FieldValue.increment(-1) });
        } else if (user.tipoPlan === "ilimitado") {
          const fechaActivacion = user.fechaActivacion?.toDate?.() || null;
          if (fechaActivacion) {
            const duracion = user.duracionDias || 0;
            const fechaFin = new Date(fechaActivacion);
            fechaFin.setDate(fechaFin.getDate() + duracion);
            if (now > fechaFin) return;
          }
        }

        const reply = await consumirGemini(text || "Hola");
        await sock.sendMessage(from, {
          text: reply || "Lo siento, no pude generar respuesta.",
        });

        await db
          .collection("usuarios")
          .doc(user.id)
          .collection("chats")
          .add({
            from,
            text,
            reply,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
      }
    } catch (e) {
      console.error("Error procesando mensaje:", e.message);
    }
  });

  sockets.set(userId, sock);
  return sock;
};

// ---------------- API endpoints ----------------

// Middleware para validar MASTER_API_KEY
const validateApiKey = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.MASTER_API_KEY) {
    return res.status(403).json({ ok: false, error: "Acceso denegado" });
  }
  next();
};

// Registro rápido (requiere API Key)
app.post("/api/register", validateApiKey, async (req, res) => {
  try {
    const { email, nombre } = req.body;
    if (!email) return res.status(400).json({ ok: false, error: "Falta email" });

    const newUserRef = db.collection("usuarios").doc();
    const usuario = {
      email,
      nombre: nombre || null,
      tipoPlan: "gratis",
      creditos: 0,
      expiraSesion: admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + 6 * 60 * 60 * 1000)
      ),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await newUserRef.set(usuario);
    res.json({ ok: true, id: newUserRef.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Error creando usuario" });
  }
});

// Crear sesión (requiere API Key)
app.post("/api/session/create", validateApiKey, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ ok: false, error: "Falta userId" });

    const userDoc = await db.collection("usuarios").doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ ok: false, error: "Usuario no encontrado" });

    await db
      .collection("sessions")
      .doc(userId)
      .set(
        { ownerId: userId, status: "starting", createdAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );

    await createAndConnectSocket(userId);

    res.json({ ok: true, sessionId: userId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Error creando sesión" });
  }
});

// Obtener QR (requiere API Key)
app.get("/api/session/qr", validateApiKey, async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ ok: false, error: "Falta sessionId" });

    const doc = await db.collection("sessions").doc(sessionId).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "Session no encontrada" });

    const data = doc.data();
    res.json({ ok: true, qr: data.qr || null, status: data.status || "unknown" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Error al obtener QR" });
  }
});

app.get("/", (req, res) =>
  res.json({ ok: true, mensaje: "Consulta PE - Wilderbot backend protegido con API Key" })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server en puerto ${PORT}`));
