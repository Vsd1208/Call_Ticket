@echo off
REM Call Ticket Bot - Startup with Tunnel

echo ================================
echo Call Ticket Booking Bot Launcher
echo ================================
echo.

REM Check if cloudflared exists
if not exist cloudflared.exe (
    echo ERROR: cloudflared.exe not found in current directory
    echo Download from: https://github.com/cloudflare/cloudflared/releases
    echo.
    pause
    exit /b 1
)

echo Starting Cloudflare Tunnel on port 3000...
echo.

REM Start tunnel in background and capture the URL
for /f "tokens=*" %%A in ('cloudflared.exe tunnel --url http://127.0.0.1:3000 --no-autoupdate 2^>^&1 ^| find "https://"') do (
    set TUNNEL_URL=%%A
    goto got_tunnel
)

:got_tunnel
if not defined TUNNEL_URL (
    echo ERROR: Could not get tunnel URL from cloudflared
    echo Make sure cloudflared is installed and working
    pause
    exit /b 1
)

echo Tunnel URL: %TUNNEL_URL%
echo.
echo Starting Node server with PUBLIC_BASE_URL=%TUNNEL_URL%...
echo.

REM Set environment variable and start server
set PUBLIC_BASE_URL=%TUNNEL_URL%
set EXOTEL_EXOPHONE=04048218468
set EXOTEL_APP_ID=1230481
set EXOTEL_SUBDOMAIN=api.exotel.com

REM Load credentials from .env if it exists
if exist .env (
    for /f "tokens=1,* delims==" %%A in (.env) do (
        if not "%%A"=="" if not "%%A:~0,1%"=="#" (
            if defined %%A (
                rem skip if already set
            ) else (
                set %%A=%%B
            )
        )
    )
)

echo ================================
echo Configuration:
echo PORT=3000
echo PUBLIC_BASE_URL=%PUBLIC_BASE_URL%
echo EXOTEL_EXOPHONE=%EXOTEL_EXOPHONE%
echo EXOTEL_APP_ID=%EXOTEL_APP_ID%
echo ================================
echo.

node server.js

pause
