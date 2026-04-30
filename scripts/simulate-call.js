const http = require("http");

const payload = JSON.stringify({
  from: "+919999999999",
  confirm: true,
  turns: [
    "reserved journey",
    "sleeper class",
    "from Delhi to Mumbai on 2026-12-01 at 10:30 for Rahul age 28 window seat"
  ]
});

const request = http.request(
  {
    hostname: "localhost",
    port: Number(process.env.PORT || 3000),
    path: "/api/simulate/call",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload)
    }
  },
  (response) => {
    let body = "";
    response.on("data", (chunk) => {
      body += chunk;
    });
    response.on("end", () => {
      console.log(body);
    });
  }
);

request.on("error", (error) => {
  console.error(`Could not reach local server: ${error.message}`);
  process.exitCode = 1;
});

request.write(payload);
request.end();
