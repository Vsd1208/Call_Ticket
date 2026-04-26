const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const querystring = require("querystring");
const crypto = require("crypto");

loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

// Dynamically resolve the base URL from the incoming request's Host header.
// This means ngrok/any tunnel works automatically even without PUBLIC_BASE_URL set.
function getBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const host = req && req.headers && req.headers.host;
  if (!host) return `http://localhost:${PORT}`;
  const proto =
    host.includes("ngrok") ||
    host.includes("localhost.run") ||
    host.includes("serveo") ||
    !host.includes("localhost")
      ? "https"
      : "http";
  return `${proto}://${host}`;
}

const DUMMY_TOLL_FREE_NUMBER = process.env.DUMMY_TOLL_FREE_NUMBER || "+18005550199";
const TWILIO_PHONE_NUMBER    = process.env.TWILIO_FROM_NUMBER || "";
const ROOT = __dirname;

const sessions      = new Map();
const payments      = new Map();
const smsOutbox     = [];
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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
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
  return String(text || "")
    .toLowerCase()
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

const MONTH_NUMBERS = {
  jan: "01", january: "01",
  feb: "02", february: "02",
  mar: "03", march: "03",
  apr: "04", april: "04",
  may: "05",
  jun: "06", june: "06",
  jul: "07", july: "07",
  aug: "08", august: "08",
  sep: "09", sept: "09", september: "09",
  oct: "10", october: "10",
  nov: "11", november: "11",
  dec: "12", december: "12"
};

function normalizeSpokenDate(text) {
  let clean = String(text || "").toLowerCase();
  const numberWords = {
    "thirty one": 31, "thirty-one": 31,
    "thirty": 30,
    "twenty nine": 29, "twenty-nine": 29,
    "twenty eight": 28, "twenty-eight": 28,
    "twenty seven": 27, "twenty-seven": 27,
    "twenty six": 26, "twenty-six": 26,
    "twenty five": 25, "twenty-five": 25,
    "twenty four": 24, "twenty-four": 24,
    "twenty three": 23, "twenty-three": 23,
    "twenty two": 22, "twenty-two": 22,
    "twenty one": 21, "twenty-one": 21,
    "twenty": 20,
    "nineteen": 19, "eighteen": 18, "seventeen": 17, "sixteen": 16, "fifteen": 15,
    "fourteen": 14, "thirteen": 13, "twelve": 12, "eleven": 11, "ten": 10,
    "nine": 9, "eight": 8, "seven": 7, "six": 6, "five": 5,
    "four": 4, "three": 3, "two": 2, "one": 1
  };
  const yearWords = {
    "twenty twenty six": 2026,
    "twenty twenty seven": 2027,
    "twenty twenty eight": 2028,
    "two thousand twenty six": 2026,
    "two thousand and twenty six": 2026,
    "two thousand twenty seven": 2027,
    "two thousand and twenty seven": 2027,
    "two thousand twenty eight": 2028,
    "two thousand and twenty eight": 2028
  };

  for (const [phrase, value] of Object.entries(yearWords)) {
    clean = clean.replace(new RegExp(`\\b${phrase}\\b`, "g"), String(value));
  }
  for (const [phrase, value] of Object.entries(numberWords)) {
    clean = clean.replace(new RegExp(`\\b${phrase}\\b`, "g"), String(value));
  }
  return clean;
}

function normalizeYear(year) {
  const y = String(year || "");
  if (/^\d{2}$/.test(y)) return `20${y}`;
  return y;
}

