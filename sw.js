// Minimal app-shell cache — just enough for installability and to survive
// a flaky connection. Never touches the GitHub API calls (different origin,
// and we skip caching anything but the static shell below).

const CACHE = "engel-capture-v2";
const SHELL = ["./", "./index.html", "./app.js", "./manifest.json", "./icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let API calls go straight to network

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
