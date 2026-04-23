const stations = [
  { name: "Delhi", aliases: ["delhi", "new delhi", "dilli", "दिल्ली"] },
  { name: "Mumbai", aliases: ["mumbai", "bombay", "मुंबई"] },
  { name: "Chennai", aliases: ["chennai", "madras", "चेन्नई"] },
  { name: "Bengaluru", aliases: ["bengaluru", "bangalore", "बेंगलुरु"] },
  { name: "Kolkata", aliases: ["kolkata", "calcutta", "कोलकाता"] },
  { name: "Hyderabad", aliases: ["hyderabad", "हैदराबाद"] },
  { name: "Pune", aliases: ["pune", "पुणे"] },
  { name: "Ahmedabad", aliases: ["ahmedabad", "अहमदाबाद"] },
  { name: "Jaipur", aliases: ["jaipur", "जयपुर"] },
  { name: "Lucknow", aliases: ["lucknow", "लखनऊ"] }
];

const translations = {
  "en-IN": {
    greeting: "Hello. Tell me your journey details, for example: book a ticket from Delhi to Mumbai tomorrow for Rahul, age 28.",
    missingFrom: "Which station are you starting from?",
    missingTo: "Which station are you going to?",
    missingDate: "What is your travel date?",
    missingDepartureTime: "What is the train departure time?",
    missingJourneyType: "Is the journey reserved or unreserved, for example a local train?",
    missingName: "What is the passenger name?",
    missingAge: "What is the passenger age?",
    ready: "I have all the details. Please confirm to send the payment link.",
    booked: "Your payment link is ready."
  },
  "hi-IN": {
    greeting: "Namaste. Kripya apni yatra bataiye, jaise Delhi se Mumbai kal Rahul age 28 ke liye ticket book karo.",
    missingFrom: "Aap kis station se yatra shuru karenge?",
    missingTo: "Aap kis station tak jana chahte hain?",
    missingDate: "Yatra ki tareekh kya hai?",
    missingDepartureTime: "Train ka departure time kya hai?",
    missingJourneyType: "Yatra reserved hai ya unreserved, jaise local train?",
    missingName: "Yatri ka naam kya hai?",
    missingAge: "Yatri ki umar kya hai?",
    ready: "Mere paas sabhi details hain. Payment link bhejne ke liye confirm kijiye.",
    booked: "Aapka payment link taiyar hai."
  }
};

const els = {
  body: document.body,
  status: document.querySelector("#callStatus"),
  botSpeech: document.querySelector("#botSpeech"),
  start: document.querySelector("#startCall"),
  stop: document.querySelector("#stopCall"),
  reset: document.querySelector("#resetFlow"),
  language: document.querySelector("#languageSelect"),
  form: document.querySelector("#typedForm"),
  input: document.querySelector("#typedInput"),
  conversation: document.querySelector("#conversation"),
  from: document.querySelector("#fromStation"),
  to: document.querySelector("#toStation"),
  date: document.querySelector("#travelDate"),
  departureTime: document.querySelector("#departureTime"),
  journeyType: document.querySelector("#journeyType"),
  name: document.querySelector("#passengerName"),
  age: document.querySelector("#passengerAge"),
  seat: document.querySelector("#seatPref"),
  paymentDeadline: document.querySelector("#paymentDeadline"),
  book: document.querySelector("#bookTicket"),
  ticketCard: document.querySelector("#ticketCard"),
  ticketRoute: document.querySelector("#ticketRoute"),
  ticketId: document.querySelector("#ticketId"),
  ticketMeta: document.querySelector("#ticketMeta"),
  paymentLink: document.querySelector("#paymentLink"),
  callNowForm: document.querySelector("#callNowForm"),
  phoneNumber: document.querySelector("#phoneNumber"),
  callMessage: document.querySelector("#callMessage"),
  providerDot: document.querySelector("#providerDot")
};

const state = {
  from: "",
  to: "",
  date: "",
  departureTime: "",
  journeyType: "",
  name: "",
  age: "",
  seat: "Any",
  locale: "en-IN",
  recognition: null
};

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const botModel = window.CALL_TICKET_BOT_MODEL;
const intentStopWords = new Set(["a", "an", "the", "is", "to", "for", "me", "my", "i", "it", "this", "please", "ke", "ki", "ka", "hai", "se", "ko"]);

