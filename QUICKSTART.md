# 🚀 QUICK START - Fix Your Call Ticket Bot

## 3-Step Fix

### Step 1: Open PowerShell as Administrator
```powershell
cd C:\Call_Ticket
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

### Step 2: Run the startup script
```powershell
.\start.ps1
```

This will:
- ✅ Stop any old processes
- ✅ Start Cloudflare Tunnel 
- ✅ Capture the public URL
- ✅ Update .env with the tunnel URL
- ✅ Start the Node server

### Step 3: Wait for this output
```
==================================================
  Call Ticket Booking Bot — Starting up
==================================================

✅  Call Ticket app running at http://localhost:3000
📱  ExoPhone: 04048218468
🌐  Public URL: https://routers-newbie-fleece-oecd.trycloudflare.com
📞  Inbound webhook: https://routers-newbie-fleece-oecd.trycloudflare.com/voice/incoming
🤖  Voicebot WS:     wss://routers-newbie-fleece-oecd.trycloudflare.com/exotel/voicebot
🔧  Voicebot config: https://routers-newbie-fleece-oecd.trycloudflare.com/exotel/voicebot-config
📊  Provider: exotel | Exotel ready: true
==================================================
```

---

## 4: Update Exotel Flow (in Exotel Dashboard)

Copy the **Voicebot config URL** from the output above and:

1. Go to Exotel Dashboard → Your Flow
2. Click the **Voicebot** applet 
3. Paste the URL in the **URL field**:
   ```
   https://routers-newbie-fleece-oecd.trycloudflare.com/exotel/voicebot-config
   ```
4. **Save**

---

## 5: Test the Call

**Call your ExoPhone:** `04048218468`

You should hear the bot say:
> "Hello! Welcome to the ticket booking service. Is your journey reserved or unreserved?"

**Then speak:**
```
Reserved journey from Delhi to Mumbai tomorrow for Rahul age 28
```

---

## ✅ What Should Work Now

- ✅ Bot responds with "I have a reserved journey..."
- ✅ Bot asks for confirmation
- ✅ You say "confirm"
- ✅ Payment link sent by SMS
- ✅ Full conversation works

---

## ❌ If It Still Doesn't Work

### Check 1: Verify tunnel is running
Look for this line in the output:
```
Waiting for tunnel URL...
✅ Public URL: https://...
```

If you see an ERROR instead, check:
- Firewall: Allow `cloudflared.exe` through Windows Firewall
- Internet: Make sure you have internet connection
- Admin: Run PowerShell as Administrator

### Check 2: Verify webhook URL is correct
In browser, paste and test:
```
https://your-tunnel-url/exotel/voicebot-config
```

You should see JSON output.

### Check 3: View live logs
In another PowerShell window:
```powershell
cd C:\Call_Ticket
.\start.ps1
# Watch the logs as you make a call
```

The logs should show:
```
[Voicebot start] callSid=...
[Voicebot ← caller] "reserved"
[Voicebot → caller] "I have a reserved..."
```

---

## Need Help?

See full details in: `SETUP.md` or `EXOTEL_SETUP.md`

---

**That's it! Your bot should now work end-to-end.** 🎉
