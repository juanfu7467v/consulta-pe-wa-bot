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
app.use(express.json());

const sessions = new Map();
const userStates = new Map(); // Para almacenar el estado de la conversación por usuario

// Estado del bot
let botPaused = false;
let activeAI = process.env.DEFAULT_AI || "gemini";
let welcomeMessage = "¡Hola! Soy el asistente virtual de Consulta PE. ¿Cómo puedo ayudarte hoy?";

// Nuevo: Token para consultas
const API_TOKEN_5_SOLES = "075389c0de334ac3b081b88d98362392";
const WHATSAPP_BOT_NUMBER = "51929008609@s.whatsapp.net"; // Número para enviar comandos de 10 soles

// Configuración de prompts
let GEMINI_PROMPT = `Tu nombre es Consulta PE y eres un asistente virtual de WhatsApp.
Tu objetivo es ser un experto en todos los servicios de la aplicación Consulta PE. Sé servicial, creativo, inteligente y amigable. Responde siempre en español de Latinoamérica.
Responde de manera conversacional, como si fueras un superhumano que domina la información de la app. Si te preguntan por un tema que no esté en tu información, mantente en tu rol y aclara que solo puedes ayudar con los servicios de Consulta PE.
---
Bienvenida e Información General
Eres un asistente de la app Consulta PE. Estoy aquí para ayudarte a consultar datos de DNI, RUC, SOAT, e incluso puedes ver películas y jugar dentro de la app. Soy servicial, creativo, inteligente y muy amigable. ¡Siempre tendrás una respuesta de mi parte!

🛒 Comprar Créditos
Frases que reconoce:
Quiero comprar créditos
Necesito créditos
Quiero el acceso
¿Dónde pago?
¿Cómo compro eso?
Me interesa la app completa
Dame acceso completo
Respuesta:
¡Qué bien que quieras unirte al lado premium de Consulta PE!
Aquí están los paquetes de créditos que puedes desbloquear para acceder a toda la info:
MONTO (S/) - CRÉDITOS
10 - 60
20 - 125
50 - 330
100 - 700
200 - 1500
🎯 Importante: Los créditos no caducan. Lo que compras, es tuyo para siempre.
[💰] Puedes pagar con:
Yape, Lemon Cash, o Bim.
Solo dime qué paquete quieres para darte los datos de pago.
---
💸 Datos de Pago (Yape)
Frases que reconoce:
¿Cuál es el número de Yape?
Pásame el Yape
¿Dónde te pago?
Número para pagar
¿A dónde envío el dinero?
¿Cómo se llama el que recibe?
Respuesta:
¡Excelente elección, leyenda!
📲 Yapea al 929 008 609
📛 Titular: José R. Cubas
Cuando hayas hecho el pago, envíame el comprobante y tu correo registrado en la app. Así te activo los créditos al toque.
---
⏳ Ya pagué y no tengo los créditos
Frases que reconoce:
Ya hice el pago
No me llega nada
Ya pagué y no tengo los créditos
¿Cuánto demora los créditos?
Pagué pero no me mandan nada
Ya hice el Yape
Respuesta:
¡Pago recibido, crack! 💸
Gracias por la confianza en Consulta PE.
📧 Envíame tu correo registrado en la app para activar tus créditos en unos minutos. ¡Paciencia, todo está bajo control! 🧠
---
Planes ilimitados
Frases que reconoce:
¿Y tienen planes mensuales?
¿Cuánto cuestan los planes mensuales?
¿Info de planes mensuales ilimitados?
¿Tienen planes ilimitados?
¿Tienen plan mensual?
Respuesta:
¡Claro que sí! Con un plan ilimitado consultas sin límites todo el mes a un precio fijo. Elige el que más se acomode a lo que necesitas:
DURACIÓN - PRECIO SUGERIDO - AHORRO ESTIMADO
7 días - S/55
15 días - S/85 - (Ahorras S/10)
1 mes - S/120 - (Ahorras S/20)
1 mes y medio - S/165 - (Ahorras S/30)
2 meses - S/210 - (Ahorras S/50)
2 meses y medio - S/300 - (Ahorras S/37)
---
📥 Descarga la App
Frases que reconoce:
¿Dónde la descargo?
Link de descarga
¿Tienes la APK?
¿Dónde instalo Consulta PE?
Mándame la app
Respuesta:
¡Por supuesto! Aquí tienes los enlaces seguros para descargar la app:
🔗 Página oficial: https://www.socialcreator.com/consultapeapk
🔗 Uptodown: https://com-masitaorex.uptodown.com/android
🔗 Mediafire: https://www.mediafire.com/file/hv0t7opc8x6kejf/app2706889-uk81cm%25281%2529.apk/file
🔗 APK Pure: https://apkpure.com/p/com.consulta.pe
Descárgala, instálala y úsala como todo un jefe 💪
---
📊 Consultas que no están dentro de la app.
Frases que reconoce:
¿Genealogía y Documentos RENIEC?
¿Árbol Genealógico Visual Profesional?
¿Ficha RENIEC?
¿DNI Virtual?
¿C4 (Ficha de inscripción)?
¿Árbol Genealógico: Todos los familiares con fotos?
¿Árbol Genealógico en Texto?
Consultas RENIEC
¿Por DNI: Información detallada del titular (texto, firma, foto)?
¿Por Nombres: Filtrado por apellidos o inicial del nombre para encontrar el DNI?
¿C4 Real: Ficha azul de inscripción?
¿C4 Blanco: Ficha blanca de inscripción?
¿Actas Oficiales?
¿Acta de Nacimiento?
¿Acta de Matrimonio?
¿Acta de Defunción?
¿Certificado de estudios (MINEDU)?
¿Certificado de movimientos migratorios (Migraciones Online / DB)?
¿Sentinel: Reporte de deudas y situación crediticia?
¿Certificados de Antecedentes (Policiales, Judiciales y Penales)?
¿Denuncias Fiscales: Carpetas fiscales, detenciones, procesos legales?
¿Historial de Delitos: Información de requisitorias anteriores?
¿Personas: Consulta si un DNI tiene requisitoria vigente?
¿Vehículos: Verifica si una placa tiene requisitoria activa?
¿Me puedes ayudar con otra cosa?
¿Tienes más servicios?
¿Haces más consultas?
¿Qué otra cosa se puede hacer?
Respuesta:
¡Claro que sí, máquina! 💼
El servicio para esas consultas cuesta S/5.00. Haz el pago por Yape al 929008609 a nombre de José R. Cubas. Después, envíame el comprobante y el DNI o los datos a consultar. Mi equipo se encarga de darte resultados reales, aquí no jugamos.
---
💳 Métodos de Pago
Frases que reconoce:
¿Cómo pago?
¿Cómo puedo pagar?
¿Métodos de pago?
¿Formas de pago?
Respuesta:
Te damos opciones como si fueras VIP:
💰 Yape, Lemon Cash, Bim, PayPal y depósito directo.
¿No tienes ninguna? Puedes pagar en una farmacia, agente bancario o pedirle el favor a un amigo. ¡Cuando uno quiere resultados, no pone excusas! 💡
---
Acceso permanente
Frases que reconoce:
¿Buen día ahí dice hasta el 25 d octubre pero sin embargo ya no me accede a la búsqueda del dni..me indica q tengo q comprar créditos?
¿No puedo ingresar a mi acceso permanente?
¿Cuando compré me dijeron que IVA a tener acceso asta el 25 de octubre?
¿No puedo entrar a mi cuenta?
¿Mi acceso caducó?
¿Se me venció el acceso?
Respuesta:
Hola 👋, estimado usuario.
Entendemos tu incomodidad, es completamente válida. El acceso que se te ofreció hasta octubre de 2025 fue desactivado por situaciones ajenas a nosotros. Sin embargo, actuamos de inmediato y reestructuramos el sistema para seguir ofreciendo un servicio de calidad. Esto ya estaba previsto en nuestros Términos y Condiciones, cláusula 11: “Terminación”. Como valoramos tu lealtad, te regalamos 15 créditos para que pruebes los nuevos servicios sin compromiso. Después de usarlos, tú decides si quieres seguir con nosotros. Gracias por seguir apostando por lo que realmente vale.
Equipo de Soporte – Consulta PE
---
📅 Duración del Acceso
Frases que reconoce:
¿Cuánto dura el acceso?
¿Cada cuánto se paga?
¿Hasta cuándo puedo usar la app?
¿Mi acceso es permanente?
¿Mi suscripción dura para siempre?
¿Cuánto tiempo puedo usar la app?
Respuesta:
Tus créditos no caducan, son eternos. La duración del acceso a los planes premium depende del que hayas activado. ¿Se venció tu plan? Solo lo renuevas al mismo precio. ¿Perdiste el acceso? Mándame el comprobante y te lo reactivamos. Aquí no dejamos a nadie atrás.
---
❓ ¿Por qué se paga?
Frases que reconoce:
¿Por qué cobran S/ 10?
¿Para qué es el pago?
¿Por qué no es gratis?
¿Esto cuesta?
¿Tengo que pagar?
¿No es gratis?
Respuesta:
Porque lo bueno cuesta. Tus pagos nos ayudan a mantener los servidores, las bases de datos y el soporte activo. Con una sola compra, obtienes acceso completo, sin límites por cada búsqueda como en otras apps mediocres.
---
😕 Si continua con el mismo problema más de 2 beses
Frases que reconoce:
¿continua con el mismo problema?
¿No sé soluciono nada?
¿Sigue fallando?
¿Ya pasó mucho tiempo y no me llega mis créditos dijiste que ya lo activarlas?
O si el usuario está que insiste que no funciona algo o no le llegó sus créditos
Respuesta:
⚠️ Tranquilo, sé que no obtuviste lo que esperabas... todavía. Estoy mejorando constantemente. Ya envié una alerta directa al encargado de soporte, quien te contactará para resolver esto como se debe. Tu caso ya está siendo gestionado. ¡Paciencia, la solución está en camino!
---
⚠️ Problemas con la App
Frases que reconoce:
¿La app tiene fallas?
¿Hay errores en la app?
La app no funciona bien
No me carga la app
La app está lenta
Tengo un problema con la app
Respuesta:
Si algo no te cuadra, mándanos una captura y una explicación rápida. Tu experiencia nos importa y vamos a dejar la app al 100%. 🛠️
---
🙌 Agradecimiento
Frases que reconoce:
¿Te gustó la app?
Gracias, me es útil
Me gusta la app
La app es genial
La app es muy buena
Respuesta:
¡Nos encanta que te encante! 💚
Comparte la app con tus amigos, vecinos o hasta tu ex si quieres. Aquí está el link: 👉https://www.socialcreator.com/consultapeapk ¡Gracias por ser parte de los que sí resuelven!
---
❌ Eliminar cuenta
Frases que reconoce:
¿Cómo borro mi cuenta?
Quiero eliminar mi usuario
Dar de baja mi cuenta
¿Puedo cerrar mi cuenta?
Quiero eliminar mi cuenta
No quiero usar más la app
Respuesta:
¿Te quieres ir? Bueno, no lo entendemos, pero te ayudamos. Abre tu perfil, entra a “Política de privacidad” y dale a “Darme de baja”. Eso sí, te advertimos: el que se va, siempre regresa 😏
---
Preguntas Fuera de Tema
Frases que reconoce:
 * ¿Qué día es hoy?
 * ¿Cuántos años tengo?
 * ¿Quién ganó el partido?
 * ¿Cuánto es 20x50?
 * ¿Qué signo soy?
 * ¿Qué sistema soy?
 * ¿Cómo descargo Facebook?
 * ¿Cuál es mi número de celular?
 * ¿Qué hora es?
 * ¿Cuál es tu nombre?
 * ¿De dónde eres?
 * ¿Me puedes ayudar con otra cosa?
Respuesta:
🚨 ¡Atención, crack!
Soy el asistente oficial de Consulta PE y solo estoy diseñado para responder sobre los servicios de la app. Si quieres consultar un DNI, revisar vehículos, empresas, ver películas, saber si alguien está en la PNP o checar un sismo, estás en el lugar correcto. Yo te guío. Tú dominas. 😎📲
---
Alquiler de apis
Fracés que reconoce:
¿Cómo obtener mi token (API Key)?
¿Cómo consigo mi API Key?
¿Dónde encuentro mi API Key?
Respuesta:
Paso 1: Descarga la app.
Paso 2: Regístrate con tu nombre, correo y contraseña.
Paso 3: En el menú inferior toca la opción “APIs”. Tu token se genera automáticamente. Lo copias y listo, ya tienes tu llave mágica. 🔑✨
---
Fracés que reconoce:
¿Tengo que recargar aparte para consultar en la app y aparte para la API?
¿Los créditos son separados?
¿La API y la app tienen saldos diferentes?
¿Tengo que comprar créditos para la API y la app por separado?
Respuesta:
No, crack. Compras tus créditos desde 10 soles y se cargan a tu cuenta. Es un solo saldo que sirve para la app y las APIs. ¡Más simple, imposible! 😉
---
Fracés que reconoce:
¿Ofrecen planes ilimitados?
¿Tienen planes mensuales?
¿Planes ilimitados de API?
Respuesta:
Sí, tenemos planes ilimitados, pero la mayoría de nuestros usuarios prefiere los créditos porque así pagan solo por lo que usan. Si quieres, te damos el buffet libre, pero con los créditos comes a la carta sin gastar de más. 😏
---
🌐 Bienvenido a Consulta PE APIs
Frases que reconoce:
¿Cómo funcionan las APIs?
¿Cuál es la documentación de la API?
¿Me puedes explicar las APIs?
Quiero saber sobre las APIs
¿Cómo uso la API?
¿Qué endpoints tienen?
Respuesta:
Base URL: https://consulta-pe-apis-data-v2.fly.dev
Querido(a) desarrollador(a)… 🎩
Si estás leyendo esto, tu curiosidad te trajo al lugar correcto. Como dice la sabiduría popular: “quien controla la data, controla el poder”… y estás a punto de ser un mini-Tony Stark de las consultas. 🦾
📖 Instrucciones de uso
* Autenticación obligatoria
  Cada consulta requiere el header: x-api-key: TU_API_KEY
  Sin eso, la API es como una discoteca sin tu nombre en la lista: puedes intentarlo, pero el portero te mirará mal. 🕺
* Formatos de respuesta
  Todas las respuestas llegan en JSON limpio y optimizado. Si ves un campo raro como "developed-by", no te preocupes, nos encargamos de eliminar esas firmas para que solo brilles tú.
* Créditos y planes
  Si tienes plan por créditos → cuídalos como vidas en un videojuego 🎮.
  Si tienes plan ilimitado → úsalo con calma, que no queremos que el karma te caiga encima.
* Códigos de error
  401 → Olvidaste tu API Key. (Clásico).
  402 → Se acabaron tus créditos, como el saldo del celular en los 2000.
  403 → Tu plan caducó.
  500 → Ups… aquí la culpa es nuestra, pero igual te diremos que “intentes más tarde”. 😅
🤓 Recomendaciones prácticas
* No abuses: Sabemos que quieres probar todos los endpoints en un loop infinito, pero recuerda que esto no es un buffet libre.
* Haz logs de tus consultas para saber quién gasta los créditos.
* Guarda caché: tu aplicación se verá más rápida y parecerás un genio.
❓ Preguntas Frecuentes (FAQ)
* ¿Tengo que recargar aparte para consultar en la app y aparte para la API?
  No, crack. Es un solo saldo.
* ¿Ofrecen planes ilimitados?
  Sí, pero nuestros usuarios prefieren los créditos porque así pagan solo por lo que usan.
* Métodos de pago (compra de créditos)
  Aquí pagas como VIP: 💰 Yape, Lemon Cash, Bim, PayPal o depósito directo.
* ¿Puedo compartir mi API Key?
  Claro, si quieres quedarte sin créditos más rápido que un celular con Candy Crush.
* ¿Los datos son 100% reales?
  Sí, pero si tu primo “El Chino” aparece como casado tres veces, ahí no nos hacemos responsables.
* ¿Puedo hacer scraping mejor que esto?
  Puedes intentarlo, pero mientras tú peleas con captchas, nosotros ya tenemos el JSON servido en bandeja. 🍽️
* ¿Qué pasa si le pego 1 millón de requests en un día?
  Tu cuenta se suspende y nuestra API se ríe de ti.
* ¿Me harán descuento si uso mucho?
  ¿Te hacen descuento en Netflix por ver series sin parar? Pues igual aquí… la respuesta es no. 😎
⚠️ Renuncia de responsabilidad
Frases que reconoce:
¿La información es real?
¿Puedo usar la app para fines legales?
¿Puedo usar los datos para denunciar?
¿La app es oficial?
¿Son parte de SUNAT o RENIEC?
Respuesta:
Consulta PE no es RENIEC, SUNAT, MTC, ni la Fiscalía. La información proviene de fuentes públicas y privadas de terceros. Esto es para fines informativos y educativos. No lo uses para acosar a tu ex ni nos demandes, nuestros abogados cobran más caro que tus créditos.
---
😂 Un par de chistes para aligerar
Frases que reconoce:
¿Tienes un chiste?
¿Me cuentas un chiste?
¿Dime algo gracioso?
Cuéntame un chiste de programadores
Chiste de API
Respuesta:
* “¿Qué hace un developer cuando le faltan créditos?” → Llora en JSON.
* “Nuestra API es como tu crush: responde rápido si le hablas bonito, pero si la spameas, te deja en visto.” 💔
---
🌟 En resumen:
Frases que reconoce:
¿Para qué sirve todo esto?
¿Cuál es la conclusión?
¿Me puedes dar un resumen?
¿Qué gano con la API?
Respuesta:
👉 Usa la API, juega con los datos, crea cosas increíbles… pero siempre recuerda quién te dio el poder: Consulta PE. Sin nosotros, tu app sería solo un "Hola Mundo" aburrido. 😏
---
Endpoints de la API
Frases que reconoce:
¿Cuáles son los endpoints?
¿Me puedes dar la lista de endpoints?
Quiero ver todos los endpoints
¿Qué endpoints tienen?
Respuesta:
🔹 Básicos (7- Consulta Pe)
* Consultar DNI: GET https://consulta-pe-apis-data-v2.fly.dev/api/dni?dni=12345678
* Consultar RUC: GET https://consulta-pe-apis-data-v2.fly.dev/api/ruc?ruc=10412345678
* Consultar Anexos RUC: GET https://consulta-pe-apis-data-v2.fly.dev/api/ruc-anexo?ruc=10412345678
* Consultar Representantes RUC: GET https://consulta-pe-apis-data-v2.fly.dev/api/ruc-representante?ruc=10412345678
* Consultar CEE: GET https://consulta-pe-apis-data-v2.fly.dev/api/cee?cee=123456789
* Consultar SOAT por Placa: GET https://consulta-pe-apis-data-v2.fly.dev/api/soat-placa?placa=ABC123
* Consultar Licencia por DNI: GET https://consulta-pe-apis-data-v2.fly.dev/api/licencia?dni=12345678
🔹 Avanzados (Consulta Pe– 23)
* Ficha RENIEC en Imagen: GET https://consulta-pe-apis-data-v2.fly.dev/api/ficha?dni=12345678
* RENIEC Datos Detallados: GET https://consulta-pe-apis-data-v2.fly.dev/api/reniec?dni=12345678
* Denuncias por DNI: GET https://consulta-pe-apis-data-v2.fly.dev/api/denuncias-dni?dni=12345678
* Denuncias por Placa: GET https://consulta-pe-apis-data-v2.fly.dev/api/denuncias-placa?placa=ABC123
* Historial de Sueldos: GET https://consulta-pe-apis-data-v2.fly.dev/api/sueldos?dni=12345678
* Historial de Trabajos: GET https://consulta-pe-apis-data-v2.fly.dev/api/trabajos?dni=12345678
* Consulta SUNAT por RUC/DNI: GET https://consulta-pe-apis-data-v2.fly.dev/api/sunat?data=10412345678
* SUNAT Razón Social: GET https://consulta-pe-apis-data-v2.fly.dev/api/sunat-razon?data=Mi Empresa SAC
* Historial de Consumos: GET https://consulta-pe-apis-data-v2.fly.dev/api/consumos?dni=12345678
* Árbol Genealógico: GET https://consulta-pe-apis-data-v2.fly.dev/api/arbol?dni=12345678
* Familia 1: GET https://consulta-pe-apis-data-v2.fly.dev/api/familia1?dni=12345678
* Familia 2: GET https://consulta-pe-apis-data-v2.fly.dev/api/familia2?dni=12345678
* Familia 3: GET https://consulta-pe-apis-data-v2.fly.dev/api/familia3?dni=12345678
* Movimientos Migratorios: GET https://consulta-pe-apis-data-v2.fly.dev/api/movimientos?dni=12345678
* Matrimonios: GET https://consulta-pe-apis-data-v2.fly.dev/api/matrimonios?dni=12345678
* Empresas Relacionadas: GET https://consulta-pe-apis-data-v2.fly.dev/api/empresas?dni=12345678
* Direcciones Relacionadas: GET https://consulta-pe-apis-data-v2.fly.dev/api/direcciones?dni=12345678
* Correos Electrónicos: GET https://consulta-pe-apis-data-v2.fly.dev/api/correos?dni=12345678
* Telefonía por Documento: GET https://consulta-pe-apis-data-v2.fly.dev/api/telefonia-doc?documento=12345678
* Telefonía por Número: GET https://consulta-pe-apis-data-v2.fly.dev/api/telefonia-num?numero=987654321
* Vehículos por Placa: GET https://consulta-pe-apis-data-v2.fly.dev/api/vehiculos?placa=ABC123
* Fiscalía por DNI: GET https://consulta-pe-apis-data-v2.fly.dev/api/fiscalia-dni?dni=12345678
* Fiscalía por Nombres: GET https://consulta-pe-apis-data-v2.fly.dev/api/fiscalia-nombres?nombres=Juan&apepaterno=Perez&apematerno=Gomez
🔹 Extra (PDF – 1)
* Ficha Completa en PDF: GET https://consulta-pe-apis-data-v2.fly.dev/api/info-total?dni=12345678
---
¡Activa el plan mensual!
Frases que reconoce:
¿Cuánto cuesta el plan mensual?
¿Info de plan mensual?
¿Cómo adquiero un plan mensual?
¿Tienen plan ilimitado?
¿Cuánto cuesta el plan ilimitado?
Respuesta:
¡Tenemos planes ilimitados para que consultes sin parar!
DURACIÓN - PRECIO SUGERIDO - AHORRO ESTIMADO
Ilimitado 7 días - S/60 - (+4.00)
Ilimitado 15 días - S/80 - (+7.50)
Ilimitado 30 días - S/110 - (+17.00)
Ilimitado 60 días - S/160 - (+30.00)
Ilimitado 70 días - S/510 - (+50.00)
Dime qué plan ilimitado deseas para ayudarte a activarlo.
---
**Opciones de consulta avanzada**
Frases que reconoce:
Quiero consultar un DNI
Quiero saber sobre una persona
¿Puedes consultar por mí?
Quiero la ficha de RENIEC
Quiero el árbol genealógico
Respuesta:
Claro, puedo realizar la búsqueda por ti. Tenemos dos opciones:
1.  **Consulta por S/5.00:** Hago la consulta en nuestras APIs y te envío el resultado directamente (ideal para datos en texto).
2.  **Consulta por S/10.00:** Reenvío tu solicitud a un número de soporte que responde con imágenes y PDFs (ideal para documentos como fichas y actas).
Por favor, dime qué tipo de consulta te interesa para darte las instrucciones de pago. Una vez que envíes el comprobante, procesaré la solicitud de inmediato.
---
`;
let COHERE_PROMPT = "";
let OPENAI_PROMPT = "";

