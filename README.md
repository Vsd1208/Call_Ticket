# 🚆 Call Ticket Booking — AI Voice Bot

A multilingual AI-powered voice bot for booking train tickets over the phone or via a browser chat interface. Built with **Twilio** for telephony, **Google Gemini** for natural language understanding, and a deterministic fallback bot for offline use. Supports English and Hindi.

---

## ✨ Features

- **Real phone calls via Twilio** — inbound and outbound voice calls with full conversation flow
- **AI-powered conversations** — Google Gemini 2.0 Flash for natural slot extraction and dialogue
- **Browser interface** — works with microphone (Chrome/Edge) or typed input
- **Multilingual** — English and Hindi (transliterated), with auto-detection
- **SMS payment links** — automatically sent to the caller after booking confirmation
- **Payment deadline enforcement** — rejects payment if fewer than 15 minutes remain before departure
- **Exotel support** — optional alternative telephony provider for Indian numbers
- **Simulation mode** — full end-to-end demo with zero telephony credentials
- **Offline bot model** — local Naive Bayes classifier when Gemini is unavailable

---

## 📞 Live Call Demo

A real phone call flow powered by Twilio + Gemini:

```
Caller dials your Twilio number
         ↓
POST /voice/incoming  ← Twilio webhook
         ↓
Twilio <Gather> collects speech
         ↓
POST /voice/process  ← speech result
         ↓
Gemini AI extracts booking slots
  (journey type, route, date, time, name, age)
         ↓
Bot responds via <Say>, continues gathering
         ↓
Caller says "confirm"
         ↓
Payment link created → SMS sent via Twilio
```

---

## 🗂 Project Structure

```
├── server.js              # Node.js HTTP server — all API, voice, and WebSocket logic
├── app.js                 # Browser frontend logic
├── index.html             # Single-page UI
├── styles.css             # UI styles
├── call.js                # Standalone Twilio outbound call script
├── bot-model.js           # Pre-trained local intent classifier
├── bot/
│   ├── train.js           # Naive Bayes trainer
│   └── training-data.json # Intent training examples
├── scripts/
│   └── simulate-call.js   # CLI call simulator (no Twilio needed)
├── .env.example           # Environment variable template
├── start.ps1              # PowerShell startup script (Windows)
├── start.bat              # Batch startup script (Windows)
└── tunnel.js              # Localtunnel helper
```

