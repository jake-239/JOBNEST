const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const DB_FILE = path.join(ROOT, "database", "db.json");
const PORT = process.env.PORT || 5000;
const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

let googleCertCache = { expiresAt: 0, keys: [] };

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function seedData() {
  return {
    users: [
      {
        id: "u_admin",
        name: "Admin User",
        email: "admin@jobnest.local",
        password: "admin123",
        role: "admin",
        bio: "Platform administrator",
      },
      {
        id: "u_client",
        name: "Demo Client",
        email: "client@jobnest.local",
        password: "client123",
        role: "client",
        bio: "Hiring product and web talent",
      },
      {
        id: "u_freelancer",
        name: "Demo Freelancer",
        email: "freelancer@jobnest.local",
        password: "freelancer123",
        role: "freelancer",
        bio: "Frontend developer and UI builder",
      },
    ],
    jobs: [
      {
        id: "j_react",
        title: "React Landing Page",
        category: "Web Development",
        budget: 450,
        description: "Build a responsive landing page for a SaaS product.",
        clientId: "u_client",
        createdAt: new Date().toISOString(),
      },
      {
        id: "j_brand",
        title: "Brand Identity Kit",
        category: "Design",
        budget: 700,
        description: "Create a logo, colors, typography, and social templates.",
        clientId: "u_client",
        createdAt: new Date().toISOString(),
      },
      {
        id: "j_seo",
        title: "SEO Blog Series",
        category: "Writing",
        budget: 350,
        description: "Write ten search-friendly articles for a startup blog.",
        clientId: "u_client",
        createdAt: new Date().toISOString(),
      },
    ],
    messages: [
      {
        id: "m_welcome",
        userId: "u_freelancer",
        subject: "Welcome to JobNest",
        body: "Your workspace is ready. Browse jobs and send your first proposal.",
        createdAt: new Date().toISOString(),
      },
    ],
    wallet: [
      { userId: "u_freelancer", available: 1250, pending: 320, withdrawn: 4800 },
      { userId: "u_client", available: 2400, pending: 900, withdrawn: 1200 },
      { userId: "u_admin", available: 0, pending: 0, withdrawn: 0 },
    ],
  };
}

function ensureDb() {
  if (!fs.existsSync(DB_FILE)) {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(seedData(), null, 2));
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function setCorsHeaders(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-user-id");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function publicUser(user) {
  if (!user) return null;
  const { password, googleId, ...safeUser } = user;
  return safeUser;
}

function findCurrentUser(req, db) {
  const userId = req.headers["x-user-id"];
  return db.users.find((user) => user.id === userId);
}

function normalizeRole(role) {
  return ["admin", "client", "freelancer"].includes(role) ? role : "freelancer";
}

function normalizeSignupRole(role) {
  return ["client", "freelancer"].includes(role) ? role : "freelancer";
}

function base64UrlToBuffer(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function decodeJwtPart(value) {
  return JSON.parse(base64UrlToBuffer(value).toString("utf8"));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error("Could not load Google sign-in certificates."));
            return;
          }
          try {
            resolve({
              headers: response.headers,
              data: JSON.parse(body),
            });
          } catch (error) {
            reject(new Error("Google sign-in certificates were unreadable."));
          }
        });
      })
      .on("error", () => reject(new Error("Could not connect to Google sign-in.")));
  });
}

async function getGoogleCerts() {
  if (googleCertCache.keys.length && googleCertCache.expiresAt > Date.now()) {
    return googleCertCache.keys;
  }

  const { headers, data } = await getJson(GOOGLE_CERTS_URL);
  const maxAge = /max-age=(\d+)/.exec(headers["cache-control"] || "")?.[1];
  googleCertCache = {
    expiresAt: Date.now() + Number(maxAge || 3600) * 1000,
    keys: Array.isArray(data.keys) ? data.keys : [],
  };
  return googleCertCache.keys;
}

