const localtunnel = require('localtunnel');
const fs = require('fs');

(async () => {
  try {
    const tunnel = await localtunnel({ port: 3000, subdomain: 'callticketbot' + Math.floor(Math.random() * 1000) });
    console.log("Localtunnel URL:", tunnel.url);
    fs.writeFileSync('lt_url.txt', tunnel.url);

    tunnel.on('close', () => {
      console.log("Tunnel closed");
    });
  } catch (err) {
    console.error("Localtunnel error:", err);
  }
})();