---

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v16+
- A [Twilio account](https://www.twilio.com/) with a voice-capable phone number
- A public HTTPS URL for Twilio webhooks — use [ngrok](https://ngrok.com/) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)

### 1. Clone and configure

```bash
git clone https://github.com/your-username/call-ticket-booking.git
cd call-ticket-booking
cp .env.example .env
```

### 2. Fill in `.env`

```env
PORT=3000
PUBLIC_BASE_URL=https://your-ngrok-url.ngrok-free.app

GEMINI_API_KEY=your_gemini_key

TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM_NUMBER=+1xxxxxxxxxx
```

### 3. Expose your local server

```bash
ngrok http 3000
```

Copy the HTTPS URL and set it as `PUBLIC_BASE_URL` in `.env`.

### 4. Configure the Twilio webhook

In your [Twilio Console](https://console.twilio.com/), go to your phone number settings and set:

- **Voice → A call comes in → Webhook:**
  ```
  https://your-ngrok-url.ngrok-free.app/voice/incoming
  ```
- Method: `HTTP POST`

### 5. Start the server

```bash
node server.js
```

Call your Twilio number and the bot picks up.

---

## ⚙️ Configuration

| Variable | Required | Description |
|---|---|---|
| `PUBLIC_BASE_URL` | Yes | Public HTTPS URL (ngrok/tunnel). Used to build Twilio callback URLs. |
| `TWILIO_ACCOUNT_SID` | Yes (for calls) | From your [Twilio Console](https://console.twilio.com/) |
| `TWILIO_AUTH_TOKEN` | Yes (for calls) | From your Twilio Console |
| `TWILIO_FROM_NUMBER` | Yes (for calls) | Your Twilio phone number in E.164 format (e.g. `+19062993655`) |
| `GEMINI_API_KEY` | Recommended | Google Gemini API key — [get one free](https://aistudio.google.com/apikey) |
| `PORT` | No | Server port, defaults to `3000` |

Without Twilio credentials the server runs in **simulation mode** — calls and SMS are handled locally.

---

## 🗣 Example Conversation

```
Bot:  "Hello! Welcome to the ticket booking service.
       Is your journey reserved or unreserved?"

You:  "Reserved journey from Delhi to Mumbai tomorrow for Rahul age 28"

Bot:  "Got it — reserved, Delhi to Mumbai, tomorrow, Rahul, age 28.
       What is the train departure time?"

You:  "10:30 AM"

Bot:  "I have all the details. A reserved journey from Delhi to Mumbai
       on 2026-04-25 at 10:30 for Rahul, age 28. You must pay before 10:15.
       Say confirm to receive the payment link by SMS, or cancel to start over."

You:  "Confirm"

Bot:  "I have sent the payment link to your phone by SMS.
       Your reference number is CTB-482910. Please pay before 10:15.
       Thank you for calling."

[SMS received]: "Pay Rs 180 for ticket CTB-482910: https://…/pay/CTB-482910. Pay before 2026-04-25 10:15."
```

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/call/config` | Provider status and webhook URLs |
| `POST` | `/api/call/start` | Trigger an outbound Twilio call |
| `POST` | `/api/chat` | Browser chat — message → AI response + slots |
| `GET` | `/api/chat/status` | AI availability and active model |
| `POST` | `/api/payment/create` | Create a payment link |
| `GET` | `/api/sms/outbox` | View simulated SMS messages |
| `GET` | `/api/voicebot/events` | Recent Voicebot WebSocket events |
| `POST` | `/api/simulate/call` | Simulate a full call without Twilio |
| `POST` | `/voice/incoming` | **Twilio inbound call webhook** |
| `POST` | `/voice/process` | **Twilio speech result webhook** |
| `GET` | `/exotel/voicebot-config` | Exotel Voicebot WebSocket config |
| `WS` | `/exotel/voicebot` | Exotel Voicebot WebSocket |
| `GET` | `/pay/:reference` | Demo payment page |

---

## 📲 Outbound Calls

The `call.js` script places a direct outbound call via the Twilio API:

```bash
node call.js
```

Or use the **Call Now** panel in the browser UI — enter any E.164 number (e.g. `+918897587467`) and click **Call**.

---

## 🧪 Testing Without a Phone

**Browser demo:** Open [http://localhost:3000](http://localhost:3000) and type or speak your journey details.

**CLI simulator** (no Twilio needed):
```bash
node scripts/simulate-call.js
```

View simulated SMS messages at:
```
http://localhost:3000/api/sms/outbox
```

---

## 🤖 Retraining the Local Bot

The offline fallback uses a Naive Bayes model trained on examples in `bot/training-data.json`. Add more phrases and retrain:

```bash
node bot/train.js
```

This regenerates `bot-model.js`. Slot parsing (stations, dates, times, names, ages) is handled by deterministic regex in `server.js` independently of the intent model.

---

## 🌐 Supported Languages

| Language | Code | Support |
|---|---|---|
| English (India) | `en-IN` | Full (voice + text + AI) |
| Hindi | `hi-IN` | Full — transliterated input supported (e.g. `"kal ke liye ticket chahiye"`) |
| Tamil | `ta-IN` | Browser speech recognition only |
| Telugu | `te-IN` | Browser speech recognition only |
| Bengali | `bn-IN` | Browser speech recognition only |
| Marathi | `mr-IN` | Browser speech recognition only |

---

## 🏗 Production Path

To turn this into a production-grade system:

1. **Hosted server** — deploy to Railway, Render, or a VPS (no tunnel needed)
2. **Database** — replace in-memory sessions with PostgreSQL or Redis
3. **Payment gateway** — integrate Razorpay, Stripe, or PayU instead of the demo page
4. **Booking API** — connect to IRCTC, RedBus, or your transport provider's API
5. **Auth + audit logs** — add caller authentication and compliance logging
6. **IVR fallback** — handle poor speech recognition with DTMF (digit) input

---

## 📋 Requirements

- Node.js 16+ (zero npm dependencies for `server.js`)
- Chrome or Edge for browser microphone support
- HTTPS public URL for Twilio webhooks

---

## 📄 License

MIT — see [LICENSE](./LICENSE) for details.

---

## 🙏 Acknowledgements

- [Twilio](https://www.twilio.com/) for voice and SMS infrastructure
- [Google Gemini](https://deepmind.google/technologies/gemini/) for the conversational AI
- [ngrok](https://ngrok.com/) / [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) for local development tunneling
