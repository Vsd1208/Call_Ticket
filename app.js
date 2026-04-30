/* ── Call Ticket Booking — LLM-powered frontend ────────────────────────── */

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
    greeting: "Hello! I'm your AI booking assistant. Tell me where you'd like to travel — for example: \"Book a ticket from Delhi to Mumbai tomorrow for Rahul, age 28.\"",
    missingFrom: "Which station are you starting from?",
    missingTo: "Which station are you going to?",
    missingDate: "What is your travel date?",
    missingDepartureTime: "What is the train departure time?",
    missingJourneyType: "Is the journey reserved or unreserved, for example a local train?",
    missingTravelClass: "What class would you like: sleeper, AC chair car, 3 AC, 2 AC, first AC, first class, second sitting, or general?",
    missingName: "What is the passenger name?",
    missingAge: "What is the passenger age?",
    missingSeat: "What type of seat do you prefer: window, aisle, lower, middle, upper, or any seat?",
    ready: "I have all the details. Please confirm to send the payment link.",
    booked: "Your payment link is ready."
  },
  "hi-IN": {
    greeting: "Namaste! Main aapka AI booking assistant hoon. Kripya apni yatra bataiye.",
    missingFrom: "Aap kis station se yatra shuru karenge?",
    missingTo: "Aap kis station tak jana chahte hain?",
    missingDate: "Yatra ki tareekh kya hai?",
    missingDepartureTime: "Train ka departure time kya hai?",
    missingJourneyType: "Yatra reserved hai ya unreserved, jaise local train?",
    missingTravelClass: "Kaunsi class chahiye: sleeper, AC chair car, 3 AC, 2 AC, first AC, first class, second sitting, ya general?",
    missingName: "Yatri ka naam kya hai?",
    missingAge: "Yatri ki umar kya hai?",
    missingSeat: "Kaunsi seat preference chahiye: window, aisle, lower, middle, upper, ya any seat?",
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
  typingIndicator: document.querySelector("#typingIndicator"),
  from: document.querySelector("#fromStation"),
  to: document.querySelector("#toStation"),
  date: document.querySelector("#travelDate"),
  departureTime: document.querySelector("#departureTime"),
  journeyType: document.querySelector("#journeyType"),
  travelClass: document.querySelector("#travelClass"),
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
  providerDot: document.querySelector("#providerDot"),
  llmBadge: document.querySelector("#llmBadge"),
  llmDot: document.querySelector("#llmDot"),
  llmLabel: document.querySelector("#llmLabel")
};

const state = {
  from: "", to: "", date: "", departureTime: "",
  journeyType: "", travelClass: "", name: "", age: "", seat: "",
  locale: "en-IN", recognition: null,
  sessionId: "web-" + Math.random().toString(36).slice(2) + Date.now(),
  llmAvailable: false, isSending: false
};

/* ── Speech Recognition ────────────────────────────────────────────────── */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function initRecognition() {
  if (!SpeechRecognition) {
    say("Speech recognition is not available. You can type below.", false);
    return null;
  }
  const r = new SpeechRecognition();
  r.continuous = true; r.interimResults = false; r.lang = state.locale;
  r.onstart = () => setListening(true);
  r.onend = () => setListening(false);
  r.onerror = (e) => { setListening(false); say(`Could not hear clearly: ${e.error}. Try again or type.`, false); };
  r.onresult = (e) => { receiveCallerText(e.results[e.results.length - 1][0].transcript); };
  return r;
}

function setListening(on) {
  els.body.classList.toggle("listening-active", on);
  els.status.textContent = on ? "Listening" : "Ready";
  els.status.classList.toggle("listening", on);
}

/* ── Local fallback helpers (used when LLM is offline) ─────────────────── */

const botModel = window.CALL_TICKET_BOT_MODEL;
const intentStopWords = new Set(["a","an","the","is","to","for","me","my","i","it","this","please","ke","ki","ka","hai","se","ko"]);

function normalize(t) { return t.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim(); }

function tokenizeForIntent(t) {
  return t.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(w => w && !intentStopWords.has(w));
}