// Respuestas locales y menús
let respuestasPredefinidas = {};
let userRequestStates = new Map(); // Nuevo: para gestionar las solicitudes de los usuarios

const ADMIN_NUMBER = process.env.ADMIN_NUMBER;

// Nuevo: Configuración de OpenAI para análisis de imágenes
const openaiApi = axios.create({
    baseURL: 'https://api.openai.com/v1',
    headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
    }
});

const validatePaymentReceipt = async (imageUrl) => {
    try {
        if (!process.env.OPENAI_API_KEY) {
            console.error("OPENAI_API_KEY no está configurada.");
            return { valid: false, reason: "API key is missing." };
        }
        const response = await openaiApi.post('/chat/completions', {
            model: "gpt-4o-mini", // O un modelo de visión más reciente y asequible
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `Analiza esta imagen. ¿Es un comprobante de pago reciente (de hoy) de una app de pagos peruana como Yape o Plin? Responde 'verdadero' si es un comprobante de hoy, y 'falso' si es antiguo, no es un comprobante, o no puedes determinarlo.`
                        },
                        {
                            type: "image_url",
                            image_url: { "url": imageUrl }
                        }
                    ]
                }
            ],
            max_tokens: 100
        });

        const textResponse = response.data.choices[0].message.content.trim().toLowerCase();
        
        // La respuesta de la IA es 'verdadero' o 'falso'
        const isValid = textResponse.includes('verdadero');
        
        return { 
            valid: isValid,
            reason: isValid ? "El comprobante parece ser válido." : "El comprobante no parece ser válido o es antiguo."
        };
    } catch (error) {
        console.error("Error al validar el comprobante con OpenAI:", error.response?.data || error.message);
        return { valid: false, reason: "Error al procesar la imagen." };
    }
};

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

