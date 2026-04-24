# Complete Setup Guide: Fix Call Ticket Bot

## The Problem
Your Exotel call ends in 3 seconds because the server doesn't know its public URL, so bot responses can't be routed back to the caller.

## Solution: One-Command Startup

### Step 1: Verify cloudflared.exe exists
The project includes a Cloudflare Tunnel executable. Check:
```
C:\Call_Ticket\cloudflared.exe
```

If missing, download from: https://github.com/cloudflare/cloudflared/releases (Windows 32-bit or 64-bit)

### Step 2: Run the startup script
Open PowerShell as Administrator and run:
```powershell
cd C:\Call_Ticket
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\start.ps1
```

Or use batch (Command Prompt):
```cmd
cd C:\Call_Ticket
start.bat
```

**What it does:**
1. ✅ Starts Cloudflare Tunnel on port 3000
2. ✅ Captures the public HTTPS URL (e.g., `https://routers-newbie-fleece-oecd.trycloudflare.com`)
3. ✅ Sets `PUBLIC_BASE_URL` environment variable
4. ✅ Starts Node.js server with correct config

### Step 3: The output should show:
```
==================================================
  Call Ticket Booking Bot — Starting up
==================================================

[1/4] Cleaning up old processes...
[2/4] Starting Cloudflare Tunnel...
[3/4] Extracting tunnel URL...

Tunnel URL: https://routers-newbie-fleece-oecd.trycloudflare.com
...
[4/4] Starting Node.js server...

Call Ticket app: http://localhost:3000
Inbound voice webhook: https://routers-newbie-fleece-oecd.trycloudflare.com/voice/incoming
```

## Step 4: Configure Exotel

### Option A: Use Voicebot Websocket (Recommended)
1. Go to Exotel dashboard → Your Flow
2. Add/edit a **Voicebot** applet
3. In the URL field, paste:
   ```
   https://routers-newbie-fleece-oecd.trycloudflare.com/exotel/voicebot-config
   ```
4. Save the flow

### Option B: Use Classic Voice Webhook
1. Go to Exotel dashboard → Your Flow
2. Add/edit a **Voice Prompt** applet
3. Set the webhook URL to:
   ```
   https://routers-newbie-fleece-oecd.trycloudflare.com/voice/incoming
   ```
4. Save the flow

## Step 5: Make a Test Call

Call your ExoPhone: **04048218468**

You should hear:
> "Hello! Welcome to the ticket booking service. Is your journey reserved or unreserved?"

**Then say something like:**
- "Reserved journey from Delhi to Mumbai tomorrow for Rahul age 28"
- Or answer one question at a time

The bot will extract details and ask confirmation. When complete, it will send a payment link by SMS.

---

## Troubleshooting

### ❌ "Connection refused" error
**Cause:** Node server isn't running or tunnel isn't pointing to it
**Fix:** 
1. Verify `PUBLIC_BASE_URL` is the tunnel HTTPS URL (not localhost)
2. Verify port 3000 is not blocked by firewall
3. Run `start.ps1` or `start.bat` again

### ❌ "Call ends in 3 seconds with no audio"
**Cause:** Exotel is not connected to the right endpoint
**Fix:**
1. Verify voicebot-config URL in Exotel is: `https://<tunnel-url>/exotel/voicebot-config`
2. Test the URL in browser: it should return JSON
3. Restart the flow in Exotel

### ❌ "Payment link not received by SMS"
**Cause:** Exotel SMS credentials not set OR no phone number captured
**Fix:**
1. Make sure caller ID is captured (should see it in logs)
2. Check SMS provider credentials in .env if configured
3. View simulated SMS at: `http://localhost:3000/api/sms/outbox`

### ❌ "Voicebot Events show no speech"
**Cause:** Exotel not sending audio transcriptions
**Fix:**
1. Verify Voicebot applet is properly configured in Exotel
2. Check that the applet is set to send speech/DTMF events
3. View events at: `http://localhost:3000/api/voicebot/events`

---

## What Each Endpoint Does

| Endpoint | Purpose |
|----------|---------|
| `/exotel/voicebot-config` | Returns websocket URL for Exotel Voicebot applet |
| `WS /exotel/voicebot` | Handles live conversation (speech → bot → TTS) |
| `/voice/incoming` | Starts call for Twilio/classic webhook style |
| `/voice/process` | Continues conversation (speech recognition results) |
| `/api/sms/outbox` | View simulated SMS messages |
| `/api/voicebot/events` | View recent voicebot connection logs |

---

## Environment Variables

Key variables set by startup script:
```
PORT=3000
PUBLIC_BASE_URL=https://routers-newbie-fleece-oecd.trycloudflare.com
EXOTEL_EXOPHONE=04048218468
EXOTEL_APP_ID=1230481
EXOTEL_SUBDOMAIN=api.exotel.com
```

Optional (if you have credentials):
```
EXOTEL_ACCOUNT_SID=srmuniversity3
EXOTEL_API_KEY=your_key
EXOTEL_API_TOKEN=your_token
```

---

## Quick Test Without Phone

Open browser:
```
http://localhost:3000
```

Use the **Call Now** panel to simulate a call with the test phone number.

Or run the simulator:
```
node scripts/simulate-call.js
```

---

## Expected Conversation Flow

```
Bot: "Hello! Welcome to the ticket booking service. Is your journey reserved or unreserved?"
You: "Reserved journey from Delhi to Mumbai tomorrow for Rahul age 28"

Bot: "I have a reserved journey from Delhi to Mumbai on 2026-04-24 at [time]. 
      When is the train departure time?"
You: "10:30 AM"

Bot: "Great! I have all the details. Your reference is CTB-123456. 
      Payment must be completed by [deadline]. Say confirm to send the payment link."
You: "Confirm"

Bot: "I have sent the payment link by SMS. Your reference number is CTB-123456."
[SMS received with link]
```

---

Done! Your bot should now work end-to-end. 🎉
