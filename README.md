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
