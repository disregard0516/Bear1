process.stdout.write("BakaBoost starting...\n");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let Stripe, nodemailer;
try {
  Stripe = require("stripe");
  nodemailer = require("nodemailer");
  console.log("[startup] Modules loaded successfully");
} catch (modErr) {
  console.error("[startup] MODULE LOAD FAILED:", modErr.message, modErr.stack);
  process.exit(1);
}

const PORT = process.env.PORT || 5000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LICENSE_SERVER_URL = process.env.LICENSE_SERVER_URL;
const CLIENT_ID = process.env.CLIENT_ID || "default";
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString("hex");
const TOKEN_TTL = 5 * 60 * 1000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "bakaboost2025";
const PROFILES_PATH = path.join(__dirname, "profiles.json");
const USERS_PATH = path.join(__dirname, "users.json");
const SETTINGS_PATH = path.join(__dirname, "settings.json");
const WITHDRAWALS_PATH = path.join(__dirname, "withdrawals.json");

// ─── Email ────────────────────────────────────────────────────────────────────
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || "noreply@bakaboost.com";

function createTransporter() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

// ─── Password Reset Codes ────────────────────────────────────────────────────
const resetCodes = new Map();

const { publicKey: RSA_PUBLIC_KEY, privateKey: RSA_PRIVATE_KEY } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// ─── Admin Sessions ───────────────────────────────────────────────────────────
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

// ─── User Sessions ────────────────────────────────────────────────────────────
const userSessions = new Map();

function createUserSession(username) {
  const id = crypto.randomBytes(32).toString("hex");
  userSessions.set(id, { username, created: Date.now() });
  return id;
}

function getUserFromSession(id) {
  if (!id) return null;
  const session = userSessions.get(id);
  if (!session) return null;
  if (Date.now() - session.created > SESSION_TTL) {
    userSessions.delete(id);
    return null;
  }
  return session.username;
}

function getUserSessionFromCookie(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/baka_user_session=([^;]+)/);
  return match ? match[1] : null;
}

// ─── Password Hashing ─────────────────────────────────────────────────────────
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return { hash, salt, passwordPlain: password };
}

function verifyPassword(password, hash, salt) {
  const result = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(result), Buffer.from(hash));
}

// ─── Data Helpers ─────────────────────────────────────────────────────────────
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

function migrateShopStatuses() {
  const profiles = loadProfiles();
  let changed = false;
  for (const username of Object.keys(profiles)) {
    const profile = profiles[username];
    if (!Array.isArray(profile.shop)) continue;
    profile.shop.forEach((item) => {
      if (!item.status) {
        item.status = "approved";
        changed = true;
      }
      if (!item.id) {
        item.id = "s" + crypto.randomBytes(6).toString("hex");
        changed = true;
      }
    });
  }
  if (changed) saveProfiles(profiles);
}

function reconcileShopItems(incomingItems, existingItems) {
  const existingById = new Map((existingItems || []).map((item) => [item.id, item]));
  const seenIds = new Set();
  const result = (incomingItems || []).map((raw) => {
    const name = (raw.name || "").trim();
    const description = (raw.description || "").trim();
    const price = parseFloat(raw.price) || 0;
    const image = (raw.image || "").trim();
    const existing = raw.id ? existingById.get(raw.id) : undefined;
    const id = raw.id || ("s" + crypto.randomBytes(6).toString("hex"));
    seenIds.add(id);
    if (!existing) {
      return { id, name, description, price, image, status: "pending" };
    }
    const unchanged = existing.name === name && existing.description === description && existing.price === price && existing.image === image;
    return { id, name, description, price, image, status: unchanged ? existing.status : "pending" };
  });
  return result;
}

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), "utf8");
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return { signupsDisabled: false, stripeEnabled: false };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
}

