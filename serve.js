// RANGVAASA Live – app server (no npm packages needed).
//   node serve.js        then open http://localhost:8080
// Serves the app from public/, checks passwords, runs the admin API and
// forwards video to/from MediaMTX. Settings come from .env (see .env.example).
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawn } = require("child_process");

const ROOT = __dirname;
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT) || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const BROADCAST_PASSWORD = process.env.BROADCAST_PASSWORD || "garba2026";
// Optional Cloudflare TURN relay, so camera phones can connect from any network (mobile data, other Wi-Fi)
const TURN_KEY_ID = process.env.TURN_KEY_ID || "";
const TURN_API_TOKEN = process.env.TURN_API_TOKEN || "";
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

// ---------- Version (when installed from GitHub), shown in the control room ----------
const STARTED = new Date().toISOString();
function gitVersion() {
  try {
    return execFileSync("git", ["log", "-1", "--format=%h|%cI|%s"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
  } catch { return ""; }
}
const VERSION = gitVersion();
const CAN_UPDATE = process.platform === "linux" && fs.existsSync(path.join(ROOT, ".git"));

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

// Viewers' video. The ticket (?t=) or admin token (?a=) is added to every link inside
// the playlists, so iPhones (which load segments themselves) keep their access too.
function proxyHls(req, res, url) {
  const gate = new URLSearchParams();
  for (const k of ["t", "a"]) if (url.searchParams.get(k)) gate.set(k, url.searchParams.get(k));
  const g = gate.toString();
  const fwd = new URLSearchParams(url.searchParams);
  fwd.delete("t"); fwd.delete("a");
  const target = url.pathname + (fwd.toString() ? `?${fwd}` : "");
  const addGate = (u) => (!g || /^[a-z]+:/i.test(u) ? u : `${u}${u.includes("?") ? "&" : "?"}${g}`);
  const headers = { ...req.headers };
  delete headers["accept-encoding"]; // playlists must arrive uncompressed so they can be rewritten

  const up = http.request({ host: "127.0.0.1", port: MTX.hls, path: target, method: req.method, headers }, (r) => {
    const out = { ...r.headers };
    if (out.location) out.location = addGate(out.location);
    const playlist = /\.m3u8$/.test(url.pathname) || /mpegurl/i.test(r.headers["content-type"] || "");
    if (!playlist || !g) { res.writeHead(r.statusCode, out); return r.pipe(res); }
    let body = "";
    r.setEncoding("utf8");
    r.on("data", (c) => (body += c));
    r.on("end", () => {
      body = body.split("\n").map((line) => {
        const l = line.trimEnd();
        if (!l) return l;
        if (l.startsWith("#")) return l.replace(/URI="([^"]+)"/g, (_, u) => `URI="${addGate(u)}"`);
        return addGate(l);
      }).join("\n");
      delete out["content-length"];
      res.writeHead(r.statusCode, out);
      res.end(body);
    });
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
      .then((items) => { trackFlow(items); pathsCache = { at: Date.now(), items }; pathsInflight = null; return items; });
  }
  return pathsInflight;
}

// A phone can stay connected but stop sending video (screen locked, app switched, camera taken by
// another app). Then the angle is "ready" but frozen, and viewers would wait forever. So an angle
// only counts as live while video bytes keep arriving.
const STALL_WINDOW_MS = 6000;
const STALL_KBPS = 80; // below this only audio is arriving (Opus is ~30-60 kbps), so the video stopped
const flow = new Map(); // angle -> { startBytes, startT, stalled }
function trackFlow(items) {
  const now = Date.now();
  for (const p of items) {
    if (!isAngle(p.name)) continue;
    if (!p.ready) { flow.delete(p.name); continue; }
    const bytes = p.inboundBytes ?? p.bytesReceived ?? 0;
    const f = flow.get(p.name);
    if (!f) { flow.set(p.name, { startBytes: bytes, startT: now, stalled: false }); continue; }
    if (now - f.startT >= STALL_WINDOW_MS) {
      const kbps = ((bytes - f.startBytes) * 8) / (now - f.startT);
      f.stalled = kbps < STALL_KBPS;
      f.startBytes = bytes;
      f.startT = now;
    }
  }
}
const isStalled = (name) => { const f = flow.get(name); return !!f && f.stalled; };
const liveAngles = (items) => items.filter((p) => isAngle(p.name) && p.ready && !isStalled(p.name)).map((p) => p.name);

// ---------- Camera connectivity (STUN / TURN) ----------
// Phones and the streaming engine both use these to find a path to each other.
// STUN alone works on many networks; TURN relays the video when nothing else can.
let iceServers = [{ urls: ["stun:stun.cloudflare.com:3478"] }];

async function getTurnServers() {
  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TURN_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: 172800 }), // 48 h: covers the whole event
  });
  if (!r.ok) throw new Error(`Cloudflare TURN replied ${r.status}`);
  const j = await r.json();
  const list = Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers];
  return list.filter(Boolean).map((s) => ({ ...s, urls: [].concat(s.urls) }));
}