function validDateParts(day, month, year) {
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  if (y < 2000 || y > 2099 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

function parseDate(text) {
  const source = normalizeSpokenDate(text);
  const today = new Date();
  if (/\btoday\b|aaj/.test(source)) return formatDate(today);
  if (/\btomorrow\b|kal/.test(source)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return formatDate(d);
  }
  const daysMatch = source.match(/\bafter\s+(\d+)\s+days?\b/i);
  if (daysMatch) {
    const d = new Date(today);
    d.setDate(d.getDate() + Number(daysMatch[1]));
    return formatDate(d);
  }
  const iso = source.match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const indian = source.match(/\b(0?[1-9]|[12]\d|3[01])[-/](0?[1-9]|1[0-2])[-/](20\d{2}|\d{2})\b/);
  if (indian) {
    const year = normalizeYear(indian[3]);
    if (validDateParts(indian[1], indian[2], year)) return `${year}-${indian[2].padStart(2, "0")}-${indian[1].padStart(2, "0")}`;
  }
  const spacedIndian = source.match(/\b(0?[1-9]|[12]\d|3[01])\s+(0?[1-9]|1[0-2])\s+(20\d{2}|\d{2})\b/);
  if (spacedIndian) {
    const year = normalizeYear(spacedIndian[3]);
    if (validDateParts(spacedIndian[1], spacedIndian[2], year)) return `${year}-${spacedIndian[2].padStart(2, "0")}-${spacedIndian[1].padStart(2, "0")}`;
  }
  const monthName = source.match(/\b(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\s+([a-z]+)\s+(20\d{2}|\d{2})\b/i);
  if (monthName && MONTH_NUMBERS[monthName[2]]) {
    const month = MONTH_NUMBERS[monthName[2]];
    const year = normalizeYear(monthName[3]);
    if (validDateParts(monthName[1], month, year)) return `${year}-${month}-${monthName[1].padStart(2, "0")}`;
  }
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
  if (/\baisle\b/i.test(text))  return "Aisle";
  if (/\blower\b/i.test(text))  return "Lower";
  if (/\bupper\b/i.test(text))  return "Upper";
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
  if (applyTrainSelection(session, rawText)) return;

  const oldFrom = session.from;
  const oldTo = session.to;
  const text = normalize(rawText);
  const ef = findStationAfter(text, ["from", "se"]);
  const et = findStationAfter(text, ["to", "tak"]);
  const all = findAllStations(text);
  if (ef) session.from = ef;
  if (et) session.to   = et;
  if (!session.from && all[0]) session.from = all[0];
  if (!session.to) {
    const other = all.find(s => s !== session.from);
    if (other) session.to = other;
  }
  const date    = parseDate(text);
  const name    = parseName(rawText) || (!session.name && session.from && session.to && session.date ? parseDirectName(rawText) : "");
  const age     = parseAge(rawText);
  const seat    = parseSeat(rawText);
  const jt      = parseJourneyType(rawText);
  const depTime = parseDepartureTime(rawText);
  if (date)    session.date          = date;
  if (name)    session.name          = name;
  if (age)     session.age           = age;
  if (seat)    session.seat          = seat;
  if (jt)      session.journeyType   = jt;
  if (depTime) session.departureTime = depTime;

  if (session.from !== oldFrom || session.to !== oldTo) {
    session.trainOptions = [];
    session.trainSelected = "";
  }
}

// ─── STATION CODE MAP ────────────────────────────────────────────────────────

const STATION_CODE_MAP = {
  chennai:   "MAS",
  hyderabad: "HYB",
  delhi:     "NDLS",
  mumbai:    "CST",
  bangalore: "SBC",
  bengaluru: "SBC",
  kolkata:   "HWH",
  pune:      "PUNE",
  ahmedabad: "ADI",
  jaipur:    "JP",
  lucknow:   "LKO"
};

function normalizeCity(name) {
  return STATION_CODE_MAP[name.toLowerCase().trim()] || null;
}

// ─── TRAINS BETWEEN STATIONS (RapidAPI) ──────────────────────────────────────

const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || "trains.p.rapidapi.com";
const RAPIDAPI_PATH_TEMPLATE =
  process.env.RAPIDAPI_PATH_TEMPLATE || "/v1/railways/trains/{from}/{to}";

function rapidApiPath(fromCode, toCode) {
  return RAPIDAPI_PATH_TEMPLATE
    .replaceAll("{from}", encodeURIComponent(fromCode))
    .replaceAll("{to}", encodeURIComponent(toCode));
}

function firstValue(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function findTrainArray(value, depth = 0) {
  if (!value || depth > 4) return [];
  if (Array.isArray(value)) {
    if (
      value.some(item =>
        item && typeof item === "object" &&
        firstValue(item, ["train_name", "trainName", "name", "train_number", "trainNumber", "number"])
      )
    ) {
      return value;
    }
    for (const item of value) {
      const nested = findTrainArray(item, depth + 1);
      if (nested.length) return nested;
    }
    return [];
  }
  if (typeof value === "object") {
    for (const key of ["data", "trains", "train", "results", "response", "body"]) {
      const nested = findTrainArray(value[key], depth + 1);
      if (nested.length) return nested;
    }
    for (const nestedValue of Object.values(value)) {
      const nested = findTrainArray(nestedValue, depth + 1);
      if (nested.length) return nested;
    }
  }
  return [];
}

function normalizeTrain(raw, index) {
  const number = raw.train_number || raw.trainNumber || raw.number || "";

  const name =
    raw.train_name ||
    raw.trainName ||
    raw.name ||
    (number ? `Train ${number}` : `Train option ${index + 1}`);

  // 🎯 IRCTC uses "from_std" for departure time
  const time =
    raw.from_std ||
    raw.departure_time ||
    raw.departureTime ||
    raw.start_time ||
    "--:--";

  return {
    number: number || "",
    name: name || `Train option ${index + 1}`,
    time: time || "--:--"
  };
}

async function getTrains(from, to) {
  const fromCode = normalizeCity(from);
  const toCode   = normalizeCity(to);

  if (!fromCode || !toCode) {
    return [{ name: "Invalid stations", time: "" }];
  }

  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";
  if (!RAPIDAPI_KEY) {
    console.warn("[RapidAPI] RAPIDAPI_KEY not set — returning placeholder trains.");
    return [
      { name: "Sample Express", time: "06:00" },
      { name: "Rajdhani Express", time: "14:30" },
      { name: "Shatabdi Express", time: "20:00" }
    ];
  }

  return new Promise((resolve) => {
    const options = {
      hostname: RAPIDAPI_HOST,
      path: rapidApiPath(fromCode, toCode),
      method: "GET",
      headers: {
        "x-rapidapi-key":  RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST
      }
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            console.error(`[RapidAPI] HTTP ${res.statusCode}: ${body.slice(0, 300)}`);
            resolve([{ name: "Error fetching trains", time: "" }]);
            return;
          }
          const data = JSON.parse(body);
          const trains = findTrainArray(data);
          if (trains.length === 0) {
            resolve([{ name: "No trains found", time: "" }]);
            return;
          }
          resolve(trains.slice(0, 5).map(normalizeTrain));
        } catch (err) {
          console.error("[RapidAPI] Parse error:", err.message);
          resolve([{ name: "Error fetching trains", time: "" }]);
        }
      });
    });

    req.on("error", (err) => {
      console.error("[RapidAPI] Request error:", err.message);
      resolve([{ name: "Error fetching trains", time: "" }]);
    });

    req.setTimeout(10000, () => {
      req.destroy(new Error("RapidAPI request timed out"));
    });

    req.end();
  });
}

function trainOptionLabel(train) {
  const number = train.number ? `${train.number} ` : "";
  return `${number}${train.name}`.trim();
}

function isPlaceholderTrain(train) {
  return /^(invalid stations|no trains found|error fetching trains)$/i.test(train.name || "");
}

