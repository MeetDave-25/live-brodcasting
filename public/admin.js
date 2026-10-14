(() => {
  const cfg = window.APP_CONFIG || {};
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
  const NO_SERVER = "The live server isn't connected. Cameras and the control room need the streaming server running on your VPS (see README).";

  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
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
    try { await api("/api/admin/login", { password: $("adminPass").value }); $("adminPass").value = ""; showDash(); }
    catch (err) { $("loginErr").textContent = err.message; }
  });
  $("logoutBtn").addEventListener("click", async () => {
    await api("/api/admin/logout", {}).catch(() => {});
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
    const src = `/${id}/index.m3u8`;
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
        : "Waiting for a phone";
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
        row.querySelector("a").href = `/api/admin/download?${q}`;
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

  // ---------- Poll ----------
  let pollTimer;
  async function poll() {
    try {
      const data = await api("/api/admin/overview");
      renderAngles(data);
      renderRecordings(data.recordings);
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
  fetch("/api/admin/overview", { cache: "no-store" })
    .then((r) => {
      if (r.ok) return showDash();
      showLogin();
      if (!(r.headers.get("content-type") || "").includes("json")) $("loginErr").textContent = NO_SERVER;
    })
    .catch(() => { showLogin(); $("loginErr").textContent = NO_SERVER; });
})();