// Give the streaming engine the same servers. Done once at start-up, because changing
// them restarts the camera side of the engine (live phones would reconnect).
async function setupIce() {
  if (TURN_KEY_ID && TURN_API_TOKEN) {
    try {
      iceServers = await getTurnServers();
      console.log("Camera relay (Cloudflare TURN) ready: phones can go live from any network.");
    } catch (e) {
      console.warn(`! Camera relay not available (${e.message}). Phones must be on the laptop's network.`);
    }
  } else {
    console.log("No TURN_KEY_ID in .env: camera phones should join the laptop's Wi-Fi (see README).");
  }
  const mtxServers = iceServers.flatMap((s) => s.urls
    .filter((u) => !/:53\b/.test(u)) // skip port-53 variants
    .map((url) => ({ url, username: s.username || "", password: s.credential || "" })));
  for (let i = 0; i < 20; i++) {
    try {
      const body = JSON.stringify({ webrtcICEServers2: mtxServers });
      const ok = await new Promise((resolve) => {
        const r = http.request({ host: "127.0.0.1", port: MTX.api, path: "/v3/config/global/patch", method: "PATCH",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
          (res) => { res.resume(); resolve(res.statusCode === 200); });
        r.on("error", () => resolve(false));
        r.end(body);
      });
      if (ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 3000)); // engine may still be starting
  }
  console.warn("! Could not configure the streaming engine's camera connectivity.");
}

// ---------- Go live everywhere: send the main angle to YouTube / Facebook / Instagram ----------
// Each switched-on platform gets its own FFmpeg process that reads the main angle from the
// streaming engine and pushes it out over RTMP(S). Video is passed through untouched (no quality
// loss, almost no CPU); audio is converted to AAC, which the platforms require. Instagram wants
// vertical video, so that one is re-encoded to 720x1280.
const DEST_FILE = path.join(DATA, "destinations.json");
const PLATFORMS = {
  youtube:   { name: "YouTube",   url: "rtmp://a.rtmp.youtube.com/live2" },
  facebook:  { name: "Facebook",  url: "rtmps://live-api-s.facebook.com:443/rtmp" },
  instagram: { name: "Instagram", url: "", vertical: true },
  custom:    { name: "Other",     url: "" },
};
let destinations = [];
try { destinations = JSON.parse(fs.readFileSync(DEST_FILE, "utf8")); } catch {}
function saveDestinations() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(DEST_FILE, JSON.stringify(destinations, null, 2));
}

const FFMPEG = process.env.FFMPEG_PATH ||
  (fs.existsSync(path.join(ROOT, "tools", "ffmpeg.exe")) ? path.join(ROOT, "tools", "ffmpeg.exe") : "ffmpeg");
let ffmpegOk = false;
try { execFileSync(FFMPEG, ["-version"], { stdio: "ignore" }); ffmpegOk = true; } catch {}

const workers = new Map(); // destination id -> { proc, angle, status, error, since, retryAt, fails }

