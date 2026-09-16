/* Sundial service worker.
   The cache name carries the app version, so a release replaces the shell
   cleanly and the page gets told to offer a reload. */
const APP_VERSION = "0.3.1";
const SHELL_CACHE = "sundial-shell-v" + APP_VERSION;
const LIB_CACHE   = "sundial-lib-v" + APP_VERSION;

/* The app shell: everything needed to open with no signal. */
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./favicon.svg",
  "./favicon-32.png",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png"
];

/* Third-party modules the page imports. They are not precached (they would
   make install fail without a network); they are cached the first time they
   are fetched and then served stale-while-revalidate. */
const LIB_HOSTS = ["https://www.gstatic.com/firebasejs/", "https://cdn.jsdelivr.net/npm/xlsx@"];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL.map(u => cache.add(new Request(u, { cache: "reload" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const stale = keys.filter(k => k.startsWith("sundial-") && k !== SHELL_CACHE && k !== LIB_CACHE);
    await Promise.all(stale.map(k => caches.delete(k)));
    await self.clients.claim();
    /* Only an upgrade (there was an older Sundial cache) is worth a toast. */
    if (stale.length) {
      const list = await self.clients.matchAll({ type: "window" });
      list.forEach(c => c.postMessage({ type: "sundial-update", version: APP_VERSION }));
    }
  })());
});

function isLib(url) { return LIB_HOSTS.some(h => url.startsWith(h)); }

async function staleWhileRevalidate(request) {
  const cache = await caches.open(LIB_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then(res => {
    if (res && (res.ok || res.type === "opaque")) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return cached || network || fetch(request);
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) {
    fetch(request).then(res => { if (res && res.ok) cache.put(request, res.clone()); }).catch(() => {});
    return cached;
  }
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok && request.method === "GET") cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === "navigate") {
      const shell = await cache.match("./index.html");
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = req.url;

  if (isLib(url)) { event.respondWith(staleWhileRevalidate(req)); return; }

  /* Firestore and Auth traffic must never be intercepted. */
  if (url.indexOf("firestore.googleapis.com") >= 0 ||
      url.indexOf("identitytoolkit.googleapis.com") >= 0 ||
      url.indexOf("securetoken.googleapis.com") >= 0 ||
      url.indexOf("googleapis.com/google.firestore") >= 0) return;

  const sameOrigin = new URL(url).origin === self.location.origin;
  if (!sameOrigin) return;

  const path = new URL(url).pathname;
  const isShell = SHELL.some(s => path.endsWith(s.replace("./", "/")) || path.endsWith("/"));
  if (req.mode === "navigate" || isShell) { event.respondWith(cacheFirst(req)); return; }
  event.respondWith(networkFirst(req));
});
