const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const payments = require("./payments");

const PORT = process.env.PORT || 3005;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "bakaboost2025";
const PROFILES_PATH = path.join(__dirname, "profiles.json");
const SESSION_TTL = 24 * 60 * 60 * 1000;

const adminSessions = new Map();
const gatewaySessions = new Map();

function createSession(store) {
  const id = crypto.randomBytes(32).toString("hex");
  store.set(id, { created: Date.now() });
  return id;
}

function isValidSession(store, id) {
  if (!id) return false;
  const session = store.get(id);
  if (!session) return false;
  if (Date.now() - session.created > SESSION_TTL) {
    store.delete(id);
    return false;
  }
  return true;
}

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(new RegExp(`${name}=([^;]+)`));
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

function normalizeProfile(data, existing) {
  const username = (data.username || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const gatewayPassword = String(data.gatewayPassword ?? existing?.gatewayPassword ?? "").trim()
    || crypto.randomBytes(4).toString("hex");
  return {
    username,
    displayName: data.displayName || username,
    bio: data.bio || "",
    pfp: data.pfp || "",
    banner: data.banner || "",
    followerCount: parseInt(data.followerCount, 10) || 0,
    coffeePrice: parseFloat(data.coffeePrice) || 1,
    coffeeLabel: data.coffeeLabel || "coffee",
    gatewayPassword,
    gallery: data.gallery || [],
    posts: data.posts || [],
    shop: data.shop || [],
  };
}

function getAdminSession(req) {
  return getCookie(req, "baka_admin_session");
}

function isAdmin(req) {
  return isValidSession(adminSessions, getAdminSession(req));
}

function getGatewayUsername(req) {
  const sessionId = getCookie(req, "baka_gateway_session");
  if (!isValidSession(gatewaySessions, sessionId)) return null;
  return gatewaySessions.get(sessionId).username || null;
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
      if (body.length > 5_000_000) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 1_000_000) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function serveProfilePage(res, profile) {
  const templatePath = path.join(__dirname, "profile-template.html");
  fs.readFile(templatePath, "utf8", (err, tmpl) => {
    if (err) {
      send(res, 500, "Profile template missing");
      return;
    }
    const publicProfile = { ...profile };
    delete publicProfile.gatewayPassword;
    const html = tmpl.replace("__PROFILE_DATA__", JSON.stringify(publicProfile).replace(/<\/script>/gi, "<\\/script>"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
}

function serveGatewayPage(res) {
  const filePath = path.join(__dirname, "gateway.html");
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 500, "Gateway page missing");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "POST" && pathname === "/api/checkout/create") {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const username = String(data.username || "").toLowerCase();
      const profiles = loadProfiles();
      const profile = profiles[username];
      if (!profile) {
        sendJson(res, 404, { message: "Creator not found" });
        return;
      }
      const result = await payments.createCheckoutSession(req, profile, data);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { message: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/webhooks/stripe") {
    try {
      const rawBody = await readRawBody(req);
      const signature = req.headers["stripe-signature"] || "";
      const result = await payments.handleStripeWebhook(rawBody, signature);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { message: error.message });
    }
    return;
  }

  if (pathname === "/api/gateway/login" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const username = String(data.username || "").toLowerCase();
      const password = String(data.password || "");
      const profiles = loadProfiles();
      const profile = profiles[username];
      if (!profile || password !== profile.gatewayPassword) {
        sendJson(res, 401, { ok: false, message: "Wrong username or password" });
        return;
      }
      const sessionId = crypto.randomBytes(32).toString("hex");
      gatewaySessions.set(sessionId, { created: Date.now(), username });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `baka_gateway_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
      });
      res.end(JSON.stringify({ ok: true, username }));
    } catch {
      sendJson(res, 400, { ok: false, message: "Bad request" });
    }
    return;
  }

  if (pathname === "/api/gateway/logout" && req.method === "POST") {
    const sessionId = getCookie(req, "baka_gateway_session");
    if (sessionId) gatewaySessions.delete(sessionId);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": "baka_gateway_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === "/api/gateway/me" && req.method === "GET") {
    const username = getGatewayUsername(req);
    if (!username) {
      sendJson(res, 200, { loggedIn: false });
      return;
    }
    const profiles = loadProfiles();
    const profile = profiles[username];
    if (!profile) {
      sendJson(res, 200, { loggedIn: false });
      return;
    }
    sendJson(res, 200, {
      loggedIn: true,
      username,
      displayName: profile.displayName,
    });
    return;
  }

  if (pathname === "/api/gateway/summary" && req.method === "GET") {
    const username = getGatewayUsername(req);
    if (!username) {
      sendJson(res, 401, { message: "Unauthorized" });
      return;
    }
    sendJson(res, 200, {
      balance: payments.getCreatorBalance(username),
      transactions: payments.listCreatorTransactions(username),
      withdrawals: payments.listCreatorWithdrawals(username),
    });
    return;
  }

  if (pathname === "/api/gateway/withdraw" && req.method === "POST") {
    const username = getGatewayUsername(req);
    if (!username) {
      sendJson(res, 401, { message: "Unauthorized" });
      return;
    }
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const row = payments.createWithdrawal(username, data);
      sendJson(res, 201, row);
    } catch (error) {
      sendJson(res, 400, { message: error.message });
    }
    return;
  }

  if (pathname === "/api/admin/login" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const { password } = JSON.parse(body);
      if (password === ADMIN_PASSWORD) {
        const sessionId = createSession(adminSessions);
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
    const sessionId = getAdminSession(req);
    if (sessionId) adminSessions.delete(sessionId);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": "baka_admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === "/api/admin/me" && req.method === "GET") {
    sendJson(res, 200, { loggedIn: isAdmin(req) });
    return;
  }

  if (pathname === "/api/admin/profiles" && req.method === "GET") {
    if (!isAdmin(req)) {
      sendJson(res, 401, { message: "Unauthorized" });
      return;
    }
    const profiles = loadProfiles();
    const summary = {};
    for (const [username, profile] of Object.entries(profiles)) {
      summary[username] = {
        ...profile,
        balance: payments.getCreatorBalance(username),
      };
    }
    sendJson(res, 200, summary);
    return;
  }

  if (pathname === "/api/admin/profiles" && req.method === "POST") {
    if (!isAdmin(req)) {
      sendJson(res, 401, { message: "Unauthorized" });
      return;
    }
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const username = (data.username || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
      if (!username) {
        sendJson(res, 400, { message: "Invalid username" });
        return;
      }
      const profiles = loadProfiles();
      if (profiles[username]) {
        sendJson(res, 409, { message: "Username already exists" });
        return;
      }
      profiles[username] = normalizeProfile(data);
      saveProfiles(profiles);
      sendJson(res, 201, profiles[username]);
    } catch (e) {
      sendJson(res, 400, { message: e.message });
    }
    return;
  }

  const profileEditMatch = pathname.match(/^\/api\/admin\/profiles\/([^/]+)$/);

  if (profileEditMatch && req.method === "PUT") {
    if (!isAdmin(req)) {
      sendJson(res, 401, { message: "Unauthorized" });
      return;
    }
    const oldUsername = profileEditMatch[1];
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const newUsername = (data.username || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
      if (!newUsername) {
        sendJson(res, 400, { message: "Invalid username" });
        return;
      }
      const profiles = loadProfiles();
      if (!profiles[oldUsername]) {
        sendJson(res, 404, { message: "Profile not found" });
        return;
      }
      if (newUsername !== oldUsername && profiles[newUsername]) {
        sendJson(res, 409, { message: "Username already exists" });
        return;
      }
      const existing = profiles[oldUsername];
      if (newUsername !== oldUsername) delete profiles[oldUsername];
      profiles[newUsername] = normalizeProfile({ ...existing, ...data, username: newUsername }, existing);
      saveProfiles(profiles);
      sendJson(res, 200, profiles[newUsername]);
    } catch (e) {
      sendJson(res, 400, { message: e.message });
    }
    return;
  }

  if (profileEditMatch && req.method === "DELETE") {
    if (!isAdmin(req)) {
      sendJson(res, 401, { message: "Unauthorized" });
      return;
    }
    const username = profileEditMatch[1];
    const profiles = loadProfiles();
    if (!profiles[username]) {
      sendJson(res, 404, { message: "Profile not found" });
      return;
    }
    delete profiles[username];
    saveProfiles(profiles);
    sendJson(res, 200, { message: "Deleted" });
    return;
  }

  if (pathname === "/api/admin/withdrawals" && req.method === "GET") {
    if (!isAdmin(req)) {
      sendJson(res, 401, { message: "Unauthorized" });
      return;
    }
    const status = url.searchParams.get("status") || "";
    sendJson(res, 200, payments.listAllWithdrawals(status || null));
    return;
  }

  const withdrawalMatch = pathname.match(/^\/api\/admin\/withdrawals\/([^/]+)\/(approve|reject|mark-paid)$/);

  if (withdrawalMatch && req.method === "POST") {
    if (!isAdmin(req)) {
      sendJson(res, 401, { message: "Unauthorized" });
      return;
    }
    const [, id, action] = withdrawalMatch;
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      body = {};
    }
    const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : "paid";
    const row = payments.updateWithdrawal(id, status, body.adminNote || "");
    if (!row) {
      sendJson(res, 404, { message: "Withdrawal not found" });
      return;
    }
    sendJson(res, 200, row);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed");
    return;
  }

  if (pathname === "/") {
    const homePath = path.join(__dirname, "homepage.html");
    fs.readFile(homePath, (err, data) => {
      if (err) {
        send(res, 500, "Homepage missing");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  if (pathname === "/admin" || pathname === "/admin/") {
    const adminPath = path.join(__dirname, "admin.html");
    fs.readFile(adminPath, (err, data) => {
      if (err) {
        send(res, 500, "Admin panel missing");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  if (pathname === "/gateway" || pathname === "/gateway/") {
    serveGatewayPage(res);
    return;
  }

  const staticExtensions = [".html", ".css", ".js", ".json", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".txt", ".zip", ".woff", ".woff2"];
  const ext = path.extname(pathname).toLowerCase();
  if (ext && staticExtensions.includes(ext)) {
    const relativePath = pathname.replace(/^\/+/, "");
    const safePath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(__dirname, safePath);
    if (!filePath.startsWith(__dirname)) {
      send(res, 403, "Forbidden");
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        send(res, 404, "Not found");
        return;
      }
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
  console.log(`Creator gateway: http://127.0.0.1:${PORT}/gateway`);
  if (!process.env.STRIPE_SECRET_KEY) {
    console.log("Stripe: STRIPE_SECRET_KEY is not set");
  }
});
