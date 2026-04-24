# ─────────────────────────────────────────────────────────────────────────────
# Call Ticket Bot — One-click startup
# Launches cloudflared tunnel, captures the public HTTPS URL,
# updates PUBLIC_BASE_URL in .env, then starts the Node server.
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Continue"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Call Ticket Booking Bot — Starting up" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# ── Kill any leftover node / cloudflared processes ──────────────────────────
Write-Host "[1/4] Cleaning up old processes..." -ForegroundColor Yellow
Stop-Process -Name node         -Force -ErrorAction SilentlyContinue
Stop-Process -Name cloudflared  -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# ── Start cloudflared tunnel and capture output in real-time ────────────────
Write-Host "[2/4] Starting Cloudflare Tunnel..." -ForegroundColor Yellow

$tunnelLog = Join-Path $scriptDir "cf_tunnel_live.log"
if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force }

$cfProcess = Start-Process -FilePath ".\cloudflared.exe" `
    -ArgumentList "tunnel --url http://127.0.0.1:3000 --no-autoupdate" `
    -RedirectStandardOutput $tunnelLog `
    -RedirectStandardError $tunnelLog `
    -WindowStyle Hidden `
    -PassThru

Write-Host "   cloudflared PID: $($cfProcess.Id)" -ForegroundColor DarkGray

# ── Wait for the tunnel URL to appear in the log (parse both stdout and stderr) ────
Write-Host "   Waiting for tunnel URL (up to 20 seconds)..." -ForegroundColor DarkGray
$publicUrl = ""
$waited = 0
while ($waited -lt 20) {
    Start-Sleep -Milliseconds 500
    $waited++
    if (Test-Path $tunnelLog) {
        $logContent = Get-Content $tunnelLog -Raw -ErrorAction SilentlyContinue
        # Match the full tunnel URL from Cloudflare output
        if ($logContent -match "https://([a-z0-9\-]+\.trycloudflare\.com)") {
            $publicUrl = "https://$($Matches[1])"
            Write-Host "   Found URL: $publicUrl" -ForegroundColor Green
            break
        }
    }
}

if (-not $publicUrl) {
    Write-Host ""
    Write-Host "ERROR: Could not get tunnel URL from cloudflared." -ForegroundColor Red
    Write-Host "Possible causes:" -ForegroundColor Yellow
    Write-Host "  1. Windows Firewall is blocking cloudflared.exe" -ForegroundColor Yellow
    Write-Host "  2. Run as Administrator" -ForegroundColor Yellow
    Write-Host "  3. No internet connectivity" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Debug: Check cf_tunnel_live.log for details" -ForegroundColor DarkGray
    if (Test-Path $tunnelLog) {
        Write-Host ""
        Get-Content $tunnelLog | Head -20
    }
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "   ✅ Tunnel URL captured: $publicUrl" -ForegroundColor Green
Write-Host ""

# ── Update PUBLIC_BASE_URL in .env ───────────────────────────────────────────
Write-Host "[3/4] Updating .env with tunnel URL..." -ForegroundColor Yellow
$envFile = Join-Path $scriptDir ".env"

if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: .env file not found at $envFile" -ForegroundColor Red
    exit 1
}

$envContent = Get-Content $envFile -Raw

# Replace PUBLIC_BASE_URL (handle both old wrong values and any existing value)
$envContent = $envContent -replace "PUBLIC_BASE_URL=.*", "PUBLIC_BASE_URL=$publicUrl"

Set-Content $envFile $envContent -NoNewline -Encoding UTF8

Write-Host "   ✅ .env updated:" -ForegroundColor Green
Write-Host "      PUBLIC_BASE_URL=$publicUrl" -ForegroundColor DarkGray
Write-Host ""

# ── Print Exotel webhook settings ────────────────────────────────────────────
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  EXOTEL FLOW CONFIGURATION" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Copy this URL to your Exotel Voicebot applet:" -ForegroundColor White
Write-Host ""
Write-Host "  $publicUrl/exotel/voicebot-config" -ForegroundColor Green
Write-Host ""
Write-Host "In Exotel Flow Editor:" -ForegroundColor White
Write-Host "  1. Open your Flow" -ForegroundColor DarkGray
Write-Host "  2. Click Voicebot applet" -ForegroundColor DarkGray
Write-Host "  3. Paste the URL above in the URL field" -ForegroundColor DarkGray
Write-Host "  4. Save the flow" -ForegroundColor DarkGray
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# ── Start the Node server ────────────────────────────────────────────────────
Write-Host "[4/4] Starting Node.js server..." -ForegroundColor Yellow
Write-Host ""
node server.js
