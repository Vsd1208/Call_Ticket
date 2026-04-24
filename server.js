const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const querystring = require("querystring");
const crypto = require("crypto");

loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DUMMY_TOLL_FREE_NUMBER = process.env.DUMMY_TOLL_FREE_NUMBER || "+18005550199";
const EXOTEL_EXOPHONE = process.env.EXOTEL_EXOPHONE || "04048218468";
const EXOTEL_TRIAL_NUMBER = process.env.EXOTEL_TRIAL_NUMBER || "08897587467";
const EXOTEL_APP_ID = process.env.EXOTEL_APP_ID || "1230481";
const ROOT = __dirname;

const sessions = new Map();
const payments = new Map();
const smsOutbox = [];
const voicebotEvents = [];

// ─── ENV LOADER ─────────────────────────────────────────────────────────────

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

// ─── STATION / SLOT PARSING ──────────────────────────────────────────────────

const stations = [
  { name: "Delhi",     aliases: ["delhi", "new delhi", "dilli", "ndls"] },
  { name: "Mumbai",    aliases: ["mumbai", "bombay", "cst", "dadar"] },
  { name: "Chennai",   aliases: ["chennai", "madras", "mas"] },
  { name: "Bengaluru", aliases: ["bengaluru", "bangalore", "blr", "ksr"] },
  { name: "Kolkata",   aliases: ["kolkata", "calcutta", "howrah"] },
  { name: "Hyderabad", aliases: ["hyderabad", "secunderabad"] },
  { name: "Pune",      aliases: ["pune", "poona"] },
  { name: "Ahmedabad", aliases: ["ahmedabad", "amdavad"] },
  { name: "Jaipur",    aliases: ["jaipur", "pink city"] },
  { name: "Lucknow",   aliases: ["lucknow", "lko"] }
];

function normalize(text) {
  return String(text || "").toLowerCase().replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
}

function stationPattern() {
  return stations
    .flatMap(s => s.aliases)
    .sort((a, b) => b.length - a.length)
    .map(a => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
}

function resolveStation(value) {
  const clean = normalize(value);
  const s = stations.find(item => item.aliases.some(alias => clean.includes(alias)));
  return s ? s.name : "";
}

function findStationAfter(text, words) {
  const pat = stationPattern();
  for (const word of words) {
    const m = text.match(new RegExp(`${word}\\s+(${pat})`, "i"));
    if (m) return resolveStation(m[1]);
  }
  return "";
}

function findAllStations(text) {
  return stations
    .filter(s => s.aliases.some(alias => text.includes(alias)))
    .map(s => s.name);
}

function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDate(text) {
  const today = new Date();
  if (/\btoday\b|aaj/.test(text)) return formatDate(today);
  if (/\btomorrow\b|kal/.test(text)) {
    const d = new Date(today); d.setDate(d.getDate() + 1); return formatDate(d);
  }
  // after N days
  const daysMatch = text.match(/\bafter\s+(\d+)\s+days?\b/i);
  if (daysMatch) {
    const d = new Date(today); d.setDate(d.getDate() + Number(daysMatch[1])); return formatDate(d);
  }
  const iso = text.match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const indian = text.match(/\b(0?[1-9]|[12]\d|3[01])[-/](0?[1-9]|1[0-2])[-/](20\d{2})\b/);
  if (indian) return `${indian[3]}-${indian[2].padStart(2, "0")}-${indian[1].padStart(2, "0")}`;
  return "";
}

function parseName(text) {
  const m = String(text || "").match(
    /\b(?:for|name is|passenger is|passenger name is|naam|mera naam)\s+([a-zA-Z][a-zA-Z ]{1,28})(?:\s+age|\s+umar|$)/i
  );
  if (!m) return "";
  return m[1]
    .replace(/\b(age|umar|seat|ticket|book)\b.*$/i, "")
    .trim()
    .replace(/\b\w/g, l => l.toUpperCase());
}

function parseDirectName(text) {
  const clean = String(text || "").trim();
  if (!/^[a-zA-Z][a-zA-Z ]{1,28}$/.test(clean)) return "";
  if (stations.some(s => s.aliases.includes(normalize(clean)))) return "";
  return clean.replace(/\b\w/g, l => l.toUpperCase());
}

function parseAge(text) {
  const m = String(text || "").match(/\b(?:age|aged|umar)\s*(?:is)?\s*(\d{1,3})\b/i);
  if (m) return m[1];
  const d = String(text || "").trim().match(/^(\d{1,3})$/);
  return d ? d[1] : "";
}

function parseSeat(text) {
  if (/\bwindow\b/i.test(text)) return "Window";
  if (/\baisle\b/i.test(text)) return "Aisle";
  if (/\blower\b/i.test(text)) return "Lower";
  if (/\bupper\b/i.test(text)) return "Upper";
  if (/\bmiddle\b/i.test(text)) return "Middle";
  return "";
}

function parseJourneyType(text) {
  if (/\b(unreserved|general|local|suburban|ordinary|general compartment)\b/i.test(text)) return "Unreserved";
  if (/\b(reserved|reservation|sleeper|chair car|ac|confirmed seat|second class|first class)\b/i.test(text)) return "Reserved";
  return "";
}

function parseDepartureTime(text) {
  const src = String(text || "").toLowerCase();
  let m = src.match(/\b(?:at|time|departure|departing|leaves|train time)\s*(?:is)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!m) m = src.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  if (!m) return "";
  let hour = Number(m[1]);
  const minute = Number(m[2] || "0");
  const meridiem = m[3];
  if (minute > 59 || hour > 24) return "";
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return `${String(hour % 24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function departureDateTime(session) {
  if (!session.date || !session.departureTime) return null;
  const v = new Date(`${session.date}T${session.departureTime}:00`);
  return isNaN(v.getTime()) ? null : v;
}

function paymentDeadline(session) {
  const dep = departureDateTime(session);
  if (!dep) return "";
  const dl = new Date(dep);
  dl.setMinutes(dl.getMinutes() - 15);
  return `${formatDate(dl)} ${String(dl.getHours()).padStart(2, "0")}:${String(dl.getMinutes()).padStart(2, "0")}`;
}

function canStillPay(session, now = new Date()) {
  const dep = departureDateTime(session);
  if (!dep) return false;
  const dl = new Date(dep);
  dl.setMinutes(dl.getMinutes() - 15);
  return now <= dl;
}

function estimateFare(session) {
  const base = session.journeyType === "Unreserved" ? 25 : 180;
  const rf = session.from && session.to ? Math.abs(session.from.length - session.to.length) * 7 : 0;
  return base + rf;
}

function updateBooking(session, rawText) {
  const text = normalize(rawText);
  const ef = findStationAfter(text, ["from", "se"]);
  const et = findStationAfter(text, ["to", "tak"]);
  const all = findAllStations(text);
  if (ef) session.from = ef;
  if (et) session.to = et;
  if (!session.from && all[0]) session.from = all[0];
  if (!session.to) {
    const other = all.find(s => s !== session.from);
    if (other) session.to = other;
  }
  const date = parseDate(text);
  const name = parseName(rawText) || (!session.name && session.from && session.to && session.date ? parseDirectName(rawText) : "");
  const age = parseAge(rawText);
  const seat = parseSeat(rawText);
  const jt = parseJourneyType(rawText);
  const depTime = parseDepartureTime(rawText);
  if (date) session.date = date;
  if (name) session.name = name;
  if (age) session.age = age;
  if (seat) session.seat = seat;
  if (jt) session.journeyType = jt;
  if (depTime) session.departureTime = depTime;
}

function nextPrompt(session) {
  if (!session.journeyType) return "Is this journey reserved or unreserved? For example, a local train or general compartment is unreserved, and a sleeper or air conditioned train is reserved.";
  if (!session.from) return "Which station are you starting from?";
  if (!session.to) return "Which station are you going to?";
  if (!session.date) return "What is your travel date? You can say today, tomorrow, or give the date.";
  if (!session.departureTime) return "What is the train departure time? For example, 9 30 AM or 14 00.";
  if (!session.name) return "What is the passenger name?";
  if (!session.age) return "What is the passenger age?";
  const dl = paymentDeadline(session);
  if (!canStillPay(session)) return "Sorry, the payment window has closed because less than 15 minutes remain before departure. Please start a new booking for a different train.";
  return `I have your booking details. A ${session.journeyType.toLowerCase()} journey from ${session.from} to ${session.to} on ${session.date} at ${session.departureTime} for ${session.name}, age ${session.age}. You must pay before ${dl}. Please say confirm to receive the payment link by SMS, or say cancel to start over.`;
}

function getSession(callSid) {
  const key = callSid || "local-call";
  if (!sessions.has(key)) {
    sessions.set(key, { from: "", to: "", date: "", departureTime: "", name: "", age: "", seat: "Any", journeyType: "", phone: "" });
  }
  return sessions.get(key);
}

function isComplete(session) {
  return Boolean(session.journeyType && session.from && session.to && session.date && session.departureTime && session.name && session.age);
}

// ─── UTILS ───────────────────────────────────────────────────────────────────

function xml(v) {
  return String(v || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlGather(message, lang = "en-IN") {
  // Exotel uses Say + GetDigits/Record; this works for Twilio. Exotel uses the Passthru/Voicebot separately.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/voice/process" method="POST" speechTimeout="auto" language="${lang}">
    <Say voice="alice" language="${lang}">${xml(message)}</Say>
  </Gather>
  <Say voice="alice" language="${lang}">I did not hear anything. Let me try again.</Say>
  <Redirect method="POST">/voice/incoming</Redirect>
</Response>`;
}

function twimlSay(message, lang = "en-IN") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="${lang}">${xml(message)}</Say>
</Response>`;
}

// Exotel ExoML — uses Record applet for speech capture
function exoml(message) {
  const action = `${PUBLIC_BASE_URL}/voice/process`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="female" language="en">
    <![CDATA[${message}]]>
  </Say>
  <Record action="${action}" method="POST"
    timeout="5"
    transcribe="true"
    transcribeCallback="${action}"
    playBeep="false"
    maxLength="15"
    finishOnKey="#"
  />
</Response>`;
}

