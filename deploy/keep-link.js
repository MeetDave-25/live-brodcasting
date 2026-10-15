// Keeps the website (Vercel) pointed at this laptop's live server.
// start-event.bat runs this when using a temporary Cloudflare link (no TUNNEL_TOKEN in .env).
//  - Reads the tunnel's current public address from cloudflared (metrics on 127.0.0.1:20241)
//  - Once it answers, writes it into public/config.js and pushes to GitHub; Vercel redeploys in ~15 s
//  - If the link stops answering for 90 s (e.g. after an internet drop), restarts the tunnel;
//    start-event.bat brings it back with a fresh link, which is then published the same way
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CONFIG = path.join(ROOT, "public", "config.js");
const METRICS = "http://127.0.0.1:20241/quicktunnel";
const DEAD_AFTER_MS = 90000;

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const git = (...args) => execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const firstLine = (e) => String((e.stderr && e.stderr.toString()) || e.message).trim().split(/\r?\n/)[0];

async function tunnelHost() {
  try {
    const r = await fetch(METRICS, { signal: AbortSignal.timeout(3000) });
    return (await r.json()).hostname || null;
  } catch { return null; }
}

async function answers(url) {
  try {
    const r = await fetch(`${url}/api/status?id=linkcheck01`, { signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch { return false; }
}

const configured = () => (fs.readFileSync(CONFIG, "utf8").match(/server:\s*"([^"]*)"/) || [])[1] || "";

function publish(url) {
  try { git("pull", "--rebase", "--autostash", "origin", "main"); }
  catch (e) { log("git pull failed:", firstLine(e)); }
  if (configured() === url) return false;
  const s = fs.readFileSync(CONFIG, "utf8").replace(/(server:\s*")[^"]*(")/, `$1${url}$2`);
  fs.writeFileSync(CONFIG, s);
  git("add", "public/config.js");
  git("commit", "-m", `Live link: ${url}`, "--", "public/config.js");
  git("push", "origin", "HEAD:main");
  return true;
}

let downSince = null;
let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const host = await tunnelHost();
    if (!host) return; // tunnel still starting
    const url = `https://${host}`;
    if (!(await answers(url))) {
      downSince = downSince || Date.now();
      if (Date.now() - downSince > DEAD_AFTER_MS) {
        log("Live link not answering for 90 s. Restarting the tunnel for a fresh link...");
        try { execFileSync("taskkill", ["/F", "/IM", "cloudflared.exe"], { stdio: "ignore" }); } catch {}
        downSince = null;
      }
      return;
    }
    downSince = null;
    if (configured() === url) return;
    log("New live link:", url, "- updating the website...");
    try {
      if (publish(url)) log("Website updated. live-brodcasting.vercel.app uses this link within ~15 s.");
    } catch (e) {
      log("Could not push to GitHub:", firstLine(e), "- will try again.");
    }
  } finally {
    busy = false;
  }
}

log("Keeping the website pointed at this laptop. Leave this window open.");
tick();
setInterval(tick, 10000);
