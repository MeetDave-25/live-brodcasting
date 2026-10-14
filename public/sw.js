// Caches the viewer app's own files so it opens instantly, even on a weak network.
// Live video, the API and the studio/admin pages always go to the network.
const CACHE = "rangvaasa-v4";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/config.js", "/theme.js", "/icon.svg",
               "/icon-192.png", "/apple-touch-icon.png", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || !SHELL.includes(url.pathname)) return;
  // Network first, so edits to config.js show up straight away
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
