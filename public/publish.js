// Publish page: saves the live links into public/live.js on GitHub; Vercel redeploys the website.
(() => {
  const cfg = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const REPO = cfg.repo || "MeetDave-25/live-brodcasting";
  const FILE = "public/live.js";
  const ANGLES = cfg.angles && cfg.angles.length ? cfg.angles : [{ id: "cam1", name: "Main stage" }];
  document.querySelectorAll("[data-cfg]").forEach((el) => { if (cfg[el.dataset.cfg]) el.textContent = cfg[el.dataset.cfg]; });

  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } },
    set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (_) {} },
  };
  let token = store.get("rv-gh-token");
  let data = JSON.parse(JSON.stringify(window.LIVE || { mode: "embed", main: "cam1", angles: {} }));

  let toastTimer;
  function toast(text) {
    const t = $("toast");
    t.textContent = text;
    t.classList.add("in");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("in"), 3500);
  }

  // ---------- Form ----------
  function render() {
    const box = $("angles");
    box.innerHTML = "";
    ANGLES.forEach((a, i) => {
      const l = (data.angles || {})[a.id] || {};
      const card = document.createElement("article");
      card.className = "pub-angle";
      card.innerHTML = `
        <div class="pub-angle-head">
          <p class="a-name"></p>
          <label class="check"><input type="radio" name="main"> Main</label>
        </div>
        <label class="field"><span>YouTube live link</span><input data-k="youtube" inputmode="url" placeholder="https://youtube.com/live/…" autocomplete="off"></label>
        <label class="field"><span>Facebook live link (backup)</span><input data-k="facebook" inputmode="url" placeholder="https://www.facebook.com/…/videos/…" autocomplete="off"></label>
        <button class="copy" type="button" data-clear>Clear (angle off air)</button>`;
      card.querySelector(".a-name").textContent = `${String(i + 1).padStart(2, "0")} · ${a.name}`;
      const main = card.querySelector("input[name=main]");
      main.value = a.id;
      main.checked = data.main === a.id;
      card.querySelectorAll("input[data-k]").forEach((inp) => { inp.value = l[inp.dataset.k] || ""; inp.dataset.angle = a.id; });
      card.querySelector("[data-clear]").addEventListener("click", () => card.querySelectorAll("input[data-k]").forEach((x) => (x.value = "")));
      box.append(card);
    });
    $("announce").value = data.announcement || "";
    const m = document.querySelector(`input[name=mode][value=${data.mode === "server" ? "server" : "embed"}]`);
    if (m) m.checked = true;
    $("note").textContent = data.updated ? `Last published ${new Date(data.updated).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : "";
  }

  function collect() {
    const angles = {};
    ANGLES.forEach((a) => (angles[a.id] = { youtube: "", facebook: "" }));
    document.querySelectorAll("input[data-k]").forEach((inp) => { angles[inp.dataset.angle][inp.dataset.k] = inp.value.trim(); });
    for (const [id, l] of Object.entries(angles)) {
      if (l.youtube && !/youtu\.?be/.test(l.youtube)) throw new Error(`${id}: the YouTube box needs a youtube.com link`);
      if (l.facebook && !/facebook\.com|fb\.watch/.test(l.facebook)) throw new Error(`${id}: the Facebook box needs a facebook.com link`);
    }
    const main = (document.querySelector("input[name=main]:checked") || {}).value || ANGLES[0].id;
    return {
      mode: (document.querySelector("input[name=mode]:checked") || {}).value || "embed",
      main,
      announcement: $("announce").value.trim().slice(0, 280),
      updated: new Date().toISOString(),
      angles,
    };
  }

  // ---------- GitHub ----------
  const b64 = (text) => { let s = ""; new TextEncoder().encode(text).forEach((c) => (s += String.fromCharCode(c))); return btoa(s); };
  const unb64 = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
  const gh = (path, opts = {}) => fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    ...opts,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });

  async function current() {
    const r = await gh(`contents/${FILE}?ref=main&t=${Date.now()}`, { cache: "no-store" });
    if (r.status === 401) throw new Error("The GitHub key is wrong or expired. Create a new one (Publish key section).");
    if (r.status === 404 || r.status === 403) throw new Error("This GitHub key can't access the live-brodcasting repository. Check its repository access and Contents permission.");
    if (!r.ok) throw new Error(`GitHub replied ${r.status}`);
    const j = await r.json();
    return { sha: j.sha, text: unb64(j.content) };
  }

  function fileText(d) {
    return [
      "// Edited from the /publish page on a phone. Don't change the first and last lines' shape.",
      '// mode "embed": phones stream to YouTube/Facebook (Larix app) and the website plays those - no laptop.',
      '// mode "server": phones use our /studio page and the laptop server (start-event.bat).',
      `window.LIVE = ${JSON.stringify(d, null, 2)};`,
      "",
    ].join("\n");
  }

  async function publish() {
    $("err").textContent = "";
    if (!token) { $("err").textContent = "Save your GitHub key first (Publish key section below)."; $("key").scrollIntoView({ behavior: "smooth" }); return; }
    let next;
    try { next = collect(); } catch (e) { $("err").textContent = e.message; return; }
    $("publishBtn").disabled = true;
    $("publishBtn").textContent = "Publishing…";
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { sha } = await current();
        const r = await gh(`contents/${FILE}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Publish live links", content: b64(fileText(next)), sha, branch: "main" }),
        });
        if (r.status === 409 && attempt === 0) continue; // changed meanwhile: retry with the fresh version
        if (!r.ok) throw new Error(`GitHub replied ${r.status}: ${(await r.json().catch(() => ({}))).message || ""}`);
        break;
      }
      data = next;
      render();
      toast("Published. The website updates in about 30 seconds.");
      $("note").textContent = "Published. Open the website in ~30 s to check.";
    } catch (e) {
      $("err").textContent = e.message;
    } finally {
      $("publishBtn").disabled = false;
      $("publishBtn").textContent = "Publish to the website";
    }
  }
  $("publishBtn").addEventListener("click", publish);

  // ---------- Key ----------
  function renderKey() {
    $("keyState").textContent = token ? "Saved on this phone" : "Not set";
    $("keyHelp").open = !token;
    $("token").value = "";
    $("token").placeholder = token ? `Saved (…${token.slice(-4)}). Paste a new one to replace` : "github_pat_…";
  }
  $("saveKey").addEventListener("click", async () => {
    const t = $("token").value.trim();
    if (!t) return toast("Paste the key first");
    token = t;
    try {
      const cur = await current();
      store.set("rv-gh-token", t);
      toast("Key works and is saved on this phone");
      const json = cur.text.slice(cur.text.indexOf("{"), cur.text.lastIndexOf("}") + 1);
      try { data = JSON.parse(json); render(); } catch (_) {}
    } catch (e) {
      token = store.get("rv-gh-token");
      $("err").textContent = e.message;
      toast("That key didn't work");
    }
    renderKey();
  });
  $("forget").addEventListener("click", () => { token = ""; store.set("rv-gh-token", ""); renderKey(); toast("Key removed from this phone"); });

  document.querySelectorAll(".copy[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast("Copied. Add the stream key after it"); } catch (_) {}
  }));

  // Load the latest published version (the page itself may be a few seconds old)
  (async () => {
    try {
      const r = await fetch(`live.js?t=${Date.now()}`, { cache: "no-store" });
      const text = await r.text();
      data = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    } catch (_) {}
    render();
  })();
  renderKey();
  render();
})();