function classifyIntent(text) {
  if (!botModel) return { name: "provide_details", confidence: 0, reply: "" };
  const tokens = tokenizeForIntent(text);
  const vocabSize = botModel.vocabulary.length || 1;
  let best = { name: "provide_details", confidence: 0, reply: "" }, secondScore = -Infinity;
  for (const [name, label] of Object.entries(botModel.labels)) {
    let score = Math.log(label.docs / botModel.totalDocs);
    for (const tok of tokens) score += Math.log(((label.tokenCounts[tok] || 0) + 1) / (label.totalTokens + vocabSize));
    if (score > best.score || best.score === undefined) { secondScore = best.score ?? -Infinity; best = { name, score, reply: label.reply }; }
    else if (score > secondScore) secondScore = score;
  }
  return { name: best.name, confidence: Math.min(0.99, Math.max(0.1, (best.score - secondScore) / 8)), reply: best.reply };
}

function stationPattern() { return stations.flatMap(s => s.aliases).sort((a,b) => b.length-a.length).map(a => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"); }
function resolveStation(v) { if(!v)return""; const c=normalize(v); const s=stations.find(i=>i.aliases.some(a=>c.includes(normalize(a)))); return s?s.name:""; }
function findStationAfter(t, words) { const p=stationPattern(); for(const w of words){ const m=t.match(new RegExp(`${w}\\s+(${p})`,"i")); if(m)return resolveStation(m[1]); } return""; }
function findAllStations(t) { return stations.filter(s=>s.aliases.some(a=>t.includes(normalize(a)))).map(s=>s.name); }

function parseDate(t) {
  const today=new Date();
  if(/\btoday\b|आज/.test(t)) return fmtDate(today);
  if(/\btomorrow\b|कल/.test(t)){ const d=new Date(today); d.setDate(d.getDate()+1); return fmtDate(d); }
  const months={jan:"01",january:"01",feb:"02",february:"02",mar:"03",march:"03",apr:"04",april:"04",may:"05",jun:"06",june:"06",jul:"07",july:"07",aug:"08",august:"08",sep:"09",sept:"09",september:"09",oct:"10",october:"10",nov:"11",november:"11",dec:"12",december:"12"};
  const valid=(d,m,y)=>{const dt=new Date(Number(y),Number(m)-1,Number(d));return dt.getFullYear()===Number(y)&&dt.getMonth()===Number(m)-1&&dt.getDate()===Number(d);};
  const yr=y=>/^\d{2}$/.test(String(y))?`20${y}`:String(y);
  const iso=t.match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/);
  if(iso) return `${iso[1]}-${iso[2].padStart(2,"0")}-${iso[3].padStart(2,"0")}`;
  const ind=t.match(/\b(0?[1-9]|[12]\d|3[01])[-/\s](0?[1-9]|1[0-2])[-/\s](20\d{2}|\d{2})\b/);
  if(ind){const y=yr(ind[3]);if(valid(ind[1],ind[2],y))return `${y}-${ind[2].padStart(2,"0")}-${ind[1].padStart(2,"0")}`;}
  const named=t.match(/\b(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\s+([a-z]+)\s+(20\d{2}|\d{2})\b/i);
  if(named&&months[named[2].toLowerCase()]){const y=yr(named[3]),m=months[named[2].toLowerCase()];if(valid(named[1],m,y))return `${y}-${m}-${named[1].padStart(2,"0")}`;}
  return "";
}
function fmtDate(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function parseName(t) { const m=t.match(/\b(?:for|name is|passenger is|naam|नाम)\s+([a-zA-Z][a-zA-Z ]{1,28})(?:\s+age|\s+umar|$)/i); return m?m[1].replace(/\b(age|umar|seat|ticket|book)\b.*$/i,"").trim().replace(/\b\w/g,l=>l.toUpperCase()):""; }
function parseDirectName(t) { const c=t.trim(); if(!/^[a-zA-Z][a-zA-Z ]{1,28}$/.test(c))return""; if(stations.some(s=>s.aliases.includes(normalize(c))))return""; return c.replace(/\b\w/g,l=>l.toUpperCase()); }
function parseAge(t) { const m=t.match(/\b(?:age|aged|umar|उम्र)\s*(?:is)?\s*(\d{1,3})\b/i); if(m)return m[1]; const d=t.trim().match(/^(\d{1,3})$/); return d?d[1]:""; }
function parseSeat(t) { if(/\b(any|no preference|no specific|koi bhi|koibhi)\b/i.test(t))return"Any"; if(/\bwindow\b/i.test(t))return"Window"; if(/\baisle\b/i.test(t))return"Aisle"; if(/\blower\b/i.test(t))return"Lower"; if(/\bupper\b/i.test(t))return"Upper"; if(/\bmiddle\b/i.test(t))return"Middle"; return""; }
function parseTravelClass(t) {
  const s=t.toLowerCase();
  if(/\b(first ac|1a|first a c|ac first|a c first)\b/i.test(s))return"First AC";
  if(/\b(second ac|2a|2 ac|two ac|a c two|ac 2 tier|2 tier ac|second a c)\b/i.test(s))return"AC 2 Tier";
  if(/\b(third ac|3a|3 ac|three ac|a c three|ac 3 tier|3 tier ac|third a c)\b/i.test(s))return"AC 3 Tier";
  if(/\b(ac chair car|cc|chair car|a c chair car)\b/i.test(s))return"AC Chair Car";
  if(/\b(sleeper|sl)\b/i.test(s))return"Sleeper";
  if(/\b(second sitting|2s|second seater|sitting)\b/i.test(s))return"Second Sitting";
  if(/\b(first class|fc)\b/i.test(s))return"First Class";
  if(/\b(general|unreserved|ordinary)\b/i.test(s))return"General";
  if(/\b(second class)\b/i.test(s))return"Second Class";
  return"";
}
function parseJourneyType(t) { if(/\b(unreserved|general|local|suburban|ordinary)\b|लोकल|जनरल/i.test(t))return"Unreserved"; if(/\b(reserved|reservation|sleeper|chair car|ac|confirmed seat)\b|आरक्षित/i.test(t))return"Reserved"; return""; }
function parseDepartureTime(t) {
  const s=t.toLowerCase(); let m=s.match(/\b(?:at|time|departure|departing|leaves|train time)\s*(?:is)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if(!m) m=s.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i); if(!m)return"";
  let h=Number(m[1]); const mn=Number(m[2]||"0"); const mr=m[3];
  if(mn>59||h>24)return""; if(mr==="pm"&&h<12)h+=12; if(mr==="am"&&h===12)h=0;
  return `${String(h%24).padStart(2,"0")}:${String(mn).padStart(2,"0")}`;
}

function localUpdateFromText(raw) {
  const t = normalize(raw);
  const ef=findStationAfter(t,["from","se","से"]), et=findStationAfter(t,["to","tak","तक"]), all=findAllStations(t);
  if(ef)state.from=ef; if(et)state.to=et;
  if(!state.from&&all[0])state.from=all[0];
  if(!state.to&&all.find(s=>s!==state.from))state.to=all.find(s=>s!==state.from);
  const date=parseDate(t), name=parseName(raw)||(!state.name&&state.from&&state.to&&state.date?parseDirectName(raw):"");
  const age=parseAge(raw), seat=parseSeat(raw), travelClass=parseTravelClass(raw), jt=parseJourneyType(raw), dt=parseDepartureTime(raw);
  if(date)state.date=date; if(name)state.name=name; if(age)state.age=age;
  if(seat)state.seat=seat; if(travelClass)state.travelClass=travelClass; if(jt)state.journeyType=jt; if(dt)state.departureTime=dt;
}

function localNextPrompt() {
  const m = translations[state.locale] || translations["en-IN"];
  if(!state.journeyType)return m.missingJourneyType; if(!state.travelClass)return m.missingTravelClass;
  if(!state.from)return m.missingFrom;
  if(!state.to)return m.missingTo; if(!state.date)return m.missingDate;
  if(!state.departureTime)return m.missingDepartureTime;
  if(!state.name)return m.missingName; if(!state.age)return m.missingAge;
  if(!state.seat)return m.missingSeat; return m.ready;
}

/* ── UI helpers ────────────────────────────────────────────────────────── */

function activeMessages() { return translations[state.locale] || translations["en-IN"]; }

function addMessage(text, kind) {
  const item = document.createElement("div");
  item.className = `message ${kind}`;
  item.textContent = text;
  // Insert before typing indicator
  if (els.typingIndicator) els.conversation.insertBefore(item, els.typingIndicator);
  else els.conversation.appendChild(item);
  els.conversation.scrollTop = els.conversation.scrollHeight;
}

function speak(text) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = state.locale;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

function say(text, shouldSpeak = true) {
  els.botSpeech.textContent = text;
  addMessage(text, "bot");
  if (shouldSpeak) speak(text);
}

function showTyping(on) {
  if (els.typingIndicator) {
    els.typingIndicator.hidden = !on;
    if (on) els.conversation.scrollTop = els.conversation.scrollHeight;
  }
}

function detectLocale(text) {
  if (els.language.value !== "auto") return els.language.value;
  if (/[ऀ-ॿ]/.test(text) || /\b(namaste|kripya|yatra|umar|naam|karo|kal)\b/i.test(text)) return "hi-IN";
  return "en-IN";
}

function updateSlotsUI(slots) {
  if (slots.from) state.from = slots.from;
  if (slots.to) state.to = slots.to;
  if (slots.date) state.date = slots.date;
  if (slots.departureTime) state.departureTime = slots.departureTime;
  if (slots.journeyType) state.journeyType = slots.journeyType;
  if (slots.travelClass) state.travelClass = slots.travelClass;
  if (slots.name) state.name = slots.name;
  if (slots.age) state.age = slots.age;
  if (slots.seat) state.seat = slots.seat;
  refreshDetails();
}

function refreshDetails() {
  els.from.textContent = state.from || "Waiting";
  els.to.textContent = state.to || "Waiting";
  els.date.textContent = state.date || "Waiting";
  els.departureTime.textContent = state.departureTime || "Waiting";
  els.journeyType.textContent = state.journeyType || "Waiting";
  els.travelClass.textContent = state.travelClass || "Waiting";
  els.name.textContent = state.name || "Waiting";
  els.age.textContent = state.age || "Waiting";
  els.seat.textContent = state.seat || "Waiting";
  els.paymentDeadline.textContent = "—";
  const allFilled = state.journeyType && state.travelClass && state.from && state.to && state.date && state.departureTime && state.name && state.age && state.seat;
  els.book.disabled = !allFilled;
}

function resetState() {
  state.from = ""; state.to = ""; state.date = ""; state.departureTime = "";
  state.journeyType = ""; state.travelClass = ""; state.name = ""; state.age = ""; state.seat = "";
  state.sessionId = "web-" + Math.random().toString(36).slice(2) + Date.now();
  els.conversation.querySelectorAll(".message").forEach(m => m.remove());
  els.ticketCard.hidden = true;
  refreshDetails();
  say(activeMessages().greeting, false);
}

function showTicket(payment) {
  els.ticketRoute.textContent = `${state.from} to ${state.to}`;
  els.ticketId.textContent = payment.reference;
  els.ticketMeta.textContent = `${state.journeyType} | ${state.travelClass} class | ${state.name}, age ${state.age} | ${state.date} ${state.departureTime} | Seat: ${state.seat} | Rs ${payment.amount} | Pay before ${payment.deadline}`;
  els.paymentLink.href = payment.url;
  els.paymentLink.toggleAttribute("hidden", !payment.url || payment.url === "#");
  els.ticketCard.hidden = false;
}

/* ── Core: send message to LLM or local fallback ───────────────────────── */

async function receiveCallerText(text) {
  if (state.isSending) return;
  addMessage(text, "user");
  state.locale = detectLocale(text);
  state.isSending = true;
  showTyping(true);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, sessionId: state.sessionId })
    });
    const data = await res.json();
    showTyping(false);
    state.isSending = false;

    if (!data.ok) {
      say(data.error || "Something went wrong. Please try again.", true);
      return;
    }

    // Update slots from server response
    if (data.slots) updateSlotsUI(data.slots);

    // Handle reset
    if (data.reset) {
      state.from = ""; state.to = ""; state.date = ""; state.departureTime = "";
      state.journeyType = ""; state.travelClass = ""; state.name = ""; state.age = ""; state.seat = "";
      state.sessionId = "web-" + Math.random().toString(36).slice(2) + Date.now();
      els.ticketCard.hidden = true;
      refreshDetails();
    }

    // Show reply
    say(data.reply, true);

    // Handle confirmed booking with payment
    if (data.confirmed && data.payment) {
      showTicket(data.payment);
    }
  } catch (err) {
    // Server unreachable — use local fallback
    showTyping(false);
    state.isSending = false;
    console.warn("Server unreachable, using local fallback:", err.message);
    localFallback(text);
  }
}

