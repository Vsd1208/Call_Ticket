# Call Ticket Bot Startup Script
# This script starts the Node.js server locally
# You'll need to set up tunneling manually (ngrok, cloudflared, etc.)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "     CALL TICKET BOT STARTUP" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# Check if Node.js is installed
if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Node.js is not installed. Please install Node.js first." -ForegroundColor Red
    exit 1
}

# Check if .env exists
if (!(Test-Path ".env")) {
    Write-Host "❌ .env file not found. Please create it with your Exotel credentials." -ForegroundColor Red
    exit 1
}

Write-Host "[1/2] Starting Node.js server..." -ForegroundColor Yellow

# Start the server
try {
    $serverProcess = Start-Process -FilePath "node" -ArgumentList "server.js" -NoNewWindow -PassThru
    Start-Sleep -Seconds 3

    if (!$serverProcess.HasExited) {
        Write-Host "✅ Server started successfully!" -ForegroundColor Green
    } else {
        Write-Host "❌ Server failed to start" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "❌ Error starting server: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  MANUAL TUNNEL SETUP REQUIRED" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "The server is running locally at http://localhost:3000" -ForegroundColor White
Write-Host ""
Write-Host "To make it accessible for Exotel, you need to set up a tunnel:" -ForegroundColor Yellow
Write-Host ""
Write-Host "Option 1 - ngrok (recommended):" -ForegroundColor White
Write-Host "  1. Download ngrok from https://ngrok.com/download" -ForegroundColor White
Write-Host "  2. Run: ngrok http 3000" -ForegroundColor White
Write-Host "  3. Copy the HTTPS URL (e.g., https://abc123.ngrok.io)" -ForegroundColor White
Write-Host ""
Write-Host "Option 2 - cloudflared:" -ForegroundColor White
Write-Host "  1. Run: cloudflared tunnel --url http://127.0.0.1:3000" -ForegroundColor White
Write-Host "  2. Copy the HTTPS URL from the output" -ForegroundColor White
Write-Host ""
Write-Host "Then update your .env file:" -ForegroundColor Yellow
Write-Host "  PUBLIC_BASE_URL=https://your-tunnel-url" -ForegroundColor White
Write-Host ""
Write-Host "Finally, update your Exotel Voicebot applet with:" -ForegroundColor Yellow
Write-Host "  https://your-tunnel-url/exotel/voicebot-config" -ForegroundColor White
Write-Host ""
Write-Host "Press Ctrl+C to stop the server" -ForegroundColor Gray
Write-Host ""

# Wait for the server process
Wait-Process -Id $serverProcess.Id
