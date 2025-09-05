// server.mjs
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import axios from 'axios';
import qrcode from 'qrcode';
import { default as makeWASocket, DisconnectReason, useSingleFileAuthState } from '@adiwajshing/baileys';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// ---------------- FIREBASE ----------------
const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
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
    console.error('Error Gemini:', err?.response?.data || err.message);
    return null;
  }
};

// ---------------- Baileys session manager ----------------
// Guardamos sockets en memoria para cada userId
const sockets = new Map();

// Guarda authState en Firestore (serializado) y carga
const authCollection = db.collection('wa_auth'); // doc per userId

const saveAuthStateToFirestore = async (userId, state) => {
  await authCollection.doc(userId).set({ state }, { merge: true });
};

const loadAuthStateFromFirestore = async (userId) => {
  const doc = await authCollection.doc(userId).get();
  if (!doc.exists) return null;
  return doc.data().state || null;
};

// Crear y conectar socket para un userId
const createAndConnectSocket = async (userId) => {
  if (sockets.has(userId)) return sockets.get(userId);

  // Intentar cargar auth state desde Firestore
  const storedState = await loadAuthStateFromFirestore(userId);

  // Baileys permite usar useSingleFileAuthState; pero aquí implementamos un wrapper simple
  // para in-memory auth que sincronizamos con Firestore manualmente.
  const { state, saveState } = useSingleFileAuthState(`/tmp/${userId}.json`);

  // If Firestore had state, overwrite file state
  if (storedState) {
    try {
      // write to /tmp file
      const fs = await import('fs');
      fs.writeFileSync(`/tmp/${userId}.json`, JSON.stringify(storedState));
    } catch (e) {
      console.warn('No pude escribir tmp auth file:', e.message);
    }
  }

  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('creds.update', async () => {
    try {
      saveState();
      // read file and save to firestore
      const fs = await import('fs');
      const data = fs.readFileSync(`/tmp/${userId}.json`, 'utf8');
      await saveAuthStateToFirestore(userId, JSON.parse(data));
    } catch (e) {
      console.error('Error guardando auth state:', e.message);
    }
  });

  // listen for connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      // guardar QR en Firestore como dataUri para frontend
      const dataUrl = await qrcode.toDataURL(qr);
      await db.collection('sessions').doc(userId).set({ qr: dataUrl, status: 'qr' }, { merge: true });
    }

    if (connection === 'open') {
      console.log('WhatsApp conectado para', userId);
      await db.collection('sessions').doc(userId).set({ qr: null, status: 'connected', connectedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }

    if (lastDisconnect?.error) {
      const code = lastDisconnect.error?.output?.statusCode || null;
      console.log('lastDisconnect code', code);
      await db.collection('sessions').doc(userId).set({ status: 'disconnected', lastDisconnect: JSON.stringify(lastDisconnect) }, { merge: true });
      // cleanup local socket
      if (sockets.has(userId)) {
        try { sockets.get(userId).end(); } catch(e){}
        sockets.delete(userId);
      }
    }
  });

  // Mensajes entrantes
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const messages = m.messages || [];
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue; // ignorar propios
        const from = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message?.extendedTextMessage?.text || '';

        // Buscar usuario asociado a este socket
        const userSnapshot = await db.collection('usuarios').where('phoneNumberId', '==', sock.user?.id || null).get();

        // Fallback: try to find by userId mapping (we store sessions doc)
        const sessionDoc = await db.collection('sessions').doc(userId).get();
        const ownerId = sessionDoc.exists ? sessionDoc.data().ownerId : null;
        const userDoc = ownerId ? await db.collection('usuarios').doc(ownerId).get() : null;
        const user = userDoc ? { id: userDoc.id, ...userDoc.data() } : null;

        // Validar planes como en tu server anterior
        if (user) {
          const now = new Date();
          if (user.tipoPlan === 'gratis') {
            const exp = user.expiraSesion ? user.expiraSesion.toDate() : null;
            if (!exp || now > exp) return; // no responder
          }
          if (user.tipoPlan === 'creditos') {
            if (!user.creditos || user.creditos <= 0) return; // sin creditos
            // descontar
            await db.collection('usuarios').doc(user.id).update({ creditos: admin.firestore.FieldValue.increment(-1) });
          }
        }

        // Generar respuesta con Gemini
        const reply = await consumirGemini(text || 'Hola');

        // Enviar respuesta
        await sock.sendMessage(from, { text: reply || 'Lo siento, no pude generar respuesta.' });

        // Guardar en historial
        const histRef = db.collection('usuarios').doc(user?.id || 'unknown').collection('chats');
        await histRef.add({ from, text, reply, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    } catch (e) {
      console.error('Error procesando mensaje upsert:', e.message);
    }
  });

  sockets.set(userId, sock);
  return sock;
};