function localFallback(text) {
  const intent = classifyIntent(text);
  if (intent.name === "reset_booking" && intent.confidence > 0.25) { resetState(); return; }
  localUpdateFromText(text);
  refreshDetails();
  if (intent.name === "confirm_booking" && intent.confidence > 0.25 && !els.book.disabled) { bookTicketLocal(); return; }
  if (intent.name === "greeting" && intent.confidence > 0.25) { say(`${intent.reply} ${localNextPrompt()}`); return; }
  say(localNextPrompt());
}

async function bookTicketLocal() {
  let payment = { reference: `CTB-${Math.floor(100000 + Math.random() * 900000)}`, amount: 180, deadline: "—", url: "#" };
  try {
    const res = await fetch("/api/payment/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: state.from, to: state.to, date: state.date, departureTime: state.departureTime, journeyType: state.journeyType, travelClass: state.travelClass, name: state.name, age: state.age, seat: state.seat })
    });
    const result = await res.json();
    if (res.ok && result.ok) payment = result.payment;
  } catch (e) { /* use fallback payment */ }
  showTicket(payment);
  say(`${activeMessages().booked} Reference number ${payment.reference}.`);
}

async function bookTicket() {
  if (state.isSending) return;
  // Send a "confirm" message through the chat flow
  receiveCallerText("confirm");
}

