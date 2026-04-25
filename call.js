const twilio = require("twilio");


const client = twilio(accountSid, authToken);

client.calls
  .create({
    url: "https://bobcat-relock-imprison.ngrok-free.dev/voice/incoming",
    to: "+918897587467",
    from: "+19062993655" // your Twilio number
  })
  .then(call => console.log("Call started:", call.sid))
  .catch(err => console.error(err));