// Service worker for the installable demo. It makes the app open offline once it has
// been visited: every same-origin GET goes to the network first (so a new deploy is
// picked up on the next load, never pinned behind a stale cache) and falls back to
// the copy saved the last time it was fetched. The files a user opens never pass
// through here — the host hands the viewer blob: URLs, which service workers don't see.
const CACHE = "3dview-v1";
const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "dist/demo.js",
  "dist/webview.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  // Drop caches from earlier versions of this worker, then serve open pages at once.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
        }
        return response;
      })
      .catch(() =>
        caches
          .match(request, { ignoreSearch: true })
          .then((hit) => hit ?? (request.mode === "navigate" ? caches.match("index.html") : undefined))
          .then((hit) => hit ?? Response.error())
      )
  );
});