function exomlSay(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="female" language="en"><![CDATA[${message}]]></Say>
  <Hangup/>
</Response>`;
}

// Exotel sends speech via Record+transcribe or SpeechResult;
// extract whatever field has the caller's words
function extractSpeech(body) {
  return String(
    body.TranscriptionText ||
    body.SpeechResult ||
    body.speech ||
    body.text ||
    body.transcript ||
    body.Digits ||
    body.digits ||
    ""
  ).trim();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function send(res, status, contentType, body) {
  res.writeHead(status, { "Content-Type": contentType, "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value, null, 2));
}

function publicWsBaseUrl() {
  const base = PUBLIC_BASE_URL;
  if (base.startsWith("https://")) return base.replace("https://", "wss://");
  if (base.startsWith("http://")) return base.replace("http://", "ws://");
  return `ws://${base}`;
}

const staticTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

function serveStatic(req, res) {
  const requested = decodeURIComponent(new URL(req.url, PUBLIC_BASE_URL).pathname);
  const safePath = path.normalize(requested === "/" ? "/index.html" : requested).replace(/^(\.\.[\\/])+/, "");
  const filePath = path.join(ROOT, safePath);
  if (!filePath.startsWith(ROOT)) { send(res, 403, "text/plain", "Forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { send(res, 404, "text/plain", "Not found"); return; }
    send(res, 200, staticTypes[path.extname(filePath)] || "application/octet-stream", data);
  });
}

// ─── PROVIDER DETECTION ──────────────────────────────────────────────────────

function twilioReady() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}

function exotelReady() {
  return Boolean(process.env.EXOTEL_ACCOUNT_SID && process.env.EXOTEL_API_KEY && process.env.EXOTEL_API_TOKEN && EXOTEL_EXOPHONE && EXOTEL_APP_ID);
}

function liveProvider() {
  if (exotelReady()) return "exotel";
  if (twilioReady()) return "twilio";
  return "simulation";
}

function activePhoneNumber() {
  if (exotelReady()) return EXOTEL_EXOPHONE;
  if (twilioReady()) return process.env.TWILIO_FROM_NUMBER;
  return DUMMY_TOLL_FREE_NUMBER;
}

function exotelSubdomain() {
  return process.env.EXOTEL_SUBDOMAIN || "api.in.exotel.com";
}

