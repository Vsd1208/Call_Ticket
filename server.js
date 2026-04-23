const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const querystring = require("querystring");

loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const DUMMY_TOLL_FREE_NUMBER = process.env.DUMMY_TOLL_FREE_NUMBER || "+18005550199";
const EXOTEL_EXOPHONE = process.env.EXOTEL_EXOPHONE || "04048218468";
const EXOTEL_TRIAL_NUMBER = process.env.EXOTEL_TRIAL_NUMBER || "09513886363";
const EXOTEL_APP_ID = process.env.EXOTEL_APP_ID || "1230481";
const ROOT = __dirname;

const sessions = new Map();
const payments = new Map();
const smsOutbox = [];
const voicebotEvents = [];

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

const stations = [
  { name: "Delhi", aliases: ["delhi", "new delhi", "dilli"] },
  { name: "Mumbai", aliases: ["mumbai", "bombay"] },
  { name: "Chennai", aliases: ["chennai", "madras"] },
  { name: "Bengaluru", aliases: ["bengaluru", "bangalore"] },
  { name: "Kolkata", aliases: ["kolkata", "calcutta"] },
  { name: "Hyderabad", aliases: ["hyderabad"] },
  { name: "Pune", aliases: ["pune"] },
  { name: "Ahmedabad", aliases: ["ahmedabad"] },
  { name: "Jaipur", aliases: ["jaipur"] },
  { name: "Lucknow", aliases: ["lucknow"] }
];

const staticTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

function normalize(text) {
  return String(text || "").toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
}

function stationPattern() {
  return stations
    .flatMap((station) => station.aliases)
    .sort((a, b) => b.length - a.length)
    .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
}

function resolveStation(value) {
  const clean = normalize(value);
  const station = stations.find((item) => item.aliases.some((alias) => clean.includes(alias)));
  return station ? station.name : "";
}

function findStationAfter(text, words) {
  const pattern = stationPattern();
  for (const word of words) {
    const match = text.match(new RegExp(`${word}\\s+(${pattern})`, "i"));
    if (match) return resolveStation(match[1]);
  }
  return "";
}