function applyTrainSelection(session, rawText) {
  if (!session || session.trainSelected || !Array.isArray(session.trainOptions)) return false;
  const options = session.trainOptions.filter(t => !isPlaceholderTrain(t));
  if (!options.length) return false;

  const text = normalize(rawText);
  const digit = String(rawText || "").match(/\b([1-5])\b/);
  let selected = null;
  if (digit) selected = options[Number(digit[1]) - 1] || null;
  if (!selected) {
    selected = options.find(t => {
      const number = normalize(t.number);
      const name = normalize(t.name);
      return (number && text.includes(number)) || (name && text.includes(name));
    }) || null;
  }
  if (!selected) return false;

  session.trainSelected = trainOptionLabel(selected);
  if (selected.time) session.departureTime = selected.time;
  return true;
}

function needsTrainSelection(session) {
  if (!session.from || !session.to || !session.date || session.trainSelected) return false;
  return !(Array.isArray(session.trainOptions) && session.trainOptions.length > 0 && session.trainOptions.every(isPlaceholderTrain));
}

// ─── SESSION MANAGEMENT ──────────────────────────────────────────────────────

function getSession(callSid) {
  const key = callSid || "local-call";
  if (!sessions.has(key)) {
    sessions.set(key, {
      from: "",
      to: "",
      date: "",
      departureTime: "",
      name: "",
      age: "",
      seat: "Any",
      journeyType: "",
      phone: "",
      trainOptions: [],
      trainSelected: ""
    });
  }
  return sessions.get(key);
}

function isComplete(session) {
  return Boolean(
    session.journeyType &&
    session.from &&
    session.to &&
    session.date &&
    session.departureTime &&
    session.name &&
    session.age
  );
}

// ─── NEXT PROMPT ─────────────────────────────────────────────────────────────

async function nextPrompt(session) {
  if (!session.journeyType)  return "Is this journey reserved or unreserved? You can say it, or press 1 for reserved and 2 for unreserved.";
  if (!session.from)         return "Which station are you starting from?";
  if (!session.to)           return "Which station are you going to?";
  if (!session.date)         return "What is your travel date?";

  // Train selection
  if (!session.trainSelected) {
    if (!session.trainOptions || session.trainOptions.length === 0) {
      const trains = await getTrains(session.from, session.to);
      session.trainOptions = trains;
      if (trains.every(isPlaceholderTrain)) {
        return `${trains[0].name}. Please tell me the train departure time.`;
      }
      let msg = "I found these trains: ";
      trains.forEach((t, i) => { msg += `${i + 1}. ${trainOptionLabel(t)}${t.time ? " at " + t.time : ""}. `; });
      msg += "Which train do you prefer?";
      return msg;
    }
    if (session.trainOptions.every(isPlaceholderTrain)) {
      if (!session.departureTime) return "Please tell me the train departure time.";
    } else {
      return "Please tell me which train you prefer by number or name.";
    }
  }

  if (!session.departureTime) return "What is the train departure time?";

  if (!session.name) return "What is the passenger name?";
  if (!session.age)  return "What is the passenger age?";

  if (!canStillPay(session))
    return "Sorry, the payment window has closed. Please choose another train.";

  return (
    `You are traveling from ${session.from} to ${session.to} on ${session.date} ` +
    `by ${session.trainSelected} at ${session.departureTime}. ` +
    `Passenger ${session.name}, age ${session.age}. ` +
    `Please say confirm to proceed or cancel to restart.`
  );
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

// Twilio TwiML: Gather (speech + DTMF)
function twimlGather(message, baseUrl, lang = "en-IN") {
  const processUrl = `${baseUrl}/voice/process`;
  const incomingUrl = `${baseUrl}/voice/incoming`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" action="${xml(processUrl)}" method="POST" timeout="10" speechTimeout="auto" actionOnEmptyResult="true" language="${lang}" hints="reserved,unreserved,confirm,cancel,Delhi,Mumbai,Chennai,Bengaluru,Kolkata,Hyderabad,Pune,Ahmedabad,Jaipur,Lucknow">
    <Say voice="alice" language="${lang}">${xml(message)}</Say>
  </Gather>
  <Say voice="alice" language="${lang}">I did not hear anything. Let me try again.</Say>
  <Redirect method="POST">${xml(incomingUrl)}</Redirect>
</Response>`;
}

// Twilio TwiML: Say + Hangup
function twimlSay(message, lang = "en-IN") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="${lang}">${xml(message)}</Say>
  <Hangup/>
</Response>`;
}

function extractSpeech(body) {
  const raw = String(
    body.TranscriptionText ||
    body.SpeechResult ||
    body.speech ||
    body.text ||
    body.transcript ||
    body.Digits ||
    body.digits ||
    ""
  ).trim();
  const dtmfMap = { "1": "reserved", "2": "unreserved", "9": "confirm", "0": "cancel" };
  return dtmfMap[raw] || raw;
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

function publicWsBaseUrl(req) {
  const base = getBaseUrl(req);
  if (base.startsWith("https://")) return base.replace("https://", "wss://");
  if (base.startsWith("http://"))  return base.replace("http://", "ws://");
  return `ws://${base}`;
}

const staticTypes = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md":   "text/markdown; charset=utf-8"
};

function serveStatic(req, res) {
  const requested = decodeURIComponent(new URL(req.url, getBaseUrl(req)).pathname);
  const safePath  = path.normalize(requested === "/" ? "/index.html" : requested).replace(/^(\.\.[\\/])+/, "");
  const filePath  = path.join(ROOT, safePath);
  if (!filePath.startsWith(ROOT)) { send(res, 403, "text/plain", "Forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { send(res, 404, "text/plain", "Not found"); return; }
    send(res, 200, staticTypes[path.extname(filePath)] || "application/octet-stream", data);
  });
}

// ─── PROVIDER DETECTION ──────────────────────────────────────────────────────

function twilioReady() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER
  );
}

