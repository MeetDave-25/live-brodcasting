// RANGVAASA Live – app server (no npm packages needed).
//   node serve.js        then open http://localhost:8080
// Serves the app from public/, checks passwords, runs the admin API and
// forwards video to/from MediaMTX. Settings come from .env (see .env.example).
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT) || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const BROADCAST_PASSWORD = process.env.BROADCAST_PASSWORD || "garba2026";
// Most people who can watch at once. Everyone after that sees "Full house" and joins when a spot opens.
const MAX_VIEWERS = Number(process.env.MAX_VIEWERS) || 400;
const MTX = { hls: 8888, webrtc: 8889, api: 9997, playback: 9996 };
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const RECORDINGS = path.join(ROOT, "server", "recordings");
const ANGLES = ["cam1", "cam2", "cam3", "cam4", "cam5", "cam6"];
const isAngle = (a) => ANGLES.includes(a);

if (!process.env.ADMIN_PASSWORD || !process.env.BROADCAST_PASSWORD) {
  console.warn("! Using default passwords. Copy .env.example to .env and set your own.");
}

function loadEnv(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

// ---------- Shared state (main angle + announcement), survives restarts ----------
const STATE_FILE = path.join(DATA, "state.json");
const state = { featured: "cam1", announcement: "", announcedAt: null };
try { Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))); } catch {}
function saveState() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- Helpers ----------
function send(res, code, body, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > limit) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function mtxRequest(port, p, method = "GET") {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, timeout: 4000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", reject);
    r.end();
  });
}

function proxy(req, res, port, targetPath, { headers = req.headers, extraHeaders = {} } = {}) {
  const up = http.request({ host: "127.0.0.1", port, path: targetPath, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode, { ...r.headers, ...extraHeaders });
    r.pipe(res);
  });
  up.on("error", () => send(res, 502, { error: "Streaming server is not running" }));
  req.pipe(up);
}

function clientIp(req) {
  const remote = req.socket.remoteAddress || "";
  const fwd = req.headers["x-forwarded-for"];
  if (fwd && /^(::1|127\.|::ffff:127\.)/.test(remote)) return fwd.split(",")[0].trim();
  return remote;
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Slow down password guessing: 8 wrong tries per IP -> locked for 10 minutes
const fails = new Map();
function isLocked(ip) {
  const f = fails.get(ip);
  return f && f.count >= 8 && Date.now() < f.until;
}
function noteFail(ip) {
  const f = fails.get(ip) || { count: 0, until: 0 };
  if (Date.now() > f.until) f.count = 0;
  f.count++;
  f.until = Date.now() + 10 * 60 * 1000;
  fails.set(ip, f);
}

// ---------- MediaMTX status (cached, so 500 viewers polling = 1 request / 2 s) ----------
let pathsCache = { at: 0, items: [] };
let pathsInflight = null;
function mtxPaths(maxAge = 2000) {
  if (Date.now() - pathsCache.at < maxAge) return Promise.resolve(pathsCache.items);
  if (!pathsInflight) {
    pathsInflight = mtxRequest(MTX.api, "/v3/paths/list?itemsPerPage=100")
      .then((r) => (JSON.parse(r.data).items || []))
      .catch(() => [])
      .then((items) => { pathsCache = { at: Date.now(), items }; pathsInflight = null; return items; });
  }
  return pathsInflight;
}
const liveAngles = (items) => items.filter((p) => isAngle(p.name) && p.ready).map((p) => p.name);

// ---------- Viewers: each open app checks in every few seconds ----------
const viewers = new Map(); // id -> { t, angle }
function pruneViewers() {
  const now = Date.now();
  for (const [k, v] of viewers) if (now - v.t > 30000) viewers.delete(k);
}

// Video is only served to viewers holding a spot (cookie from /api/status)
function hasViewerSpot(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)rv_v=([a-z0-9]{6,40})/);
  const v = m && viewers.get(m[1]);
  return !!v && Date.now() - v.t < 30000;
}

// ---------- Admin sessions ----------
const sessions = new Map(); // token -> expiry
function isAdmin(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)rv_admin=([a-f0-9]{48})/);
  const exp = m && sessions.get(m[1]);
  return !!exp && exp > Date.now();
}