// ---------------- API endpoints ----------------

// Registro simple (crea user con plan gratis)
app.post('/api/register', async (req, res) => {
  try {
    const { email, nombre } = req.body;
    if (!email) return res.status(400).json({ ok: false, error: 'Falta email' });
    const newUserRef = db.collection('usuarios').doc();
    const apiKey = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    const usuario = {
      email,
      nombre: nombre || null,
      apiKey,
      tipoPlan: 'gratis',
      creditos: 0,
      expiraSesion: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 6 * 60 * 60 * 1000)), // 6h
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await newUserRef.set(usuario);
    res.json({ ok: true, id: newUserRef.id, apiKey });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Error creando usuario' });
  }
});

// Crear sesión Baileys y devolver id de sesión
app.post('/api/session/create', async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey) return res.status(400).json({ ok: false, error: 'Falta apiKey' });

    const snapshot = await db.collection('usuarios').where('apiKey', '==', apiKey).get();
    if (snapshot.empty) return res.status(403).json({ ok: false, error: 'apiKey inválida' });
    const userDoc = snapshot.docs[0];
    const userId = userDoc.id;

    // guardar sesión básica
    await db.collection('sessions').doc(userId).set({ ownerId: userId, status: 'starting', createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    // crea y conecta socket
    await createAndConnectSocket(userId);

    res.json({ ok: true, sessionId: userId, message: 'Sesión iniciada. Consulta /api/session/qr?sessionId=' + userId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Error creando sesión' });
  }
});

// Obtener QR para sessionId
app.get('/api/session/qr', async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ ok: false, error: 'Falta sessionId' });
    const doc = await db.collection('sessions').doc(sessionId).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: 'Session no encontrada' });
    const data = doc.data();
    res.json({ ok: true, qr: data.qr || null, status: data.status || 'unknown' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Error al obtener QR' });
  }
});

// Disconnect session
app.post('/api/session/disconnect', async (req, res) => {
  try {
    const { sessionId, masterKey } = req.body;
    if (masterKey !== process.env.MASTER_API_KEY) return res.status(403).json({ ok: false, error: 'Master key inválida' });
    if (!sessionId) return res.status(400).json({ ok: false, error: 'Falta sessionId' });
    if (sockets.has(sessionId)) {
      try { sockets.get(sessionId).end(); } catch(e){}
      sockets.delete(sessionId);
    }
    await db.collection('sessions').doc(sessionId).set({ status: 'disconnected' }, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Error desconectando' });
  }
});

// Endpoint simple para añadir créditos (admin)
app.post('/api/add-credits', async (req, res) => {
  try {
    const { masterKey, userId, credits } = req.body;
    if (masterKey !== process.env.MASTER_API_KEY) return res.status(403).json({ ok: false, error: 'Master key inválida' });
    await db.collection('usuarios').doc(userId).update({ creditos: admin.firestore.FieldValue.increment(credits) });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Error añadiendo creditos' });
  }
});

app.get('/', (req, res) => res.json({ ok: true, mensaje: 'Consulta PE - Wilderbot backend' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server en puerto ${PORT}`));