function liveProvider() {
  if (twilioReady()) return "twilio";
  return "simulation";
}

function activePhoneNumber() {
  if (twilioReady()) return process.env.TWILIO_FROM_NUMBER;
  return DUMMY_TOLL_FREE_NUMBER;
}

// ─── HTTP HELPERS ────────────────────────────────────────────────────────────

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

// ─── TWILIO CALL & SMS ───────────────────────────────────────────────────────

function startTwilioCall(to, baseUrl) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_FROM_NUMBER;
  const postData   = querystring.stringify({ To: to, From: from, Url: `${baseUrl}/voice/incoming` });
  return httpsPost({
    hostname: "api.twilio.com",
    path:     `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`,
    method:   "POST",
    auth:     `${accountSid}:${authToken}`,
    headers:  { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(postData) }
  }, postData);
}

function sendTwilioSms(to, message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_FROM_NUMBER;
  const postData   = querystring.stringify({ To: to, From: from, Body: message });
  return httpsPost({
    hostname: "api.twilio.com",
    path:     `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    method:   "POST",
    auth:     `${accountSid}:${authToken}`,
    headers:  { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(postData) }
  }, postData);
}

// ─── SMS OUTBOX / PAYMENT SMS ────────────────────────────────────────────────

function recordSms(to, message, reference = "") {
  const item = {
    id:        `SMS-${String(smsOutbox.length + 1).padStart(4, "0")}`,
    to, message, reference,
    simulated: true,
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

async function sendPaymentSms(to, message, reference, baseUrl) {
  if (twilioReady()) {
    try {
      const sent = await sendTwilioSms(to, message);
      return { sent: true, simulated: false, provider: "twilio", providerId: sent.sid };
    } catch (err) {
      console.error("[Twilio SMS error]", err.message);
    }
  }
  const simulated = recordSms(to, message, reference);
  return { sent: true, simulated: true, provider: "simulation", providerId: simulated.id };
}

async function createPaymentLink(session, req) {
  const reference = `CTB-${Math.floor(100000 + Math.random() * 900000)}`;
  const amount    = estimateFare(session);
  const deadline  = paymentDeadline(session);
  const payment   = {
    reference, amount, deadline, status: "pending",
    route:       `${session.from} to ${session.to}`,
    date:         session.date,
    departureTime: session.departureTime,
    journeyType:   session.journeyType,
    passenger:     session.name,
    age:           session.age
  };
  payments.set(reference, payment);
  return { ...payment, url: `${getBaseUrl(req)}/pay/${reference}` };
}

// ─── LLM (GOOGLE GEMINI) ─────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL   = "gemini-2.0-flash";

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
  const today   = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return SYSTEM_PROMPT.replace("{{TODAY}}", dateStr);
}

async function callGemini(sessionId, userMessage) {
  if (!chatHistories.has(sessionId)) chatHistories.set(sessionId, []);
  const history = chatHistories.get(sessionId);
  history.push({ role: "user", parts: [{ text: userMessage }] });
  if (history.length > 40) history.splice(0, history.length - 40);

  const body = JSON.stringify({
    system_instruction: { parts: [{ text: buildSystemPrompt() }] },
    contents: history,
    generationConfig: { temperature: 0.3, maxOutputTokens: 512 }
  });

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  return new Promise((resolve, reject) => {
    const parsed = new URL(apiUrl);
    const req = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) { reject(new Error(json.error.message || JSON.stringify(json.error))); return; }
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
          history.push({ role: "model", parts: [{ text }] });
          resolve(text);
        } catch (e) {
          reject(new Error(`Gemini parse error: ${e.message} — raw: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error("Gemini request timed out"));
    });
    req.write(body);
    req.end();
  });
}

function parseGeminiResponse(raw) {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  try {
    const parsed = JSON.parse(cleaned);
    return {
      reply:     parsed.reply || "",
      slots: {
        journeyType:   parsed.slots?.journeyType   || "",
        from:          parsed.slots?.from          || "",
        to:            parsed.slots?.to            || "",
        date:          parsed.slots?.date          || "",
        departureTime: parsed.slots?.departureTime || "",
        name:          parsed.slots?.name          || "",
        age:           parsed.slots?.age           || ""
      },
      confirmed: Boolean(parsed.confirmed),
      reset:     Boolean(parsed.reset)
    };
  } catch {
    return {
      reply:     raw.trim(),
      slots:     { journeyType: "", from: "", to: "", date: "", departureTime: "", name: "", age: "" },
      confirmed: false,
      reset:     false
    };
  }
}

// ─── API HANDLERS ─────────────────────────────────────────────────────────────