function ffmpegArgs(d, angle) {
  const target = `${d.url.replace(/\/+$/, "")}/${d.key}`;
  const input = ["-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", `rtsp://127.0.0.1:8554/${angle}`];
  const audio = ["-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2"];
  const video = d.vertical
    ? ["-vf", "scale=720:-2,pad=720:1280:(ow-iw)/2:(oh-ih)/2", "-c:v", "libx264", "-preset", "veryfast",
       "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "5000k", "-g", "60", "-pix_fmt", "yuv420p"]
    : ["-c:v", "copy"];
  return [...input, "-map", "0:v:0", "-map", "0:a:0?", ...video, ...audio, "-f", "flv", target];
}

function stopWorker(id, status = "off") {
  const w = workers.get(id);
  if (w && w.proc) { w.stopping = true; try { w.proc.kill("SIGKILL"); } catch {} }
  if (status === "off") workers.delete(id);
  else workers.set(id, { status, since: null, error: w && w.error, fails: (w && w.fails) || 0 });
}

function startWorker(d, angle) {
  const prev = workers.get(d.id) || {};
  const w = { angle, status: "starting", since: Date.now(), error: prev.error || null, fails: prev.fails || 0 };
  const proc = spawn(FFMPEG, ffmpegArgs(d, angle), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  w.proc = proc;
  let errText = "";
  proc.stderr.on("data", (c) => { errText = (errText + c).slice(-600); });
  // FFmpeg prints nothing on success at this log level; if it is still running after 6 s, we're live
  const liveTimer = setTimeout(() => { if (workers.get(d.id) === w && !w.stopping) { w.status = "live"; w.error = null; w.fails = 0; } }, 6000);
  proc.on("error", (e) => { errText = e.message; });
  proc.on("exit", () => {
    clearTimeout(liveTimer);
    if (w.stopping || workers.get(d.id) !== w) return;
    w.fails++;
    w.proc = null;
    w.status = "retrying";
    w.error = (errText.trim().split(/\r?\n/).pop() || "Connection closed").slice(0, 200);
    w.retryAt = Date.now() + Math.min(30000, 3000 * w.fails); // back off: 3 s, 6 s ... 30 s
  });
  workers.set(d.id, w);
}

async function syncRestreams() {
  if (!ffmpegOk) return;
  const live = liveAngles(await mtxPaths());
  const angle = state.featured;
  for (const d of destinations) {
    const w = workers.get(d.id);
    if (!d.enabled) { if (w) stopWorker(d.id); continue; }
    if (!live.includes(angle)) { if (!w || w.proc || w.status !== "waiting") stopWorker(d.id, "waiting"); continue; }
    if (w && w.proc && w.angle === angle) continue;                 // running fine
    if (w && w.proc && w.angle !== angle) { stopWorker(d.id, "starting"); }  // main angle changed: follow it
    const cur = workers.get(d.id);
    if (cur && cur.status === "retrying" && Date.now() < cur.retryAt) continue;
    startWorker(d, angle);
  }
  for (const id of workers.keys()) if (!destinations.some((d) => d.id === id)) stopWorker(id);
}
setInterval(() => { syncRestreams().catch(() => {}); }, 3000);
process.on("exit", () => { for (const w of workers.values()) if (w.proc) try { w.proc.kill(); } catch {} });

function restreamView() {
  return {
    ffmpeg: ffmpegOk,
    destinations: destinations.map((d) => {
      const w = workers.get(d.id) || {};
      return {
        id: d.id, platform: d.platform, name: (PLATFORMS[d.platform] || PLATFORMS.custom).name,
        url: d.url, key: d.key ? `••••${d.key.slice(-4)}` : "", vertical: !!d.vertical, enabled: !!d.enabled,
        watchUrl: d.watchUrl || "", status: d.enabled ? (w.status || "starting") : "off",
        error: w.error || null, since: w.status === "live" ? w.since : null,
      };
    }),
  };
}

// A YouTube link the admin pasted, used to send overflow viewers to the YouTube copy
function overflowVideoId() {
  const d = destinations.find((x) => x.enabled && x.platform === "youtube" && x.watchUrl);
  const w = d && workers.get(d.id);
  if (!d || !w || w.status !== "live") return null;
  const m = d.watchUrl.match(/(?:v=|youtu\.be\/|\/live\/|\/embed\/)([\w-]{11})/);
  return m ? m[1] : null;
}

// ---------- Viewers: each open app checks in every few seconds ----------
const viewers = new Map(); // id -> { t, angle }
function pruneViewers() {
  const now = Date.now();
  for (const [k, v] of viewers) if (now - v.t > 30000) viewers.delete(k);
}

// Video is only served to viewers holding a spot: ticket in the URL (?t=) or cookie, from /api/status
function hasViewerSpot(req, url) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)rv_v=([a-z0-9]{6,40})/);
  const id = url.searchParams.get("t") || (m && m[1]);
  const v = id && viewers.get(id);
  return !!v && Date.now() - v.t < 30000;
}

