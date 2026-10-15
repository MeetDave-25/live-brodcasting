(() => {
  const cfg = window.APP_CONFIG || {};
  if (["embed", "cloud"].includes((window.LIVE || {}).mode)) { location.replace("publish"); return; }
  const $ = (id) => document.getElementById(id);
  const ANGLES = cfg.angles && cfg.angles.length ? cfg.angles : [{ id: "cam1", name: "Main stage" }];
  const angleName = (id) => (ANGLES.find((a) => a.id === id) || { name: id }).name;
  const num = (id) => String(ANGLES.findIndex((a) => a.id === id) + 1).padStart(2, "0");
  document.querySelectorAll("[data-cfg]").forEach((el) => { if (cfg[el.dataset.cfg]) el.textContent = cfg[el.dataset.cfg]; });
  if (window.Lenis && !matchMedia("(prefers-reduced-motion: reduce)").matches) new Lenis({ autoRaf: true, lerp: 0.1 });

  let toastTimer;
  function toast(text) {
    const t = $("toast");
    t.textContent = text;
    t.classList.add("in");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("in"), 3000);
  }

  // Shown when the pages are hosted without the app server (e.g. static hosting like Vercel)
  const NO_SERVER = "The live server isn't connected. Start it on the laptop (start-event.bat) and check the server address in config.js.";
  // Live server: this site when the laptop serves the page, otherwise config.server (e.g. from Vercel)
  const API = window.LIVE_SERVER_HERE ? "" : (cfg.server || "").replace(/\/+$/, "");

  // Login token, kept for this browser tab (works across sites, unlike cookies)
  let token = "";
  try { token = sessionStorage.getItem("rv-admin-token") || ""; } catch (_) {}
  function setToken(t) {
    token = t || "";
    try { t ? sessionStorage.setItem("rv-admin-token", t) : sessionStorage.removeItem("rv-admin-token"); } catch (_) {}
  }

  async function api(path, body) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const r = await fetch(API + path, body === undefined ? { cache: "no-store", headers } : {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!(r.headers.get("content-type") || "").includes("json")) throw new Error(NO_SERVER);
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== "/api/admin/login") { showLogin(); throw new Error("Please log in"); }
    if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
    return j;
  }

  // ---------- Login ----------
  function showLogin() {
    $("dash").hidden = true;
    $("logoutBtn").hidden = true;
    $("login").hidden = false;
    clearInterval(pollTimer);
    $("adminPass").focus();
  }
  function showDash() {
    $("login").hidden = true;
    $("dash").hidden = false;
    $("logoutBtn").hidden = false;
    poll();
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, 3000);
  }
  $("login").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("loginErr").textContent = "";
    try {
      const j = await api("/api/admin/login", { password: $("adminPass").value });
      setToken(j.token);
      $("adminPass").value = "";
      showDash();
    }
    catch (err) { $("loginErr").textContent = err.message; }
  });
  $("logoutBtn").addEventListener("click", async () => {
    await api("/api/admin/logout", {}).catch(() => {});
    setToken("");
    showLogin();
  });

  // ---------- Angle cards ----------
  const cards = {};
  ANGLES.forEach((a) => {
    const el = document.createElement("article");
    el.className = "a-card";
    el.innerHTML = `
      <div class="a-frame"><div class="off">Off air</div></div>
      <div class="a-body">
        <p class="a-name"></p>
        <p class="a-meta"></p>
        <div class="a-actions">
          <button class="btn btn-quiet" data-act="main">Make main</button>
          <button class="btn btn-danger" data-act="end">End</button>
        </div>
      </div>`;
    el.querySelector(".a-name").textContent = `${num(a.id)} · ${a.name}`;
    el.querySelector("[data-act=main]").addEventListener("click", async () => {
      try { await api("/api/admin/state", { featured: a.id }); toast(`${a.name} is now the main angle`); poll(); }
      catch (err) { toast(err.message); }
    });
    el.querySelector("[data-act=end]").addEventListener("click", async () => {
      if (!confirm(`End the stream from ${a.name}? The phone will stop broadcasting.`)) return;
      try { await api("/api/admin/kick", { angle: a.id }); toast(`${a.name} ended`); poll(); }
      catch (err) { toast(err.message); }
    });
    $("angleGrid").append(el);
    cards[a.id] = { el, frame: el.querySelector(".a-frame"), video: null, hls: null };
  });

  function startPreview(c, id) {
    if (c.video) return;
    c.video = document.createElement("video");
    c.video.muted = true;
    c.video.playsInline = true;
    c.video.autoplay = true;
    c.frame.querySelector(".off").hidden = true;
    c.frame.append(c.video);
    const src = `${API}/${id}/index.m3u8?a=${token}`;
    if (window.Hls && Hls.isSupported()) {
      c.hls = new Hls({ backBufferLength: 10 });
      c.hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) stopPreview(c); });
      c.hls.loadSource(src);
      c.hls.attachMedia(c.video);
    } else c.video.src = src;
    c.video.play().catch(() => {});
  }
  function stopPreview(c) {
    if (c.hls) { c.hls.destroy(); c.hls = null; }
    if (c.video) { c.video.remove(); c.video = null; }
    c.frame.querySelector(".off").hidden = false;
  }

  function since(iso) {
    const min = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
  }
  function setTag(frame, cls, text, on) {
    let tag = frame.querySelector(`.a-tag.${cls}`);
    if (on && !tag) { tag = document.createElement("span"); tag.className = `a-tag ${cls}`; tag.textContent = text; frame.append(tag); }
    if (!on && tag) tag.remove();
  }

  function renderAngles(data) {
    data.angles.forEach((a) => {
      const c = cards[a.id];
      if (!c) return;
      const isMain = data.state.featured === a.id;
      c.el.classList.toggle("is-main", isMain);
      setTag(c.frame, "live", "Live", a.live);
      setTag(c.frame, "main", "Main", isMain);
      c.el.querySelector(".a-meta").textContent = a.live
        ? [`Live ${since(a.since)}`, a.kbps != null ? `${a.kbps} kbps` : null, `${a.watching} watching`].filter(Boolean).join(" · ")
        : a.stalled ? "Paused: no video from the phone. Is its screen on and the camera page open?" : "Waiting for a phone";
      c.el.querySelector("[data-act=main]").disabled = isMain;
      c.el.querySelector("[data-act=main]").textContent = isMain ? "Main angle" : "Make main";
      c.el.querySelector("[data-act=end]").disabled = !a.live;
      if (a.live) startPreview(c, a.id); else stopPreview(c);
    });
    const live = data.angles.filter((a) => a.live && cards[a.id]).length;
    $("sumWatching").textContent = data.capacity ? `${data.watching} / ${data.capacity}` : data.watching.toLocaleString();
    $("sumLive").textContent = `${live} / ${ANGLES.length}`;
    $("sumMain").textContent = angleName(data.state.featured);
  }

  // ---------- Recordings ----------
  let lastRecKey = "";
  function fmtDuration(sec) {
    const m = Math.round(sec / 60);
    return m < 60 ? `${Math.max(1, m)} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  }
  function fmtSize(sec, kbps) {
    const mb = (sec * kbps) / 8 / 1000;
    return mb > 1000 ? `~${(mb / 1000).toFixed(1)} GB` : `~${Math.max(1, Math.round(mb))} MB`;
  }
  function renderRecordings(recs) {
    const key = JSON.stringify(recs);
    if (key === lastRecKey) return;
    lastRecKey = key;
    const box = $("recordings");
    box.innerHTML = "";
    let any = false;
    ANGLES.forEach((a) => {
      const list = (recs[a.id] || []).slice().reverse();
      if (!list.length) return;
      any = true;
      const g = document.createElement("div");
      g.className = "rec-group";
      const h = document.createElement("h3");
      h.textContent = `${num(a.id)} · ${a.name}`;
      g.append(h);
      list.forEach((r) => {
        const row = document.createElement("div");
        row.className = "rec-row";
        const when = new Date(r.start);
        row.innerHTML = `<div class="rec-when"><b></b><span></span></div><a class="btn btn-quiet" download>Download MP4</a>`;
        row.querySelector("b").textContent = when.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
        row.querySelector("span").textContent = `${fmtDuration(r.duration)} · ${fmtSize(r.duration, 900)}`;
        const q = new URLSearchParams({ angle: a.id, start: r.start, duration: String(r.duration) });
        q.set("a", token);
        row.querySelector("a").href = `${API}/api/admin/download?${q}`;
        g.append(row);
      });
      box.append(g);
    });
    if (!any) box.innerHTML = '<p class="empty">Nothing recorded yet. Recording starts automatically when a phone goes live.</p>';
  }

  // ---------- Announcement ----------
  let announceDirty = false;
  $("announceText").addEventListener("input", () => {
    announceDirty = true;
    $("announceCount").textContent = `${$("announceText").value.length} / 280`;
  });
  $("announceForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await api("/api/admin/state", { announcement: $("announceText").value.trim() }); announceDirty = false; toast("Posted to viewers"); }
    catch (err) { toast(err.message); }
  });
  $("clearAnnounce").addEventListener("click", async () => {
    try { await api("/api/admin/state", { announcement: "" }); $("announceText").value = ""; announceDirty = false; toast("Announcement removed"); }
    catch (err) { toast(err.message); }
  });

  // ---------- Go live everywhere ----------
  const RS_HELP = {
    youtube: "YouTube Studio → Create → Go live → Stream. Copy the Stream key. (A new channel needs about 24 h before live streaming works.)",
    facebook: "facebook.com/live/producer → Go live → Streaming software. Copy the Stream key.",
    instagram: "On a computer: instagram.com → Create (+) → Live video → add a title → copy the Stream URL and Stream key. Instagram gives a new key each time you go live.",
    custom: "Any service that accepts RTMP: paste its Stream URL and key.",
  };
  const RS_URL = { youtube: "rtmp://a.rtmp.youtube.com/live2", facebook: "rtmps://live-api-s.facebook.com:443/rtmp", instagram: "", custom: "" };
  const RS_STATUS = { off: "Off", waiting: "Waiting for the main angle", starting: "Connecting…", live: "Live", retrying: "Retrying…" };
  let rsLast = "";
  let rsData = { destinations: [] };

  function rsPlatform() { return document.querySelector("input[name=rsPlatform]:checked").value; }
  function rsSyncForm(fillUrl) {
    const p = rsPlatform();
    $("rsHelp").textContent = RS_HELP[p];
    if (fillUrl) $("rsUrl").value = RS_URL[p];
    $("rsWatchRow").hidden = $("rsWatchHelp").hidden = p !== "youtube";
    if (fillUrl) $("rsVertical").checked = p === "instagram";
  }
  document.querySelectorAll("input[name=rsPlatform]").forEach((r) => r.addEventListener("change", () => rsSyncForm(true)));

  function rsOpen(d) {
    $("rsForm").hidden = false;
    $("rsAdd").hidden = true;
    $("rsErr").textContent = "";
    $("rsId").value = d ? d.id : "";
    document.querySelector(`input[name=rsPlatform][value=${d ? d.platform : "youtube"}]`).checked = true;
    rsSyncForm(!d);
    if (d) { $("rsUrl").value = d.url; $("rsWatch").value = d.watchUrl; $("rsVertical").checked = d.vertical; }
    else $("rsWatch").value = "";
    $("rsKey").value = "";
    $("rsKey").placeholder = d ? `Saved (${d.key}). Paste a new one to change it` : "Paste the stream key";
    $("rsForm").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function rsClose() { $("rsForm").hidden = true; $("rsAdd").hidden = false; }
  $("rsAdd").addEventListener("click", () => rsOpen(null));
  $("rsCancel").addEventListener("click", rsClose);
  $("rsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("rsErr").textContent = "";
    try {
      const v = await api("/api/admin/restream/save", {
        id: $("rsId").value || undefined, platform: rsPlatform(), url: $("rsUrl").value.trim(),
        key: $("rsKey").value.trim(), watchUrl: $("rsWatch").value.trim(), vertical: $("rsVertical").checked,
      });
      rsClose();
      renderRestream(v, true);
      toast("Saved. Switch it on when you're ready");
    } catch (err) { $("rsErr").textContent = err.message; }
  });

  function renderRestream(v, force) {
    if (!v) return;
    rsData = v;
    const key = JSON.stringify(v);
    if (key === rsLast && !force) return;
    rsLast = key;
    $("rsIntro").textContent = v.ffmpeg
      ? "Switch a platform on and the main angle goes live there too. When you change the main angle, they follow."
      : "FFmpeg isn't installed on the server, so this can't send to other platforms yet (start-event.bat downloads it).";
    const list = $("rsList");
    list.innerHTML = "";
    v.destinations.forEach((d) => {
      const card = document.createElement("article");
      card.className = `rs-card is-${d.status}`;
      card.innerHTML = `
        <div class="rs-top">
          <div><p class="rs-name"></p><p class="rs-status"><i></i><span></span></p></div>
          <button class="switch" role="switch" aria-label="On or off"><span></span></button>
        </div>
        <p class="rs-err" hidden></p>
        <div class="rs-actions"><button class="copy" data-act="edit">Edit</button><button class="copy" data-act="del">Remove</button></div>`;
      card.querySelector(".rs-name").textContent = d.name + (d.vertical ? " · vertical" : "");
      card.querySelector(".rs-status span").textContent = RS_STATUS[d.status] || d.status;
      if (d.error && d.status !== "live") { const er = card.querySelector(".rs-err"); er.hidden = false; er.textContent = d.error; }
      const sw = card.querySelector(".switch");
      sw.setAttribute("aria-checked", d.enabled);
      sw.addEventListener("click", async () => {
        try { renderRestream(await api("/api/admin/restream/toggle", { id: d.id, enabled: !d.enabled }), true); }
        catch (err) { toast(err.message); }
      });
      card.querySelector("[data-act=edit]").addEventListener("click", () => rsOpen(d));
      card.querySelector("[data-act=del]").addEventListener("click", async () => {
        if (!confirm(`Remove ${d.name}? It stops streaming there.`)) return;
        try { renderRestream(await api("/api/admin/restream/delete", { id: d.id }), true); } catch (err) { toast(err.message); }
      });
      list.append(card);
    });
  }

  // ---------- Server ----------
  const fmtWhen = (iso) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  function renderServer(s) {
    if (!s) return;
    $("srvVersion").textContent = s.version ? `${s.version} · ${fmtWhen(s.versionDate)}` : "Local copy";
    $("srvVersion").title = s.versionNote || "";
    $("srvStarted").textContent = fmtWhen(s.started);
    $("srvRelay").textContent = s.relay ? "Relay on: phones can go live from any network" : "Direct: works on most networks";
    $("updateBtn").hidden = !s.canUpdate;
  }
  $("updateBtn").addEventListener("click", async () => {
    if (!confirm("Update the server to the latest version from GitHub?\n\nLive streams pause for about a minute while it restarts. Don't do this during the event.")) return;
    try {
      await api("/api/admin/update", {});
      $("updateBtn").disabled = true;
      $("updateNote").textContent = "Updating… the page reconnects by itself in about a minute.";
      setTimeout(() => location.reload(), 75000);
    } catch (err) { toast(err.message); }
  });

  // ---------- Poll ----------
  let pollTimer;
  async function poll() {
    try {
      const data = await api("/api/admin/overview");
      renderAngles(data);
      renderRecordings(data.recordings);
      renderServer(data.server);
      renderRestream(data.restream);
      if (!announceDirty && document.activeElement !== $("announceText")) {
        $("announceText").value = data.state.announcement || "";
        $("announceCount").textContent = `${$("announceText").value.length} / 280`;
      }
    } catch (_) {}
  }

  // ---------- Links & QR ----------
  const viewerUrl = location.origin + "/";
  const studioUrl = location.origin + "/studio";
  $("viewerLink").textContent = viewerUrl;
  $("studioLink").textContent = studioUrl;
  document.querySelectorAll(".copy").forEach((b) => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($(b.dataset.copy).textContent); toast("Copied"); } catch (_) {}
  }));

  function drawQr(canvas, size) {
    if (!window.qrcode) return false;
    const qr = qrcode(0, "M");
    qr.addData(viewerUrl);
    qr.make();
    const n = qr.getModuleCount(), quiet = 3;
    const cell = Math.floor(size / (n + quiet * 2));
    const total = cell * (n + quiet * 2);
    canvas.width = canvas.height = total;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, total, total);
    ctx.fillStyle = "#1b1533";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
    }
    return true;
  }
  addEventListener("load", () => drawQr($("qr"), 240));
  $("qrDownload").addEventListener("click", () => {
    const c = document.createElement("canvas");
    if (!drawQr(c, 1200)) return toast("QR library didn't load");
    const a = document.createElement("a");
    a.download = "rangvaasa-live-qr.png";
    a.href = c.toDataURL("image/png");
    a.click();
  });

  // ---------- Start: already logged in? ----------
  fetch(`${API}/api/admin/overview`, { cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {} })
    .then((r) => {
      if (r.ok) return showDash();
      showLogin();
      if (!(r.headers.get("content-type") || "").includes("json")) $("loginErr").textContent = NO_SERVER;
    })
    .catch(() => { showLogin(); $("loginErr").textContent = NO_SERVER; });
})();