/* ── LLM status check ──────────────────────────────────────────────────── */

async function checkLlmStatus() {
  try {
    const res = await fetch("/api/chat/status");
    const data = await res.json();
    state.llmAvailable = data.llmAvailable;
    if (els.llmBadge) {
      els.llmBadge.classList.toggle("active", data.llmAvailable);
      els.llmLabel.textContent = data.llmAvailable ? `AI Mode (${data.model})` : "Local Bot";
    }
    // Update greeting based on mode
    if (data.llmAvailable) {
      els.botSpeech.textContent = activeMessages().greeting;
    }
  } catch {
    state.llmAvailable = false;
    if (els.llmBadge) {
      els.llmBadge.classList.remove("active");
      els.llmLabel.textContent = "Offline";
    }
  }
}

/* ── Call provider status ──────────────────────────────────────────────── */

async function loadCallProviderStatus() {
  if (!els.callMessage) return;
  try {
    const res = await fetch("/api/call/config");
    const config = await res.json();
    els.providerDot.classList.toggle("ready", config.ready);
    els.callMessage.textContent = config.ready
      ? `Live phone provider is ready. Call ${config.callableNumber} or enter a number.`
      : `Simulation mode. Dummy number: ${config.dummyTollFreeNumber}.`;
  } catch {
    els.providerDot.classList.remove("ready");
    els.callMessage.textContent = "Start the local server to enable phone calls: node server.js";
  }
}