// ---------- Admin sessions ----------
const sessions = new Map(); // token -> expiry
function adminToken(req) {
  const c = (req.headers.cookie || "").match(/(?:^|;\s*)rv_admin=([a-f0-9]{48})/);
  const h = (req.headers.authorization || "").match(/^Bearer ([a-f0-9]{48})$/);
  const q = new URL(req.url, "http://x").searchParams.get("a");
  return (h && h[1]) || (q && /^[a-f0-9]{48}$/.test(q) && q) || (c && c[1]) || null;
}
function isAdmin(req) {
  const token = adminToken(req);
  const exp = token && sessions.get(token);
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
      ticket: admitted ? id : null,
      overflow: admitted ? null : overflowVideoId(),
    }, headers);
  }

  // Broadcaster password check (studio, before going live)
  if (route === "/api/studio/check" && req.method === "POST") {
    const ip = clientIp(req);
    if (isLocked(ip)) return send(res, 429, { error: "Too many wrong passwords. Wait 10 minutes." });
    const { password } = JSON.parse((await readBody(req)) || "{}");
    if (!safeEqual(password || "", BROADCAST_PASSWORD)) { noteFail(ip); return send(res, 401, { error: "Wrong password" }); }
    return send(res, 200, { ok: true, live: liveAngles(await mtxPaths(0)), iceServers });
  }

  if (route === "/api/admin/login" && req.method === "POST") {
    const ip = clientIp(req);
    if (isLocked(ip)) return send(res, 429, { error: "Too many wrong passwords. Wait 10 minutes." });
    const { password } = JSON.parse((await readBody(req)) || "{}");
    if (!safeEqual(password || "", ADMIN_PASSWORD)) { noteFail(ip); return send(res, 401, { error: "Wrong password" }); }
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, Date.now() + 12 * 3600 * 1000);
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    return send(res, 200, { ok: true, token }, {
      "Set-Cookie": `rv_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`,
    });
  }

  if (route.startsWith("/api/admin/")) {
    if (!isAdmin(req)) return send(res, 401, { error: "Please log in" });

    if (route === "/api/admin/logout") {
      const token = adminToken(req);
      if (token) sessions.delete(token);
      return send(res, 200, { ok: true }, { "Set-Cookie": "rv_admin=; Path=/; Max-Age=0" });
    }

    if (route === "/api/admin/overview") {
      pruneViewers();
      const items = await mtxPaths(0);
      const now = Date.now();
      const angles = ANGLES.map((id) => {
        const p = items.find((i) => i.name === id);
        const stalled = !!(p && p.ready) && isStalled(id);
        const live = !!(p && p.ready) && !stalled;
        let kbps = null;
        if (live) {
          const bytes = p.inboundBytes ?? p.bytesReceived ?? 0;
          const prev = rates.get(id);
          if (prev && now > prev.t && bytes >= prev.b) kbps = Math.round(((bytes - prev.b) * 8) / (now - prev.t));
          rates.set(id, { b: bytes, t: now });
        } else rates.delete(id);
        let watching = 0;
        for (const v of viewers.values()) if (v.angle === id) watching++;
        return { id, live, stalled, since: live ? p.readyTime : null, kbps, tracks: (p && p.tracks) || [], watching };
      });
      const recordings = {};
      await Promise.all(ANGLES.map(async (id) => {
        if (!fs.existsSync(path.join(RECORDINGS, id))) return (recordings[id] = []);
        try {
          const r = await mtxRequest(MTX.playback, `/list?path=${id}`);
          recordings[id] = r.status === 200 ? JSON.parse(r.data).map(({ start, duration }) => ({ start, duration })) : [];
        } catch { recordings[id] = []; }
      }));
      const [sha, date, subject] = VERSION.split("|");
      return send(res, 200, {
        angles, recordings, watching: viewers.size, capacity: MAX_VIEWERS, state, restream: restreamView(),
        server: { version: sha || null, versionDate: date || null, versionNote: subject || null, started: STARTED,
                  canUpdate: CAN_UPDATE, relay: iceServers.some((s) => s.urls.some((u) => u.startsWith("turn"))) },
      });
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
      syncRestreams().catch(() => {});
      return send(res, 200, { ok: true, state });
    }

    // Go live everywhere: add/edit, switch on/off, remove a platform
    if (route === "/api/admin/restream/save" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (!PLATFORMS[b.platform]) return send(res, 400, { error: "Pick a platform" });
      const url = String(b.url || PLATFORMS[b.platform].url || "").trim();
      if (!/^rtmps?:\/\/[^\s]+$/i.test(url)) return send(res, 400, { error: "Stream URL must start with rtmp:// or rtmps://" });
      let d = destinations.find((x) => x.id === b.id);
      const key = String(b.key || "").trim();
      if (!d && !key) return send(res, 400, { error: "Paste the stream key" });
      if (!d) { d = { id: crypto.randomBytes(6).toString("hex"), enabled: false }; destinations.push(d); }
      Object.assign(d, {
        platform: b.platform, url,
        vertical: b.vertical !== undefined ? !!b.vertical : !!PLATFORMS[b.platform].vertical,
        watchUrl: String(b.watchUrl || "").trim().slice(0, 300),
      });
      if (key) d.key = key;
      saveDestinations();
      if (workers.get(d.id) && workers.get(d.id).proc) stopWorker(d.id, "starting"); // restart with new settings
      return send(res, 200, restreamView());
    }
    if (route === "/api/admin/restream/toggle" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const d = destinations.find((x) => x.id === b.id);
      if (!d) return send(res, 404, { error: "Not found" });
      if (!ffmpegOk) return send(res, 400, { error: "FFmpeg isn't installed on the server" });
      d.enabled = !!b.enabled;
      saveDestinations();
      if (!d.enabled) stopWorker(d.id);
      syncRestreams().catch(() => {});
      return send(res, 200, restreamView());
    }
    if (route === "/api/admin/restream/delete" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      stopWorker(b.id);
      destinations = destinations.filter((x) => x.id !== b.id);
      saveDestinations();
      return send(res, 200, restreamView());
    }

    // Pull the latest version from GitHub and reinstall, from the phone. Runs as its own
    // systemd job so it survives this app restarting halfway through.
    if (route === "/api/admin/update" && req.method === "POST") {
      if (!CAN_UPDATE) return send(res, 400, { error: "Updates work on the cloud server (installed from GitHub) only." });
      const job = spawn("systemd-run", ["--unit", `rangvaasa-update-${Date.now()}`, "--collect",
        "bash", "-c", `bash ${path.join(ROOT, "deploy", "update.sh")} >> /var/log/rangvaasa-update.log 2>&1`],
        { detached: true, stdio: "ignore" });
      job.on("error", () => {});
      job.unref();
      return send(res, 202, { ok: true });
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
  if (/^\/(api|whip|cam[1-6])\b/.test(url.pathname)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Go-Live");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "Location, Content-Disposition");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  }
  try {
    // Viewers' video (on the real server Caddy sends this straight to MediaMTX)
    if (/^\/cam[1-6]\//.test(url.pathname)) {
      if (!hasViewerSpot(req, url) && !isAdmin(req)) return send(res, 403, { error: "Full house" });
      return proxyHls(req, res, url);
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

    // Lets pages know they're being served by the live server itself (so they talk to it directly)
    if (url.pathname === "/server-info.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end("window.LIVE_SERVER_HERE = true;\n");
    }
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });
    serveStatic(req, res, url.pathname);
  } catch (e) {
    if (!res.headersSent) send(res, 400, { error: "Bad request" });
  }
}).listen(PORT, () => {
  setupIce();
  console.log(`RANGVAASA Live on http://localhost:${PORT}`);
  console.log(`  Go live: http://localhost:${PORT}/studio    Admin: http://localhost:${PORT}/admin`);
});