// ---------- API ----------
async function api(req, res, url) {
  const route = url.pathname;

  // Public status for the viewer app. Also hands out viewer spots (up to MAX_VIEWERS).
  if (route === "/api/status") {
    const id = url.searchParams.get("id");
    const angle = url.searchParams.get("angle");
    pruneViewers();
    let admitted = false;
    const headers = {};
    if (id && /^[a-z0-9]{6,40}$/.test(id) && (viewers.has(id) || viewers.size < MAX_VIEWERS)) {
      viewers.set(id, { t: Date.now(), angle: isAngle(angle) ? angle : null });
      admitted = true;
      const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
      headers["Set-Cookie"] = `rv_v=${id}; Path=/; SameSite=Lax; Max-Age=120${secure}`;
    }
    const items = await mtxPaths();
    return send(res, 200, {
      live: liveAngles(items),
      featured: state.featured,
      announcement: state.announcement,
      announcedAt: state.announcedAt,
      watching: viewers.size,
      capacity: MAX_VIEWERS,
      admitted,
    }, headers);
  }

  // Broadcaster password check (studio, before going live)
  if (route === "/api/studio/check" && req.method === "POST") {
    const ip = clientIp(req);
    if (isLocked(ip)) return send(res, 429, { error: "Too many wrong passwords. Wait 10 minutes." });
    const { password } = JSON.parse((await readBody(req)) || "{}");
    if (!safeEqual(password || "", BROADCAST_PASSWORD)) { noteFail(ip); return send(res, 401, { error: "Wrong password" }); }
    return send(res, 200, { ok: true, live: liveAngles(await mtxPaths(0)) });
  }

  if (route === "/api/admin/login" && req.method === "POST") {
    const ip = clientIp(req);
    if (isLocked(ip)) return send(res, 429, { error: "Too many wrong passwords. Wait 10 minutes." });
    const { password } = JSON.parse((await readBody(req)) || "{}");
    if (!safeEqual(password || "", ADMIN_PASSWORD)) { noteFail(ip); return send(res, 401, { error: "Wrong password" }); }
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, Date.now() + 12 * 3600 * 1000);
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    return send(res, 200, { ok: true }, {
      "Set-Cookie": `rv_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`,
    });
  }

  if (route.startsWith("/api/admin/")) {
    if (!isAdmin(req)) return send(res, 401, { error: "Please log in" });

    if (route === "/api/admin/logout") {
      const m = (req.headers.cookie || "").match(/rv_admin=([a-f0-9]{48})/);
      if (m) sessions.delete(m[1]);
      return send(res, 200, { ok: true }, { "Set-Cookie": "rv_admin=; Path=/; Max-Age=0" });
    }

    if (route === "/api/admin/overview") {
      pruneViewers();
      const items = await mtxPaths(0);
      const now = Date.now();
      const angles = ANGLES.map((id) => {
        const p = items.find((i) => i.name === id);
        const live = !!(p && p.ready);
        let kbps = null;
        if (live) {
          const bytes = p.inboundBytes ?? p.bytesReceived ?? 0;
          const prev = rates.get(id);
          if (prev && now > prev.t && bytes >= prev.b) kbps = Math.round(((bytes - prev.b) * 8) / (now - prev.t));
          rates.set(id, { b: bytes, t: now });
        } else rates.delete(id);
        let watching = 0;
        for (const v of viewers.values()) if (v.angle === id) watching++;
        return { id, live, since: live ? p.readyTime : null, kbps, tracks: (p && p.tracks) || [], watching };
      });
      const recordings = {};
      await Promise.all(ANGLES.map(async (id) => {
        if (!fs.existsSync(path.join(RECORDINGS, id))) return (recordings[id] = []);
        try {
          const r = await mtxRequest(MTX.playback, `/list?path=${id}`);
          recordings[id] = r.status === 200 ? JSON.parse(r.data).map(({ start, duration }) => ({ start, duration })) : [];
        } catch { recordings[id] = []; }
      }));
      return send(res, 200, { angles, recordings, watching: viewers.size, capacity: MAX_VIEWERS, state });
    }

    if (route === "/api/admin/state" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.featured !== undefined) {
        if (!isAngle(body.featured)) return send(res, 400, { error: "Unknown angle" });
        state.featured = body.featured;
      }
      if (body.announcement !== undefined) {
        state.announcement = String(body.announcement).slice(0, 280);
        state.announcedAt = state.announcement ? new Date().toISOString() : null;
      }
      saveState();
      return send(res, 200, { ok: true, state });
    }

    if (route === "/api/admin/kick" && req.method === "POST") {
      const { angle } = JSON.parse((await readBody(req)) || "{}");
      const p = (await mtxPaths(0)).find((i) => i.name === angle);
      if (!p || !p.source || p.source.type !== "webRTCSession") return send(res, 404, { error: "Angle is not live" });
      ended.add(angle); // stop the phone's auto-reconnect from bringing it straight back
      await mtxRequest(MTX.api, `/v3/webrtcsessions/kick/${encodeURIComponent(p.source.id)}`, "POST");
      pathsCache.at = 0;
      return send(res, 200, { ok: true });
    }

    if (route === "/api/admin/download") {
      const angle = url.searchParams.get("angle");
      const start = url.searchParams.get("start") || "";
      const duration = url.searchParams.get("duration") || "";
      if (!isAngle(angle) || !/^[\dT:.+\-Z]+$/.test(start) || !/^[\d.]+$/.test(duration)) {
        return send(res, 400, { error: "Bad request" });
      }
      const stamp = start.slice(0, 16).replace("T", "_").replace(/:/g, "-");
      const q = new URLSearchParams({ path: angle, start, duration, format: "mp4" });
      return proxy(req, res, MTX.playback, `/get?${q}`, {
        headers: {},
        extraHeaders: { "Content-Disposition": `attachment; filename="rangvaasa-${angle}-${stamp}.mp4"` },
      });
    }
  }

  send(res, 404, { error: "Not found" });
}
const rates = new Map();
// Angles ended from the control room. A phone can only come back by pressing Go Live again.
const ended = new Set();