async function handleApi(req, res, url) {
  // GET /api/call/config
  if (url.pathname === "/api/call/config" && req.method === "GET") {
    const provider = liveProvider();
    sendJson(res, 200, {
      ready:    provider !== "simulation",
      provider,
      mode:     provider === "simulation" ? "simulation" : "live",
      callableNumber:       activePhoneNumber(),
      dummyTollFreeNumber:  DUMMY_TOLL_FREE_NUMBER,
      twilio: {
        configured:          twilioReady(),
        fromNumber:          TWILIO_PHONE_NUMBER,
        voicebotWsUrl:       `${publicWsBaseUrl(req)}/twilio/voicebot`,
        outboundStatusCallback: `${getBaseUrl(req)}/twilio/status`,
        inboundWebhook:      `${getBaseUrl(req)}/voice/incoming`
      },
      publicBaseUrl:        getBaseUrl(req),
      supportsSmsPaymentLinks: twilioReady(),
      supportsSimulatedSms: true,
      simulatorEndpoint:    "/api/simulate/call",
      rapidApi: {
        configured: Boolean(process.env.RAPIDAPI_KEY),
        host: RAPIDAPI_HOST,
        pathTemplate: RAPIDAPI_PATH_TEMPLATE
      },
      requiredEnv:          ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "PUBLIC_BASE_URL", "RAPIDAPI_KEY"]
    });
    return;
  }

  // POST /api/call/start
  if (url.pathname === "/api/call/start" && req.method === "POST") {
    const body  = JSON.parse((await readBody(req)) || "{}");
    const toRaw = String(body.to || "").trim();
    const to    = toE164(toRaw) || toRaw;
    if (!/^\+[1-9]\d{7,14}$/.test(to)) {
      sendJson(res, 400, { ok: false, error: "Enter a valid phone number, e.g. +918897587467 or 8897587467." });
      return;
    }
    const provider = liveProvider();
    if (provider === "simulation") {
      sendJson(res, 200, {
        ok: true, simulated: true,
        callSid:  `SIM-${Date.now()}`,
        status:   "simulated",
        message:  `No live provider configured. Dummy number: ${DUMMY_TOLL_FREE_NUMBER}.`
      });
      return;
    }
    try {
      const call = await startTwilioCall(to, getBaseUrl(req));
      sendJson(res, 200, { ok: true, provider, callSid: call.sid, status: call.status });
    } catch (err) {
      sendJson(res, 502, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/payment/create
  if (url.pathname === "/api/payment/create" && req.method === "POST") {
    const body    = JSON.parse((await readBody(req)) || "{}");
    const session = {
      from: body.from, to: body.to, date: body.date,
      departureTime: body.departureTime, journeyType: body.journeyType,
      name: body.name, age: body.age
    };
    if (!isComplete(session))   { sendJson(res, 400, { ok: false, error: "Missing booking details." }); return; }
    if (!canStillPay(session))  { sendJson(res, 400, { ok: false, error: "Payment is closed — less than 15 minutes before departure." }); return; }
    const payment = await createPaymentLink(session, req);
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
    const body    = JSON.parse((await readBody(req)) || "{}");
    const from    = String(body.from || "+919999999999");
    const callSid = `SIM-CALL-${Date.now()}`;
    const session = getSession(callSid);
    session.phone = from;
    const turns   = Array.isArray(body.turns) ? body.turns : [String(body.speech || "")].filter(Boolean);
    const transcript = [];
    for (const turn of turns) {
      updateBooking(session, turn);
      transcript.push({ caller: turn, bot: await nextPrompt(session), session: { ...session } });
    }
    let payment = null;
    if (body.confirm === true && isComplete(session) && !needsTrainSelection(session)) {
      if (!canStillPay(session)) {
        transcript.push({ caller: "confirm", bot: "Payment is closed because less than 15 minutes remain before departure." });
      } else {
        payment = await createPaymentLink(session, req);
        const smsText = `Pay Rs ${payment.amount} for ticket ${payment.reference}: ${payment.url}. Pay before ${payment.deadline}.`;
        const sms = await sendPaymentSms(session.phone, smsText, payment.reference, getBaseUrl(req));
        transcript.push({
          caller: "confirm",
          bot:    `Payment link sent${sms.simulated ? " to simulated SMS outbox" : " by SMS"}. Reference ${payment.reference}.`,
          payment, sms
        });
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
    const body        = JSON.parse((await readBody(req)) || "{}");
    const userMessage = String(body.message || "").trim();
    const sessionId   = String(body.sessionId || `web-${Date.now()}`);

    if (!userMessage) {
      sendJson(res, 400, { ok: false, error: "No message provided." });
      return;
    }

    // LLM path
    if (geminiReady()) {
      try {
        const rawResponse = await callGemini(sessionId, userMessage);
        const parsed      = parseGeminiResponse(rawResponse);
        const session     = getSession(sessionId);
        const s           = parsed.slots;
        if (s.journeyType)   session.journeyType   = s.journeyType;
        if (s.from)          session.from          = s.from;
        if (s.to)            session.to            = s.to;
        if (s.date)          session.date          = s.date;
        if (s.departureTime) session.departureTime = s.departureTime;
        if (s.name)          session.name          = s.name;
        if (s.age)           session.age           = s.age;
        updateBooking(session, userMessage);

        const result = {
          ok: true,
          llm: true,
          reply: parsed.reply,
          slots: {
            journeyType:   session.journeyType   || "",
            from:          session.from          || "",
            to:            session.to            || "",
            date:          session.date          || "",
            departureTime: session.departureTime || "",
            name:          session.name          || "",
            age:           session.age           || ""
          },
          confirmed: parsed.confirmed,
          reset: parsed.reset,
          payment: null
        };

        if (parsed.reset) {
          chatHistories.delete(sessionId);
          sessions.delete(sessionId);
        }

        if (parsed.confirmed) {
          if (isComplete(session) && !needsTrainSelection(session)) {
            if (canStillPay(session)) {
              result.payment = await createPaymentLink(session, req);
            } else {
              result.reply    += " However, payment is closed because less than 15 minutes remain before departure. Please choose another train.";
              result.confirmed = false;
            }
          } else {
            result.confirmed = false;
            result.reply = await nextPrompt(session);
          }
        } else if (!parsed.reset) {
          result.reply = await nextPrompt(session);
        }

        sendJson(res, 200, result);
        return;
      } catch (err) {
        console.error("[Gemini chat error]", err.message);
        // Fall through to the deterministic bot so setup still works if the
        // Gemini key is missing quota, invalid, or temporarily unreachable.
      }
    }

    // Deterministic fallback bot
    const session = getSession(sessionId);
    if (/\b(reset|cancel|start over|new ticket|dobara|shuru)\b/i.test(userMessage)) {
      sessions.delete(sessionId);
      getSession(sessionId); // create fresh
      sendJson(res, 200, {
        ok: true, llm: false,
        reply:     "No problem, I have cleared the details. Please tell me your new journey.",
        slots:     { journeyType: "", from: "", to: "", date: "", departureTime: "", name: "", age: "" },
        confirmed: false, reset: true, payment: null
      });
      return;
    }

    updateBooking(session, userMessage);

    const isConfirm = /\b(confirm|yes|book it|go ahead|proceed|haan|theek|ok)\b/i.test(userMessage) && isComplete(session);
    let payment = null;
    if (isConfirm && !needsTrainSelection(session) && canStillPay(session)) {
      payment = await createPaymentLink(session, req);
    }

    sendJson(res, 200, {
      ok: true, llm: false,
      reply: isConfirm && payment
        ? `Your payment link is ready. Reference number ${payment.reference}. Pay before ${payment.deadline}.`
        : isConfirm && needsTrainSelection(session)
          ? await nextPrompt(session)
        : await nextPrompt(session),
      slots: {
        journeyType:   session.journeyType   || "",
        from:          session.from          || "",
        to:            session.to            || "",
        date:          session.date          || "",
        departureTime: session.departureTime || "",
        name:          session.name          || "",
        age:           session.age           || ""
      },
      confirmed: Boolean(isConfirm && payment),
      reset:     false,
      payment
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "API route not found." });
}

// ─── VOICE HANDLERS (Twilio TwiML + Gemini AI) ───────────────────────────────

const callHistories = new Map();

async function callGeminiVoice(callSid, userSpeech) {
  if (!callHistories.has(callSid)) callHistories.set(callSid, []);
  const history = callHistories.get(callSid);
  history.push({ role: "user", parts: [{ text: userSpeech }] });
  if (history.length > 30) history.splice(0, history.length - 30);

  const body = JSON.stringify({
    system_instruction: { parts: [{ text: buildSystemPrompt() }] },
    contents:           history,
    generationConfig:   { temperature: 0.3, maxOutputTokens: 256 }
  });

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  return new Promise((resolve, reject) => {
    const parsed = new URL(apiUrl);
    const req    = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
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
    req.setTimeout(8000, () => {
      req.destroy(new Error("Gemini request timed out"));
    });
    req.write(body);
    req.end();
  });
}

async function handleVoice(req, res, url) {
  const base = getBaseUrl(req);
  const renderGather = (message) => twimlGather(message, base);
  const renderSay    = (message) => twimlSay(message);

  // GET or POST /voice/incoming — call starts
  if (url.pathname === "/voice/incoming") {
    let body = {};
    if (req.method === "POST") {
      body = querystring.parse(await readBody(req));
    }

    const callSid = body.CallSid || body.callsid || body.CallId || `call-${Date.now()}`;
    const session = getSession(callSid);

    try {
      session.phone = callerPhoneFromWebhook(body) || "";
    } catch {
      session.phone = "";
    }

    callHistories.delete(callSid);
    console.log(`[Call incoming] callSid=${callSid} from=${session.phone}`);

    send(res, 200, "text/xml; charset=utf-8",
      renderGather("Hello! Welcome to the ticket booking service. You can speak naturally. Is your journey reserved or unreserved? You can also press 1 for reserved or 2 for unreserved."));
    return;
  }

  // POST /voice/process — caller spoke or transcription arrived
  if (url.pathname === "/voice/process") {
    const body    = querystring.parse(await readBody(req));
    const speech  = extractSpeech(body);
    const callSid = body.CallSid || body.callsid || body.CallId || "local-call";
    const session = getSession(callSid);

    console.log(`[Call process] callSid=${callSid} speech="${speech}"`);
    if (!speech) {
      console.log(`[Call process empty] callSid=${callSid} keys=${Object.keys(body).join(",")} SpeechResult="${body.SpeechResult || ""}" Digits="${body.Digits || ""}"`);
    }
    session.phone = callerPhoneFromWebhook(body) || session.phone;

    // Empty speech — re-prompt
    if (!speech) {
      const prompt = await nextPrompt(session) || "Please tell me your journey details.";
      send(res, 200, "text/xml; charset=utf-8", renderGather(prompt));
      return;
    }

    // Try Gemini AI first
    if (geminiReady()) {
      try {
        const parsed = await callGeminiVoice(callSid, speech);
        const s      = parsed.slots;
        if (s.journeyType)   session.journeyType   = s.journeyType;
        if (s.from)          session.from          = s.from;
        if (s.to)            session.to            = s.to;
        if (s.date)          session.date          = s.date;
        if (s.departureTime) session.departureTime = s.departureTime;
        if (s.name)          session.name          = s.name;
        if (s.age)           session.age           = s.age;

        updateBooking(session, speech);

        if (parsed.reset) {
          sessions.delete(callSid);
          callHistories.delete(callSid);
          send(res, 200, "text/xml; charset=utf-8",
            renderGather("No problem. I have cleared your booking. Please tell me your new journey."));
          return;
        }

        if (parsed.confirmed && isComplete(session) && !needsTrainSelection(session)) {
          if (!canStillPay(session)) {
            sessions.delete(callSid);
            callHistories.delete(callSid);
            send(res, 200, "text/xml; charset=utf-8",
              renderSay("Sorry, payment is now closed because less than 15 minutes remain before departure. Please call again for a different train. Thank you."));
            return;
          }
          const payment = await createPaymentLink(session, req);
          const smsText = `Pay Rs ${payment.amount} for ticket ${payment.reference}: ${payment.url}. Pay before ${payment.deadline}.`;
          let smsSent = false, simulated = false;
          if (session.phone) {
            try {
              const sms = await sendPaymentSms(session.phone, smsText, payment.reference, getBaseUrl(req));
              smsSent = true; simulated = sms.simulated;
            } catch (err) { console.error("[SMS error]", err.message); }
          }
          sessions.delete(callSid);
          callHistories.delete(callSid);
          const smsMsg = smsSent && !simulated
            ? "I have sent the payment link to your phone by SMS."
            : "Your payment link is ready. Please check your SMS.";
          send(res, 200, "text/xml; charset=utf-8",
            renderSay(`${smsMsg} Your reference number is ${payment.reference}. Please pay before ${payment.deadline}. Thank you for calling.`));
          return;
        }

        const replyText = (parsed.confirmed || needsTrainSelection(session))
          ? await nextPrompt(session)
          : parsed.reply || await nextPrompt(session);
        send(res, 200, "text/xml; charset=utf-8", renderGather(replyText));
        return;
      } catch (err) {
        console.error("[Gemini voice error]", err.message);
        // Fall through to deterministic bot
      }
    }

    // Deterministic fallback
    if (/\b(reset|cancel|start over|new ticket|dobara|shuru)\b/i.test(speech)) {
      sessions.delete(callSid);
      send(res, 200, "text/xml; charset=utf-8",
        renderGather("No problem. I have cleared the details. Please tell me your new journey."));
      return;
    }

    updateBooking(session, speech);

    if (/\b(confirm|yes|book|proceed|done|go ahead|haan|theek|ok)\b/i.test(speech)) {
      if (needsTrainSelection(session)) {
        send(res, 200, "text/xml; charset=utf-8", renderGather(await nextPrompt(session)));
        return;
      }
      if (!isComplete(session)) {
        send(res, 200, "text/xml; charset=utf-8", renderGather("Please provide all details before confirming."));
        return;
      }
      if (!canStillPay(session)) {
        sessions.delete(callSid);
        send(res, 200, "text/xml; charset=utf-8",
          renderSay("Sorry, payment is closed. Please call again for a different train. Thank you."));
        return;
      }
      const payment = await createPaymentLink(session, req);
      const smsText = `Pay Rs ${payment.amount} for ticket ${payment.reference}: ${payment.url}. Pay before ${payment.deadline}.`;
      let smsSent = false, simulated = false;
      if (session.phone) {
        try {
          const sms = await sendPaymentSms(session.phone, smsText, payment.reference, getBaseUrl(req));
          smsSent = true; simulated = sms.simulated;
        } catch (err) { console.error("[SMS error]", err.message); }
      }
      sessions.delete(callSid);
      const smsStatus = smsSent && !simulated
        ? "The payment link has been sent to your phone by SMS."
        : `A payment link has been created. Reference: ${payment.reference}`;
      send(res, 200, "text/xml; charset=utf-8",
        renderSay(`${smsStatus} Please pay before ${payment.deadline}. Thank you for calling.`));
      return;
    }

    const prompt = await nextPrompt(session);
    send(res, 200, "text/xml; charset=utf-8", renderGather(prompt));
    return;
  }

  send(res, 404, "text/plain", "Voice route not found.");
}

// ─── TWILIO STATUS HANDLER ────────────────────────────────────────────────────

async function handleTwilio(req, res, url) {
  const params = req.method === "GET"
    ? Object.fromEntries(url.searchParams.entries())
    : querystring.parse(await readBody(req));

  const event = {
    receivedAt: new Date().toISOString(),
    route:      url.pathname,
    callSid:    params.CallSid  || params.callsid  || "",
    messageSid: params.MessageSid || "",
    from:       params.From     || params.from     || "",
    to:         params.To       || params.to       || "",
    status:     params.CallStatus || params.MessageStatus || params.Status || "",
    direction:  params.Direction  || params.direction || "",
    raw:        params
  };

  console.log(`[Twilio] ${url.pathname}:`, JSON.stringify(event));
  voicebotEvents.push(event);
  sendJson(res, 200, { ok: true, event });
}

// ─── WEBSOCKET VOICEBOT (Twilio Media Streams compatible) ────────────────────

function websocketAcceptKey(key) {
  return crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function wsFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len     = payload.length;
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

function parseWsFrames(buffer) {
  const frames = [];
  let offset   = 0;
  while (offset + 2 <= buffer.length) {
    const b0      = buffer[offset];
    const b1      = buffer[offset + 1];
    const opcode  = b0 & 0x0f;
    const masked  = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let headerLen  = 2;

    if (payloadLen === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen  = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen  = 10;
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

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${websocketAcceptKey(key)}`,
    "", ""
  ].join("\r\n"));

  let callSid = `WS-${Date.now()}`;
  let session = getSession(callSid);

  const sendJson_ = (obj) => {
    if (!socket.destroyed) socket.write(wsFrame(JSON.stringify(obj)));
  };

  const speak = (text) => {
    console.log(`[Voicebot → caller] "${text}"`);
    sendJson_({ event: "playback", text, language: "en-IN" });
  };

  const handleSpeech = async (text) => {
    if (!text) return;
    console.log(`[Voicebot ← caller] "${text}"`);
    voicebotEvents.push({ receivedAt: new Date().toISOString(), callSid, speech: text });

    if (/\b(reset|cancel|start over|new ticket|dobara|shuru)\b/i.test(text)) {
      sessions.delete(callSid);
      callSid = `WS-${Date.now()}`;
      session = getSession(callSid);
      speak("No problem. I have cleared the booking. Please tell me your new journey.");
      return;
    }

    updateBooking(session, text);

    if (/\b(confirm|yes|book it|go ahead|proceed|haan|theek hai|ok)\b/i.test(text) && isComplete(session) && !needsTrainSelection(session)) {
      if (!canStillPay(session)) {
        speak("Sorry, payment is now closed because less than 15 minutes remain before departure. Please call again for a different train. Goodbye.");
        sendJson_({ event: "stop" });
        sessions.delete(callSid);
        return;
      }
      const payment = await createPaymentLink(session, { headers: req.headers });
      const smsText = `Pay Rs ${payment.amount} for ticket ${payment.reference}: ${payment.url}. Pay before ${payment.deadline}.`;
      let smsSent = false, simulated = false;
      if (session.phone) {
        try {
          const sms = await sendPaymentSms(session.phone, smsText, payment.reference, getBaseUrl(req));
          smsSent = true; simulated = sms.simulated;
        } catch (err) { console.error("[SMS error]", err.message); }
      }
      const smsMsg = smsSent && !simulated
        ? "I have sent the payment link to your phone by SMS."
        : "Your payment link is ready.";
      speak(`${smsMsg} Your reference number is ${payment.reference}. Please pay before ${payment.deadline}. Thank you for calling.`);
      sendJson_({ event: "stop" });
      sessions.delete(callSid);
      return;
    }

    speak(await nextPrompt(session));
  };

  voicebotEvents.push({ connectedAt: new Date().toISOString(), callSid, remoteAddress: socket.remoteAddress });
  speak("Hello! Welcome to the ticket booking service. Is your journey reserved or unreserved?");

  let buf = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const frames = parseWsFrames(buf);
    buf = Buffer.alloc(0);

    for (const frame of frames) {
      if (frame.opcode === 0x8) { socket.destroy(); return; }
      if (frame.opcode === 0x9) { socket.write(wsFrame("pong")); continue; }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        let msg;
        try { msg = JSON.parse(frame.data.toString("utf8")); } catch { continue; }
        voicebotEvents.push({ receivedAt: new Date().toISOString(), event: msg.event || "unknown", callSid });

        if (msg.event === "start") {
          callSid      = msg.callSid || msg.call_sid || callSid;
          session      = getSession(callSid);
          session.phone = msg.from || msg.From || session.phone || "";
          console.log(`[Voicebot start] callSid=${callSid} from=${session.phone}`);
        } else if (msg.event === "speech" && msg.text) {
          handleSpeech(msg.text).catch(console.error);
        } else if (msg.event === "dtmf" && msg.digit) {
          const dtmfMap = { "1": "reserved", "2": "unreserved", "9": "confirm", "0": "cancel" };
          handleSpeech(dtmfMap[String(msg.digit)] || msg.digit).catch(console.error);
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

// ─── PAYMENT PAGE ─────────────────────────────────────────────────────────────

function servePaymentPage(res, reference) {
  const payment = payments.get(reference);
  if (!payment) {
    send(res, 404, "text/html; charset=utf-8", "<h1>Payment link not found</h1>");
    return;
  }
  const expired     = new Date() > new Date(payment.deadline.replace(" ", "T"));
  const disabledAttr = expired ? "disabled" : "";
  const statusNote  = expired
    ? "<p style='color:#ba2e4a;font-weight:700'>⚠ Payment window has closed for this departure.</p>"
    : "";
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

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  console.log("REQUEST:", req.method, req.url);
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "GET,POST",
        "Access-Control-Allow-Headers": "Content-Type"
      });
      res.end();
      return;
    }

    const url = new URL(req.url, getBaseUrl(req));

    if (url.pathname.startsWith("/api/"))    { await handleApi(req, res, url);    return; }
    if (url.pathname.startsWith("/voice/"))  { await handleVoice(req, res, url);  return; }
    if (url.pathname.startsWith("/twilio/")) { await handleTwilio(req, res, url); return; }
    if (url.pathname.startsWith("/pay/"))    { servePaymentPage(res, decodeURIComponent(url.pathname.slice(5))); return; }
    serveStatic(req, res);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

// WebSocket upgrade (Twilio Media Streams / Voicebot)
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, getBaseUrl(req));
  if (url.pathname === "/twilio/voicebot") {
    handleVoicebotSocket(req, socket);
    return;
  }
  socket.destroy();
});

server.listen(PORT, "0.0.0.0", () => {
  const displayUrl = PUBLIC_BASE_URL || `http://localhost:${PORT} (auto-detects ngrok/tunnel from Host header)`;
  console.log("─────────────────────────────────────────────────────────");
  console.log(`✅  Call Ticket app running at http://localhost:${PORT}`);
  console.log(`📱  Twilio number: ${activePhoneNumber()}`);
  console.log(`🌐  Public URL: ${displayUrl}`);
  console.log(`📞  Inbound webhook:  ${displayUrl}/voice/incoming`);
  console.log(`🤖  Voicebot WS:      ${displayUrl.replace("https://", "wss://").replace("http://", "ws://")}/twilio/voicebot`);
  console.log(`📊  Provider: ${liveProvider()} | Twilio ready: ${twilioReady()}`);
  if (!geminiReady()) {
    console.warn("WARNING: GEMINI_API_KEY not set - voice bot will use deterministic fallback only.");
  }
  if (!process.env.RAPIDAPI_KEY) {
    console.warn("WARNING: RAPIDAPI_KEY not set - train lookup will use placeholder trains.");
  }
  if (!PUBLIC_BASE_URL) {
    console.log(`⚡  TIP: Set PUBLIC_BASE_URL=https://your-ngrok-url.ngrok-free.app in .env`);
  }
  console.log("─────────────────────────────────────────────────────────");
});