async function startOutboundCall(phone) {
  els.callMessage.textContent = "Starting phone call...";
  try {
    const res = await fetch("/api/call/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: phone }) });
    const result = await res.json();
    if (!res.ok || !result.ok) { els.callMessage.textContent = result.error || "Could not start the call."; return; }
    els.callMessage.textContent = result.simulated ? `${result.message} Simulated call id: ${result.callSid}` : `Call started. Provider call id: ${result.callSid}`;
  } catch { els.callMessage.textContent = "Could not reach the local call server. Run: node server.js"; }
}

/* ── Event listeners ───────────────────────────────────────────────────── */

els.start.addEventListener("click", () => {
  state.locale = els.language.value === "auto" ? state.locale : els.language.value;
  state.recognition = initRecognition();
  if (state.recognition) { state.recognition.lang = state.locale; state.recognition.start(); }
});

els.stop.addEventListener("click", () => { if (state.recognition) state.recognition.stop(); setListening(false); });
els.reset.addEventListener("click", resetState);
els.language.addEventListener("change", () => {
  state.locale = els.language.value === "auto" ? state.locale : els.language.value;
  if (state.recognition) state.recognition.lang = state.locale;
});

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = "";
  receiveCallerText(text);
});

els.book.addEventListener("click", bookTicket);

els.callNowForm.addEventListener("submit", (e) => {
  e.preventDefault();
  startOutboundCall(els.phoneNumber.value.trim());
});

/* ── Init ──────────────────────────────────────────────────────────────── */

refreshDetails();
checkLlmStatus();
loadCallProviderStatus();