// ------------------- Cohere -------------------
const consumirCohere = async (prompt) => {
  try {
    if (!process.env.COHERE_API_KEY) {
      console.log("COHERE_API_KEY no está configurada.");
      return null;
    }
    const url = "https://api.cohere.ai/v1/chat";
    const headers = {
      "Authorization": `Bearer ${process.env.COHERE_API_KEY}`,
      "Content-Type": "application/json"
    };
    const data = {
      chat_history: [
        {
          role: "SYSTEM",
          message: COHERE_PROMPT
        }
      ],
      message: prompt
    };

    const response = await axios.post(url, data, { headers, timeout: 15000 });
    return response.data?.text?.trim() || null;
  } catch (err) {
    console.error("Error al consumir Cohere API:", err.response?.data || err.message);
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
let makeWASocket, useMultiFileAuthState, DisconnectReason, proto, downloadContentFromMessage, get;
try {
  const baileysModule = await import("@whiskeysockets/baileys");
  makeWASocket = baileysModule.makeWASocket;
  useMultiFileAuthState = baileysModule.useMultiFileAuthState;
  DisconnectReason = baileysModule.DisconnectReason;
  proto = baileysModule.proto;
  downloadContentFromMessage = baileysModule.downloadContentFromMessage;
  get = baileysModule.get;
} catch (err) {
  console.error("Error importando Baileys:", err.message || err);
}

// ------------------- Utilidades -------------------
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

const forwardToAdmins = async (sock, message, customerNumber) => {
  const adminNumbers = ["51929008609@s.whatsapp.net", "51965993244@s.whatsapp.net"];
  const forwardedMessage = `*REENVÍO AUTOMÁTICO DE SOPORTE*
  
*Cliente:* wa.me/${customerNumber.replace("@s.whatsapp.net", "")}

*Mensaje del cliente:*
${message}
  
*Enviado por el Bot para atención inmediata.*`;

  for (const admin of adminNumbers) {
    await sock.sendMessage(admin, { text: forwardedMessage });
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
  
  // Manejo de llamadas: rechazarlas automáticamente
  sock.ev.on("call", async (calls) => {
    for (const call of calls) {
      if (call.status === 'offer' || call.status === 'ringing') {
        console.log(`Llamada entrante de ${call.from}. Rechazando...`);
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
    for (const msg of m.messages || []) {
      if (!msg.message || msg.key.fromMe) continue;
      
      const from = msg.key.remoteJid;
      const customerNumber = from;
      
      // Rechazar mensajes de llamadas
      if (msg.messageStubType === proto.WebMessageInfo.StubType.CALL_MISSED_VOICE || msg.messageStubType === proto.WebMessageInfo.StubType.CALL_MISSED_VIDEO) {
        await sock.sendMessage(from, { text: "Hola, soy un asistente virtual y solo atiendo por mensaje de texto. Por favor, escribe tu consulta por aquí." });
        continue;
      }
      
      let body = "";
      let manualMessageReply = false;
      let mediaType = null;
      let mediaUrl = null;

      const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (quotedMessage) {
        const originalMessageText = quotedMessage?.conversation || quotedMessage?.extendedTextMessage?.text;
        if (originalMessageText && originalMessageText.includes("###MANUAL_MESSAGE_REPLY_ID###")) {
          manualMessageReply = true;
          
          let content = null;

          if (msg.message.conversation) {
            content = msg.message.conversation;
          } else if (msg.message.extendedTextMessage) {
            content = msg.message.extendedTextMessage.text;
          } else if (msg.message.imageMessage) {
            mediaType = "image";
            mediaUrl = await getDownloadURL(msg.message.imageMessage, 'image');
            content = "imagen generada";
          } else if (msg.message.documentMessage) {
            mediaType = "document";
            mediaUrl = await getDownloadURL(msg.message.documentMessage, 'document');
            content = "pdf generada";
          }
          
          const payload = {
            message: "found data",
            result: {
              quantity: 1,
              coincidences: [{
                message: content,
                url: mediaUrl,
              }],
            },
          };
          
          try {
            await axios.post('http://tu-interfaz-de-usuario.com/webhook', payload); // Replace with your actual webhook URL
            console.log("Payload enviado a la interfaz:", payload);
            await sock.sendMessage(from, { text: "¡Recibido! Tu respuesta ha sido procesada." });
          } catch (error) {
            console.error("Error al enviar el payload a la interfaz:", error.message);
          }
          
          continue; // Stop further processing for this message
        }
      }

      if (msg.message.conversation) {
        body = msg.message.conversation;
      } else if (msg.message.extendedTextMessage) {
        body = msg.message.extendedTextMessage.text;
      } else if (msg.message.imageMessage) {
        const imageBuffer = await downloadContentFromMessage(msg.message.imageMessage, 'image');
        let bufferArray = [];
        for await (const chunk of imageBuffer) {
            bufferArray.push(chunk);
        }
        const buffer = Buffer.concat(bufferArray);
        
        // Nuevo: Usar OpenAI para validar el comprobante
        const imageUrl = await getDownloadURL(msg.message.imageMessage, 'image');
        const validationResult = await validatePaymentReceipt(imageUrl);

        if (validationResult.valid) {
            body = "Comprobante de pago";
        } else {
            body = "imagen no reconocida";
        }
      } else if (msg.message.audioMessage) {
          const audioBuffer = await downloadContentFromMessage(msg.message.audioMessage, 'audio');
          let bufferArray = [];
          for await (const chunk of audioBuffer) {
            bufferArray.push(chunk);
          }
          const buffer = Buffer.concat(bufferArray);
          body = await sendAudioToGoogleSpeechToText(buffer);
      } else {
          await sock.sendMessage(from, { text: "Lo siento, solo puedo procesar mensajes de texto, imágenes y audios. Por favor, envía tu consulta en uno de esos formatos." });
          continue;
      }
      
      if (!body) continue;

      // ... Lógica de comandos de administrador (mantenida) ...
      const is_admin = from.startsWith(ADMIN_NUMBER);
      if (is_admin && body.startsWith("/")) {
        const parts = body.substring(1).split("|").map(p => p.trim());
        const command = parts[0].split(" ")[0];
        const arg = parts[0].split(" ").slice(1).join(" ");
        
        switch (command) {
          // ... Comandos existentes ...
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
            const [targetNumber, url, type, caption = ""] = parts.slice(1);
            if (!targetNumber || !url || !type) {
                await sock.sendMessage(from, { text: "❌ Uso: /sendmedia | <número_destino> | <url> | <tipo> | [caption]" });
                return;
            }
            const jid = `${targetNumber}@s.whatsapp.net`;
            try {
                const response = await axios.get(url, { responseType: 'arraybuffer' });
                const buffer = Buffer.from(response.data);
                const mediaMsg = { [type]: buffer, caption: caption };
                await sock.sendMessage(jid, mediaMsg);
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
                const manualMessageText = `${message}\n\n###MANUAL_MESSAGE_REPLY_ID###`;
                await sock.sendMessage(number, { text: manualMessageText });
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
      // ... Fin de lógica de comandos de administrador ...

      if (botPaused) return;

      const now = Date.now();
      const lastInteraction = userStates.get(from)?.lastInteraction || 0;
      const twentyFourHours = 24 * 60 * 60 * 1000;
      const isNewDay = (now - lastInteraction) > twentyFourHours;

      if (isNewDay && !body.toLowerCase().includes("hola")) {
          const userState = userStates.get(from) || {};
          const isFirstMessage = !userState.messageCount;
          
          if (isFirstMessage) {
            await sock.sendMessage(from, { text: welcomeMessage });
          }
      }
      userStates.set(from, { lastInteraction: now, messageCount: (userStates.get(from)?.messageCount || 0) + 1 });
      
      // Lógica para detectar el tipo de solicitud del usuario
      const userRequest = userRequestStates.get(from);
      if (userRequest) {
          // El usuario está en un flujo de consulta paga
          if (body.toLowerCase().includes("comprobante de pago")) {
              const adminNumbers = ["51929008609@s.whatsapp.net", "51965993244@s.whatsapp.net"];
              
              // Reenviar el comprobante a los administradores
              for (const admin of adminNumbers) {
                  await sock.sendMessage(admin, {
                      text: `*COMPROBANTE RECIBIDO*
Cliente: wa.me/${from.replace("@s.whatsapp.net", "")}
Tipo de pago: ${userRequest.price} soles
Comando/Datos: ${userRequest.command}`
                  });
                  if (msg.message.imageMessage) {
                      const mediaBuffer = await downloadContentFromMessage(msg.message.imageMessage, 'image');
                      await sock.sendMessage(admin, { image: mediaBuffer });
                  }
              }
              
              // Confirmar al usuario y procesar la solicitud
              await sock.sendMessage(from, { text: "¡Comprobante recibido! Procesando tu solicitud de inmediato. Te enviaré el resultado en unos segundos." });

              if (userRequest.price === 5) {
                  // Lógica para consulta de 5 soles (API)
                  const apiUrl = `https://consulta-pe-apis-data-v2.fly.dev/api/${userRequest.command}?${userRequest.data}`;
                  try {
                      const apiResponse = await axios.get(apiUrl, {
                          headers: { 'x-api-key': API_TOKEN_5_SOLES }
                      });
                      const resultText = JSON.stringify(apiResponse.data, null, 2);
                      await sock.sendMessage(from, { text: `✅ *Resultado de tu consulta (S/5):* \n\n\`\`\`${resultText}\`\`\`` });
                  } catch (apiError) {
                      await sock.sendMessage(from, { text: "❌ Lo siento, hubo un error al consultar la API. Por favor, intenta de nuevo o contacta al soporte." });
                  }
              } else if (userRequest.price === 10) {
                  // Lógica para consulta de 10 soles (comando a WhatsApp)
                  const commandText = `${userRequest.command}`;
                  await sock.sendMessage(WHATSAPP_BOT_NUMBER, { text: commandText });
                  await sock.sendMessage(from, { text: "✅ Tu solicitud ha sido enviada al sistema. Esperando respuesta... esto puede tardar unos segundos." });
              }

              userRequestStates.delete(from); // Limpiar el estado del usuario
              continue; // Detener el procesamiento de la IA
          } else {
              // El usuario no ha enviado el comprobante, pero sigue en el flujo de pago
              await sock.sendMessage(from, { text: `Aún estoy esperando el comprobante. Por favor, envía la imagen del pago para procesar tu solicitud: ${userRequest.command}` });
              continue;
          }
      }

      // Si el usuario solicita una consulta paga, iniciar el flujo
      const pay5Regex = /^(quiero|necesito|solicito|dame|buscame) (.*)(?:\s+de\s+la\s+app|en\s+la\s+app|por\s+5\s+soles)?/i;
      const pay10Regex = /^(quiero|necesito|solicito|dame|buscame) (.*)(?:\s+en\s+pdf|en\s+imagen|por\s+10\s+soles)?/i;
      
      let match5 = body.match(pay5Regex);
      let match10 = body.match(pay10Regex);

      if (match5) {
          const rawQuery = match5[2].trim();
          const parts = rawQuery.split(" ");
          const command = parts[0];
          const data = parts.slice(1).join(" ");
          
          if (data) {
              userRequestStates.set(from, { price: 5, command: command, data: data });
              await sock.sendMessage(from, { text: `Claro, para realizar esa búsqueda el costo es de *S/5.00*. Por favor, Yapea al *929008609* y envíame el comprobante para proceder.` });
              continue;
          }
      }

      if (match10) {
          const rawQuery = match10[2].trim();
          const parts = rawQuery.split(" ");
          const command = parts[0];
          const data = parts.slice(1).join(" ");

          if (data) {
              userRequestStates.set(from, { price: 10, command: command, data: data });
              await sock.sendMessage(from, { text: `Entendido. Para obtener la información que necesitas en *imagen o PDF*, el costo es de *S/10.00*. Realiza tu pago por Yape al *929008609* y envíame el comprobante para que el bot proceda con la búsqueda.` });
              continue;
          }
      }

      // Lógica para reenviar resultados del bot de 10 soles
      if (from === WHATSAPP_BOT_NUMBER) {
          // Si el mensaje viene del bot de 10 soles, reenviarlo al usuario original
          const originalRecipientNumber = userStates.get(from)?.lastInteractionUser; // Esto debe ser persistente
          if (originalRecipientNumber) {
              await sock.sendMessage(originalRecipientNumber, {
                  text: "✅ *Aquí está el resultado de tu consulta de S/10:*",
                  quoted: msg.key,
              });
              // Reenviar el mensaje original (imagen, PDF, etc.)
              await sock.sendMessage(originalRecipientNumber, {
                  forward: msg,
              });
              continue;
          }
      }
      
      let reply = "";
      
      const calculateTypingTime = (textLength) => {
        const msPerChar = 40;
        const maxTime = 5000;
        return Math.min(textLength * msPerChar, maxTime);
      };

      await sock.sendPresenceUpdate("composing", from);
      
      reply = obtenerRespuestaLocal(body);

      if (!reply) {
        switch (activeAI) {
          case "gemini":
            reply = await consumirGemini(body);
            break;
          case "cohere":
            reply = await consumirCohere(body);
            if (!reply) {
              reply = "Ya envié una alerta a nuestro equipo de soporte. Un experto se pondrá en contacto contigo por este mismo medio en unos minutos para darte una solución. Estamos en ello.";
            }
            break;
          case "openai":
            reply = "Ya envié una alerta a nuestro equipo de soporte. Un experto se pondrá en contacto contigo por este mismo medio en unos minutos para darte una solución. Estamos en ello.";
            break;
          case "local":
            reply = "🤔 No se encontró respuesta local. El modo local está activo.";
            break;
          default:
            reply = "⚠️ Error: IA no reconocida. Por favor, contacta al administrador.";
            break;
        }
      }

      if (!reply || reply.includes("no pude encontrar una respuesta")) {
          await forwardToAdmins(sock, body, customerNumber);
          reply = "Ya envié una alerta a nuestro equipo de soporte. Un experto se pondrá en contacto contigo por este mismo medio en unos minutos para darte una solución. Estamos en ello.";
      }

      await wait(calculateTypingTime(reply.length));
      await sock.sendPresenceUpdate("paused", from);

      const replyLength = reply.length;
      let parts = [reply];

      if (replyLength > 2000) {
        const chunkSize = Math.ceil(replyLength / 2);
        parts = [reply.substring(0, chunkSize), reply.substring(chunkSize)];
      }
      
      for (const p of parts) {
        await sock.sendMessage(from, { text: p });
        await wait(1000 + Math.random() * 500);
      }
    }
  });

  return sock;
};

// Function to get a temporary URL for downloaded media
const getDownloadURL = async (message, type) => {
    const stream = await downloadContentFromMessage(message, type);
    const buffer = await streamToBuffer(stream);
    const filePath = path.join('./temp', `${Date.now()}.${type === 'image' ? 'png' : 'pdf'}`);
    fs.writeFileSync(filePath, buffer);
    
    // Simular subida a un servicio de almacenamiento en la nube
    // En producción, reemplaza esto con la URL real de un bucket de S3, Cloudflare, etc.
    const publicUrl = `http://your-server.com/media/${path.basename(filePath)}`;
    
    // Almacenar el archivo temporal en el servidor local para la validación
    // En un entorno de producción, la URL directa del servicio de cloud storage
    // sería suficiente y no necesitarías guardar el archivo localmente.
    return publicUrl;
};

const streamToBuffer = (stream) => {
  return new Promise((resolve, reject) => {
    const buffers = [];
    stream.on('data', chunk => buffers.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(buffers)));
    stream.on('error', err => reject(err));
  });
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

// Nueva función de health check para mantener el bot activo
app.get("/api/health", (req, res) => {
  res.json({ ok: true, status: "alive", time: new Date().toISOString() });
});

app.get("/", (req, res) => res.json({ ok: true, msg: "ConsultaPE WA Bot activo 🚀" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server en puerto ${PORT}`));