function exotelFlowUrl() {
  return process.env.EXOTEL_FLOW_URL ||
    `http://my.exotel.com/${process.env.EXOTEL_ACCOUNT_SID}/exoml/start_voice/${EXOTEL_APP_ID}`;
}

// ─── SMS / CALL PROVIDERS ────────────────────────────────────────────────────

function recordSms(to, message, reference = "") {
  const item = {
    id: `SMS-${String(smsOutbox.length + 1).padStart(4, "0")}`,
    to, message, reference, simulated: true,
    createdAt: new Date().toISOString()
  };
  smsOutbox.push(item);
  console.log(`[SMS outbox] ${to}: ${message}`);
  return item;
}

// Normalise any Indian phone number to E.164 (+91XXXXXXXXXX)
function toE164(number) {
  const digits = String(number || "").replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) return "+" + digits;
  if (digits.length === 10) return "+91" + digits;
  if (digits.startsWith("0") && digits.length === 11) return "+91" + digits.slice(1);
  return digits ? "+" + digits : "";
}

function callerPhoneFromWebhook(body) {
  const from = String(body.From || body.CallFrom || "");
  const to   = String(body.To   || body.CallTo   || "");
  const configuredFrom = activePhoneNumber();
  if (configuredFrom && toE164(from) === toE164(configuredFrom)) return toE164(to);
  return toE164(from) || toE164(to) || from || to;
}

function httpsPost(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch { resolve(body); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

function startTwilioCall(to) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const postData = querystring.stringify({ To: to, From: from, Url: `${PUBLIC_BASE_URL}/voice/incoming` });
  return httpsPost({
    hostname: "api.twilio.com",
    path: `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`,
    method: "POST",
    auth: `${accountSid}:${authToken}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(postData) }
  }, postData);
}

function startExotelCall(to) {
  const accountSid = process.env.EXOTEL_ACCOUNT_SID;
  const apiKey = process.env.EXOTEL_API_KEY;
  const apiToken = process.env.EXOTEL_API_TOKEN;
  const postData = querystring.stringify({
    From: to,
    CallerId: EXOTEL_EXOPHONE,
    Url: exotelFlowUrl(),
    CallType: "trans",
    StatusCallback: `${PUBLIC_BASE_URL}/exotel/status`
  });
  return httpsPost({
    hostname: exotelSubdomain(),
    path: `/v1/Accounts/${encodeURIComponent(accountSid)}/Calls/connect.json`,
    method: "POST",
    auth: `${apiKey}:${apiToken}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(postData) }
  }, postData);
}

function sendTwilioSms(to, message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const postData = querystring.stringify({ To: to, From: from, Body: message });
  return httpsPost({
    hostname: "api.twilio.com",
    path: `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    method: "POST",
    auth: `${accountSid}:${authToken}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(postData) }
  }, postData);
}

