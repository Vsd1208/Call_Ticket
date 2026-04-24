# ─────────────────────────────────────────────────────────────────────────────
# Call Ticket Bot — One-click startup
# Launches cloudflared tunnel, captures the public HTTPS URL,
# updates PUBLIC_BASE_URL in .env, then starts the Node server.
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"
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
Start-Sleep -Seconds 1

# ── Start cloudflared tunnel in a temp log file ─────────────────────────────
Write-Host "[2/4] Starting Cloudflare Tunnel..." -ForegroundColor Yellow

$tunnelLog = Join-Path $scriptDir "cf_tunnel_live.log"
if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force }

$cfProcess = Start-Process -FilePath ".\cloudflared.exe" `
    -ArgumentList "tunnel --url http://localhost:3000 --no-autoupdate" `
    -RedirectStandardError $tunnelLog `
    -WindowStyle Hidden `
    -PassThru

Write-Host "   cloudflared PID: $($cfProcess.Id)" -ForegroundColor DarkGray

# ── Wait for the tunnel URL to appear in the log ────────────────────────────
Write-Host "   Waiting for tunnel URL (up to 30 seconds)..." -ForegroundColor DarkGray
$publicUrl = ""
$waited = 0
while ($waited -lt 30) {
    Start-Sleep -Seconds 1
    $waited++
    if (Test-Path $tunnelLog) {
        $logContent = Get-Content $tunnelLog -Raw -ErrorAction SilentlyContinue
        if ($logContent -match "https://[a-z0-9\-]+\.trycloudflare\.com") {
            $publicUrl = $Matches[0]
            break
        }
    }
}

if (-not $publicUrl) {
    Write-Host ""
    Write-Host "ERROR: Could not get tunnel URL from cloudflared." -ForegroundColor Red
    Write-Host "Possible causes:" -ForegroundColor Yellow
    Write-Host "  1. Windows Firewall is blocking cloudflared.exe" -ForegroundColor Yellow
    Write-Host "     → Run this script as Administrator, or allow cloudflared in Firewall settings." -ForegroundColor Yellow
    Write-Host "  2. No internet connectivity." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Starting server on localhost only (no Exotel webhooks will work)..." -ForegroundColor Yellow
    $publicUrl = "http://localhost:3000"
}

Write-Host ""
Write-Host "   ✅ Public URL: $publicUrl" -ForegroundColor Green
Write-Host ""

# ── Update PUBLIC_BASE_URL in .env ───────────────────────────────────────────
Write-Host "[3/4] Updating .env with tunnel URL..." -ForegroundColor Yellow
$envFile = Join-Path $scriptDir ".env"
$envContent = Get-Content $envFile -Raw

# Replace the PUBLIC_BASE_URL line
$envContent = $envContent -replace "(?m)^PUBLIC_BASE_URL=.*$", "PUBLIC_BASE_URL=$publicUrl"
Set-Content $envFile $envContent -NoNewline

Write-Host "   PUBLIC_BASE_URL set to: $publicUrl" -ForegroundColor DarkGray
Write-Host ""

# ── Print Exotel webhook info ────────────────────────────────────────────────
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  EXOTEL WEBHOOK SETTINGS" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  In your Exotel flow, set the Passthru / Voice webhook to:" -ForegroundColor White
Write-Host "  → $publicUrl/voice/incoming" -ForegroundColor Green
Write-Host ""
Write-Host "  For the Voicebot applet URL use:" -ForegroundColor White
Write-Host "  → $publicUrl/exotel/voicebot-config" -ForegroundColor Green
Write-Host ""
Write-Host "  Status callbacks:" -ForegroundColor White
Write-Host "  → $publicUrl/exotel/status" -ForegroundColor DarkGray
Write-Host "  → $publicUrl/exotel/passthru" -ForegroundColor DarkGray
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# ── Start the Node server ────────────────────────────────────────────────────
Write-Host "[4/4] Starting Node.js server..." -ForegroundColor Yellow
Write-Host ""
node server.js