// ---------- Static files ----------
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json",
};
const PRETTY = { "/": "index.html", "/studio": "studio.html", "/admin": "admin.html" };

function serveStatic(req, res, pathname) {
  const rel = PRETTY[pathname] || path.normalize(decodeURIComponent(pathname)).replace(/^[\\/]+/, "");
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    const headers = {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    };
    if (/studio|admin/.test(rel)) headers["X-Robots-Tag"] = "noindex";
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ---------- Router ----------
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    // Viewers' video (on the real server Caddy sends this straight to MediaMTX)
    if (/^\/cam[1-6]\//.test(url.pathname)) {
      if (!hasViewerSpot(req) && !isAdmin(req)) return send(res, 403, { error: "Full house" });
      return proxy(req, res, MTX.hls, req.url);
    }

    // A phone going live: check password, then hand over to MediaMTX
    const whip = url.pathname.match(/^\/whip\/(cam[1-6])$/);
    if (whip && req.method === "POST") {
      const ip = clientIp(req);
      if (isLocked(ip)) return send(res, 429, { error: "Too many wrong passwords" });
      const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!safeEqual(auth, BROADCAST_PASSWORD)) { noteFail(ip); return send(res, 401, { error: "Wrong password" }); }
      if (req.headers["x-go-live"] === "1") ended.delete(whip[1]);
      else if (ended.has(whip[1])) return send(res, 409, { error: "Ended by the control room" });
      const headers = { ...req.headers };
      delete headers.authorization;
      delete headers["x-go-live"];
      pathsCache.at = 0;
      return proxy(req, res, MTX.webrtc, `/${whip[1]}/whip`, { headers });
    }

    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });
    serveStatic(req, res, url.pathname);
  } catch (e) {
    if (!res.headersSent) send(res, 400, { error: "Bad request" });
  }
}).listen(PORT, () => {
  console.log(`RANGVAASA Live on http://localhost:${PORT}`);
  console.log(`  Go live: http://localhost:${PORT}/studio    Admin: http://localhost:${PORT}/admin`);
});