function initRecognition() {
  if (!SpeechRecognition) {
    say("Speech recognition is not available in this browser. You can still type the caller's words below.", false);
    return null;
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = state.locale;

  recognition.onstart = () => setListening(true);
  recognition.onend = () => setListening(false);
  recognition.onerror = (event) => {
    setListening(false);
    say(`I could not hear clearly: ${event.error}. Please try again or type the sentence.`, false);
  };
  recognition.onresult = (event) => {
    const latest = event.results[event.results.length - 1][0].transcript;
    receiveCallerText(latest);
  };

  return recognition;
}

function setListening(isListening) {
  els.body.classList.toggle("listening-active", isListening);
  els.status.textContent = isListening ? "Listening" : "Ready";
  els.status.classList.toggle("listening", isListening);
}

function activeMessages() {
  return translations[state.locale] || translations["en-IN"];
}

function addMessage(text, kind) {
  const item = document.createElement("div");
  item.className = `message ${kind}`;
  item.textContent = text;
  els.conversation.appendChild(item);
  els.conversation.scrollTop = els.conversation.scrollHeight;
}

function speak(text) {
  if (!window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = state.locale;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function say(text, shouldSpeak = true) {
  els.botSpeech.textContent = text;
  addMessage(text, "bot");
  if (shouldSpeak) speak(text);
}

function normalize(text) {
  return text.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenizeForIntent(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((token) => token && !intentStopWords.has(token));
}

function classifyIntent(text) {
  if (!botModel) return { name: "provide_details", confidence: 0, reply: "" };

  const tokens = tokenizeForIntent(text);
  const vocabularySize = botModel.vocabulary.length || 1;
  let best = { name: "provide_details", confidence: 0, reply: "" };
  let secondScore = Number.NEGATIVE_INFINITY;

  for (const [name, label] of Object.entries(botModel.labels)) {
    let score = Math.log(label.docs / botModel.totalDocs);
    for (const token of tokens) {
      const count = label.tokenCounts[token] || 0;
      score += Math.log((count + 1) / (label.totalTokens + vocabularySize));
    }

    if (score > best.score || best.score === undefined) {
      secondScore = best.score ?? Number.NEGATIVE_INFINITY;
      best = { name, score, reply: label.reply };
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  const margin = best.score - secondScore;
  return {
    name: best.name,
    confidence: Math.min(0.99, Math.max(0.1, margin / 8)),
    reply: best.reply
  };
}

function stationPattern() {
  const aliases = stations.flatMap((station) => station.aliases);
  return aliases
    .sort((a, b) => b.length - a.length)
    .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
}

function resolveStation(value) {
  if (!value) return "";
  const clean = normalize(value);
  const station = stations.find((item) => item.aliases.some((alias) => clean.includes(normalize(alias))));
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
  return stations.filter((station) => station.aliases.some((alias) => text.includes(normalize(alias)))).map((station) => station.name);
}

function parseDate(text) {
  const today = new Date();
  if (/\btoday\b|आज/.test(text)) return formatDate(today);
  if (/\btomorrow\b|कल/.test(text)) {
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

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseName(text) {
  const match = text.match(/\b(?:for|name is|passenger is|passenger name is|naam|नाम)\s+([a-zA-Z][a-zA-Z ]{1,28})(?:\s+age|\s+umar|\s+उम्र|$)/i);
  if (!match) return "";
  return match[1]
    .replace(/\b(age|umar|seat|ticket|book)\b.*$/i, "")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parseDirectName(text) {
  const clean = text.trim();
  if (!/^[a-zA-Z][a-zA-Z ]{1,28}$/.test(clean)) return "";
  if (stations.some((station) => station.aliases.includes(normalize(clean)))) return "";
  return clean.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parseAge(text) {
  const match = text.match(/\b(?:age|aged|umar|उम्र)\s*(?:is)?\s*(\d{1,3})\b/i);
  if (match) return match[1];
  const direct = text.trim().match(/^(\d{1,3})$/);
  return direct ? direct[1] : "";
}

function parseSeat(text) {
  if (/\bwindow\b|खिड़की/i.test(text)) return "Window";
  if (/\baisle\b/i.test(text)) return "Aisle";
  if (/\blower\b/i.test(text)) return "Lower";
  if (/\bupper\b/i.test(text)) return "Upper";
  return "";
}

function parseJourneyType(text) {
  if (/\b(unreserved|general|local|suburban|ordinary)\b|लोकल|जनरल/i.test(text)) return "Unreserved";
  if (/\b(reserved|reservation|sleeper|chair car|ac|confirmed seat)\b|आरक्षित/i.test(text)) return "Reserved";
  return "";
}

function parseDepartureTime(text) {
  const source = text.toLowerCase();
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

function departureDateTime() {
  if (!state.date || !state.departureTime) return null;
  const value = new Date(`${state.date}T${state.departureTime}:00`);
  return Number.isNaN(value.getTime()) ? null : value;
}

function paymentDeadline() {
  const departure = departureDateTime();
  if (!departure) return "";
  const deadline = new Date(departure);
  deadline.setMinutes(deadline.getMinutes() - 15);
  return `${formatDate(deadline)} ${String(deadline.getHours()).padStart(2, "0")}:${String(deadline.getMinutes()).padStart(2, "0")}`;
}

function canStillPay() {
  const departure = departureDateTime();
  if (!departure) return false;
  const deadline = new Date(departure);
  deadline.setMinutes(deadline.getMinutes() - 15);
  return new Date() <= deadline;
}

function estimateFare() {
  const base = state.journeyType === "Unreserved" ? 25 : 180;
  const routeFactor = state.from && state.to ? Math.abs(state.from.length - state.to.length) * 7 : 0;
  return base + routeFactor;
}

function detectLocale(text) {
  if (els.language.value !== "auto") return els.language.value;
  if (/[ऀ-ॿ]/.test(text) || /\b(namaste|kripya|yatra|umar|naam|karo|kal)\b/i.test(text)) return "hi-IN";
  return "en-IN";
}

function updateFromText(rawText) {
  const text = normalize(rawText);
  state.locale = detectLocale(rawText);

  const explicitFrom = findStationAfter(text, ["from", "se", "से"]);
  const explicitTo = findStationAfter(text, ["to", "tak", "तक"]);
  const foundStations = findAllStations(text);

  if (explicitFrom) state.from = explicitFrom;
  if (explicitTo) state.to = explicitTo;
  if (!state.from && foundStations[0]) state.from = foundStations[0];
  if (!state.to && foundStations.find((station) => station !== state.from)) {
    state.to = foundStations.find((station) => station !== state.from);
  }

  const date = parseDate(text);
  const name = parseName(rawText) || (!state.name && state.from && state.to && state.date ? parseDirectName(rawText) : "");
  const age = parseAge(rawText);
  const seat = parseSeat(rawText);
  const journeyType = parseJourneyType(rawText);
  const departureTime = parseDepartureTime(rawText);

  if (date) state.date = date;
  if (name) state.name = name;
  if (age) state.age = age;
  if (seat) state.seat = seat;
  if (journeyType) state.journeyType = journeyType;
  if (departureTime) state.departureTime = departureTime;
}

function nextPrompt() {
  const messages = activeMessages();
  if (!state.journeyType) return messages.missingJourneyType;
  if (!state.from) return messages.missingFrom;
  if (!state.to) return messages.missingTo;
  if (!state.date) return messages.missingDate;
  if (!state.departureTime) return messages.missingDepartureTime;
  if (!state.name) return messages.missingName;
  if (!state.age) return messages.missingAge;
  if (!canStillPay()) return "Payment is already closed for this train because less than 15 minutes remain before departure. Please choose another train.";
  return messages.ready;
}

function refreshDetails() {
  els.from.textContent = state.from || "Waiting";
  els.to.textContent = state.to || "Waiting";
  els.date.textContent = state.date || "Waiting";
  els.departureTime.textContent = state.departureTime || "Waiting";
  els.journeyType.textContent = state.journeyType || "Waiting";
  els.name.textContent = state.name || "Waiting";
  els.age.textContent = state.age || "Waiting";
  els.seat.textContent = state.seat || "Any";
  els.paymentDeadline.textContent = paymentDeadline() || "Waiting";
  els.book.disabled = !(state.journeyType && state.from && state.to && state.date && state.departureTime && state.name && state.age && canStillPay());
}

function receiveCallerText(text) {
  addMessage(text, "user");
  const intent = classifyIntent(text);

  if (intent.name === "reset_booking" && intent.confidence > 0.25) {
    resetState();
    return;
  }

  updateFromText(text);
  refreshDetails();

  if (intent.name === "confirm_booking" && intent.confidence > 0.25 && !els.book.disabled) {
    bookTicket();
    return;
  }

  if (intent.name === "greeting" && intent.confidence > 0.25) {
    say(`${intent.reply} ${nextPrompt()}`);
    return;
  }

  say(nextPrompt());
}

function resetState() {
  state.from = "";
  state.to = "";
  state.date = "";
  state.departureTime = "";
  state.journeyType = "";
  state.name = "";
  state.age = "";
  state.seat = "Any";
  els.conversation.textContent = "";
  els.ticketCard.hidden = true;
  refreshDetails();
  say(activeMessages().greeting, false);
}

async function bookTicket() {
  let payment = {
    reference: `CTB-${Math.floor(100000 + Math.random() * 900000)}`,
    amount: estimateFare(),
    deadline: paymentDeadline(),
    url: "#"
  };

  try {
    const response = await fetch("/api/payment/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: state.from,
        to: state.to,
        date: state.date,
        departureTime: state.departureTime,
        journeyType: state.journeyType,
        name: state.name,
        age: state.age
      })
    });
    const result = await response.json();
    if (response.ok && result.ok) payment = result.payment;
  } catch (error) {
    payment.url = "#";
  }

  els.ticketRoute.textContent = `${state.from} to ${state.to}`;
  els.ticketId.textContent = payment.reference;
  els.ticketMeta.textContent = `${state.journeyType} | ${state.name}, age ${state.age} | ${state.date} ${state.departureTime} | Seat: ${state.seat} | Rs ${payment.amount} | Pay before ${payment.deadline}`;
  els.paymentLink.href = payment.url;
  els.paymentLink.toggleAttribute("hidden", payment.url === "#");
  els.ticketCard.hidden = false;
  say(`${activeMessages().booked} Reference number ${payment.reference}. Pay before ${payment.deadline}.`);
}

async function loadCallProviderStatus() {
  if (!els.callMessage) return;

  try {
    const response = await fetch("/api/call/config");
    const config = await response.json();
    els.providerDot.classList.toggle("ready", config.ready);
    els.callMessage.textContent = config.ready
      ? `Live phone provider is ready. Call ${config.callableNumber} or enter a number.`
      : `Simulation mode. Dummy number: ${config.dummyTollFreeNumber}. Replace it with a provider number for real calls.`;
  } catch (error) {
    els.providerDot.classList.remove("ready");
    els.callMessage.textContent = "Open this app through the local server to make real calls: node server.js";
  }
}

async function startOutboundCall(phoneNumber) {
  els.callMessage.textContent = "Starting phone call...";

  try {
    const response = await fetch("/api/call/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: phoneNumber })
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      els.callMessage.textContent = result.error || "Could not start the call.";
      return;
    }

    els.callMessage.textContent = result.simulated
      ? `${result.message} Simulated call id: ${result.callSid}`
      : `Call started. Provider call id: ${result.callSid}`;
  } catch (error) {
    els.callMessage.textContent = "Could not reach the local call server. Run: node server.js";
  }
}

els.start.addEventListener("click", () => {
  state.locale = els.language.value === "auto" ? state.locale : els.language.value;
  state.recognition = initRecognition();
  if (state.recognition) {
    state.recognition.lang = state.locale;
    state.recognition.start();
  }
});

els.stop.addEventListener("click", () => {
  if (state.recognition) state.recognition.stop();
  setListening(false);
});

els.reset.addEventListener("click", resetState);

els.language.addEventListener("change", () => {
  state.locale = els.language.value === "auto" ? state.locale : els.language.value;
  if (state.recognition) state.recognition.lang = state.locale;
});

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = "";
  receiveCallerText(text);
});

els.book.addEventListener("click", bookTicket);

els.callNowForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const phoneNumber = els.phoneNumber.value.trim();
  startOutboundCall(phoneNumber);
});

refreshDetails();
loadCallProviderStatus();
