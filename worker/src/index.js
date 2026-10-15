// RANGVAASA Live: cloud relay. No laptop needed.
// A Cloudflare Worker that connects camera phones and viewers through Cloudflare Realtime (SFU):
//   camera phone  --WebRTC-->  Cloudflare SFU  --WebRTC-->  every viewer
// The Worker only does the hand-shakes; the video itself flows through Cloudflare's network.
// State (which angle is live, and its SFU session) is kept in a KV namespace.
//
// Settings (wrangler.toml / secrets):
//   CALLS_APP_ID        Realtime SFU app id
//   CALLS_APP_TOKEN     Realtime SFU app token   (secret)
//   BROADCAST_PASSWORD  camera password          (secret)
//   LIVE                KV namespace binding

const SFU = "https://rtc.live.cloudflare.com/v1/apps";
const ANGLES = ["cam1", "cam2", "cam3", "cam4", "cam5", "cam6"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });

async function sfu(env, path, method = "POST", body) {
  const r = await fetch(`${SFU}/${env.CALLS_APP_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CALLS_APP_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errorCode) throw new Error(j.errorDescription || j.errorCode || `SFU replied ${r.status}`);
  return j;
}

const getAngles = async (env) => (await env.LIVE.get("angles", "json")) || {};
const putAngles = (env, a) => env.LIVE.put("angles", JSON.stringify(a));

function passwordOk(req, env) {
  const given = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  return !!given && given === env.BROADCAST_PASSWORD;
}

// Is the camera's session still sending? (Phone closed without "End" leaves a dead entry.)
async function stillLive(env, a) {
  try {
    const s = await sfu(env, `/sessions/${a.sessionId}`, "GET");
    const tracks = s.tracks || [];
    // Dead only if the SFU reports no tracks, or every track explicitly not active
    return tracks.length > 0 && !tracks.every((t) => t.status && t.status !== "active");
  } catch { return false; }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const [, route, arg] = url.pathname.split("/");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!env.CALLS_APP_ID || !env.CALLS_APP_TOKEN) return json({ error: "Cloud relay is not configured" }, 500);

    try {
      // Which angles are live
      if (route === "live" && req.method === "GET") {
        return json({ live: Object.keys(await getAngles(env)) });
      }

      // Camera password check (before going live)
      if (route === "check" && req.method === "POST") {
        const { password } = await req.json().catch(() => ({}));
        if (!password || password !== env.BROADCAST_PASSWORD) return json({ error: "Wrong password" }, 401);
        return json({ ok: true, live: Object.keys(await getAngles(env)), iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }] });
      }

      // A camera phone goes live: its offer goes to the SFU, the SFU's answer comes back
      if (route === "publish" && req.method === "POST" && ANGLES.includes(arg)) {
        if (!passwordOk(req, env)) return json({ error: "Wrong password" }, 401);
        const { sdp, tracks } = await req.json();
        if (!sdp || !Array.isArray(tracks) || !tracks.length) return json({ error: "Bad request" }, 400);
        const { sessionId } = await sfu(env, "/sessions/new");
        const r = await sfu(env, `/sessions/${sessionId}/tracks/new`, "POST", {
          sessionDescription: { type: "offer", sdp },
          tracks: tracks.map((t) => ({ location: "local", mid: String(t.mid), trackName: String(t.trackName) })),
        });
        const angles = await getAngles(env);
        angles[arg] = { sessionId, tracks: tracks.map((t) => String(t.trackName)), at: Date.now() };
        await putAngles(env, angles);
        return json({ sdp: r.sessionDescription.sdp });
      }

      // A camera phone ends its stream
      if (route === "end" && req.method === "POST" && ANGLES.includes(arg)) {
        if (!passwordOk(req, env)) return json({ error: "Wrong password" }, 401);
        const angles = await getAngles(env);
        delete angles[arg];
        await putAngles(env, angles);
        return json({ ok: true });
      }

      // A viewer starts watching an angle: the SFU makes an offer with that camera's tracks
      if (route === "watch" && req.method === "POST" && ANGLES.includes(arg)) {
        const angles = await getAngles(env);
        const a = angles[arg];
        if (!a) return json({ error: "Off air" }, 404);
        if (!(await stillLive(env, a))) {
          delete angles[arg];
          await putAngles(env, angles);
          return json({ error: "Off air" }, 404);
        }
        const { sessionId } = await sfu(env, "/sessions/new");
        const r = await sfu(env, `/sessions/${sessionId}/tracks/new`, "POST", {
          tracks: a.tracks.map((trackName) => ({ location: "remote", sessionId: a.sessionId, trackName })),
        });
        return json({ sessionId, sdp: r.sessionDescription.sdp });
      }

      // The viewer's answer
      if (route === "answer" && req.method === "POST" && /^[\w-]{8,128}$/.test(arg || "")) {
        const { sdp } = await req.json();
        await sfu(env, `/sessions/${arg}/renegotiate`, "PUT", { sessionDescription: { type: "answer", sdp } });
        return json({ ok: true });
      }

      if (route === "" || route === undefined) return json({ ok: true, service: "RANGVAASA cloud relay" });
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  },
};
