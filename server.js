const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3005;
const WEBHOOK_URL =
  process.env.DISCORD_WEBHOOK_URL ||
  "https://discord.com/api/webhooks/1516474263266398280/EysYSuovGzrOae0FSnsIwU_xWgQW52VGMJLSTa1QUAc1dtwwERb0nQoFNSufQfAGfUvP";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    return xff.split(",")[0].trim();
  }

  const addr = req.socket?.remoteAddress;
  if (typeof addr === "string" && addr.trim()) return addr.trim();

  return "Unknown";
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/order") {
    try {
      const body = await readBody(req);
      const clientIp = getClientIp(req);

      // Inject sender IP into the existing Discord webhook payload.
      let payloadObj;
      try {
        payloadObj = JSON.parse(body);
      } catch {
        payloadObj = null;
      }

      if (payloadObj && payloadObj.embeds?.[0]?.fields) {
        const fields = payloadObj.embeds[0].fields;
        fields.push({ name: "Sender IP", value: String(clientIp).slice(0, 1024), inline: false });
      }

      const response = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payloadObj ? JSON.stringify(payloadObj) : body,
      });


      if (!response.ok) {
        const text = await response.text().catch(() => "");
        send(res, 502, JSON.stringify({ message: `Discord rejected order: ${text}` }), MIME[".json"]);
        return;
      }

      send(res, 200, JSON.stringify({ message: "Order sent" }), MIME[".json"]);
    } catch (error) {
      send(res, 500, JSON.stringify({ message: error.message }), MIME[".json"]);
    }
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed");
    return;
  }

  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const routePath = urlPath === "/dashboard" ? "/dashboard.html" : urlPath;
  const relativePath = routePath === "/" ? "index.html" : routePath.replace(/^\/+/, "");
  const safePath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, safePath);

  if (!filePath.startsWith(__dirname)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Static BakaBoost preview running at http://127.0.0.1:${PORT}`);
});
