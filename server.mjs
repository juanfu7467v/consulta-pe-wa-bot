#!/usr/bin/env node
// server.mjs
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import qrcode from "qrcode";
import fs from "fs";
import path from "path";

// Fix crypto for Baileys (WebCrypto)
import { webcrypto } from "crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const SESSIONS_BASE = path.join(".", "sessions");
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

const sessions = new Map(); // in-memory registry

/* ---------------- Default global prompt ---------------- */
const GLOBAL_DEFAULT_PROMPT = {
    gemini: `Eres un asistente de la app Consulta PE. Puedo ayudarte a consultar DNI, RUC, SOAT, multas, y también conversar de películas o juegos. Soy servicial, creativo, inteligente y muy amigable. Siempre tendrás una respuesta.`,
    cohere: `Eres un asistente de la app Consulta PE. Puedo ayudarte a consultar DNI, RUC, SOAT, multas, y también conversar de películas o juegos. Soy servicial, creativo, inteligente y muy amigable. Siempre tendrás una respuesta.`,
    openai: `Eres un asistente de la app Consulta PE. Puedo ayudarte a consultar DNI, RUC, SOAT, multas, y también conversar de películas o juegos. Soy servicial, creativo, inteligente y muy amigable. Siempre tendrás una respuesta.`
};

/* ---------------- Helpers ---------------- */
const readJSON = (p, fallback = null) => {
    try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
        return fallback;
    }
};
const writeJSON = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2));