function loadWithdrawals() {
  try {
    return JSON.parse(fs.readFileSync(WITHDRAWALS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveWithdrawals(data) {
  fs.writeFileSync(WITHDRAWALS_PATH, JSON.stringify(data, null, 2), "utf8");
}

// ─── Token (order form) ───────────────────────────────────────────────────────
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

// ─── Earnings Helper ──────────────────────────────────────────────────────────
async function getUserEarnings(username) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return { gross: 0, fees: 0, net: 0, count: 0 };
  const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });
  let gross = 0, fees = 0, count = 0;
  let hasMore = true;
  let startingAfter = undefined;
  while (hasMore) {
    const page = await stripe.checkout.sessions.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const session of page.data) {
      if (session.payment_status !== "paid") continue;
      if ((session.metadata?.creatorUsername || "") !== username) continue;
      const grossCents = session.amount_total || 0;
      const feeCents = Math.round(grossCents * 0.029 + 30);
      gross += grossCents / 100;
      fees += feeCents / 100;
      count++;
    }
    hasMore = page.has_more;
    if (hasMore && page.data.length > 0) startingAfter = page.data[page.data.length - 1].id;
    else hasMore = false;
  }
  gross = Math.round(gross * 100) / 100;
  fees = Math.round(fees * 100) / 100;
  const net = Math.round((gross - fees) * 100) / 100;
  return { gross, fees, net, count };
}

