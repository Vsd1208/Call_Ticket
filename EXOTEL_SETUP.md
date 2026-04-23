# Exotel Setup

Your screenshot shows:

- ExoPhone: `04048218468`
- Trial number: `09513886363`
- App ID: `1230481`
- Flow name: `srmuniversity3 Landing Flow`
- Account SID: `srmuniversity3`
- Region: Singapore
- Subdomain: `api.exotel.com`

Do not commit the trial PIN, API key, API token, or account SID.

## Local Server

Start the app:

```powershell
$env:EXOTEL_EXOPHONE="04048218468"
$env:EXOTEL_TRIAL_NUMBER="09513886363"
$env:EXOTEL_APP_ID="1230481"
$env:EXOTEL_SUBDOMAIN="api.exotel.com"
$env:PUBLIC_BASE_URL="https://your-public-url"
$env:EXOTEL_ACCOUNT_SID="srmuniversity3"
$env:EXOTEL_API_KEY="your_exotel_api_key"
$env:EXOTEL_API_TOKEN="your_exotel_api_token"
node server.js
```

For local development, expose port `3000` with a tunnel and use that HTTPS URL as `PUBLIC_BASE_URL`.

## Exotel Flow URL

The app builds this flow URL automatically:

```text
http://my.exotel.com/{EXOTEL_ACCOUNT_SID}/exoml/start_voice/1230481
```

If your dashboard gives a different flow URL, set:

```powershell
$env:EXOTEL_FLOW_URL="http://my.exotel.com/your_sid/exoml/start_voice/1230481"
```

## Webhooks

For status or passthru logging, use:

```text
https://your-public-url/exotel/status
https://your-public-url/exotel/passthru
https://your-public-url/exotel/sms-status
```

Exotel Passthru sends call data to your server as URL query parameters. It is useful for logging and branching. A full spoken conversational bot needs the Exotel flow to include a Voicebot or Stream applet that connects audio to your bot service.

## Voicebot Applet

Your flow editor screenshot shows a `Voicebot` applet. In the blank URL field, use the public HTTPS version of:

```text
https://your-public-url/exotel/voicebot-config
```

That endpoint returns the websocket bot URL:

```text
wss://your-public-url/exotel/voicebot
```

If Exotel accepts a direct websocket URL in that field, you can enter the websocket URL directly instead.

For local development, `localhost` will not work inside Exotel because Exotel servers cannot reach your machine. Start a tunnel first:

```powershell
ngrok http 3000
```

If `ngrok` is not installed, this project can use a portable Cloudflare Tunnel executable:

```powershell
.\cloudflared.exe tunnel --url http://localhost:3000 --no-autoupdate
```

If Windows blocks it with `connectex: An attempt was made to access a socket in a way forbidden by its access permissions`, open PowerShell as Administrator or allow `cloudflared.exe` through Windows Firewall/security software, then run the command again.

Then set:

```powershell
$env:PUBLIC_BASE_URL="https://your-ngrok-url"
node server.js
```

After saving the flow, call your ExoPhone:

```text
04048218468
```

The current websocket endpoint logs Voicebot traffic at:

```text
http://localhost:3000/api/voicebot/events
```

It confirms Exotel can connect to your server. To make the bot speak naturally and extract details during the call, connect `/exotel/voicebot` to a real speech AI engine such as Exotel AgentStream/Voicebot protocol plus an AI realtime model.

## Outbound Test

Once Exotel credentials are set, the browser app's `Call Now` button will call the entered phone number and connect it to App ID `1230481`.

Without credentials, the same button stays in simulation mode.

## SMS Payment Links

The server now sends payment links through Exotel when Exotel credentials are configured. The API endpoint used is:

```text
POST https://api.exotel.com/v1/Accounts/{EXOTEL_ACCOUNT_SID}/Sms/send.json
```

For Indian mobile numbers, Exotel/operator rules may require DLT-approved SMS templates and sender configuration. If SMS fails even though calls work, check your Exotel SMS/DLT settings and use a template-approved payment-link message.