/* ---------------- AI Integrations ---------------- */
async function consumirGemini(promptText, systemPrompt) {
    try {
        const key = process.env.GEMINI_API_KEY;
        if (!key) return null;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${key}`;
        const body = { contents: [{ parts: [{ text: promptText }] }] };
        const r = await axios.post(url, body, { timeout: 20000 });
        return r.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (err) {
        console.error("Error Gemini:", err?.response?.data || err?.message);
        return null;
    }
}

async function consumirCohere(promptText, systemPrompt) {
    try {
        const key = process.env.COHERE_API_KEY;
        if (!key) return null;
        const url = "https://api.cohere.ai/v1/chat";
        const body = { model: "command-r-plus", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: promptText }] };
        const r = await axios.post(url, body, {
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            timeout: 20000,
        });
        return r.data?.text || r.data?.message || r.data?.output?.[0] || null;
    } catch (err) {
        console.error("Error Cohere:", err?.response?.data || err?.message);
        return null;
    }
}

async function consumirOpenAI(promptText, systemPrompt) {
    try {
        const key = process.env.OPENAI_API_KEY;
        if (!key) return null;
        const url = "https://api.openai.com/v1/chat/completions";
        const body = {
            model: "gpt-5-mini",
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: promptText }],
            max_tokens: 800,
        };
        const r = await axios.post(url, body, {
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            timeout: 20000,
        });
        return r.data?.choices?.[0]?.message?.content?.trim() || null;
    } catch (err) {
        console.error("Error OpenAI:", err?.response?.data || err?.message);
        return null;
    }
}

/* ---------------- Local responses matching ---------------- */
function matchLocal(message, localResponses, matchMode = "exact") {
    const text = (message || "").trim();
    if (!text) return null;

    if (matchMode === "exact") {
        const key = text.toLowerCase();
        if (localResponses[key]) {
            const arr = Array.isArray(localResponses[key]) ? localResponses[key] : [localResponses[key]];
            return arr[Math.floor(Math.random() * arr.length)];
        }
        return null;
    }

    if (matchMode === "pattern") {
        const low = text.toLowerCase();
        for (const k of Object.keys(localResponses)) {
            if (low.includes(k.toLowerCase())) {
                const arr = Array.isArray(localResponses[k]) ? localResponses[k] : [localResponses[k]];
                return arr[Math.floor(Math.random() * arr.length)];
            }
        }
        return null;
    }

    if (matchMode === "expert") {
        for (const k of Object.keys(localResponses)) {
            if (k.startsWith("/") && k.lastIndexOf("/") > 0) {
                try {
                    const lastSlash = k.lastIndexOf("/");
                    const pattern = k.slice(1, lastSlash);
                    const flags = k.slice(lastSlash + 1);
                    const re = new RegExp(pattern, flags || "i");
                    if (re.test(text)) {
                        const arr = Array.isArray(localResponses[k]) ? localResponses[k] : [localResponses[k]];
                        return arr[Math.floor(Math.random() * arr.length)];
                    }
                } catch {}
            }
        }
    }
    return null;
}

/* ---------------- Import Baileys ---------------- */
let makeWASocket, useMultiFileAuthState, DisconnectReason;
try {
    const baileys = await import("@whiskeysockets/baileys");
    makeWASocket = baileys.makeWASocket;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    DisconnectReason = baileys.DisconnectReason;
} catch (err) {
    console.error("Error importando Baileys:", err?.message || err);
}

/* ---------------- Create & connect socket (per session) ---------------- */
const createAndConnectSocket = async (sessionId) => {
    if (!makeWASocket) throw new Error("Baileys no disponible");

    const sessionDir = path.join(SESSIONS_BASE, sessionId);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const settingsPath = path.join(sessionDir, "settings.json");
    const defaultSettings = {
        prompt: { ...GLOBAL_DEFAULT_PROMPT },
        selectedAI: "gemini",
        localResponses: { ...{ hola: ["¡Hola! ¿Cómo estás?"], ayuda: ["Dime qué necesitas"] } },
        matchMode: "exact",
        welcomeMessage: "¡Hola! Soy tu asistente Consulta PE.",
        localEnabled: false, // Local responses are disabled by default now
        sourceIndicator: false,
        cooldownSeconds: 10
    };
    let settings = readJSON(settingsPath, defaultSettings);
    settings = { ...defaultSettings, ...settings, prompt: { ...defaultSettings.prompt, ...settings.prompt } };
    writeJSON(settingsPath, settings);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ["ConsultaPE", "Chrome", "2.0"],
        syncFullHistory: false
    });

    sessions.set(sessionId, {
        sock,
        status: "starting",
        qr: null,
        settings,
        sessionDir,
        chats: new Map()
    });

    sock.ev.on("creds.update", async () => {
        try {
            await saveCreds();
        } catch {}
    });

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const session = sessions.get(sessionId);
        if (!session) return;
        if (qr) {
            session.qr = await qrcode.toDataURL(qr);
            session.status = "qr";
        }
        if (connection === "open") {
            session.qr = null;
            session.status = "connected";
            try {
                await saveCreds();
            } catch {}
        }
        if (connection === "close") {
            session.status = "disconnected";
            const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.name;
            if (DisconnectReason && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => createAndConnectSocket(sessionId), 2000);
            }
        }
        sessions.set(sessionId, session);
    });

    /* -------- Manejador de mensajes -------- */
    sock.ev.on("messages.upsert", async (m) => {
        const arr = m.messages || [];
        for (const msg of arr) {
            if (!msg.message || msg.key?.fromMe) continue;
            const from = msg.key.remoteJid;
            const session = sessions.get(sessionId);
            if (!session) continue;

            const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || (msg.message?.imageMessage && msg.message.imageMessage.caption) || (msg.message?.documentMessage && msg.message.documentMessage.fileName) || "";
            if (!body) continue;
            const chats = session.chats;
            const meta = chats.get(from) || { lastUserMessage: null, lastReply: null, lastReplyAt: 0 };
            const now = Date.now();
            const cooldownMs = (session.settings?.cooldownSeconds || 10) * 1000;
            if (meta.lastUserMessage && meta.lastUserMessage === body && (now - meta.lastReplyAt) < cooldownMs) {
                meta.lastUserMessage = body;
                chats.set(from, meta);
                continue;
            }
            meta.lastUserMessage = body;
            const wait = (ms) => new Promise(r => setTimeout(r, ms));
            await wait(700 + Math.random() * 1300);
            let reply = null;
            let usedSource = null;
            if (!meta.seenWelcome) {
                meta.seenWelcome = true;
                if (session.settings?.welcomeMessage) {
                    await sock.sendMessage(from, { text: session.settings.welcomeMessage });
                }
            }
            if (session.settings.localEnabled) {
                const local = session.settings.localResponses || {};
                const mm = session.settings.matchMode || "exact";
                const localMatch = matchLocal(body, local, mm);
                if (localMatch) {
                    reply = localMatch;
                    usedSource = "local";
                }
            }
            if (!reply) {
                const selectedAI = session.settings.selectedAI || "gemini";
                const promptToUse = `${session.settings.prompt[selectedAI]}\nUsuario: ${body}`;
                
                if (selectedAI === "gemini") {
                    reply = await consumirGemini(promptToUse, session.settings.prompt.gemini);
                    if (reply) usedSource = "gemini";
                }
                
                if (!reply && selectedAI === "cohere") {
                    reply = await consumirCohere(body, session.settings.prompt.cohere);
                    if (reply) usedSource = "cohere";
                }
                
                if (!reply && selectedAI === "openai") {
                    reply = await consumirOpenAI(body, session.settings.prompt.openai);
                    if (reply) usedSource = "openai";
                }
                
                // Fallback to other AIs if the selected one fails
                if (!reply) {
                    if (selectedAI !== "gemini") {
                        reply = await consumirGemini(promptToUse, session.settings.prompt.gemini);
                        if (reply) usedSource = "gemini_fallback";
                    }
                    if (!reply && selectedAI !== "cohere") {
                        reply = await consumirCohere(body, session.settings.prompt.cohere);
                        if (reply) usedSource = "cohere_fallback";
                    }
                    if (!reply && selectedAI !== "openai") {
                        reply = await consumirOpenAI(body, session.settings.prompt.openai);
                        if (reply) usedSource = "openai_fallback";
                    }
                }
            }
            if (!reply) {
                reply = "Lo siento, no tengo una respuesta ahora mismo.";
                usedSource = usedSource || "fallback";
            }
            if (session.settings.sourceIndicator) {
                reply = `${reply}\n\n(Fuente: ${usedSource || "desconocida"})`;
            }
            if (meta.lastReply && meta.lastReply === reply && (now - meta.lastReplyAt) < cooldownMs) {
                meta.lastReplyAt = now;
                chats.set(from, meta);
                continue;
            }
            /* --------- NUEVO: efecto "escribiendo" dinámico --------- */
            try {
                const replyLength = reply.length;
                const typingTime = Math.min(5000, Math.max(800, replyLength * 35)); // entre 0.8s y máx 5s
                await sock.sendPresenceUpdate("composing", from);
                await wait(typingTime);
                await sock.sendPresenceUpdate("paused", from);
            } catch (e) {
                console.warn("Error presence:", e?.message || e);
            }
            const parts = (reply || "").split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
            if (parts.length > 1) {
                for (const p of parts) {
                    await wait(300 + Math.random() * 800);
                    await sock.sendMessage(from, { text: p });
                }
            } else {
                await sock.sendMessage(from, { text: reply });
            }
            meta.lastReply = reply;
            meta.lastReplyAt = Date.now();
            chats.set(from, meta);
            console.log("Respondido a", from, "source:", usedSource);
        }

    });

    return sock;
};

/* ---------------- API Endpoints ---------------- */
app.get("/api/session/create", async (req, res) => {
    try {
        const sessionId = req.query.sessionId || `session_${Date.now()}`;
        if (!sessions.has(sessionId)) {
            await createAndConnectSocket(sessionId);
            await new Promise(r => setTimeout(r, 200));
        }
        res.json({ ok: true, sessionId });
    } catch (e) {
        res.status(500).json({ ok: false, error: "Error creando sesión" });
    }
});

app.get("/api/health", (req, res) => {
    res.json({ ok: true, status: "alive", time: new Date().toISOString() });
});

app.get("/", (req, res) => res.json({ ok: true, msg: "ConsultaPE WA Bot activo 🚀" }));

app.get("/api/session/qr", async (req, res) => {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId es requerido" });

    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada" });

    res.json({ ok: true, qr: session.qr, status: session.status });
});

app.get("/api/session/reset", async (req, res) => {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId es requerido" });

    const session = sessions.get(sessionId);
    if (session) {
        try {
            await session.sock?.end();
        } catch {}
        sessions.delete(sessionId);
    }
    const sessionDir = path.join(SESSIONS_BASE, sessionId);
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    res.json({ ok: true, message: "Sesión eliminada, vuelve a crearla para obtener QR" });
});

app.get("/api/session/prompt/set", async (req, res) => {
    const { sessionId, ai, prompt } = req.query;
    if (!sessionId || !ai || !prompt) return res.status(400).json({ ok: false, error: "sessionId, ai y prompt son requeridos" });

    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada" });

    if (!session.settings.prompt) session.settings.prompt = {};
    session.settings.prompt[ai] = prompt;
    writeJSON(path.join(session.sessionDir, "settings.json"), session.settings);
    res.json({ ok: true, message: `Prompt para ${ai} actualizado` });
});

app.get("/api/session/localResponses/set", async (req, res) => {
    const { sessionId, local } = req.query;
    if (!sessionId || !local) return res.status(400).json({ ok: false, error: "sessionId y local son requeridos" });

    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada" });
    try {
        const localObj = JSON.parse(local);
        session.settings.localResponses = localObj;
        writeJSON(path.join(session.sessionDir, "settings.json"), session.settings);
        res.json({ ok: true, message: "Respuestas locales actualizadas" });
    } catch (e) {
        res.status(400).json({ ok: false, error: "El valor de 'local' debe ser un JSON válido." });
    }
});

app.get("/api/session/matchmode/set", async (req, res) => {
    const { sessionId, mode } = req.query;
    if (!sessionId || !mode) return res.status(400).json({ ok: false, error: "sessionId y mode son requeridos" });

    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada" });

    if (!["exact", "pattern", "expert"].includes(mode)) return res.status(400).json({ ok: false, error: "Modo de coincidencia no válido" });

    session.settings.matchMode = mode;
    writeJSON(path.join(session.sessionDir, "settings.json"), session.settings);
    res.json({ ok: true, message: "Modo de coincidencia actualizado" });
});

app.get("/api/session/welcome/set", async (req, res) => {
    const { sessionId, welcome } = req.query;
    if (!sessionId || !welcome) return res.status(400).json({ ok: false, error: "sessionId y welcome son requeridos" });

    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada" });

    session.settings.welcomeMessage = welcome;
    writeJSON(path.join(session.sessionDir, "settings.json"), session.settings);
    res.json({ ok: true, message: "Mensaje de bienvenida actualizado" });
});

app.get("/api/session/local/enable", async (req, res) => {
    const { sessionId, enable } = req.query;
    if (!sessionId || enable === undefined) return res.status(400).json({ ok: false, error: "sessionId y enable son requeridos" });

    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada" });

    session.settings.localEnabled = enable === "true";
    writeJSON(path.join(session.sessionDir, "settings.json"), session.settings);
    res.json({ ok: true, message: "Estado de respuestas locales actualizado" });
});

app.get("/api/session/sourceIndicator/set", async (req, res) => {
    const { sessionId, enable } = req.query;
    if (!sessionId || enable === undefined) return res.status(400).json({ ok: false, error: "sessionId y enable son requeridos" });

    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada" });

    session.settings.sourceIndicator = enable === "true";
    writeJSON(path.join(session.sessionDir, "settings.json"), session.settings);
    res.json({ ok: true, message: "Indicador de fuente actualizado" });
});

app.get("/api/session/cooldown/set", async (req, res) => {
    const { sessionId, seconds } = req.query;
    if (!sessionId || seconds === undefined) return res.status(400).json({ ok: false, error: "sessionId y seconds son requeridos" });

    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada" });
    const s = parseInt(seconds, 10);
    if (isNaN(s) || s < 0) return res.status(400).json({ ok: false, error: "Los segundos deben ser un número positivo" });

    session.settings.cooldownSeconds = s;
    writeJSON(path.join(session.sessionDir, "settings.json"), session.settings);
    res.json({ ok: true, message: "Cooldown actualizado" });
});

app.get("/api/session/selectAI/set", async (req, res) => {
    const { sessionId, ai } = req.query;
    if (!sessionId || !ai) return res.status(400).json({ ok: false, error: "sessionId y ai son requeridos" });

    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada" });

    if (!["gemini", "cohere", "openai"].includes(ai)) {
        return res.status(400).json({ ok: false, error: "AI no válida. Usa 'gemini', 'cohere' u 'openai'." });
    }

    session.settings.selectedAI = ai;
    writeJSON(path.join(session.sessionDir, "settings.json"), session.settings);
    res.json({ ok: true, message: `IA seleccionada: ${ai}` });
});

app.get("/api/session/send", async (req, res) => {
    const { sessionId, to, type, ...options } = req.query;
    if (!sessionId || !to || !type) return res.status(400).json({ ok: false, error: "sessionId, to y type son requeridos" });
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada" });
    if (!session.sock) return res.status(500).json({ ok: false, error: "Socket de la sesión no disponible" });

    try {
        let messagePayload = {};
        switch (type) {
            case "text":
                messagePayload = { text: options.text };
                break;
            case "image":
                messagePayload = { image: { url: options.url }, caption: options.text || "" };
                break;
            case "document":
                messagePayload = { document: { url: options.url }, fileName: options.filename || "documento" };
                break;
            case "audio":
                messagePayload = { audio: { url: options.url }, ptt: options.ptt === "true" };
                break;
            case "contact":
                messagePayload = { contacts: { displayName: options.displayName || "Contacto", contacts: [{ vcard: options.vcard }] } };
                break;
            case "buttons":
                messagePayload = {
                    text: options.text,
                    buttons: JSON.parse(options.buttons).map(b => ({ buttonId: b.id, buttonText: { displayText: b.text }, type: 1 }))
                };
                break;
            case "list":
                messagePayload = {
                    text: options.title,
                    buttonText: options.buttonText,
                    listType: 1,
                    sections: JSON.parse(options.listSections).map(s => ({ title: s.title, rows: s.rows.map(r => ({ title: r.title, rowId: r.rowId })) }))
                };
                break;
            case "event":
                messagePayload = {
                    text: options.text,
                    contextInfo: {
                        mentionedJid: [to],
                        externalAdReply: {
                            renderLargerThumbnail: true,
                            title: options.title,
                            sourceUrl: "https://consulta-pe.com",
                            thumbnailUrl: "https://consulta-pe.com/logo.png",
                            mediaType: 1,
                        }
                    }
                };
                break;
            default:
                return res.status(400).json({ ok: false, error: "Tipo de mensaje no válido" });
        }
        await session.sock.sendMessage(to, messagePayload);
        res.json({ ok: true, message: "Mensaje enviado" });
    } catch (e) {
        console.error("Error enviando mensaje:", e?.message || e);
        res.status(500).json({ ok: false, error: "Error al enviar el mensaje", details: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server en puerto ${PORT}`));