// ─── Utilities ────────────────────────────────────────────────────────────────
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

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  res.setHeader("X-Content-Type-Options", "nosniff");

  // ── Token & Public Key ──────────────────────────────────────────────────────
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

  // ── Order ───────────────────────────────────────────────────────────────────
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

  // ── Admin Auth ──────────────────────────────────────────────────────────────
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
    const profiles = loadProfiles();
    const users = loadUsers();
    for (const username of Object.keys(profiles)) {
      profiles[username].hasPassword = !!users[username];
      if (users[username]) {
        profiles[username].passwordPlain = users[username].passwordPlain || "";
      }
    }
    sendJson(res, 200, profiles);
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
      const password = data.password || "";
      if (password) {
        if (password.length < 6) { sendJson(res, 400, { message: "Password must be at least 6 characters." }); return; }
        const users = loadUsers();
        if (users[username]) { sendJson(res, 409, { message: "Username already exists" }); return; }
        const { hash, salt, passwordPlain } = hashPassword(password);
        users[username] = { username, email: (data.email || "").trim(), passwordHash: hash, salt, passwordPlain, created: new Date().toISOString() };
        saveUsers(users);
      }
      profiles[username] = { username, displayName: data.displayName || username, email: data.email || "", bio: data.bio || "", pfp: data.pfp || "", banner: data.banner || "", followerCount: parseInt(data.followerCount) || 0, coffeePrice: parseFloat(data.coffeePrice) || 1, coffeeLabel: data.coffeeLabel || "coffee", gallery: data.gallery || [], posts: data.posts || [], shop: (data.shop || []).map((item) => ({ id: item.id || ("s" + crypto.randomBytes(6).toString("hex")), name: item.name || "", description: item.description || "", price: parseFloat(item.price) || 0, image: item.image || "", status: "approved" })), tags: Array.isArray(data.tags) ? data.tags.slice(0, 4) : [] };
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
      const users = loadUsers();
      const userEmail = (data.email || "").trim();

      if (data.password) {
        if (data.password.length < 6) { sendJson(res, 400, { message: "Password must be at least 6 characters." }); return; }
        const { hash, salt, passwordPlain } = hashPassword(data.password);
        if (users[oldUsername]) {
          users[oldUsername].passwordHash = hash;
          users[oldUsername].salt = salt;
          users[oldUsername].passwordPlain = passwordPlain;
          if (userEmail) users[oldUsername].email = userEmail;
        } else {
          users[newUsername] = { username: newUsername, email: userEmail, passwordHash: hash, salt, passwordPlain, created: new Date().toISOString() };
        }
      } else if (userEmail && users[oldUsername]) {
        users[oldUsername].email = userEmail;
      }

      if (newUsername !== oldUsername) {
        if (users[oldUsername]) {
          users[newUsername] = { ...users[oldUsername], username: newUsername };
          delete users[oldUsername];
        }
        delete profiles[oldUsername];
      }
      saveUsers(users);
      profiles[newUsername] = {
        username: newUsername,
        displayName: data.displayName ?? existing.displayName,
        email: data.email !== undefined ? data.email : existing.email,
        bio: data.bio ?? existing.bio,
        pfp: data.pfp ?? existing.pfp,
        banner: data.banner ?? existing.banner,
        followerCount: data.followerCount !== undefined ? parseInt(data.followerCount) : existing.followerCount,
        coffeePrice: data.coffeePrice !== undefined ? parseFloat(data.coffeePrice) : existing.coffeePrice,
        coffeeLabel: data.coffeeLabel ?? existing.coffeeLabel,
        gallery: data.gallery ?? existing.gallery,
        posts: data.posts ?? existing.posts,
        shop: data.shop ? data.shop.map((item) => ({ id: item.id || ("s" + crypto.randomBytes(6).toString("hex")), name: item.name || "", description: item.description || "", price: parseFloat(item.price) || 0, image: item.image || "", status: "approved" })) : existing.shop,
        tags: Array.isArray(data.tags) ? data.tags.slice(0, 4) : existing.tags,
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
    const users = loadUsers();
    if (users[username]) {
      delete users[username];
      saveUsers(users);
    }
    sendJson(res, 200, { message: "Deleted" });
    return;
  }

  if (pathname === "/api/admin/settings" && req.method === "GET") {
    const sessionId = getAdminSessionFromCookie(req);
    if (!isValidAdminSession(sessionId)) { sendJson(res, 401, { message: "Unauthorized" }); return; }
    sendJson(res, 200, loadSettings());
    return;
  }

  if (pathname === "/api/admin/settings" && req.method === "PUT") {
    const sessionId = getAdminSessionFromCookie(req);
    if (!isValidAdminSession(sessionId)) { sendJson(res, 401, { message: "Unauthorized" }); return; }
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const settings = loadSettings();
      if (typeof data.signupsDisabled === "boolean") {
        settings.signupsDisabled = data.signupsDisabled;
      }
      if (typeof data.stripeEnabled === "boolean") {
        settings.stripeEnabled = data.stripeEnabled;
      }
      saveSettings(settings);
      sendJson(res, 200, settings);
    } catch (e) {
      sendJson(res, 400, { message: e.message });
    }
    return;
  }

  if (pathname === "/api/settings/public" && req.method === "GET") {
    const settings = loadSettings();
    sendJson(res, 200, { signupsDisabled: !!settings.signupsDisabled, stripeEnabled: !!settings.stripeEnabled });
    return;
  }

  if (pathname === "/api/admin/shop-pending" && req.method === "GET") {
    const sessionId = getAdminSessionFromCookie(req);
    if (!isValidAdminSession(sessionId)) { sendJson(res, 401, { message: "Unauthorized" }); return; }
    const profiles = loadProfiles();
    const pending = [];
    for (const username of Object.keys(profiles)) {
      const profile = profiles[username];
      (profile.shop || []).forEach((item) => {
        if (item.status === "pending") {
          pending.push({ username, displayName: profile.displayName, item });
        }
      });
    }
    sendJson(res, 200, pending);
    return;
  }

  if (pathname === "/api/admin/shop-review" && req.method === "POST") {
    const sessionId = getAdminSessionFromCookie(req);
    if (!isValidAdminSession(sessionId)) { sendJson(res, 401, { message: "Unauthorized" }); return; }
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const username = data.username || "";
      const itemId = data.itemId || "";
      const decision = data.decision === "approve" ? "approved" : data.decision === "reject" ? "rejected" : null;
      if (!username || !itemId || !decision) { sendJson(res, 400, { message: "Invalid request" }); return; }
      const profiles = loadProfiles();
      const profile = profiles[username];
      if (!profile) { sendJson(res, 404, { message: "Profile not found" }); return; }
      const item = (profile.shop || []).find((s) => s.id === itemId);
      if (!item) { sendJson(res, 404, { message: "Shop item not found" }); return; }
      item.status = decision;
      saveProfiles(profiles);
      sendJson(res, 200, { ok: true, item });
    } catch (e) {
      sendJson(res, 400, { message: e.message });
    }
    return;
  }

  // ── User Auth ───────────────────────────────────────────────────────────────
  if (pathname === "/api/auth/login" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const username = (data.username || "").toLowerCase().trim();
      const password = data.password || "";

      const users = loadUsers();
      const user = users[username];
      if (!user) {
        sendJson(res, 401, { message: "Incorrect username or password." }); return;
      }

      let valid = false;
      try { valid = verifyPassword(password, user.passwordHash, user.salt); } catch { valid = false; }

      if (!valid) {
        sendJson(res, 401, { message: "Incorrect username or password." }); return;
      }

      const sessionId = createUserSession(username);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `baka_user_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
      });
      res.end(JSON.stringify({ ok: true, username }));
    } catch (e) {
      sendJson(res, 400, { message: e.message });
    }
    return;
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    const sessionId = getUserSessionFromCookie(req);
    if (sessionId) userSessions.delete(sessionId);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": "baka_user_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === "/api/auth/me" && req.method === "GET") {
    const sessionId = getUserSessionFromCookie(req);
    const username = getUserFromSession(sessionId);
    sendJson(res, 200, username ? { loggedIn: true, username } : { loggedIn: false });
    return;
  }

  if (pathname === "/api/auth/change-password" && req.method === "POST") {
    const sessionId = getUserSessionFromCookie(req);
    const username = getUserFromSession(sessionId);
    if (!username) { sendJson(res, 401, { message: "Not logged in." }); return; }
    try {
      const body = await readBody(req);
      const { currentPassword, newPassword } = JSON.parse(body);
      const users = loadUsers();
      const user = users[username];
      if (!user) { sendJson(res, 404, { message: "User not found." }); return; }
      let valid = false;
      try { valid = verifyPassword(currentPassword, user.passwordHash, user.salt); } catch { valid = false; }
      if (!valid) { sendJson(res, 401, { message: "Current password is incorrect." }); return; }
      if ((newPassword || "").length < 6) { sendJson(res, 400, { message: "New password must be at least 6 characters." }); return; }
      const { hash, salt, passwordPlain } = hashPassword(newPassword);
      users[username].passwordHash = hash;
      users[username].salt = salt;
      users[username].passwordPlain = passwordPlain;
      saveUsers(users);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { message: e.message });
    }
    return;
  }

  // ── Forgot / Reset Password ─────────────────────────────────────────────────
  if (pathname === "/api/auth/forgot-password" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const email = (data.email || "").trim().toLowerCase();
      if (!email) { sendJson(res, 400, { message: "Please enter your email address." }); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        sendJson(res, 400, { message: "Please enter a valid email address." }); return;
      }
      const users = loadUsers();
      const entry = Object.entries(users).find(([, u]) => (u.email || "").toLowerCase() === email);
      if (!entry) {
        sendJson(res, 404, { message: "No account found with that email address." }); return;
      }

      const [username] = entry;
      const code = crypto.randomInt(100000, 999999).toString();
      resetCodes.set(email, { username, code, expires: Date.now() + 5 * 60 * 1000 });

      const transporter = createTransporter();
      if (!transporter) {
        console.log(`[Password Reset] Code for ${email} (${username}): ${code}`);
        sendJson(res, 200, { ok: true, message: "A reset code has been sent to your email." });
        return;
      }

      try {
        await transporter.sendMail({
          from: SMTP_FROM,
          to: email,
          subject: "BakaBoost — Password Reset Code",
          text: `Your password reset code is: ${code}\n\nThis code expires in 5 minutes.\n\nIf you did not request this, you can ignore this email.`,
          html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
            <h2 style="color:#467ceb;">BakaBoost</h2>
            <p>Your password reset code is:</p>
            <div style="font-size:2rem;font-weight:900;letter-spacing:.15em;text-align:center;padding:24px;background:#f4f7fc;border-radius:12px;margin:20px 0;">${code}</div>
            <p style="color:#7e879b;font-size:.85rem;">This code expires in 5 minutes. If you did not request this, you can ignore this email.</p>
          </div>`,
        });
      } catch (mailErr) {
        console.error("Failed to send reset email:", mailErr.message);
        sendJson(res, 500, { message: "Failed to send email. Please try again later." }); return;
      }

      sendJson(res, 200, { ok: true, message: "A reset code has been sent to your email." });
    } catch (e) {
      sendJson(res, 400, { message: e.message });
    }
    return;
  }

  if (pathname === "/api/auth/verify-reset-code" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const email = (data.email || "").trim().toLowerCase();
      const code = (data.code || "").trim();

      if (!email || !code) { sendJson(res, 400, { message: "Email and code are required." }); return; }

      const stored = resetCodes.get(email);
      if (!stored) { sendJson(res, 400, { message: "No reset code was requested for this email." }); return; }
      if (Date.now() > stored.expires) {
        resetCodes.delete(email);
        sendJson(res, 400, { message: "Reset code has expired. Please request a new one." }); return;
      }
      if (stored.code !== code) { sendJson(res, 400, { message: "Invalid reset code." }); return; }

      sendJson(res, 200, { ok: true, message: "Code verified." });
    } catch (e) {
      sendJson(res, 400, { message: e.message });
    }
    return;
  }

  if (pathname === "/api/auth/reset-password" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const email = (data.email || "").trim().toLowerCase();
      const code = (data.code || "").trim();
      const newPassword = data.newPassword || "";

      if (!email || !code) { sendJson(res, 400, { message: "Email and code are required." }); return; }
      if (newPassword.length < 6) { sendJson(res, 400, { message: "Password must be at least 6 characters." }); return; }

      const stored = resetCodes.get(email);
      if (!stored) { sendJson(res, 400, { message: "No reset code was requested for this email." }); return; }
      if (Date.now() > stored.expires) {
        resetCodes.delete(email);
        sendJson(res, 400, { message: "Reset code has expired. Please request a new one." }); return;
      }
      if (stored.code !== code) { sendJson(res, 400, { message: "Invalid reset code." }); return; }

      const users = loadUsers();
      const user = users[stored.username];
      if (!user) { sendJson(res, 404, { message: "User not found." }); return; }

      const { hash, salt, passwordPlain } = hashPassword(newPassword);
      user.passwordHash = hash;
      user.salt = salt;
      user.passwordPlain = passwordPlain;
      saveUsers(users);

      resetCodes.delete(email);

      sendJson(res, 200, { ok: true, message: "Password has been reset. You can now log in with your new password." });
    } catch (e) {
      sendJson(res, 400, { message: e.message });
    }
    return;
  }

  // ── User Profile (own) ──────────────────────────────────────────────────────
  if (pathname === "/api/user/profile" && req.method === "GET") {
    const sessionId = getUserSessionFromCookie(req);
    const username = getUserFromSession(sessionId);
    if (!username) { sendJson(res, 401, { message: "Not logged in." }); return; }
    const profiles = loadProfiles();
    const profile = profiles[username];
    if (!profile) { sendJson(res, 404, { message: "Profile not found." }); return; }
    sendJson(res, 200, profile);
    return;
  }

  if (pathname === "/api/user/profile" && req.method === "PUT") {
    const sessionId = getUserSessionFromCookie(req);
    const username = getUserFromSession(sessionId);
    if (!username) { sendJson(res, 401, { message: "Not logged in." }); return; }
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const profiles = loadProfiles();
      if (!profiles[username]) { sendJson(res, 404, { message: "Profile not found." }); return; }
      const existing = profiles[username];
      profiles[username] = {
        username,
        displayName: (data.displayName || "").trim() || existing.displayName,
        email: data.email !== undefined ? data.email : existing.email,
        bio: data.bio !== undefined ? data.bio : existing.bio,
        pfp: data.pfp !== undefined ? data.pfp : existing.pfp,
        banner: data.banner !== undefined ? data.banner : existing.banner,
        followerCount: existing.followerCount,
        coffeePrice: data.coffeePrice !== undefined ? parseFloat(data.coffeePrice) || 1 : existing.coffeePrice,
        coffeeLabel: data.coffeeLabel !== undefined ? data.coffeeLabel || "coffee" : existing.coffeeLabel,
        gallery: Array.isArray(data.gallery) ? data.gallery : existing.gallery,
        posts: Array.isArray(data.posts) ? data.posts : existing.posts,
        shop: Array.isArray(data.shop) ? reconcileShopItems(data.shop, existing.shop) : existing.shop,
        tags: Array.isArray(data.tags) ? data.tags.slice(0, 4) : existing.tags,
      };
      saveProfiles(profiles);
      sendJson(res, 200, profiles[username]);
    } catch (e) {
      sendJson(res, 400, { message: e.message });
    }
    return;
  }

  // ── Earnings ─────────────────────────────────────────────────────────────────
  if (pathname === "/api/user/earnings" && req.method === "GET") {
    const sessionId = getUserSessionFromCookie(req);
    const username = getUserFromSession(sessionId);
    if (!username) { sendJson(res, 401, { message: "Not logged in." }); return; }
    try {
      const { gross, fees, net, count } = await getUserEarnings(username);
      const payments = [];
      if (process.env.STRIPE_SECRET_KEY) {
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
        let hasMore = true;
        let startingAfter = undefined;
        while (hasMore) {
          const page = await stripe.checkout.sessions.list({
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          });
          for (const session of page.data) {
            if (session.payment_status !== "paid") continue;
            if ((session.metadata?.creatorUsername || "") !== username) continue;
            const grossCents = session.amount_total || 0;
            const feeCents = Math.round(grossCents * 0.029 + 30);
            const netCents = grossCents - feeCents;
            payments.push({
              id: session.id,
              date: new Date(session.created * 1000).toISOString(),
              gross: grossCents / 100,
              fee: feeCents / 100,
              net: netCents / 100,
              donorName: session.metadata?.donorName || "",
              message: session.metadata?.message || "",
              type: session.metadata?.type || "donation",
              itemName: session.metadata?.itemName || "",
            });
          }
          hasMore = page.has_more;
          if (hasMore && page.data.length > 0) startingAfter = page.data[page.data.length - 1].id;
          else hasMore = false;
        }
        payments.sort((a, b) => new Date(b.date) - new Date(a.date));
      }
      // Calculate available balance (net minus pending/approved withdrawals)
      const withdrawals = loadWithdrawals();
      const userWithdrawals = Object.values(withdrawals).filter(w => w.username === username);
      const alreadyWithdrawn = userWithdrawals
        .filter(w => w.status === "approved" || w.status === "pending")
        .reduce((sum, w) => sum + (parseFloat(w.amount) || 0), 0);
      const available = Math.round((net - alreadyWithdrawn) * 100) / 100;
      sendJson(res, 200, { gross, fees, net, count, payments, available, alreadyWithdrawn });
    } catch (err) {
      console.error("Earnings error:", err.message);
      sendJson(res, 500, { message: err.message });
    }
    return;
  }

  // ── Stripe Checkout ─────────────────────────────────────────────────────────
  if (pathname === "/api/stripe/create-checkout" && req.method === "POST") {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      sendJson(res, 503, { error: "Stripe is not configured on this server." });
      return;
    }
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const amountCents = Math.round(parseFloat(data.amount) * 100);
      if (!amountCents || amountCents < 50) {
        sendJson(res, 400, { error: "Minimum donation amount is $0.50." });
        return;
      }
      const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });
      const host = req.headers.host || "localhost";
      const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
      const baseUrl = `${proto}://${host}`;
      const creatorUsername = (data.creatorUsername || "").replace(/[^a-zA-Z0-9_-]/g, "");
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: {
              name: `Support ${data.creatorName || creatorUsername || "a creator"} on BakaBoost`,
              description: data.message ? `"${data.message.slice(0, 120)}"` : "Coffee donation",
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        }],
        mode: "payment",
        success_url: `${baseUrl}/payment-success?creator=${encodeURIComponent(creatorUsername)}`,
        cancel_url: creatorUsername ? `${baseUrl}/${creatorUsername}` : `${baseUrl}/`,
        customer_email: data.email || undefined,
        metadata: {
          creatorUsername,
          donorName: (data.donorName || "").slice(0, 64),
          message: (data.message || "").slice(0, 200),
          type: (data.type || "donation").slice(0, 32),
          itemName: (data.itemName || "").slice(0, 64),
        },
      });
      sendJson(res, 200, { url: session.url });
    } catch (err) {
      console.error("Stripe checkout error:", err.message);
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (pathname === "/api/stripe/create-shop-checkout" && req.method === "POST") {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      sendJson(res, 503, { error: "Stripe is not configured on this server." });
      return;
    }
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const creatorUsername = (data.creatorUsername || "").replace(/[^a-zA-Z0-9_-]/g, "");
      const itemId = data.itemId || "";
      const profiles = loadProfiles();
      const profile = profiles[creatorUsername];
      if (!profile) { sendJson(res, 404, { error: "Creator not found." }); return; }
      const item = (profile.shop || []).find((s) => s.id === itemId && s.status === "approved");
      if (!item) { sendJson(res, 404, { error: "Item not found or not available." }); return; }
      const amountCents = Math.round(parseFloat(item.price) * 100);
      if (!amountCents || amountCents < 50) {
        sendJson(res, 400, { error: "Item price is invalid." });
        return;
      }
      const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });
      const host = req.headers.host || "localhost";
      const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
      const baseUrl = `${proto}://${host}`;
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: {
              name: item.name || "Shop item",
              description: item.description ? item.description.slice(0, 200) : undefined,
              images: item.image ? [item.image] : undefined,
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        }],
        mode: "payment",
        success_url: `${baseUrl}/payment-success?creator=${encodeURIComponent(creatorUsername)}`,
        cancel_url: `${baseUrl}/${creatorUsername}`,
        customer_email: data.email || undefined,
        metadata: {
          creatorUsername,
          itemId,
          itemName: (item.name || "").slice(0, 64),
          type: "shop",
        },
      });
      sendJson(res, 200, { url: session.url });
    } catch (err) {
      console.error("Stripe shop checkout error:", err.message);
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // ── Withdrawals ─────────────────────────────────────────────────────────────
  if (pathname === "/api/user/withdraw" && req.method === "POST") {
    const sessionId = getUserSessionFromCookie(req);
    const username = getUserFromSession(sessionId);
    if (!username) { sendJson(res, 401, { message: "Not logged in." }); return; }
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const amount = parseFloat(data.amount) || 0;
      if (amount <= 0) { sendJson(res, 400, { message: "Invalid amount." }); return; }
      if (amount < 10) { sendJson(res, 400, { message: "Minimum withdrawal is $10." }); return; }

      // Round to 2 decimal places to avoid floating point issues
      const roundedAmount = Math.round(amount * 100) / 100;

      const email = (data.email || "").trim();
      if (!email) { sendJson(res, 400, { message: "Payment email is required." }); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        sendJson(res, 400, { message: "Please enter a valid email address." }); return;
      }

      // Fetch user's total earnings from Stripe
      const { net } = await getUserEarnings(username);

      // Sum all previously approved + pending withdrawals for this user
      const withdrawals = loadWithdrawals();
      const userWithdrawals = Object.values(withdrawals).filter(w => w.username === username);
      const alreadyWithdrawn = userWithdrawals
        .filter(w => w.status === "approved" || w.status === "pending")
        .reduce((sum, w) => sum + (parseFloat(w.amount) || 0), 0);

      const available = Math.round((net - alreadyWithdrawn) * 100) / 100;

      if (roundedAmount > available) {
        sendJson(res, 400, {
          message: `Insufficient balance. You have $${available.toFixed(2)} available to withdraw ($${net.toFixed(2)} earned − $${alreadyWithdrawn.toFixed(2)} already requested/paid out).`,
          available,
          earned: net,
          alreadyWithdrawn,
        });
        return;
      }

      // Prevent duplicate pending requests for similar amount
      const hasPending = userWithdrawals.some(
        w => w.status === "pending" && Math.abs(parseFloat(w.amount) - roundedAmount) < 0.01
      );
      if (hasPending) {
        sendJson(res, 400, { message: "You already have a pending withdrawal request for this amount." });
        return;
      }

      const id = "w" + Date.now() + crypto.randomBytes(4).toString("hex");
      withdrawals[id] = {
        id, username, amount: roundedAmount, email,
        status: "pending",
        created: new Date().toISOString(),
      };
      saveWithdrawals(withdrawals);
      sendJson(res, 201, { ok: true, withdrawal: withdrawals[id], available: available - roundedAmount });
    } catch (e) {
      sendJson(res, 400, { message: e.message });
    }
    return;
  }

  if (pathname === "/api/user/withdrawals" && req.method === "GET") {
    const sessionId = getUserSessionFromCookie(req);
    const username = getUserFromSession(sessionId);
    if (!username) { sendJson(res, 401, { message: "Not logged in." }); return; }
    const withdrawals = loadWithdrawals();
    const list = Object.values(withdrawals).filter(w => w.username === username).sort((a, b) => new Date(b.created) - new Date(a.created));
    sendJson(res, 200, list);
    return;
  }

  if (pathname === "/api/admin/withdrawals" && req.method === "GET") {
    const sessionId = getAdminSessionFromCookie(req);
    if (!isValidAdminSession(sessionId)) { sendJson(res, 401, { message: "Unauthorized" }); return; }
    const withdrawals = loadWithdrawals();
    const list = Object.values(withdrawals).sort((a, b) => {
      if (a.status === "pending" && b.status !== "pending") return -1;
      if (a.status !== "pending" && b.status === "pending") return 1;
      return new Date(b.created) - new Date(a.created);
    });
    sendJson(res, 200, list);
    return;
  }

  if (pathname === "/api/admin/withdraw-review" && req.method === "POST") {
    const sessionId = getAdminSessionFromCookie(req);
    if (!isValidAdminSession(sessionId)) { sendJson(res, 401, { message: "Unauthorized" }); return; }
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const id = data.id || "";
      const decision = data.decision; // "approved" or "rejected"
      if (!id || !["approved", "rejected"].includes(decision)) {
        sendJson(res, 400, { message: "Invalid request." }); return;
      }
      const withdrawals = loadWithdrawals();
      if (!withdrawals[id]) { sendJson(res, 404, { message: "Withdrawal not found." }); return; }
      withdrawals[id].status = decision;
      withdrawals[id].reviewedAt = new Date().toISOString();
      saveWithdrawals(withdrawals);
      sendJson(res, 200, { ok: true, withdrawal: withdrawals[id] });
    } catch (e) {
      sendJson(res, 400, { message: e.message });
    }
    return;
  }

  // ── Static & Page Routes ────────────────────────────────────────────────────
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

  if (pathname === "/payment-success" || pathname === "/payment-success/") {
    const filePath = path.join(__dirname, "payment-success.html");
    fs.readFile(filePath, (err, data) => {
      if (err) { send(res, 500, "Page missing"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  if (pathname === "/login" || pathname === "/login/") {
    const filePath = path.join(__dirname, "login.html");
    fs.readFile(filePath, (err, data) => {
      if (err) { send(res, 500, "Login page missing"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  if (pathname === "/apply" || pathname === "/apply/") {
    const filePath = path.join(__dirname, "apply.html");
    fs.readFile(filePath, (err, data) => {
      if (err) { send(res, 500, "Apply page missing"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  if (pathname === "/dashboard" || pathname === "/dashboard/") {
    const filePath = path.join(__dirname, "dashboard.html");
    fs.readFile(filePath, (err, data) => {
      if (err) { send(res, 500, "Dashboard missing"); return; }
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

  if (pathname === "/health" || pathname === "/_health") {
    send(res, 200, JSON.stringify({ status: "ok", time: Date.now() }));
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

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

migrateShopStatuses();

try {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`BakaBoost running at http://0.0.0.0:${PORT}`);
    console.log(`Admin panel: http://0.0.0.0:${PORT}/admin`);
    console.log(`Login: http://0.0.0.0:${PORT}/login`);
  });
} catch (err) {
  console.error("FAILED TO START SERVER:", err);
  process.exit(1);
}