async function verifyGoogleCredential(credential) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error("Set GOOGLE_CLIENT_ID on the server to use real Google sign-in.");
  }

  const parts = String(credential || "").split(".");
  if (parts.length !== 3) {
    throw new Error("Google sign-in response was invalid.");
  }

  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decodeJwtPart(headerPart);
  const payload = decodeJwtPart(payloadPart);

  if (header.alg !== "RS256" || !header.kid) {
    throw new Error("Google sign-in response was invalid.");
  }

  const cert = (await getGoogleCerts()).find((key) => key.kid === header.kid);
  if (!cert) {
    throw new Error("Google sign-in certificate was not found.");
  }

  const signedData = Buffer.from(`${headerPart}.${payloadPart}`);
  const signature = base64UrlToBuffer(signaturePart);
  const publicKey = crypto.createPublicKey({ key: cert, format: "jwk" });
  const isVerified = crypto.verify("RSA-SHA256", signedData, publicKey, signature);
  if (!isVerified) {
    throw new Error("Google sign-in response could not be verified.");
  }

  if (!GOOGLE_ISSUERS.has(payload.iss) || payload.aud !== clientId || Number(payload.exp || 0) * 1000 <= Date.now()) {
    throw new Error("Google sign-in response has expired or is not for this app.");
  }

  if (!payload.email || payload.email_verified === false || payload.email_verified === "false") {
    throw new Error("Your Google account email must be verified.");
  }

  return {
    googleId: String(payload.sub || ""),
    name: String(payload.name || payload.email.split("@")[0]).trim(),
    email: String(payload.email).trim().toLowerCase(),
  };
}

async function getGoogleProfile(body) {
  if (body.credential) {
    return verifyGoogleCredential(body.credential);
  }

  return {
    googleId: "demo-google-user",
    name: "Google Demo User",
    email: "google.user@jobnest.local",
  };
}

function requireAdmin(req, res, db) {
  const user = findCurrentUser(req, db);
  if (!user || user.role !== "admin") {
    sendJson(res, 403, { error: "Admin access required." });
    return null;
  }
  return user;
}

function readIdFromPath(pathname, prefix) {
  return decodeURIComponent(pathname.slice(prefix.length));
}

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function serveFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(ROOT, requested));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      const notFoundPath = path.join(ROOT, "404.html");
      fs.readFile(notFoundPath, (notFoundError, notFoundContents) => {
        if (notFoundError) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }
        res.writeHead(404, { "Content-Type": mimeTypes[".html"] });
        res.end(notFoundContents);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(contents);
  });
}