function findAllStations(text) {
  return stations.filter((station) => station.aliases.some((alias) => text.includes(alias))).map((station) => station.name);
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDate(text) {
  const today = new Date();
  if (/\btoday\b|aaj/.test(text)) return formatDate(today);
  if (/\btomorrow\b|kal/.test(text)) {
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    return formatDate(tomorrow);
  }

  const iso = text.match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;

  const indian = text.match(/\b(0?[1-9]|[12]\d|3[01])[-/](0?[1-9]|1[0-2])[-/](20\d{2})\b/);
  if (indian) return `${indian[3]}-${indian[2].padStart(2, "0")}-${indian[1].padStart(2, "0")}`;

  return "";
}

function parseName(text) {
  const match = String(text || "").match(/\b(?:for|name is|passenger is|passenger name is|naam)\s+([a-zA-Z][a-zA-Z ]{1,28})(?:\s+age|\s+umar|$)/i);
  if (!match) return "";
  return match[1]
    .replace(/\b(age|umar|seat|ticket|book)\b.*$/i, "")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parseDirectName(text) {
  const clean = String(text || "").trim();
  if (!/^[a-zA-Z][a-zA-Z ]{1,28}$/.test(clean)) return "";
  if (stations.some((station) => station.aliases.includes(normalize(clean)))) return "";
  return clean.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parseAge(text) {
  const match = String(text || "").match(/\b(?:age|aged|umar)\s*(?:is)?\s*(\d{1,3})\b/i);
  if (match) return match[1];
  const direct = String(text || "").trim().match(/^(\d{1,3})$/);
  return direct ? direct[1] : "";
}

function parseSeat(text) {
  if (/\bwindow\b/i.test(text)) return "Window";
  if (/\baisle\b/i.test(text)) return "Aisle";
  if (/\blower\b/i.test(text)) return "Lower";
  if (/\bupper\b/i.test(text)) return "Upper";
  return "";
}

function parseJourneyType(text) {
  if (/\b(unreserved|general|local|suburban|ordinary)\b/i.test(text)) return "Unreserved";
  if (/\b(reserved|reservation|sleeper|chair car|ac|confirmed seat)\b/i.test(text)) return "Reserved";
  return "";
}

function parseDepartureTime(text) {
  const source = String(text || "").toLowerCase();
  let match = source.match(/\b(?:at|time|departure|departing|leaves|train time)\s*(?:is)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) match = source.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  if (!match) return "";

  let hour = Number(match[1]);
  const minute = Number(match[2] || "0");
  const meridiem = match[3];

  if (minute > 59 || hour > 24) return "";
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (!meridiem && hour === 24 && minute > 0) return "";

  return `${String(hour % 24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function departureDateTime(session) {
  if (!session.date || !session.departureTime) return null;
  const value = new Date(`${session.date}T${session.departureTime}:00`);
  return Number.isNaN(value.getTime()) ? null : value;
}

function paymentDeadline(session) {
  const departure = departureDateTime(session);
  if (!departure) return "";
  const deadline = new Date(departure);
  deadline.setMinutes(deadline.getMinutes() - 15);
  return `${formatDate(deadline)} ${String(deadline.getHours()).padStart(2, "0")}:${String(deadline.getMinutes()).padStart(2, "0")}`;
}

function canStillPay(session, now = new Date()) {
  const departure = departureDateTime(session);
  if (!departure) return false;
  const deadline = new Date(departure);
  deadline.setMinutes(deadline.getMinutes() - 15);
  return now <= deadline;
}

function estimateFare(session) {
  const base = session.journeyType === "Unreserved" ? 25 : 180;
  const routeFactor = session.from && session.to ? Math.abs(session.from.length - session.to.length) * 7 : 0;
  return base + routeFactor;
}

function updateBooking(session, rawText) {
  const text = normalize(rawText);
  const explicitFrom = findStationAfter(text, ["from", "se"]);
  const explicitTo = findStationAfter(text, ["to", "tak"]);
  const foundStations = findAllStations(text);

  if (explicitFrom) session.from = explicitFrom;
  if (explicitTo) session.to = explicitTo;
  if (!session.from && foundStations[0]) session.from = foundStations[0];
  if (!session.to && foundStations.find((station) => station !== session.from)) {
    session.to = foundStations.find((station) => station !== session.from);
  }

  const date = parseDate(text);
  const name = parseName(rawText) || (!session.name && session.from && session.to && session.date ? parseDirectName(rawText) : "");
  const age = parseAge(rawText);
  const seat = parseSeat(rawText);
  const journeyType = parseJourneyType(rawText);
  const departureTime = parseDepartureTime(rawText);

  if (date) session.date = date;
  if (name) session.name = name;
  if (age) session.age = age;
  if (seat) session.seat = seat;
  if (journeyType) session.journeyType = journeyType;
  if (departureTime) session.departureTime = departureTime;
}

function nextPrompt(session) {
  if (!session.journeyType) return "Is this journey reserved or unreserved, for example a local train?";
  if (!session.from) return "Which station are you starting from?";
  if (!session.to) return "Which station are you going to?";
  if (!session.date) return "What is your travel date?";
  if (!session.departureTime) return "What is the train departure time?";
  if (!session.name) return "What is the passenger name?";
  if (!session.age) return "What is the passenger age?";
  return `I have a ${session.journeyType.toLowerCase()} journey from ${session.from} to ${session.to} on ${session.date} at ${session.departureTime} for ${session.name}, age ${session.age}. Payment must be completed by ${paymentDeadline(session)}. Say confirm to send the payment link by SMS.`;
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

function xml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlGather(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/voice/process" method="POST" speechTimeout="auto" language="en-IN">
    <Say voice="alice" language="en-IN">${xml(message)}</Say>
  </Gather>
  <Say voice="alice" language="en-IN">I did not hear anything. Let us try again.</Say>
  <Redirect method="POST">/voice/incoming</Redirect>
</Response>`;
}

function twimlSay(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-IN">${xml(message)}</Say>
</Response>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function send(res, status, contentType, body) {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value, null, 2));
}

function publicWsBaseUrl() {
  const base = PUBLIC_BASE_URL.replace(/\/$/, "");
  if (base.startsWith("https://")) return base.replace("https://", "wss://");
  if (base.startsWith("http://")) return base.replace("http://", "ws://");
  return `ws://${base}`;
}

function serveStatic(req, res) {
  const requested = decodeURIComponent(new URL(req.url, PUBLIC_BASE_URL).pathname);
  const safePath = path.normalize(requested === "/" ? "/index.html" : requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    send(res, 403, "text/plain; charset=utf-8", "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "text/plain; charset=utf-8", "Not found");
      return;
    }
    send(res, 200, staticTypes[path.extname(filePath)] || "application/octet-stream", data);
  });
}

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

function recordSms(to, message, reference = "") {
  const item = {
    id: `SMS-${String(smsOutbox.length + 1).padStart(4, "0")}`,
    to,
    message,
    reference,
    simulated: true,
    createdAt: new Date().toISOString()
  };
  smsOutbox.push(item);
  return item;
}

function callerPhoneFromWebhook(body) {
  const configuredFrom = activePhoneNumber();
  const from = String(body.From || "");
  const to = String(body.To || "");

  if (configuredFrom && from === configuredFrom) return to;
  return from || to;
}

function startTwilioCall(to) {
  return new Promise((resolve, reject) => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    const postData = querystring.stringify({
      To: to,
      From: from,
      Url: `${PUBLIC_BASE_URL.replace(/\/$/, "")}/voice/incoming`
    });

    const req = https.request(
      {
        hostname: "api.twilio.com",
        path: `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`,
        method: "POST",
        auth: `${accountSid}:${authToken}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData)
        }
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(JSON.parse(body));
          } else {
            reject(new Error(`Twilio returned ${response.statusCode}: ${body}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

function exotelSubdomain() {
  return process.env.EXOTEL_SUBDOMAIN || "api.in.exotel.com";
}

function exotelFlowUrl() {
  return process.env.EXOTEL_FLOW_URL || `http://my.exotel.com/${process.env.EXOTEL_ACCOUNT_SID}/exoml/start_voice/${EXOTEL_APP_ID}`;
}

function startExotelCall(to) {
  return new Promise((resolve, reject) => {
    const accountSid = process.env.EXOTEL_ACCOUNT_SID;
    const apiKey = process.env.EXOTEL_API_KEY;
    const apiToken = process.env.EXOTEL_API_TOKEN;
    const postData = querystring.stringify({
      From: to,
      CallerId: EXOTEL_EXOPHONE,
      Url: exotelFlowUrl(),
      CallType: "trans",
      StatusCallback: `${PUBLIC_BASE_URL.replace(/\/$/, "")}/exotel/status`
    });

    const req = https.request(
      {
        hostname: exotelSubdomain(),
        path: `/v1/Accounts/${encodeURIComponent(accountSid)}/Calls/connect.json`,
        method: "POST",
        auth: `${apiKey}:${apiToken}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData)
        }
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(JSON.parse(body));
          } else {
            reject(new Error(`Exotel returned ${response.statusCode}: ${body}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

function sendTwilioSms(to, message) {
  return new Promise((resolve, reject) => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    const postData = querystring.stringify({ To: to, From: from, Body: message });

    const req = https.request(
      {
        hostname: "api.twilio.com",
        path: `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        method: "POST",
        auth: `${accountSid}:${authToken}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData)
        }
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(JSON.parse(body));
          } else {
            reject(new Error(`Twilio SMS returned ${response.statusCode}: ${body}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

function sendExotelSms(to, message) {
  return new Promise((resolve, reject) => {
    const accountSid = process.env.EXOTEL_ACCOUNT_SID;
    const apiKey = process.env.EXOTEL_API_KEY;
    const apiToken = process.env.EXOTEL_API_TOKEN;
    const postData = querystring.stringify({
      From: EXOTEL_EXOPHONE,
      To: to,
      Body: message,
      StatusCallback: `${PUBLIC_BASE_URL.replace(/\/$/, "")}/exotel/sms-status`
    });

    const req = https.request(
      {
        hostname: exotelSubdomain(),
        path: `/v1/Accounts/${encodeURIComponent(accountSid)}/Sms/send.json`,
        method: "POST",
        auth: `${apiKey}:${apiToken}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData)
        }
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(JSON.parse(body));
          } else {
            reject(new Error(`Exotel SMS returned ${response.statusCode}: ${body}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

async function sendPaymentSms(to, message, reference) {
  if (exotelReady()) {
    const sent = await sendExotelSms(to, message);
    const sms = sent.SMSMessage || sent.sms || sent;
    return { sent: true, simulated: false, provider: "exotel", providerId: sms.Sid || sms.sid || "" };
  }

  if (twilioReady()) {
    const sent = await sendTwilioSms(to, message);
    return { sent: true, simulated: false, provider: "twilio", providerId: sent.sid };
  }

  const simulated = recordSms(to, message, reference);
  return { sent: true, simulated: true, provider: "simulation", providerId: simulated.id };
}

async function createPaymentLink(session) {
  const reference = `CTB-${Math.floor(100000 + Math.random() * 900000)}`;
  const amount = estimateFare(session);
  const deadline = paymentDeadline(session);
  const payment = {
    reference,
    amount,
    deadline,
    status: "pending",
    route: `${session.from} to ${session.to}`,
    date: session.date,
    departureTime: session.departureTime,
    journeyType: session.journeyType,
    passenger: session.name,
    age: session.age
  };
  payments.set(reference, payment);
  return {
    ...payment,
    url: `${PUBLIC_BASE_URL.replace(/\/$/, "")}/pay/${reference}`
  };
}

async function handleApi(req, res, url) {
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
        flowUrl: process.env.EXOTEL_ACCOUNT_SID ? exotelFlowUrl() : "",
        voicebotConfigUrl: `${PUBLIC_BASE_URL.replace(/\/$/, "")}/exotel/voicebot-config`,
        voicebotWsUrl: `${publicWsBaseUrl()}/exotel/voicebot`,
        outboundStatusCallback: `${PUBLIC_BASE_URL.replace(/\/$/, "")}/exotel/status`,
        passthruUrl: `${PUBLIC_BASE_URL.replace(/\/$/, "")}/exotel/passthru`
      },
      publicBaseUrl: PUBLIC_BASE_URL,
      inboundWebhook: `${PUBLIC_BASE_URL.replace(/\/$/, "")}/voice/incoming`,
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

  if (url.pathname === "/api/call/start" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const to = String(body.to || "").trim();

    if (!/^\+[1-9]\d{7,14}$/.test(to)) {
      sendJson(res, 400, { ok: false, error: "Enter a phone number in E.164 format, for example +919876543210." });
      return;
    }

    const provider = liveProvider();
    if (provider === "simulation") {
      sendJson(res, 200, {
        ok: true,
        simulated: true,
        callSid: `SIM-${Date.now()}`,
        status: "simulated",
        message: `No live provider is configured. Use dummy number ${DUMMY_TOLL_FREE_NUMBER} for local testing, or set Twilio credentials for a real call.`
      });
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
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === "/api/payment/create" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const session = {
      from: body.from,
      to: body.to,
      date: body.date,
      departureTime: body.departureTime,
      journeyType: body.journeyType,
      name: body.name,
      age: body.age
    };

    if (!isComplete(session)) {
      sendJson(res, 400, { ok: false, error: "Missing booking details." });
      return;
    }

    if (!canStillPay(session)) {
      sendJson(res, 400, { ok: false, error: "Payment is closed because less than 15 minutes remain before departure." });
      return;
    }

    const payment = await createPaymentLink(session);
    sendJson(res, 200, { ok: true, payment });
    return;
  }

  if (url.pathname === "/api/sms/outbox" && req.method === "GET") {
    sendJson(res, 200, { ok: true, messages: smsOutbox.slice().reverse() });
    return;
  }

  if (url.pathname === "/api/voicebot/events" && req.method === "GET") {
    sendJson(res, 200, { ok: true, events: voicebotEvents.slice().reverse() });
    return;
  }

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
        transcript.push({
          caller: "confirm",
          bot: `Payment link sent${sms.simulated ? " to simulated SMS outbox" : " by SMS"}. Reference ${payment.reference}.`,
          payment,
          sms
        });
      }
    }

    sessions.delete(callSid);
    sendJson(res, 200, { ok: true, callSid, from, dummyNumber: DUMMY_TOLL_FREE_NUMBER, payment, transcript });
    return;
  }

  sendJson(res, 404, { ok: false, error: "API route not found." });
}

async function handleExotel(req, res, url) {
  if (url.pathname === "/exotel/voicebot-config") {
    sendJson(res, 200, {
      ws_url: `${publicWsBaseUrl()}/exotel/voicebot`,
      websocket_url: `${publicWsBaseUrl()}/exotel/voicebot`,
      status_callback: `${PUBLIC_BASE_URL.replace(/\/$/, "")}/exotel/status`
    });
    return;
  }

  const params = req.method === "GET" ? Object.fromEntries(url.searchParams.entries()) : querystring.parse(await readBody(req));
  const event = {
    receivedAt: new Date().toISOString(),
    route: url.pathname,
    callSid: params.CallSid || params.callsid || "",
    from: params.CallFrom || params.callfrom || params.From || params.from || "",
    to: params.CallTo || params.callto || params.To || params.to || "",
    status: params.CallStatus || params.callstatus || params.Status || params.status || "",
    direction: params.Direction || params.direction || "",
    recordingUrl: params.RecordingUrl || params.recordingurl || "",
    raw: params
  };

  console.log(`Exotel ${url.pathname}: ${JSON.stringify(event)}`);
  sendJson(res, 200, { ok: true, event });
}

function websocketAcceptKey(key) {
  return require("crypto")
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function sendWsFrame(socket, text) {
  const payload = Buffer.from(text);
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  socket.write(Buffer.concat([header, payload]));
}

function handleVoicebotSocket(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${websocketAcceptKey(key)}`,
    "",
    ""
  ].join("\r\n"));

  const event = {
    connectedAt: new Date().toISOString(),
    remoteAddress: socket.remoteAddress,
    note: "Voicebot websocket connected. This placeholder logs traffic; connect an AI speech engine here for live conversation."
  };
  voicebotEvents.push(event);
  sendWsFrame(socket, JSON.stringify({ type: "ready", message: "Call Ticket voicebot websocket connected." }));

  socket.on("data", (buffer) => {
    voicebotEvents.push({
      receivedAt: new Date().toISOString(),
      bytes: buffer.length,
      previewHex: buffer.subarray(0, 24).toString("hex")
    });
  });

  socket.on("close", () => {
    voicebotEvents.push({ disconnectedAt: new Date().toISOString() });
  });
}

async function handleVoice(req, res, url) {
  if (url.pathname === "/voice/incoming") {
    const body = req.method === "POST" ? querystring.parse(await readBody(req)) : {};
    const callSid = body.CallSid || "local-call";
    const session = getSession(callSid);
    session.phone = callerPhoneFromWebhook(body);
    send(res, 200, "text/xml; charset=utf-8", twimlGather("Hello. I am your ticket booking bot. You do not need internet for this call. First, is your journey reserved or unreserved, for example a local train?"));
    return;
  }

  if (url.pathname === "/voice/process") {
    const body = querystring.parse(await readBody(req));
    const callSid = body.CallSid || "local-call";
    const speech = String(body.SpeechResult || "");
    const session = getSession(callSid);
    session.phone = callerPhoneFromWebhook(body) || session.phone;

    if (/\b(reset|cancel|start over|new ticket)\b/i.test(speech)) {
      sessions.delete(callSid);
      send(res, 200, "text/xml; charset=utf-8", twimlGather("No problem. I cleared the booking details. Tell me the new journey."));
      return;
    }

    updateBooking(session, speech);

    if (/\b(confirm|yes|book it|go ahead|proceed)\b/i.test(speech) && isComplete(session)) {
      if (!canStillPay(session)) {
        sessions.delete(callSid);
        send(res, 200, "text/xml; charset=utf-8", twimlSay("Sorry, payment is closed for this train because less than 15 minutes remain before departure. Please start a new booking for another train."));
        return;
      }

      const payment = await createPaymentLink(session);
      const smsText = `Pay Rs ${payment.amount} for ticket ${payment.reference}: ${payment.url}. Pay before ${payment.deadline}.`;
      let smsSent = false;
      let simulatedSms = false;
      if (session.phone) {
        try {
          const sms = await sendPaymentSms(session.phone, smsText, payment.reference);
          smsSent = true;
          simulatedSms = sms.simulated;
        } catch (error) {
          console.error(error.message);
        }
      }
      sessions.delete(callSid);
      const smsStatus = smsSent && simulatedSms
        ? "I created a simulated SMS payment link because this server is not connected to a live phone provider."
        : smsSent
          ? "I have sent the payment link by SMS."
          : "Your payment link is ready, but SMS sending could not be completed.";
      send(res, 200, "text/xml; charset=utf-8", twimlSay(`${smsStatus} Please pay before ${payment.deadline}. Your ticket will be confirmed after payment. Reference number ${payment.reference}.`));
      return;
    }

    send(res, 200, "text/xml; charset=utf-8", twimlGather(nextPrompt(session)));
    return;
  }

  send(res, 404, "text/plain; charset=utf-8", "Voice route not found.");
}

function servePaymentPage(res, reference) {
  const payment = payments.get(reference);
  if (!payment) {
    send(res, 404, "text/html; charset=utf-8", "<h1>Payment link not found</h1>");
    return;
  }

  const disabled = new Date() > new Date(payment.deadline.replace(" ", "T")) ? "disabled" : "";
  send(
    res,
    200,
    "text/html; charset=utf-8",
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pay ${xml(payment.reference)}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Arial, sans-serif; background: #f7f9fb; color: #172126; }
    main { width: min(420px, calc(100% - 32px)); background: #fff; border: 1px solid #d7dde2; border-radius: 8px; padding: 24px; box-shadow: 0 18px 50px rgba(27, 40, 51, 0.14); }
    h1 { margin: 0 0 8px; }
    p { line-height: 1.5; }
    button { width: 100%; min-height: 46px; border: 0; border-radius: 8px; background: #0b7a53; color: #fff; font-weight: 800; }
    button:disabled { background: #aab4bc; }
  </style>
</head>
<body>
  <main>
    <h1>Payment Link</h1>
    <p><strong>${xml(payment.reference)}</strong></p>
    <p>${xml(payment.journeyType)} journey: ${xml(payment.route)}<br>${xml(payment.date)} at ${xml(payment.departureTime)}</p>
    <p>Passenger: ${xml(payment.passenger)}, age ${xml(payment.age)}</p>
    <p>Amount: <strong>Rs ${xml(payment.amount)}</strong><br>Pay before ${xml(payment.deadline)}</p>
    <button ${disabled}>Pay Now</button>
  </main>
</body>
</html>`
  );
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, PUBLIC_BASE_URL);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (url.pathname.startsWith("/voice/")) {
      await handleVoice(req, res, url);
      return;
    }

    if (url.pathname.startsWith("/exotel/")) {
      await handleExotel(req, res, url);
      return;
    }

    if (url.pathname.startsWith("/pay/")) {
      servePaymentPage(res, decodeURIComponent(url.pathname.replace("/pay/", "")));
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, PUBLIC_BASE_URL);
  if (url.pathname === "/exotel/voicebot") {
    handleVoicebotSocket(req, socket);
    return;
  }

  socket.destroy();
});

server.listen(PORT, () => {
  console.log(`Call Ticket app: http://localhost:${PORT}`);
  console.log(`Dummy toll-free number: ${DUMMY_TOLL_FREE_NUMBER}`);
  console.log(`Exotel ExoPhone: ${EXOTEL_EXOPHONE}`);
  console.log(`Inbound voice webhook: ${PUBLIC_BASE_URL.replace(/\/$/, "")}/voice/incoming`);
});