function sendExotelSms(to, message) {
  const accountSid = process.env.EXOTEL_ACCOUNT_SID;
  const apiKey = process.env.EXOTEL_API_KEY;
  const apiToken = process.env.EXOTEL_API_TOKEN;
  const postData = querystring.stringify({
    From: EXOTEL_EXOPHONE,
    To: to,
    Body: message,
    StatusCallback: `${PUBLIC_BASE_URL}/exotel/sms-status`
  });
  return httpsPost({
    hostname: exotelSubdomain(),
    path: `/v1/Accounts/${encodeURIComponent(accountSid)}/Sms/send.json`,
    method: "POST",
    auth: `${apiKey}:${apiToken}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(postData) }
  }, postData);
}

async function sendPaymentSms(to, message, reference) {
  if (exotelReady()) {
    try {
      const sent = await sendExotelSms(to, message);
      const sms = sent.SMSMessage || sent.sms || sent;
      return { sent: true, simulated: false, provider: "exotel", providerId: sms.Sid || sms.sid || "" };
    } catch (err) {
      console.error("Exotel SMS error:", err.message);
    }
  }
  if (twilioReady()) {
    try {
      const sent = await sendTwilioSms(to, message);
      return { sent: true, simulated: false, provider: "twilio", providerId: sent.sid };
    } catch (err) {
      console.error("Twilio SMS error:", err.message);
    }
  }
  const simulated = recordSms(to, message, reference);
  return { sent: true, simulated: true, provider: "simulation", providerId: simulated.id };
}

async function createPaymentLink(session) {
  const reference = `CTB-${Math.floor(100000 + Math.random() * 900000)}`;
  const amount = estimateFare(session);
  const deadline = paymentDeadline(session);
  const payment = {
    reference, amount, deadline, status: "pending",
    route: `${session.from} to ${session.to}`,
    date: session.date, departureTime: session.departureTime,
    journeyType: session.journeyType, passenger: session.name, age: session.age
  };
  payments.set(reference, payment);
  return { ...payment, url: `${PUBLIC_BASE_URL}/pay/${reference}` };
}

// ─── LLM (GOOGLE GEMINI) ────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.0-flash";

function geminiReady() { return Boolean(GEMINI_API_KEY); }

// Per-browser-session conversation histories  (sessionId → messages[])
const chatHistories = new Map();

const SYSTEM_PROMPT = `You are a friendly Indian railway ticket booking voice assistant. You help callers book train tickets over the phone or chat.

Your job is to collect these booking details one by one through natural conversation:
1. Journey type: "Reserved" or "Unreserved" (local/general = Unreserved; sleeper/AC/chair car = Reserved)
2. Source station (from): one of Delhi, Mumbai, Chennai, Bengaluru, Kolkata, Hyderabad, Pune, Ahmedabad, Jaipur, Lucknow
3. Destination station (to): one of the same list above
4. Travel date: in YYYY-MM-DD format (interpret "today", "tomorrow", "kal", "aaj" etc. relative to the current date which is {{TODAY}})
5. Departure time: in HH:MM 24-hour format (interpret "9:30 AM" as "09:30", "2 PM" as "14:00")
6. Passenger name
7. Passenger age

Rules:
- Be conversational, warm, and concise. Keep responses to 1-2 sentences.
- If the user gives multiple details at once, extract all of them.
- If a detail is missing, ask for the NEXT missing one naturally.
- Understand both English and Hindi (transliterated). For example "Delhi se Mumbai kal" means "from Delhi to Mumbai tomorrow".
- When ALL details are collected, summarize the booking and ask the user to say "confirm" to proceed or "cancel" to start over.
- If the user says confirm/yes/haan/proceed and all details are filled, set "confirmed" to true.
- If the user says cancel/reset/start over/dobara, set "reset" to true.
- You MUST respond with valid JSON only. No markdown, no code fences. Just raw JSON.

Respond ONLY with a JSON object in this exact format (no extra text, no markdown):
{
  "reply": "Your conversational response to the user",
  "slots": {
    "journeyType": "",
    "from": "",
    "to": "",
    "date": "",
    "departureTime": "",
    "name": "",
    "age": ""
  },
  "confirmed": false,
  "reset": false
}

The "slots" object should contain ALL slot values collected so far across the entire conversation (not just from the latest message). Leave a slot as "" if not yet known. Use the canonical station names (Delhi, Mumbai, Chennai, Bengaluru, Kolkata, Hyderabad, Pune, Ahmedabad, Jaipur, Lucknow). Use "Reserved" or "Unreserved" for journeyType.`;

function buildSystemPrompt() {
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return SYSTEM_PROMPT.replace("{{TODAY}}", dateStr);
}

async function callGemini(sessionId, userMessage) {
  // Manage conversation history
  if (!chatHistories.has(sessionId)) {
    chatHistories.set(sessionId, []);
  }
  const history = chatHistories.get(sessionId);
  history.push({ role: "user", parts: [{ text: userMessage }] });

  // Keep history manageable (last 20 turns)
  if (history.length > 40) history.splice(0, history.length - 40);

  const body = JSON.stringify({
    system_instruction: { parts: [{ text: buildSystemPrompt() }] },
    contents: history,
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 512
    }
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(json.error.message || JSON.stringify(json.error)));
            return;
          }
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
          // Add assistant response to history
          history.push({ role: "model", parts: [{ text }] });
          resolve(text);
        } catch (e) {
          reject(new Error(`Gemini parse error: ${e.message} — raw: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function parseGeminiResponse(raw) {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  try {
    const parsed = JSON.parse(cleaned);
    return {
      reply: parsed.reply || "",
      slots: {
        journeyType: parsed.slots?.journeyType || "",
        from: parsed.slots?.from || "",
        to: parsed.slots?.to || "",
        date: parsed.slots?.date || "",
        departureTime: parsed.slots?.departureTime || "",
        name: parsed.slots?.name || "",
        age: parsed.slots?.age || ""
      },
      confirmed: Boolean(parsed.confirmed),
      reset: Boolean(parsed.reset)
    };
  } catch {
    // If LLM didn't return valid JSON, return the text as reply
    return {
      reply: raw.trim(),
      slots: { journeyType: "", from: "", to: "", date: "", departureTime: "", name: "", age: "" },
      confirmed: false,
      reset: false
    };
  }
}

// ─── API HANDLERS ────────────────────────────────────────────────────────────

async function handleApi(req, res, url) {
  // GET /api/call/config
  if (url.pathname === "/api/call/config" && req.method === "GET") {
    const provider = liveProvider();
    sendJson(res, 200, {
      ready: provider !== "simulation",
      provider,
      mode: provider === "simulation" ? "simulation" : "live",
      callableNumber: activePhoneNumber(),
      dummyTollFreeNumber: DUMMY_TOLL_FREE_NUMBER,
      exotel: {
        configured: exotelReady(),
        exophone: EXOTEL_EXOPHONE,
        trialNumber: EXOTEL_TRIAL_NUMBER,
        appId: EXOTEL_APP_ID,
        flowUrl: exotelReady() ? exotelFlowUrl() : "",
        voicebotConfigUrl: `${PUBLIC_BASE_URL}/exotel/voicebot-config`,
        voicebotWsUrl: `${publicWsBaseUrl()}/exotel/voicebot`,
        outboundStatusCallback: `${PUBLIC_BASE_URL}/exotel/status`,
        passthruUrl: `${PUBLIC_BASE_URL}/exotel/passthru`
      },
      publicBaseUrl: PUBLIC_BASE_URL,
      inboundWebhook: `${PUBLIC_BASE_URL}/voice/incoming`,
      supportsSmsPaymentLinks: exotelReady() || twilioReady(),
      supportsSimulatedSms: true,
      simulatorEndpoint: "/api/simulate/call",
      requiredEnv: {
        exotel: ["EXOTEL_ACCOUNT_SID", "EXOTEL_API_KEY", "EXOTEL_API_TOKEN", "EXOTEL_EXOPHONE", "EXOTEL_APP_ID", "PUBLIC_BASE_URL"],
        twilio: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "PUBLIC_BASE_URL"]
      }
    });
    return;
  }

  // POST /api/call/start
  if (url.pathname === "/api/call/start" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const toRaw = String(body.to || "").trim();
    const to = toE164(toRaw) || toRaw;
    if (!/^\+[1-9]\d{7,14}$/.test(to)) {
      sendJson(res, 400, { ok: false, error: "Enter a valid phone number, e.g. +918897587467 or 8897587467." });
      return;
    }
    const provider = liveProvider();
    if (provider === "simulation") {
      sendJson(res, 200, { ok: true, simulated: true, callSid: `SIM-${Date.now()}`, status: "simulated", message: `No live provider configured. Dummy number: ${DUMMY_TOLL_FREE_NUMBER}.` });
      return;
    }
    try {
      if (provider === "exotel") {
        const result = await startExotelCall(to);
        const call = result.Call || result.call || result;
        sendJson(res, 200, { ok: true, provider, callSid: call.Sid || call.sid || "", status: call.Status || call.status || "requested" });
        return;
      }
      const call = await startTwilioCall(to);
      sendJson(res, 200, { ok: true, provider, callSid: call.sid, status: call.status });
    } catch (err) {
      sendJson(res, 502, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/payment/create
  if (url.pathname === "/api/payment/create" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const session = { from: body.from, to: body.to, date: body.date, departureTime: body.departureTime, journeyType: body.journeyType, name: body.name, age: body.age };
    if (!isComplete(session)) { sendJson(res, 400, { ok: false, error: "Missing booking details." }); return; }
    if (!canStillPay(session)) { sendJson(res, 400, { ok: false, error: "Payment is closed — less than 15 minutes before departure." }); return; }
    const payment = await createPaymentLink(session);
    sendJson(res, 200, { ok: true, payment });
    return;
  }

  // GET /api/sms/outbox
  if (url.pathname === "/api/sms/outbox" && req.method === "GET") {
    sendJson(res, 200, { ok: true, messages: smsOutbox.slice().reverse() });
    return;
  }

  // GET /api/voicebot/events
  if (url.pathname === "/api/voicebot/events" && req.method === "GET") {
    sendJson(res, 200, { ok: true, events: voicebotEvents.slice(-50).reverse() });
    return;
  }

  // POST /api/simulate/call
  if (url.pathname === "/api/simulate/call" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const from = String(body.from || "+919999999999");
    const callSid = `SIM-CALL-${Date.now()}`;
    const session = getSession(callSid);
    session.phone = from;
    const turns = Array.isArray(body.turns) ? body.turns : [String(body.speech || "")].filter(Boolean);
    const transcript = [];
    for (const turn of turns) {
      updateBooking(session, turn);
      transcript.push({ caller: turn, bot: nextPrompt(session), session: { ...session } });
    }
    let payment = null;
    if (body.confirm === true && isComplete(session)) {
      if (!canStillPay(session)) {
        transcript.push({ caller: "confirm", bot: "Payment is closed because less than 15 minutes remain before departure." });
      } else {
        payment = await createPaymentLink(session);
        const smsText = `Pay Rs ${payment.amount} for ticket ${payment.reference}: ${payment.url}. Pay before ${payment.deadline}.`;
        const sms = await sendPaymentSms(session.phone, smsText, payment.reference);
        transcript.push({ caller: "confirm", bot: `Payment link sent${sms.simulated ? " to simulated SMS outbox" : " by SMS"}. Reference ${payment.reference}.`, payment, sms });
      }
    }
    sessions.delete(callSid);
    sendJson(res, 200, { ok: true, callSid, from, dummyNumber: DUMMY_TOLL_FREE_NUMBER, payment, transcript });
    return;
  }

  // GET /api/chat/status
  if (url.pathname === "/api/chat/status" && req.method === "GET") {
    sendJson(res, 200, { ok: true, llmAvailable: geminiReady(), model: geminiReady() ? GEMINI_MODEL : "local-bot" });
    return;
  }

  // POST /api/chat
  if (url.pathname === "/api/chat" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const userMessage = String(body.message || "").trim();
    const sessionId = String(body.sessionId || `web-${Date.now()}`);

    if (!userMessage) {
      sendJson(res, 400, { ok: false, error: "No message provided." });
      return;
    }

    // ── LLM path ──
    if (geminiReady()) {
      try {
        const rawResponse = await callGemini(sessionId, userMessage);
        const parsed = parseGeminiResponse(rawResponse);

        const result = {
          ok: true,
          llm: true,
          reply: parsed.reply,
          slots: parsed.slots,
          confirmed: parsed.confirmed,
          reset: parsed.reset,
          payment: null
        };

        // If LLM says reset, clear chat history
        if (parsed.reset) {
          chatHistories.delete(sessionId);
        }

        // If LLM says confirmed and all slots are filled, create payment link
        if (parsed.confirmed) {
          const s = parsed.slots;
          const session = {
            from: s.from, to: s.to, date: s.date,
            departureTime: s.departureTime, journeyType: s.journeyType,
            name: s.name, age: s.age
          };
          if (isComplete(session)) {
            if (canStillPay(session)) {
              const payment = await createPaymentLink(session);
              result.payment = payment;
            } else {
              result.reply += " However, payment is closed because less than 15 minutes remain before departure. Please choose another train.";
              result.confirmed = false;
            }
          } else {
            result.confirmed = false;
          }
        }

        sendJson(res, 200, result);
      } catch (err) {
        console.error("Gemini chat error:", err.message);
        sendJson(res, 502, { ok: false, error: "LLM error: " + err.message, llm: true });
      }
      return;
    }

    // ── Fallback: deterministic bot ──
    const session = getSession(sessionId);
    const isReset = /\b(reset|cancel|start over|new ticket|dobara|shuru)\b/i.test(userMessage);
    if (isReset) {
      sessions.delete(sessionId);
      const freshSession = getSession(sessionId);
      sendJson(res, 200, {
        ok: true, llm: false,
        reply: "No problem, I have cleared the details. Please tell me your new journey.",
        slots: { journeyType: "", from: "", to: "", date: "", departureTime: "", name: "", age: "" },
        confirmed: false, reset: true, payment: null
      });
      return;
    }

    updateBooking(session, userMessage);

    const isConfirm = /\b(confirm|yes|book it|go ahead|proceed|haan|theek|ok)\b/i.test(userMessage) && isComplete(session);
    let payment = null;
    if (isConfirm) {
      if (canStillPay(session)) {
        payment = await createPaymentLink(session);
      }
    }

    sendJson(res, 200, {
      ok: true, llm: false,
      reply: isConfirm && payment ? `Your payment link is ready. Reference number ${payment.reference}. Pay before ${payment.deadline}.` : nextPrompt(session),
      slots: {
        journeyType: session.journeyType || "",
        from: session.from || "",
        to: session.to || "",
        date: session.date || "",
        departureTime: session.departureTime || "",
        name: session.name || "",
        age: session.age || ""
      },
      confirmed: Boolean(isConfirm && payment),
      reset: false,
      payment
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "API route not found." });
}

// ─── VOICE HANDLERS (Twilio TwiML + Exotel ExoML + Gemini AI) ───────────────

// Per-call Gemini conversation histories (callSid → messages[])
const callHistories = new Map();

async function callGeminiVoice(callSid, userSpeech, currentSession) {
  if (!callHistories.has(callSid)) callHistories.set(callSid, []);
  const history = callHistories.get(callSid);
  history.push({ role: "user", parts: [{ text: userSpeech }] });
  if (history.length > 30) history.splice(0, history.length - 30);

  const body = JSON.stringify({
    system_instruction: { parts: [{ text: buildSystemPrompt() }] },
    contents: history,
    generationConfig: { temperature: 0.3, maxOutputTokens: 256 }
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (r) => {
      let data = "";
      r.on("data", chunk => { data += chunk; });
      r.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) { reject(new Error(json.error.message)); return; }
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
          history.push({ role: "model", parts: [{ text }] });
          resolve(parseGeminiResponse(text));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function handleVoice(req, res, url) {
  // Always use ExoML for Exotel; detect by user-agent or query param
  const isExotel = true; // We are using Exotel exclusively

  const renderGather = (message) => exoml(message);
  const renderSay    = (message) => exomlSay(message);

  // ── GET or POST /voice/incoming — call starts ─────────────────────────────
  if (url.pathname === "/voice/incoming") {
    const body = req.method === "POST" ? querystring.parse(await readBody(req)) : {};
    const callSid = body.CallSid || body.callsid || body.CallId || `call-${Date.now()}`;
    const session = getSession(callSid);
    session.phone = callerPhoneFromWebhook(body);
    // Reset any old Gemini history for this call
    callHistories.delete(callSid);
    console.log(`[Call incoming] callSid=${callSid} from=${session.phone}`);
    const greeting = "Hello! Welcome to the ticket booking service. You can speak naturally. Please tell me: is your journey reserved, like a sleeper or AC train, or unreserved, like a local or general train?";
    send(res, 200, "text/xml; charset=utf-8", renderGather(greeting));
    return;
  }

  // ── POST /voice/process — caller spoke or transcription arrived ───────────
  if (url.pathname === "/voice/process") {
    const body = querystring.parse(await readBody(req));
    const speech = extractSpeech(body);
    const callSid = body.CallSid || body.callsid || body.CallId || "local-call";
    const session = getSession(callSid);
    console.log("----- VOICE DEBUG -----");
    console.log("Speech:", speech);
    console.log("Session BEFORE:", session);
    
    session.phone = callerPhoneFromWebhook(body) || session.phone;

    console.log(`[Call process] callSid=${callSid} speech="${speech}"`);

    // Empty speech — re-prompt
    if (!speech) {
      const prompt = nextPrompt(session) || "Please tell me your journey details.";
send(res, 200, "text/xml; charset=utf-8", renderGather(prompt));
      return;
    }

    // ── Try Gemini AI first ────────────────────────────────────────────────
    if (geminiReady()) {
      try {
        const parsed = await callGeminiVoice(callSid, speech, session);

        // Merge Gemini slots into session
        const s = parsed.slots;
        if (s.journeyType) session.journeyType = s.journeyType;
        if (s.from)        session.from        = s.from;
        if (s.to)          session.to          = s.to;
        if (s.date)        session.date        = s.date;
        if (s.departureTime) session.departureTime = s.departureTime;
        if (s.name)        session.name        = s.name;
        if (s.age)         session.age         = s.age;

        updateBooking(session, speech);

        // Reset
        if (parsed.reset) {
          sessions.delete(callSid);
          callHistories.delete(callSid);
          send(res, 200, "text/xml; charset=utf-8",
            renderGather("No problem. I have cleared your booking. Please tell me your new journey."));
          return;
        }

        // Confirmed + all slots filled → create payment
        if (parsed.confirmed && isComplete(session)) {
          if (!canStillPay(session)) {
            sessions.delete(callSid);
            callHistories.delete(callSid);
            send(res, 200, "text/xml; charset=utf-8",
              renderSay("Sorry, payment is now closed because less than 15 minutes remain before departure. Please call again for a different train. Thank you."));
            return;
          }
          const payment = await createPaymentLink(session);
          const smsText = `Pay Rs ${payment.amount} for ticket ${payment.reference}: ${payment.url}. Pay before ${payment.deadline}.`;
          let smsSent = false, simulated = false;
          if (session.phone) {
            try {
              const sms = await sendPaymentSms(session.phone, smsText, payment.reference);
              smsSent = true; simulated = sms.simulated;
            } catch (err) { console.error("SMS error:", err.message); }
          }
          sessions.delete(callSid);
          callHistories.delete(callSid);
          const smsMsg = smsSent && !simulated
            ? "I have sent the payment link to your phone by SMS."
            : "Your payment link is ready. Please check your SMS."
          send(res, 200, "text/xml; charset=utf-8",
            renderSay(`${smsMsg} Your reference number is ${payment.reference}. Please pay before ${payment.deadline}. Thank you for calling.`));
          return;
        }

        // Otherwise speak Gemini's reply
        const replyText = parsed.reply || nextPrompt(session);
        send(res, 200, "text/xml; charset=utf-8", renderGather(replyText));
        return;

      } catch (err) {
        console.error("[Gemini voice error]", err.message);
        // Fall through to deterministic bot
      }
    }

    // ── Deterministic fallback ────────────────────────────────────────────
    if (/\b(reset|cancel|start over|new ticket|dobara|shuru)\b/i.test(speech)) {
      sessions.delete(callSid);
      send(res, 200, "text/xml; charset=utf-8",
        renderGather("No problem. I have cleared the details. Please tell me your new journey."));
      return;
    }

    updateBooking(session, speech);

    if (/\b(confirm|yes|book|proceed|done|go ahead|haan|theek|ok)\b/i.test(speech)) {
  if (!isComplete(session)) {
    send(res, 200, "text/xml; charset=utf-8",
      renderGather("Please provide all details before confirming."));
    return;
  }
      if (!canStillPay(session)) {
        sessions.delete(callSid);
        send(res, 200, "text/xml; charset=utf-8",
          renderSay("Sorry, payment is closed. Please call again for a different train. Thank you."));
        return;
      }
      const payment = await createPaymentLink(session);
      const smsText = `Pay Rs ${payment.amount} for ticket ${payment.reference}: ${payment.url}. Pay before ${payment.deadline}.`;
      let smsSent = false, simulated = false;
      if (session.phone) {
        try {
          const sms = await sendPaymentSms(session.phone, smsText, payment.reference);
          smsSent = true; simulated = sms.simulated;
        } catch (err) { console.error("SMS error:", err.message); }
      }
      sessions.delete(callSid);
      const smsStatus = smsSent && !simulated
        ? "The payment link has been sent to your phone by SMS."
        : "A payment link has been created. Reference: " + payment.reference;
      send(res, 200, "text/xml; charset=utf-8",
        renderSay(`${smsStatus} Please pay before ${payment.deadline}. Thank you for calling.`));
      return;
    }

    send(res, 200, "text/xml; charset=utf-8", renderGather(nextPrompt(session)));
    return;
  }

  send(res, 404, "text/plain", "Voice route not found.");
}

// ─── EXOTEL HANDLERS ─────────────────────────────────────────────────────────

async function handleExotel(req, res, url) {
  // Voicebot config — returns WS URL for the Exotel Voicebot applet
  if (url.pathname === "/exotel/voicebot-config") {
    sendJson(res, 200, {
      ws_url: `${publicWsBaseUrl()}/exotel/voicebot`,
      websocket_url: `${publicWsBaseUrl()}/exotel/voicebot`,
      status_callback: `${PUBLIC_BASE_URL}/exotel/status`
    });
    return;
  }

  // Status / passthru / sms-status — log and acknowledge
  const params = req.method === "GET"
    ? Object.fromEntries(url.searchParams.entries())
    : querystring.parse(await readBody(req));

  const event = {
    receivedAt: new Date().toISOString(),
    route: url.pathname,
    callSid: params.CallSid || params.callsid || "",
    from: params.CallFrom || params.From || params.from || "",
    to: params.CallTo || params.To || params.to || "",
    status: params.CallStatus || params.Status || params.status || "",
    direction: params.Direction || params.direction || "",
    raw: params
  };

  console.log(`[Exotel] ${url.pathname}:`, JSON.stringify(event));
  voicebotEvents.push(event);
  sendJson(res, 200, { ok: true, event });
}

// ─── WEBSOCKET VOICEBOT (Exotel Voicebot / AgentStream) ─────────────────────
//
// This implements a text-based conversational bot over the Exotel Voicebot
// websocket protocol. Exotel sends JSON frames; we reply with JSON frames.
//
// Protocol summary (Exotel Voicebot):
//   → { event: "start",  callSid, from, to, ... }
//   → { event: "media",  payload: "<base64-mulaw-audio>" }   (if audio streaming)
//   → { event: "dtmf",   digit }
//   → { event: "speech", text: "..." }   (if ASR is enabled on Exotel side)
//   → { event: "stop" }
//
//   ← { event: "playback", text: "..." }  — ask Exotel TTS to speak
//   ← { event: "mark",     name: "..." }  — synchronisation marker
//   ← { event: "stop" }                   — hang up
//
// If Exotel sends raw speech text via the "speech" event, we can do full
// conversational booking without any additional AI model.
// ─────────────────────────────────────────────────────────────────────────────

function websocketAcceptKey(key) {
  return crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

// Build a WebSocket text frame (FIN + opcode 0x1)
function wsFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x81, 126, len >> 8, len & 0xff]);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// Decode incoming WebSocket frames (handles masking)
function parseWsFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let headerLen = 2;

    if (payloadLen === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }

    const maskOffset = offset + headerLen;
    const dataOffset = maskOffset + (masked ? 4 : 0);
    if (dataOffset + payloadLen > buffer.length) break;

    let data = buffer.subarray(dataOffset, dataOffset + payloadLen);
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      data = Buffer.from(data);
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    }

    frames.push({ opcode, data });
    offset = dataOffset + payloadLen;
  }
  return frames;
}

function handleVoicebotSocket(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }

  // Complete the WebSocket handshake
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${websocketAcceptKey(key)}`,
    "", ""
  ].join("\r\n"));

  // Per-call state
  let callSid = `WS-${Date.now()}`;
  let session = getSession(callSid);

  const sendJson_ = (obj) => {
    if (!socket.destroyed) socket.write(wsFrame(JSON.stringify(obj)));
  };

  const speak = (text) => {
    console.log(`[Voicebot → caller] "${text}"`);
    // Exotel Voicebot TTS playback event
    sendJson_({ event: "playback", text, language: "en-IN" });
  };

  const handleSpeech = async (text) => {
    if (!text) return;
    console.log(`[Voicebot ← caller] "${text}"`);
    voicebotEvents.push({ receivedAt: new Date().toISOString(), callSid, speech: text });

    // Reset
    if (/\b(reset|cancel|start over|new ticket|dobara|shuru)\b/i.test(text)) {
      sessions.delete(callSid);
      callSid = `WS-${Date.now()}`;
      session = getSession(callSid);
      speak("No problem. I have cleared the booking. Please tell me your new journey.");
      return;
    }

    updateBooking(session, text);

    // Confirm
    if (/\b(confirm|yes|book it|go ahead|proceed|haan|theek hai|ok)\b/i.test(text) && isComplete(session)) {
      if (!canStillPay(session)) {
        speak("Sorry, payment is now closed because less than 15 minutes remain before departure. Please call again for a different train. Goodbye.");
        sendJson_({ event: "stop" });
        sessions.delete(callSid);
        return;
      }
      const payment = await createPaymentLink(session);
      const smsText = `Pay Rs ${payment.amount} for ticket ${payment.reference}: ${payment.url}. Pay before ${payment.deadline}.`;
      let smsSent = false, simulated = false;
      if (session.phone) {
        try {
          const sms = await sendPaymentSms(session.phone, smsText, payment.reference);
          smsSent = true; simulated = sms.simulated;
        } catch (err) { console.error("SMS error:", err.message); }
      }
      const smsMsg = smsSent && !simulated ? "I have sent the payment link to your phone by SMS." : "Your payment link is ready.";
      speak(`${smsMsg} Your reference number is ${payment.reference}. Please pay before ${payment.deadline}. Thank you for calling.`);
      sendJson_({ event: "stop" });
      sessions.delete(callSid);
      return;
    }

    speak(nextPrompt(session));
  };

  // Greet immediately on connect
  voicebotEvents.push({ connectedAt: new Date().toISOString(), callSid, remoteAddress: socket.remoteAddress });
  speak("Hello! Welcome to the ticket booking service. Is your journey reserved or unreserved?");

  let buf = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const frames = parseWsFrames(buf);
    // Consume parsed bytes
    let consumed = 0;
    for (const frame of frames) {
      // Compute frame byte length to advance buf (re-parse header)
      consumed = buf.length; // simple: just reset after each batch
    }
    buf = Buffer.alloc(0); // reset accumulator after processing

    for (const frame of frames) {
      if (frame.opcode === 0x8) { // close
        socket.destroy();
        return;
      }
      if (frame.opcode === 0x9) { // ping → pong
        socket.write(wsFrame("pong")); // simplified
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) { // text or binary
        let msg;
        try { msg = JSON.parse(frame.data.toString("utf8")); } catch { continue; }

        voicebotEvents.push({ receivedAt: new Date().toISOString(), event: msg.event || "unknown", callSid });

        if (msg.event === "start") {
          callSid = msg.callSid || msg.call_sid || callSid;
          session = getSession(callSid);
          session.phone = msg.from || msg.From || session.phone || "";
          console.log(`[Voicebot start] callSid=${callSid} from=${session.phone}`);
        } else if (msg.event === "speech" && msg.text) {
          handleSpeech(msg.text).catch(console.error);
        } else if (msg.event === "dtmf" && msg.digit) {
          // Map DTMF to common answers for accessibility
          const dtmfMap = { "1": "reserved", "2": "unreserved", "9": "confirm", "0": "cancel" };
          const mapped = dtmfMap[String(msg.digit)] || msg.digit;
          handleSpeech(mapped).catch(console.error);
        } else if (msg.event === "stop") {
          sessions.delete(callSid);
          socket.destroy();
        }
      }
    }
  });

  socket.on("close", () => {
    voicebotEvents.push({ disconnectedAt: new Date().toISOString(), callSid });
    console.log(`[Voicebot disconnected] callSid=${callSid}`);
  });

  socket.on("error", (err) => {
    console.error(`[Voicebot error] callSid=${callSid}`, err.message);
  });
}

// ─── PAYMENT PAGE ────────────────────────────────────────────────────────────

function servePaymentPage(res, reference) {
  const payment = payments.get(reference);
  if (!payment) {
    send(res, 404, "text/html; charset=utf-8", "<h1>Payment link not found</h1>");
    return;
  }
  const expired = new Date() > new Date(payment.deadline.replace(" ", "T"));
  const disabledAttr = expired ? "disabled" : "";
  const statusNote = expired ? "<p style='color:#ba2e4a;font-weight:700'>⚠ Payment window has closed for this departure.</p>" : "";
  send(res, 200, "text/html; charset=utf-8", `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pay ${xml(payment.reference)}</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Arial,sans-serif;background:#f7f9fb;color:#172126}
    main{width:min(440px,calc(100% - 32px));background:#fff;border:1px solid #d7dde2;border-radius:8px;padding:28px;box-shadow:0 18px 50px rgba(27,40,51,.14)}
    h1{margin:0 0 4px;font-size:1.6rem}
    .ref{display:inline-block;padding:4px 10px;border-radius:6px;background:#f0f4ff;font-weight:800;color:#1f5eff;margin-bottom:16px}
    p{line-height:1.55;margin:6px 0}
    .amount{font-size:2rem;font-weight:800;color:#0b7a53;margin:16px 0}
    .deadline{color:#b05d00;font-weight:700}
    button{width:100%;min-height:48px;border:0;border-radius:8px;background:#0b7a53;color:#fff;font-weight:800;font-size:1.1rem;cursor:pointer;margin-top:20px}
    button:disabled{background:#aab4bc;cursor:not-allowed}
    .success{display:none;padding:14px;border-radius:8px;background:#e7f6ef;color:#075c40;font-weight:700;margin-top:16px;text-align:center}
  </style>
</head>
<body>
  <main>
    <h1>Ticket Payment</h1>
    <div class="ref">${xml(payment.reference)}</div>
    <p><strong>${xml(payment.journeyType)}</strong> journey</p>
    <p>🚆 ${xml(payment.route)}</p>
    <p>📅 ${xml(payment.date)} at ${xml(payment.departureTime)}</p>
    <p>👤 ${xml(payment.passenger)}, age ${xml(payment.age)}</p>
    <div class="amount">₹ ${xml(payment.amount)}</div>
    <p class="deadline">⏰ Pay before: ${xml(payment.deadline)}</p>
    ${statusNote}
    <button id="payBtn" ${disabledAttr} onclick="handlePay()">Pay Now ₹${xml(payment.amount)}</button>
    <div class="success" id="successMsg">✅ Payment successful! Your ticket is confirmed.<br>Reference: ${xml(payment.reference)}</div>
  </main>
  <script>
    function handlePay() {
      document.getElementById('payBtn').disabled = true;
      document.getElementById('payBtn').textContent = 'Processing...';
      setTimeout(() => {
        document.getElementById('payBtn').style.display = 'none';
        document.getElementById('successMsg').style.display = 'block';
      }, 1800);
    }
  </script>
</body>
</html>`);
}

// ─── HTTP SERVER ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type" });
      res.end();
      return;
    }

    const url = new URL(req.url, PUBLIC_BASE_URL);

    if (url.pathname.startsWith("/api/")) { await handleApi(req, res, url); return; }
    if (url.pathname.startsWith("/voice/")) { await handleVoice(req, res, url); return; }
    if (url.pathname.startsWith("/exotel/")) { await handleExotel(req, res, url); return; }
    if (url.pathname.startsWith("/pay/")) { servePaymentPage(res, decodeURIComponent(url.pathname.slice(5))); return; }
    serveStatic(req, res);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

// WebSocket upgrade (Exotel Voicebot)
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, PUBLIC_BASE_URL);
  if (url.pathname === "/exotel/voicebot") {
    handleVoicebotSocket(req, socket);
    return;
  }
  socket.destroy();
});

server.listen(PORT, () => {
  console.log("─────────────────────────────────────────────────────────");
  console.log(`✅  Call Ticket app running at http://localhost:${PORT}`);
  console.log(`📱  ExoPhone: ${EXOTEL_EXOPHONE} (trial: ${EXOTEL_TRIAL_NUMBER})`);
  console.log(`🌐  Public URL: ${PUBLIC_BASE_URL}`);
  console.log(`📞  Inbound webhook: ${PUBLIC_BASE_URL}/voice/incoming`);
  console.log(`🤖  Voicebot WS:     ${publicWsBaseUrl()}/exotel/voicebot`);
  console.log(`🔧  Voicebot config: ${PUBLIC_BASE_URL}/exotel/voicebot-config`);
  console.log(`📊  Provider: ${liveProvider()} | Exotel ready: ${exotelReady()}`);
  console.log("─────────────────────────────────────────────────────────");
});