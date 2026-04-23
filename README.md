# Call Ticket Booking

A browser-based prototype for booking a travel ticket through a multilingual voice bot.

## What it does

- Listens to a caller through the browser microphone when speech recognition is available.
- Detects English or Hindi-style input and replies with browser speech synthesis.
- Extracts booking details from speech or typed text:
  - source station
  - destination station
  - travel date
  - passenger name
  - passenger age
  - seat preference
- Shows a live ticket draft and creates a local confirmation reference.
- Uses a locally trained intent model for booking, detail collection, confirmation, reset, and greeting intents.

## Try it

Open `index.html` in a browser.

For best microphone support, use Chrome or Edge. If speech recognition is unavailable, use the text box:

```text
Book a ticket from Delhi to Mumbai tomorrow for Rahul age 28 window seat
```

You can also answer one slot at a time:

```text
Delhi
Mumbai
tomorrow
Rahul
28
```

## Train the bot

Training data lives in `bot/training-data.json`. Add more caller phrases there, then run:

```bash
node bot/train.js
```

That command regenerates `bot-model.js`, which is loaded by `index.html` before `app.js`.

The current model is intentionally small and offline. It learns intent detection from examples, while station/date/name/age extraction is still handled by deterministic slot parsing in `app.js`.

## Make real phone calls

The browser microphone flow works immediately, but the no-WiFi user flow is handled by the phone network: the user dials your Twilio number from any phone, speaks to the bot, and receives an SMS payment link. This project includes a no-dependency Node server with Twilio-compatible endpoints.

The included dummy toll-free-style number is:

```text
+18005550199
```

That number is for local demos only. It is not actually callable until you replace it with a real provider number.

Your Exotel screenshot details have been added as configuration defaults:

- ExoPhone: `04048218468`
- Trial number: `09513886363`
- App ID: `1230481`
- Account SID: `srmuniversity3`
- Region: Singapore / `api.exotel.com`

See `EXOTEL_SETUP.md` for the exact Exotel environment variables and webhook URLs. The trial PIN is intentionally not stored in this repo.

Start the local server:

```bash
node server.js
```

Then open:

```text
http://localhost:3000
```

The server exposes:

- `GET /api/call/config` - checks whether phone provider credentials are configured.
- `POST /api/call/start` - starts an outbound call when Twilio credentials exist.
- `POST /api/simulate/call` - simulates a complete phone conversation without Twilio.
- `GET /api/sms/outbox` - shows simulated SMS payment links when Twilio is not configured.
- `POST /api/payment/create` - creates a payment link for the browser demo.
- `GET|POST /exotel/status` - receives Exotel call status callbacks.
- `GET|POST /exotel/passthru` - receives Exotel Passthru call details.
- `GET /exotel/voicebot-config` - returns the websocket URL for the Exotel Voicebot applet.
- `WS /exotel/voicebot` - receives Exotel Voicebot websocket traffic.
- `GET /api/voicebot/events` - shows recent Voicebot websocket connection events.
- `POST /voice/incoming` - webhook for an incoming call.
- `POST /voice/process` - receives speech results and continues the booking conversation.
- `GET /pay/:reference` - demo payment page.

During a phone call, the bot asks for:

- reserved or unreserved journey, including local train/general ticket
- source station
- destination station
- travel date
- train departure time
- passenger name
- passenger age

After the caller confirms, the server generates a payment link and sends it by SMS when Exotel or Twilio SMS credentials are configured. The link is valid only until 15 minutes before the train departure time. If fewer than 15 minutes remain, the bot refuses that payment and asks the user to start a new booking for another train.

## Test without a toll-free number

Run the server:

```bash
node server.js
```

Then simulate a caller:

```bash
node scripts/simulate-call.js
```

The simulator sends a reserved Delhi to Mumbai booking, confirms it, creates a payment link, and stores the SMS in the local outbox. View simulated SMS messages at:

```text
http://localhost:3000/api/sms/outbox
```

You can also use the app's Call Now panel. Without Twilio credentials it returns a simulated call id instead of placing a real phone call.

To receive calls from a real phone number:

1. Create a Twilio account and buy or connect a voice-capable phone number.
2. Expose this local server with a public HTTPS URL using a tunnel such as ngrok or Cloudflare Tunnel.
3. Set that public URL as `PUBLIC_BASE_URL`.
4. Configure the Twilio number voice webhook to:

```text
https://your-public-url/voice/incoming
```

To place outbound calls from the app, set these environment variables before starting the server:

```powershell
$env:TWILIO_ACCOUNT_SID="your_account_sid"
$env:TWILIO_AUTH_TOKEN="your_auth_token"
$env:TWILIO_FROM_NUMBER="+1234567890"
$env:PUBLIC_BASE_URL="https://your-public-url"
node server.js
```

Phone numbers must use E.164 format, for example `+919876543210`.

In a real railway deployment, the final payment link should come from your payment gateway, and successful payment should trigger the official railway or transit booking API. This demo creates a local payment page so the full conversation can be tested before those integrations exist.

## Production architecture

To turn this prototype into a real phone-call booking system:

1. Buy or connect a phone number through a telephony provider.
2. Stream call audio to speech-to-text with language detection.
3. Send transcripts into a slot-filling service that extracts trip details.
4. Confirm details with the caller using text-to-speech.
5. Take payment or wallet authorization.
6. Call the railway, bus, event, or transport booking API.
7. Send the ticket by SMS, WhatsApp, or email.

The current app keeps booking data in the browser only. A real deployment needs backend storage, authentication, payment handling, audit logs, and integration with an official booking provider.
