(() => {
  const cfg = window.APP_CONFIG || {};
  if ((window.LIVE || {}).mode === "embed") { location.replace("publish#camera"); return; }
  // "cloud" mode: go live through the Cloudflare relay instead of the laptop
  const CLOUD = (window.LIVE || {}).mode === "cloud" && (cfg.cloud || "").replace(/\/+$/, "");
  const $ = (id) => document.getElementById(id);
  // Live server: this site when the laptop serves the page, otherwise config.server (e.g. from Vercel)
  const API = window.LIVE_SERVER_HERE ? "" : (cfg.server || "").replace(/\/+$/, "");
  const preview = $("preview");
  const ANGLES = cfg.angles && cfg.angles.length ? cfg.angles : [{ id: "cam1", name: "Main stage" }];
  // The camera always captures 720p (phones' own 480p modes are soft) and the encoder scales down.
  // start/min keep Chrome from opening blurry and creeping up from ~300 kbps.
  const QUALITY = {
    hd:  { scale: 1,   bitrate: 2_500_000, start: 1500, min: 900, label: "720p" },
    sd:  { scale: 1.5, bitrate: 1_200_000, start: 900,  min: 600, label: "480p" },
    low: { scale: 2,   bitrate: 600_000,   start: 450,  min: 300, label: "360p" },
  };
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} },
  };
  document.querySelectorAll("[data-cfg]").forEach((el) => { if (cfg[el.dataset.cfg]) el.textContent = cfg[el.dataset.cfg]; });

  const settings = {
    pass: store.get("rv-pass") || "",
    angle: store.get("rv-angle") || ANGLES[0].id,
    quality: store.get("rv-quality") || "sd",
  };
  if (!ANGLES.some((a) => a.id === settings.angle)) settings.angle = ANGLES[0].id;
  if (!QUALITY[settings.quality]) settings.quality = "sd";

  let stream = null, pc = null, videoSender = null;
  let wantLive = false, liveSince = 0;
  let facing = "environment";
  let reconnectTimer, statsTimer, clockTimer, graceTimer, wakeLock = null;
  let takenAngles = [];
  let iceServers = []; // STUN/TURN from the server, so phones on other networks can connect

  function say(text, kind) {
    $("msg").textContent = text || "";
    $("msg").className = "cam-msg" + (kind ? " " + kind : "");
  }
  const angleIndex = (id) => ANGLES.findIndex((a) => a.id === id);
  function renderAngleChip() {
    const i = angleIndex(settings.angle);
    $("angleLabel").textContent = `${String(i + 1).padStart(2, "0")} · ${ANGLES[i].name}`;
  }

  // ---------- Setup sheet ----------
  function buildAngleChoices() {
    $("angleChoices").innerHTML = "";
    ANGLES.forEach((a, i) => {
      const label = document.createElement("label");
      label.className = "choice";
      const taken = takenAngles.includes(a.id) && !(wantLive && a.id === settings.angle);
      label.innerHTML = `<input type="radio" name="angle"><span><b></b><small></small></span>`;
      const input = label.querySelector("input");
      input.value = a.id;
      input.checked = a.id === settings.angle;
      label.querySelector("b").textContent = `${String(i + 1).padStart(2, "0")} · ${a.name}`;
      const small = label.querySelector("small");
      small.textContent = taken ? "Live on another phone" : "Free";
      if (taken) small.className = "taken";
      $("angleChoices").append(label);
    });
  }
  function openSheet() {
    if (wantLive) { say("End the stream before changing settings.", "err"); return; }
    $("pass").value = settings.pass;
    document.querySelector(`input[name=quality][value=${settings.quality}]`).checked = true;
    buildAngleChoices();
    $("sheetErr").textContent = "";
    $("sheet").classList.add("open");
  }
  function closeSheet() { $("sheet").classList.remove("open"); }

  async function checkPassword(pass) {
    const r = await fetch(CLOUD ? `${CLOUD}/check` : `${API}/api/studio/check`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pass }),
    });
    if (!(r.headers.get("content-type") || "").includes("json")) {
      throw new Error("The live server isn't connected. Going live needs the streaming server running on your VPS.");
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Could not reach the server");
    takenAngles = j.live || [];
    iceServers = j.iceServers || [];
  }

  $("setupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pass = $("pass").value;
    const angle = (document.querySelector("input[name=angle]:checked") || {}).value || settings.angle;
    const quality = document.querySelector("input[name=quality]:checked").value;
    $("saveBtn").disabled = true;
    $("sheetErr").textContent = "";
    try {
      await checkPassword(pass);
      Object.assign(settings, { pass, angle, quality });
      store.set("rv-pass", pass); store.set("rv-angle", angle); store.set("rv-quality", quality);
      renderAngleChip();
      closeSheet();
      await openCamera();
      say(takenAngles.includes(angle) ? "This angle is live on another phone. Going live will take it over." : "Ready. Tap the red button to go live.");
    } catch (err) {
      $("sheetErr").textContent = err.message;
    } finally {
      $("saveBtn").disabled = false;
    }
  });
  $("angleChip").addEventListener("click", openSheet);
  $("settingsBtn").addEventListener("click", openSheet);

  // ---------- Camera ----------
  function videoConstraints() {
    return { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  }
  // Garba music: switch off the "voice call" filters that would muffle it
  const audioConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

  async function openCamera() {
    if (!window.isSecureContext || !navigator.mediaDevices) {
      throw new Error("The camera needs a secure (https://) link.");
    }
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(), audio: audioConstraints });
    const vt = stream.getVideoTracks()[0];
    if (vt && "contentHint" in vt) vt.contentHint = "motion"; // garba: keep movement fluid
    preview.srcObject = stream;
    preview.style.transform = facing === "user" ? "scaleX(-1)" : "";
    renderMic();
  }

  async function flipCamera() {
    facing = facing === "environment" ? "user" : "environment";
    if (!stream) return openCamera();
    const old = stream.getVideoTracks()[0];
    old.stop(); // iPhones allow only one camera at a time
    const fresh = (await navigator.mediaDevices.getUserMedia({ video: videoConstraints() })).getVideoTracks()[0];
    stream.removeTrack(old);
    stream.addTrack(fresh);
    preview.srcObject = stream;
    preview.style.transform = facing === "user" ? "scaleX(-1)" : "";
    if (videoSender) await videoSender.replaceTrack(fresh);
  }
  $("flipBtn").addEventListener("click", () => flipCamera().catch((e) => say("Could not switch camera: " + e.message, "err")));

  function renderMic() {
    const t = stream && stream.getAudioTracks()[0];
    const off = t ? !t.enabled : false;
    $("micBtn").classList.toggle("is-off", off);
    $("micBtn").querySelector(".slash").toggleAttribute("hidden", !off);
    $("micBtn").setAttribute("aria-label", off ? "Turn microphone on" : "Mute microphone");
  }
  $("micBtn").addEventListener("click", () => {
    const t = stream && stream.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    renderMic();
  });

  // ---------- Publish (WHIP) ----------
  function preferCodecs(transceiver) {
    // Viewers need H.264 (plays on every phone); VP9 only as a fallback
    if (!transceiver.setCodecPreferences || !RTCRtpSender.getCapabilities) return;
    const codecs = RTCRtpSender.getCapabilities("video").codecs;
    const h264 = codecs.filter((c) => c.mimeType === "video/H264");
    const vp9 = codecs.filter((c) => c.mimeType === "video/VP9");
    const extra = codecs.filter((c) => /rtx|red|ulpfec/i.test(c.mimeType));
    if (h264.length || vp9.length) transceiver.setCodecPreferences([...h264, ...vp9, ...extra]);
    if (!h264.length) say("This phone can't send H.264, so iPhone viewers may not see this angle. Use another phone if you can.", "err");
  }

  // Tell the encoder where to start and the floor to hold (Chrome / Android), and allow the full bitrate.
  function tuneBitrate(sdp, q) {
    const maxKbps = Math.round(q.bitrate / 1000);
    let inVideo = false;
    return sdp.split("\r\n").map((line) => {
      if (line.startsWith("m=")) inVideo = line.startsWith("m=video");
      if (inVideo && line.startsWith("a=fmtp:") && !line.includes("x-google-start-bitrate")) {
        return `${line};x-google-start-bitrate=${q.start};x-google-min-bitrate=${q.min};x-google-max-bitrate=${maxKbps}`;
      }
      if (inVideo && line.startsWith("c=")) return `${line}\r\nb=AS:${maxKbps}`;
      return line;
    }).join("\r\n");
  }

  function waitForIce(conn) {
    return new Promise((resolve) => {
      if (conn.iceGatheringState === "complete") return resolve();
      const t = setTimeout(resolve, 2000);
      conn.addEventListener("icegatheringstatechange", () => {
        if (conn.iceGatheringState === "complete") { clearTimeout(t); resolve(); }
      });
    });
  }

  async function publish(fresh) {
    closePc();
    const q = QUALITY[settings.quality];
    pc = new RTCPeerConnection({ iceServers });
    const vt = pc.addTransceiver(stream.getVideoTracks()[0], {
      direction: "sendonly",
      sendEncodings: [{ maxBitrate: q.bitrate, maxFramerate: 30, scaleResolutionDownBy: q.scale }],
    });
    videoSender = vt.sender;
    preferCodecs(vt);
    const at = stream.getAudioTracks()[0];
    if (at) pc.addTransceiver(at, { direction: "sendonly" });

    const thisPc = pc;
    pc.addEventListener("connectionstatechange", () => {
      if (pc !== thisPc) return;
      const st = pc.connectionState;
      if (st === "connected") {
        clearTimeout(graceTimer);
        if (!liveSince) liveSince = Date.now();
        say("");
        $("rec").hidden = false;
        if (navigator.vibrate) navigator.vibrate(40);
      } else if (st === "disconnected") {
        // Mobile networks blip for a second or two all the time. Hold on instead of tearing the
        // connection down; only reconnect if it hasn't come back after 10 s.
        if (!wantLive) return;
        say("Weak signal… holding on", "err");
        clearTimeout(graceTimer);
        graceTimer = setTimeout(() => {
          if (wantLive && pc === thisPc && pc.connectionState !== "connected") reconnect("Signal lost. Reconnecting…");
        }, 10000);
      } else if (st === "failed") {
        if (!wantLive) return;
        clearTimeout(graceTimer);
        if (!liveSince) {
          reconnect("Can't reach the laptop from this network. Join the laptop's Wi-Fi, or ask the organisers to turn on the camera relay. Retrying…");
        } else reconnect("Signal lost. Reconnecting…");
      }
    });

    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc);
    if (CLOUD) {
      // Cloud relay: send the offer plus which track is which; Cloudflare answers
      const tracks = pc.getTransceivers().filter((t) => t.sender.track)
        .map((t) => ({ mid: t.mid, trackName: t.sender.track.kind }));
      const r = await fetch(`${CLOUD}/publish/${settings.angle}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.pass}` },
        body: JSON.stringify({ sdp: pc.localDescription.sdp, tracks }),
      });
      if (r.status === 401) { const e = new Error("Wrong camera password."); e.fatal = true; throw e; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `cloud replied ${r.status}`);
      await pc.setRemoteDescription({ type: "answer", sdp: tuneBitrate(j.sdp, q) });
      try {
        const p = videoSender.getParameters();
        p.degradationPreference = "balanced";
        await videoSender.setParameters(p);
      } catch (_) {}
      return;
    }
    const res = await fetch(`${API}/whip/${settings.angle}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/sdp",
        Authorization: `Bearer ${settings.pass}`,
        "X-Go-Live": fresh ? "1" : "0", // reconnects are refused if the control room ended this angle
      },
      body: pc.localDescription.sdp,
    });
    if (res.status === 401 || res.status === 429) {
      const e = new Error(res.status === 401 ? "Wrong camera password." : "Too many wrong passwords. Wait 10 minutes.");
      e.fatal = true;
      throw e;
    }
    if (res.status === 409) {
      const e = new Error("The control room ended this angle. Tap the red button to go live again.");
      e.fatal = true;
      throw e;
    }
    if (!res.ok) throw new Error(`server replied ${res.status}`);
    await pc.setRemoteDescription({ type: "answer", sdp: tuneBitrate(await res.text(), q) });

    try {
      const p = videoSender.getParameters();
      p.degradationPreference = "balanced"; // on a weak signal, give up a little of both instead of all sharpness
      await videoSender.setParameters(p);
    } catch (_) {}
  }

  function reconnect(text) {
    say(text, "err");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
      if (!wantLive) return;
      try { await publish(); }
      catch (e) {
        if (e.fatal) return stopLive(e.message);
        reconnect("Can't reach the server. Retrying…");
      }
    }, 2000);
  }

  function closePc() {
    if (pc) { pc.close(); pc = null; videoSender = null; }
  }

  // ---------- Go live / stop ----------
  async function goLive() {
    if (!settings.pass) return openSheet();
    try { if (!stream) await openCamera(); }
    catch (e) { return say(e.message, "err"); }
    try { await checkPassword(settings.pass); } catch (e) { return say(e.message, "err"); }
    if (takenAngles.includes(settings.angle) &&
        !confirm(`${ANGLES[angleIndex(settings.angle)].name} is already live from another phone. Take it over?`)) return;

    wantLive = true;
    liveSince = 0;
    $("goBtn").classList.add("is-live");
    $("goBtn").setAttribute("aria-label", "End stream");
    say("Connecting…");
    keepAwake();
    startStats();
    clearInterval(clockTimer);
    clockTimer = setInterval(renderClock, 1000);
    try { await publish(true); }
    catch (e) {
      if (e.fatal) return stopLive(e.message);
      reconnect("Can't reach the server. Retrying…");
    }
  }

  function stopLive(reason) {
    if (CLOUD && wantLive) {
      fetch(`${CLOUD}/end/${settings.angle}`, { method: "POST", headers: { Authorization: `Bearer ${settings.pass}` } }).catch(() => {});
    }
    wantLive = false;
    clearTimeout(reconnectTimer);
    clearInterval(statsTimer);
    clearInterval(clockTimer);
    closePc();
    liveSince = 0;
    $("rec").hidden = true;
    $("stats").hidden = true;
    $("goBtn").classList.remove("is-live");
    $("goBtn").setAttribute("aria-label", "Go live");
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    say(reason || "Stream ended. Tap the red button to go live again.", reason ? "err" : "");
  }

  $("goBtn").addEventListener("click", () => {
    if (!wantLive) goLive();
    else if (confirm("End the stream for this angle?")) stopLive();
  });

  function renderClock() {
    if (!liveSince) return;
    const s = Math.floor((Date.now() - liveSince) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    $("timer").textContent = (h ? `${h}:${String(m).padStart(2, "0")}` : String(m).padStart(2, "0")) + ":" + String(sec).padStart(2, "0");
  }

  // ---------- Keep the screen on ----------
  async function keepAwake() {
    try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch (_) {}
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && wantLive) { keepAwake(); recoverTracks(); }
  });

  // Android stops the camera/mic when the screen locks or another app takes over. When we're back,
  // get fresh tracks and swap them into the live connection, so viewers see video again.
  async function recoverTracks() {
    if (!stream) return;
    const dead = (t) => !t || t.readyState === "ended" || t.muted;
    try {
      const v = stream.getVideoTracks()[0];
      if (dead(v)) {
        if (v) { v.stop(); stream.removeTrack(v); }
        const fresh = (await navigator.mediaDevices.getUserMedia({ video: videoConstraints() })).getVideoTracks()[0];
        if ("contentHint" in fresh) fresh.contentHint = "motion";
        stream.addTrack(fresh);
        preview.srcObject = stream;
        if (videoSender) await videoSender.replaceTrack(fresh);
      }
      const a = stream.getAudioTracks()[0];
      if (a && a.readyState === "ended") {
        stream.removeTrack(a);
        const freshA = (await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })).getAudioTracks()[0];
        stream.addTrack(freshA);
        const audioSender = pc && pc.getSenders().find((s) => s !== videoSender);
        if (audioSender) await audioSender.replaceTrack(freshA);
        renderMic();
      }
      if (wantLive && pc && pc.connectionState === "connected") say("Camera back on. You're live.", "ok");
    } catch (e) {
      say("Camera stopped. Tap Flip camera, or end and go live again.", "err");
    }
  }
  addEventListener("beforeunload", (e) => { if (wantLive) { e.preventDefault(); e.returnValue = ""; } });

  // ---------- Upload stats ----------
  function startStats() {
    let lastBytes = 0, lastTs = 0;
    clearInterval(statsTimer);
    statsTimer = setInterval(async () => {
      if (!pc || pc.connectionState !== "connected") return;
      (await pc.getStats()).forEach((r) => {
        if (r.type !== "outbound-rtp" || r.kind !== "video") return;
        const kbps = lastTs ? Math.round(((r.bytesSent - lastBytes) * 8) / (r.timestamp - lastTs)) : 0;
        lastBytes = r.bytesSent; lastTs = r.timestamp;
        const parts = [
          kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`,
          r.frameHeight ? `${r.frameHeight}p` : "",
          r.framesPerSecond ? `${Math.round(r.framesPerSecond)} fps` : "",
        ].filter(Boolean);
        const weak = r.qualityLimitationReason === "bandwidth";
        $("stats").innerHTML = parts.join(" · ") + (weak ? ' · <span class="weak">weak signal</span>' : "");
        $("stats").hidden = false;
      });
    }, 2000);
  }

  // ---------- Orientation hint ----------
  const portrait = matchMedia("(orientation: portrait)");
  const renderRotate = () => { $("rotateHint").hidden = !portrait.matches; };
  portrait.addEventListener ? portrait.addEventListener("change", renderRotate) : portrait.addListener(renderRotate);
  renderRotate();

  // ---------- Start ----------
  renderAngleChip();
  if (!settings.pass) openSheet();
  else openCamera()
    .then(() => say("Ready. Tap the red button to go live."))
    .catch((e) => say(e.message.includes("secure") ? e.message : "Allow camera and microphone access, then reload.", "err"));
})();
