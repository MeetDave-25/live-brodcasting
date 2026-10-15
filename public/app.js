(() => {
  const cfg = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const video = $("video");
  const screenEl = $("screen");
  const ANGLES = cfg.angles && cfg.angles.length ? cfg.angles : [{ id: "cam1", name: "Main stage" }];
  const angleName = (id) => (ANGLES.find((a) => a.id === id) || { name: id }).name;
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // "embed" mode: phones stream to YouTube/Facebook and we play those here (no laptop needed)
  let LIVE = window.LIVE || { mode: "server" };
  const EMBED = LIVE.mode === "embed";
  // "cloud" mode: watch the camera through the Cloudflare relay (WebRTC, under a second of delay)
  const CLOUD = LIVE.mode === "cloud" && (cfg.cloud || "").replace(/\/+$/, "");
  let rtc = null;
  let cloudLive = [];
  let cloudPolledAt = 0;
  const useFacebook = {}; // angle -> viewer chose the Facebook copy
  // Live server: this site when the laptop serves the page, otherwise config.server (e.g. from Vercel)
  const API = window.LIVE_SERVER_HERE ? "" : (cfg.server || "").replace(/\/+$/, "");

  // ---------- Text from config ----------
  document.querySelectorAll("[data-cfg]").forEach((el) => { if (cfg[el.dataset.cfg]) el.textContent = cfg[el.dataset.cfg]; });
  if (cfg.name) document.title = `${cfg.name} ${cfg.year || ""} · Live`.replace("  ", " ");
  $("posterKicker").textContent = cfg.host ? `${cfg.host} · Live` : "Live coverage";
  if (cfg.coords) $("coords").textContent = cfg.coords;

  // ---------- Smooth scrolling (Lenis) ----------
  const lenis = window.Lenis && !calm ? new Lenis({ autoRaf: true, lerp: 0.1 }) : null;

  // ---------- Event times ----------
  const start = cfg.startTime ? new Date(cfg.startTime) : null;
  const hasStart = start && !isNaN(start);
  const [, eventDay, tz] = (cfg.startTime || "").match(/^(\d{4}-\d{2}-\d{2})T[\d:.]+(Z|[+-]\d{2}:\d{2})?$/) || [];

  function slotTime(hhmm) {
    if (!eventDay) return null;
    const t = new Date(`${eventDay}T${hhmm}:00${tz || "+05:30"}`);
    // Times after midnight belong to the next day
    if (hasStart && t < start - 6 * 3600e3) t.setDate(t.getDate() + 1);
    return t;
  }
  function prettyTime(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
  }
  const pad2 = (n) => String(n).padStart(2, "0");

  const ICONS = {
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.4"/></svg>',
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  // ---------- Marquee ----------
  const words = cfg.marquee || ["એ હાલો", "Garba", "Dandiya Raas", "Nav Rang", "Live from the ground", "Every angle"];
  const track = $("marquee");
  for (let r = 0; r < 2; r++) words.forEach((w) => {
    const s = el("span", "", w);
    if (/[઀-૿]/.test(w)) s.lang = "gu";
    track.append(s);
  });

  // ---------- Programme timeline ----------
  const slots = (cfg.schedule || []).map((item) => {
    const li = el("li", "tl-item");
    const title = el("h3", "", item.title);
    li.append(el("span", "tl-dot"), el("p", "tl-time", [prettyTime(item.time), item.label].filter(Boolean).join(" · ")), title);
    if (item.note) li.append(el("p", "tl-note", item.note));
    $("programme").append(li);
    return { li, title, at: slotTime(item.time) };
  });

  function markProgramme() {
    const now = Date.now();
    let reached = -1;
    slots.forEach((s, i) => {
      const next = slots[i + 1] ? slots[i + 1].at : s.at && new Date(+s.at + 2 * 3600e3);
      const isNow = s.at && now >= s.at && now < next;
      const isPast = s.at && next && now >= next;
      if (s.at && now >= s.at) reached = i;
      s.li.classList.toggle("is-now", !!isNow);
      s.li.classList.toggle("is-past", !!isPast);
      const tag = s.title.querySelector(".now-tag");
      if (isNow && !tag) s.title.insertAdjacentHTML("beforeend", '<span class="now-tag">Now</span>');
      if (!isNow && tag) tag.remove();
    });
    // Fill the line down to the current item's dot
    const list = $("programme");
    const target = slots[reached];
    const h = target ? target.li.offsetTop + 12 : 0;
    list.style.setProperty("--progress", `${h}px`);
  }
  setTimeout(markProgramme, 600); // after fonts settle, so the line lands on the dot
  setInterval(markProgramme, 30000);
  addEventListener("resize", markProgramme);

  if (hasStart) {
    $("dateLabel").textContent = start.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) +
      " · from " + start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  // ---------- Details as tickets ----------
  (cfg.details || []).forEach((d) => {
    const card = el("article", "ticket");
    const tile = el("span", "tile");
    tile.innerHTML = ICONS[d.icon] || ICONS.calendar;
    card.append(tile, el("p", "label", d.label), el("h3", "", d.title));
    if (d.note) card.append(el("p", "t-note", d.note));
    $("details").append(card);
  });
  if (cfg.mapUrl) { $("mapBtn").href = cfg.mapUrl; $("mapRow").hidden = false; }

  // ---------- Staggered reveal as things scroll into view ----------
  $("programme").classList.add("reveal");
  $("details").classList.add("reveal");
  const reveals = document.querySelectorAll(".reveal");
  reveals.forEach((r) => [...r.children].forEach((c, i) => c.style.setProperty("--i", i)));
  const io = "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      }), { rootMargin: "0px 0px -6% 0px" })
    : null;
  reveals.forEach((x) => (io ? io.observe(x) : x.classList.add("in")));

  // ---------- Live state ----------
  let status = { live: [], featured: null, announcement: "", announcedAt: null, watching: 0 };
  let current = null;      // angle being shown
  let userPicked = null;   // angle the viewer chose themselves
  let wasLive = false;
  let wantSound = false;
  let hls = null;

  const isFull = () => status.admitted === false && status.live.length > 0;

  // Angles that kept freezing on this device: skip them for a little while if others are live
  const shaky = new Map(); // angle -> until
  const isShaky = (id) => (shaky.get(id) || 0) > Date.now();

  function pickAngle() {
    if (status.admitted === false) return null; // no spot yet: wait on the poster
    const all = ANGLES.map((a) => a.id).filter((id) => status.live.includes(id));
    const steady = all.filter((id) => !isShaky(id));
    const live = steady.length ? steady : all;
    if (userPicked && live.includes(userPicked)) return userPicked;
    if (live.includes(status.featured)) return status.featured;
    if (current && live.includes(current)) return current;
    return live[0] || null;
  }

  // ---------- Angle switcher ----------
  const anglesEl = $("angles");
  const angleBtns = ANGLES.map((a, i) => {
    const b = document.createElement("button");
    b.className = "angle";
    b.setAttribute("role", "tab");
    b.innerHTML = `<span class="angle-num">${String(i + 1).padStart(2, "0")}</span>
      <span class="angle-text"><span class="angle-name"></span><span class="angle-state"></span></span>`;
    b.querySelector(".angle-name").textContent = a.name;
    b.addEventListener("click", () => {
      if (!status.live.includes(a.id)) return;
      userPicked = a.id;
      if (a.id !== current) show(a.id);
      b.scrollIntoView({ behavior: calm ? "auto" : "smooth", inline: "center", block: "nearest" });
    });
    anglesEl.append(b);
    return { id: a.id, b };
  });
  anglesEl.hidden = ANGLES.length < 2;

  function renderAngles() {
    angleBtns.forEach(({ id, b }) => {
      const live = status.live.includes(id);
      b.classList.toggle("is-live", live);
      b.classList.toggle("is-active", id === current);
      b.setAttribute("aria-selected", id === current);
      b.disabled = !live;
      b.querySelector(".angle-state").textContent = live ? (id === current ? "Watching" : "Live") : "Off air";
    });
  }

  // ---------- Status pill ----------
  function renderPill() {
    const pill = $("statusPill");
    const label = pill.querySelector("span");
    pill.className = "pill";
    if (!navigator.onLine) { label.textContent = "No connection"; return; }
    if (isFull()) { pill.classList.add("is-off"); label.textContent = "Full house"; return; }
    if (current) {
      pill.classList.add("is-live");
      label.textContent = !EMBED && status.watching > 1 ? `Live · ${status.watching.toLocaleString()}` : "Live";
      if (status.watching > 1) label.append(Object.assign(document.createElement("span"), { className: "w-long", textContent: " watching" }));
    } else if (hasStart && Date.now() < start) {
      label.textContent = "Upcoming";
    } else {
      pill.classList.add("is-off");
      label.textContent = "Off air";
    }
  }

  // ---------- Waiting poster ----------
  function setDigit(id, value) {
    const b = $(id);
    const v = String(value);
    if (b.textContent === v) return;
    b.textContent = v;
    b.classList.remove("tick");
    void b.offsetWidth; // restart the flip animation
    b.classList.add("tick");
  }
  // Full house + a live YouTube copy: play that inside our app until a spot opens
  function showOverflow(id) {
    let f = $("overflowFrame");
    if (!id) { if (f) f.remove(); return; }
    if (f && f.dataset.id === id) return;
    if (!f) {
      f = document.createElement("iframe");
      f.id = "overflowFrame";
      f.title = "Live stream";
      f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
      f.allowFullscreen = true;
      screenEl.append(f);
    }
    f.dataset.id = id;
    f.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&playsinline=1&rel=0`;
  }

  function renderPoster() {
    if (current) return;
    showOverflow(isFull() ? status.overflow : null);
    if (isFull()) {
      $("countdown").hidden = true;
      $("posterTitle").innerHTML = "";
      $("posterTitle").append("It's a ", el("em", "", "full house"));
      $("posterNote").classList.add("keep"); // shown even on small phones
      $("posterNote").textContent = `All ${status.capacity} spots are taken. You'll join automatically when one opens.`;
      return;
    }
    $("posterNote").classList.remove("keep");
    const ms = hasStart ? start - Date.now() : 0;
    $("countdown").hidden = !(ms > 0);
    if (ms > 0) {
      const s = Math.floor(ms / 1000);
      setDigit("cdD", Math.floor(s / 86400));
      setDigit("cdH", pad2(Math.floor((s % 86400) / 3600)));
      setDigit("cdM", pad2(Math.floor((s % 3600) / 60)));
      setDigit("cdS", pad2(s % 60));
      const day = start.toLocaleDateString(undefined, { weekday: "long" });
      const t = start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      $("posterTitle").innerHTML = "";
      $("posterTitle").append("Live from ", el("em", "", `${day}, ${t}`));
      $("posterNote").textContent = "The video begins on its own. Keep this page open.";
    } else if (wasLive) {
      $("posterTitle").textContent = "A short pause";
      $("posterNote").textContent = "The cameras will be back shortly. The video resumes on its own.";
    } else {
      $("posterTitle").textContent = "Starting soon";
      $("posterNote").textContent = "The video begins on its own. Keep this page open.";
    }
  }
  setInterval(renderPoster, 1000);

  // ---------- Player ----------
  function stopPlayer() {
    if (rtc) { rtc.close(); rtc = null; }
    if (video.srcObject) video.srcObject = null;
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute("src");
    video.load();
  }

  function embedUrl(angle) {
    const l = (LIVE.angles || {})[angle] || {};
    const yt = (l.youtube || "").match(/(?:v=|youtu\.be\/|\/live\/|\/embed\/|\/shorts\/)([\w-]{11})/);
    if (yt && !(useFacebook[angle] && l.facebook)) {
      return `https://www.youtube-nocookie.com/embed/${yt[1]}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1`;
    }
    if (l.facebook) {
      return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(l.facebook)}&show_text=false&autoplay=true&mute=true&width=1280`;
    }
    return null;
  }
  function renderAltSource() {
    const b = $("altSource");
    const l = (current && (LIVE.angles || {})[current]) || {};
    b.hidden = !(EMBED && current && l.youtube && l.facebook);
    b.textContent = useFacebook[current] ? "Video not playing? Watch the YouTube copy" : "Video not playing? Watch the Facebook copy";
  }
  $("altSource").addEventListener("click", () => {
    useFacebook[current] = !useFacebook[current];
    const f = $("embedFrame");
    if (f) f.remove();
    show(current);
  });

  function showEmbed(angle) {
    let f = $("embedFrame");
    const src = angle && embedUrl(angle);
    if (!src) { if (f) f.remove(); return; }
    if (f && f.dataset.src === src) return;
    if (!f) {
      f = document.createElement("iframe");
      f.id = "embedFrame";
      f.title = "Live stream";
      f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write";
      f.allowFullscreen = true;
      $("screen").append(f);
    }
    f.dataset.src = src;
    f.src = src;
  }

  function show(angle) {
    current = angle;
    if (EMBED) {
      wasLive = wasLive || !!angle;
      video.hidden = true;
      $("poster").hidden = !!angle;
      $("buffer").hidden = true;
      $("soundHint").hidden = true;
      screenEl.classList.remove("show-hud");
      showEmbed(angle);
      if (!angle) renderPoster();
      renderAngles();
      renderPill();
      renderAltSource();
      return;
    }
    if (angle) showOverflow(null);
    stopPlayer();
    $("buffer").hidden = true;
    if (!angle) {
      video.hidden = true;
      $("poster").hidden = false;
      $("soundHint").hidden = true;
      screenEl.classList.remove("show-hud");
      renderPoster();
    } else {
      wasLive = true;
      video.hidden = false;
      $("poster").hidden = true;
      $("hudAngle").textContent = angleName(angle);
      const src = `${API}/${angle}${status.suffix || ""}/index.m3u8?t=${viewerId}`; // ticket = this viewer's spot
      if (CLOUD) {
        playCloud(angle);
      } else if (window.Hls && Hls.isSupported()) {
        hls = new Hls({ backBufferLength: 30, maxLiveSyncPlaybackRate: 1.1, liveSyncDurationCount: 4, liveMaxLatencyDurationCount: 10 }); // ~8 s buffer rides out hiccups
        hls.on(Hls.Events.ERROR, (_, d) => {
          if (!d.fatal) return;
          if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else lost();
        });
        hls.loadSource(src);
        hls.attachMedia(video);
      } else {
        video.src = src; // iPhone plays HLS natively
      }
      startPlayback();
      peekHud();
    }
    renderAngles();
    renderPill();
  }

  function startPlayback() {
    video.muted = !wantSound;
    video.play().catch(() => {
      video.muted = true; // browsers block autoplay with sound until the viewer taps
      video.play().catch(() => {});
    }).finally(renderSound);
  }

  async function playCloud(angle) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
    rtc = pc;
    const ms = new MediaStream();
    pc.ontrack = (e) => {
      ms.addTrack(e.track);
      if (video.srcObject !== ms) video.srcObject = ms;
      video.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => { if (rtc === pc && pc.connectionState === "failed") lost(); };
    try {
      const r = await fetch(`${CLOUD}/watch/${angle}`, { method: "POST" });
      if (!r.ok) throw new Error("off air");
      const j = await r.json();
      if (rtc !== pc) return;
      await pc.setRemoteDescription({ type: "offer", sdp: j.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      const a = await fetch(`${CLOUD}/answer/${j.sessionId}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sdp: pc.localDescription.sdp }),
      });
      if (!a.ok) throw new Error("answer failed");
    } catch (_) {
      if (rtc === pc) { cloudPolledAt = 0; lost(); }
    }
  }

  // Lost the stream: show a spinner and check again shortly
  function lost() {
    stopPlayer();
    $("buffer").hidden = false;
    const was = current;
    current = null;
    setTimeout(() => { if (!current) { current = was; refresh(true); } }, 2500);
  }

  video.addEventListener("error", () => { if (!hls && current) lost(); });
  video.addEventListener("waiting", () => { if (current) $("buffer").hidden = false; });
  video.addEventListener("playing", () => { $("buffer").hidden = true; });

  // Watchdog: if the picture hasn't moved for ~10 s, restart the player
  let lastT = -1, frozen = 0;
  const restarts = {};
  video.addEventListener("playing", () => { if (current) restarts[current] = 0; });
  setInterval(() => {
    if (EMBED) return; // YouTube/Facebook players handle their own buffering
    if (!current || (video.paused && video.readyState >= 2)) { frozen = 0; return; }
    if (video.currentTime === lastT) frozen += 2; else { frozen = 0; lastT = video.currentTime; }
    if (frozen >= 16) {
      frozen = 0; lastT = -1;
      // Second freeze in a row on this angle: try another live angle for 30 s
      restarts[current] = (restarts[current] || 0) + 1;
      if (restarts[current] >= 2) {
        shaky.set(current, Date.now() + 30000);
        restarts[current] = 0;
        const next = pickAngle();
        if (next && next !== current) { if (userPicked === current) userPicked = null; return show(next); }
      }
      show(current);
    }
  }, 2000);

  // ---------- Controls ----------
  let hudTimer;
  function peekHud() {
    screenEl.classList.add("show-hud");
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => screenEl.classList.remove("show-hud"), 3500);
  }
  screenEl.addEventListener("click", (e) => {
    if (!current || e.target.closest("button")) return;
    if (screenEl.classList.contains("show-hud")) screenEl.classList.remove("show-hud");
    else peekHud();
  });

  function renderSound() {
    const muted = video.muted;
    $("soundHint").hidden = !current || !muted;
    $("muteBtn").setAttribute("aria-label", muted ? "Turn sound on" : "Mute");
    $("muteBtn").querySelector(".ic-off").toggleAttribute("hidden", !muted);
    $("muteBtn").querySelector(".ic-on").toggleAttribute("hidden", muted);
  }
  function toggleSound() {
    wantSound = video.muted;
    video.muted = !wantSound;
    if (wantSound) video.play().catch(() => {});
    renderSound();
    peekHud();
  }
  $("muteBtn").addEventListener("click", toggleSound);
  $("soundHint").addEventListener("click", toggleSound);
  video.addEventListener("volumechange", renderSound);

  $("fullBtn").addEventListener("click", async () => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) return (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    if (screenEl.requestFullscreen) {
      await screenEl.requestFullscreen().catch(() => {});
      try { await screen.orientation.lock("landscape"); } catch (_) {}
    } else if (screenEl.webkitRequestFullscreen) screenEl.webkitRequestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
  });
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) try { screen.orientation.unlock(); } catch (_) {}
  });

  const canPip = document.pictureInPictureEnabled ||
    (video.webkitSupportsPresentationMode && video.webkitSupportsPresentationMode("picture-in-picture"));
  $("pipBtn").hidden = !canPip;
  $("pipBtn").addEventListener("click", () => {
    if (document.pictureInPictureElement) return document.exitPictureInPicture();
    if (video.requestPictureInPicture) video.requestPictureInPicture().catch(() => {});
    else video.webkitSetPresentationMode("picture-in-picture");
  });

  // ---------- Announcements ----------
  let lastNotice = undefined;
  function renderNotice() {
    const text = status.announcement;
    $("notice").hidden = !text;
    if (!text) { lastNotice = null; return; }
    $("noticeText").textContent = text;
    $("noticeTime").textContent = status.announcedAt
      ? "· " + new Date(status.announcedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : "";
    if (lastNotice !== undefined && lastNotice !== status.announcedAt) toast("New note from the organisers", scrollToNotice);
    lastNotice = status.announcedAt;
  }
  function scrollToNotice() {
    const offset = -(document.querySelector(".bar").offsetHeight + document.querySelector(".stage").offsetHeight + 12);
    if (lenis) lenis.scrollTo($("notice"), { offset, duration: 1.2 });
    else window.scrollTo({ top: $("notice").getBoundingClientRect().top + scrollY + offset, behavior: "smooth" });
  }

  let toastTimer;
  function toast(text, onClick) {
    const t = $("toast");
    t.textContent = text;
    t.onclick = () => { t.classList.remove("in"); if (onClick) onClick(); };
    t.classList.add("in");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("in"), 6000);
  }

  // ---------- Talk to the server every few seconds ----------
  const viewerId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let refreshing = false;
  // live.js holds the links; re-read it so changes from /publish arrive without reloading
  async function readLiveFile() {
    const r = await fetch(`live.js?t=${Date.now()}`, { cache: "no-store" });
    const text = await r.text();
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    return JSON.parse(json);
  }
  function embedStatus() {
    const angles = LIVE.angles || {};
    return {
      live: Object.keys(angles).filter((id) => angles[id].youtube || angles[id].facebook),
      featured: LIVE.main, announcement: LIVE.announcement || "", announcedAt: LIVE.announcement ? LIVE.updated : null,
      watching: 0, admitted: true,
    };
  }

  async function refresh(force) {
    if (refreshing && !force) return;
    refreshing = true;
    try {
      if (CLOUD) {
        try { LIVE = await readLiveFile(); } catch (_) {}
        // Ask the relay often while waiting, rarely while watching (keeps within the free plan)
        if (force || Date.now() - cloudPolledAt > (current ? 90000 : 15000)) {
          try { cloudLive = (await (await fetch(`${CLOUD}/live`, { cache: "no-store" })).json()).live || []; } catch (_) {}
          cloudPolledAt = Date.now();
        }
        status = {
          live: cloudLive, featured: LIVE.main, announcement: LIVE.announcement || "",
          announcedAt: LIVE.announcement ? LIVE.updated : null, watching: 0, admitted: true,
        };
        renderPoster();
        const next = pickAngle();
        if (next !== current || (next && !rtc)) show(next);
        renderAngles(); renderPill(); renderNotice();
        return;
      }
      if (EMBED) {
        try { LIVE = await readLiveFile(); } catch (_) { /* keep what we have */ }
        status = embedStatus();
        const next = pickAngle();
        if (next !== current) show(next);
        else if (next) { showEmbed(next); renderAltSource(); } // links may have changed
        renderAngles(); renderPill(); renderNotice(); renderPoster();
        return;
      }
      const r = await fetch(`${API}/api/status?id=${viewerId}&angle=${current || ""}`, { cache: "no-store" });
      status = await r.json();
      renderPoster();
      const next = pickAngle();
      if (next !== current || (next && !hls && !video.src)) show(next);
      renderAngles();
      renderPill();
      renderNotice();
    } catch (_) {
      renderPill();
    } finally {
      refreshing = false;
    }
  }
  refresh();
  setInterval(refresh, EMBED || CLOUD ? 20000 : 5000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  addEventListener("online", () => refresh());
  addEventListener("offline", renderPill);
  renderPoster();

  // ---------- Share & install ----------
  $("shareBtn").addEventListener("click", async () => {
    const data = { title: document.title, text: "Watch the garba night live", url: location.origin };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(data.url); toast("Link copied"); }
    } catch (_) {}
  });

  let deferredInstall;
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
    $("installBtn").hidden = false;
  });
  $("installBtn").addEventListener("click", async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $("installBtn").hidden = true;
  });
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (isIOS && !standalone) $("iosHint").hidden = false;

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