async function handleApi(req, res) {
  const db = readDb();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === "GET /api/health") {
      sendJson(res, 200, { status: "ok", app: "JobNest" });
      return;
    }

    if (route === "POST /api/auth/signup") {
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const name = String(body.name || "").trim();
      const password = String(body.password || "");
      const role = normalizeSignupRole(String(body.role || "freelancer").toLowerCase());

      if (!name || !email || !password) {
        sendJson(res, 400, { error: "Name, email, and password are required." });
        return;
      }

      if (password.length < 6) {
        sendJson(res, 400, { error: "Password must be at least 6 characters." });
        return;
      }

      if (db.users.some((user) => user.email === email)) {
        sendJson(res, 409, { error: "An account with this email already exists." });
        return;
      }

      const user = { id: uid("u"), name, email, password, role, bio: "" };
      db.users.push(user);
      db.wallet.push({ userId: user.id, available: 0, pending: 0, withdrawn: 0 });
      db.messages.push({
        id: uid("m"),
        userId: user.id,
        subject: "Welcome to JobNest",
        body: "Your account is ready.",
        createdAt: new Date().toISOString(),
      });
      writeDb(db);
      sendJson(res, 201, { user: publicUser(user) });
      return;
    }

    if (route === "POST /api/auth/login") {
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const user = db.users.find((item) => item.email === email && item.password === password);

      if (!user) {
        sendJson(res, 401, { error: "Invalid email or password." });
        return;
      }

      sendJson(res, 200, { user: publicUser(user) });
      return;
    }

    if (route === "POST /api/auth/google") {
      const body = await readBody(req);
      let profile;
      try {
        profile = await getGoogleProfile(body);
      } catch (error) {
        sendJson(res, 401, { error: error.message || "Google sign-in failed." });
        return;
      }
      const role = normalizeSignupRole(String(body.role || "freelancer").toLowerCase());
      let user = db.users.find((item) => item.email === profile.email);
      let changed = false;

      if (!user) {
        user = {
          id: uid("u"),
          name: profile.name,
          email: profile.email,
          password: uid("google"),
          role,
          bio: "Signed in with Google.",
          googleId: profile.googleId,
        };
        db.users.push(user);
        db.wallet.push({ userId: user.id, available: 0, pending: 0, withdrawn: 0 });
        db.messages.push({
          id: uid("m"),
          userId: user.id,
          subject: "Welcome to JobNest",
          body: "Your Google account is connected.",
          createdAt: new Date().toISOString(),
        });
        changed = true;
      } else if (!user.googleId && profile.googleId) {
        user.googleId = profile.googleId;
        changed = true;
      }

      if (profile.googleId === "demo-google-user" && body.context === "signup" && user.role !== role) {
        user.role = role;
        changed = true;
      }

      if (changed) writeDb(db);
      sendJson(res, 200, { user: publicUser(user) });
      return;
    }

    if (route === "GET /api/me") {
      sendJson(res, 200, { user: publicUser(findCurrentUser(req, db)) });
      return;
    }

    if (route === "GET /api/jobs") {
      const jobs = db.jobs.map((job) => ({
        ...job,
        client: publicUser(db.users.find((user) => user.id === job.clientId)),
      }));
      sendJson(res, 200, { jobs });
      return;
    }

    if (route === "POST /api/jobs") {
      const user = findCurrentUser(req, db);
      if (!user || !["client", "admin"].includes(user.role)) {
        sendJson(res, 403, { error: "Only clients can post jobs." });
        return;
      }

      const body = await readBody(req);
      const title = String(body.title || "").trim();
      const category = String(body.category || "").trim();
      const budget = Number(body.budget || 0);
      const description = String(body.description || "").trim();

      if (!title || !category || !budget || !description) {
        sendJson(res, 400, { error: "Title, category, budget, and description are required." });
        return;
      }

      const job = {
        id: uid("j"),
        title,
        category,
        budget,
        description,
        clientId: user.id,
        createdAt: new Date().toISOString(),
      };
      db.jobs.unshift(job);
      writeDb(db);
      sendJson(res, 201, { job });
      return;
    }

    if (route === "POST /api/profile") {
      const user = findCurrentUser(req, db);
      if (!user) {
        sendJson(res, 401, { error: "Please login first." });
        return;
      }

      const body = await readBody(req);
      user.name = String(body.name || user.name).trim();
      user.bio = String(body.bio || "").trim();
      writeDb(db);
      sendJson(res, 200, { user: publicUser(user) });
      return;
    }

    if (route === "GET /api/messages") {
      const user = findCurrentUser(req, db);
      if (!user) {
        sendJson(res, 401, { error: "Please login first." });
        return;
      }
      const messages = db.messages.filter((message) => message.userId === user.id || user.role === "admin");
      sendJson(res, 200, { messages });
      return;
    }

    if (route === "POST /api/messages") {
      const user = findCurrentUser(req, db);
      if (!user) {
        sendJson(res, 401, { error: "Please login first." });
        return;
      }

      const body = await readBody(req);
      const message = {
        id: uid("m"),
        userId: user.id,
        subject: String(body.subject || "New Message").trim(),
        body: String(body.body || "").trim(),
        createdAt: new Date().toISOString(),
      };
      db.messages.unshift(message);
      writeDb(db);
      sendJson(res, 201, { message });
      return;
    }

    if (route === "GET /api/wallet") {
      const user = findCurrentUser(req, db);
      if (!user) {
        sendJson(res, 401, { error: "Please login first." });
        return;
      }

      const wallet = db.wallet.find((item) => item.userId === user.id) || {
        userId: user.id,
        available: 0,
        pending: 0,
        withdrawn: 0,
      };
      sendJson(res, 200, { wallet });
      return;
    }

    if (route === "GET /api/admin/stats") {
      if (!requireAdmin(req, res, db)) return;

      sendJson(res, 200, {
        users: db.users.length,
        jobs: db.jobs.length,
        messages: db.messages.length,
        reports: 0,
      });
      return;
    }

    if (route === "GET /api/admin/overview") {
      if (!requireAdmin(req, res, db)) return;
      sendJson(res, 200, {
        users: db.users.map(publicUser),
        jobs: db.jobs.map((job) => ({
          ...job,
          client: publicUser(db.users.find((user) => user.id === job.clientId)),
        })),
        messages: db.messages,
        wallet: db.wallet.map((wallet) => ({
          ...wallet,
          user: publicUser(db.users.find((user) => user.id === wallet.userId)),
        })),
      });
      return;
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/admin/users/")) {
      const admin = requireAdmin(req, res, db);
      if (!admin) return;

      const id = readIdFromPath(url.pathname, "/api/admin/users/");
      const user = db.users.find((item) => item.id === id);
      if (!user) {
        sendJson(res, 404, { error: "User not found." });
        return;
      }

      const body = await readBody(req);
      if (body.name) user.name = String(body.name).trim();
      if (body.bio !== undefined) user.bio = String(body.bio).trim();
      if (body.role && id !== admin.id) user.role = normalizeRole(String(body.role).toLowerCase());
      writeDb(db);
      sendJson(res, 200, { user: publicUser(user) });
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/users/")) {
      const admin = requireAdmin(req, res, db);
      if (!admin) return;

      const id = readIdFromPath(url.pathname, "/api/admin/users/");
      if (id === admin.id) {
        sendJson(res, 400, { error: "Admin cannot delete their own account." });
        return;
      }

      db.users = db.users.filter((user) => user.id !== id);
      db.jobs = db.jobs.filter((job) => job.clientId !== id);
      db.messages = db.messages.filter((message) => message.userId !== id);
      db.wallet = db.wallet.filter((wallet) => wallet.userId !== id);
      writeDb(db);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/jobs/")) {
      if (!requireAdmin(req, res, db)) return;
      const id = readIdFromPath(url.pathname, "/api/admin/jobs/");
      db.jobs = db.jobs.filter((job) => job.id !== id);
      writeDb(db);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/messages/")) {
      if (!requireAdmin(req, res, db)) return;
      const id = readIdFromPath(url.pathname, "/api/admin/messages/");
      db.messages = db.messages.filter((message) => message.id !== id);
      writeDb(db);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/admin/wallet/")) {
      if (!requireAdmin(req, res, db)) return;
      const userId = readIdFromPath(url.pathname, "/api/admin/wallet/");
      const body = await readBody(req);
      let wallet = db.wallet.find((item) => item.userId === userId);
      if (!wallet) {
        wallet = { userId, available: 0, pending: 0, withdrawn: 0 };
        db.wallet.push(wallet);
      }
      wallet.available = Number(body.available ?? wallet.available);
      wallet.pending = Number(body.pending ?? wallet.pending);
      wallet.withdrawn = Number(body.withdrawn ?? wallet.withdrawn);
      writeDb(db);
      sendJson(res, 200, { wallet });
      return;
    }

    sendJson(res, 404, { error: "API route not found." });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error." });
  }
}

ensureDb();

http
  .createServer((req, res) => {
    setCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url.startsWith("/api/")) {
      handleApi(req, res);
      return;
    }
    serveFile(req, res);
  })
  .listen(PORT, () => {
    console.log(`JobNest running at http://localhost:${PORT}`);
  });
