/* Loadout service worker (PLAN section 9).
   The cache name carries the app version, so a release replaces the shell
   cleanly; activate drops the older caches and tells open pages a newer
   version took over, so they can offer a reload. Bump VERSION with the app
   (index.html VERSION, manifest.json, README) on every release. */
const VERSION = "0.5.0";
const SHELL_CACHE = "loadout-shell-v" + VERSION;
const LIB_CACHE = "loadout-lib-v" + VERSION;
/* product photos keep their own cache across releases: they do not change
   when the app does, and a phone in a dead corner should still show them */
const IMG_CACHE = "loadout-img";
const IMG_MAX = 300;

/* The app shell: everything needed to open with no signal. */
const SHELL = [
  "./",
  "./index.html",
  "./qr.js",
  "./manifest.json",
  "./favicon.svg",
  "./icon-192.png",
  "./icon-512.png"
];

/* Third-party scripts the page loads. Precached best effort (a failure here
   must not fail the install), then served stale-while-revalidate. The zxing
   decoder is listed so the iOS camera fallback also works offline; the
   Firebase versions must match SDK in index.html. */
const SDK = "https://www.gstatic.com/firebasejs/12.13.0/";
const LIBS = [
  "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js",
  SDK + "firebase-app.js",
  SDK + "firebase-auth.js",
  SDK + "firebase-firestore.js",
  SDK + "firebase-storage.js"
];
const LIB_HOSTS = ["https://www.gstatic.com/firebasejs/", "https://cdn.jsdelivr.net/npm/"];
/* a slow link in the warehouse should not hold the shell hostage */
const NET_TIMEOUT_MS = 4000;

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL.map(u => shell.add(new Request(u, { cache: "reload" })).catch(() => {})));
    const lib = await caches.open(LIB_CACHE);
    await Promise.all(LIBS.map(u => lib.add(new Request(u, { mode: "cors" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const stale = keys.filter(k => k.startsWith("loadout-") && k !== SHELL_CACHE && k !== LIB_CACHE && k !== IMG_CACHE);
    await Promise.all(stale.map(k => caches.delete(k)));
    await self.clients.claim();
    /* only an upgrade (an older Loadout cache was here) is worth a toast */
    if (stale.length) {
      const list = await self.clients.matchAll({ type: "window" });
      list.forEach(c => c.postMessage({ type: "loadout-update", version: VERSION }));
    }
  })());
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)); }

/* the shell: the network when it answers, the cache when it does not */
async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await Promise.race([fetch(request), timeout(NET_TIMEOUT_MS)]);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === "navigate") {
      const shell = await cache.match("./index.html") || await cache.match("./");
      if (shell) return shell;
    }
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName, max) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request).then(async res => {
    if (res && (res.ok || res.type === "opaque")) {
      await cache.put(request, res.clone());
      if (max) { const keys = await cache.keys(); if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k))); }
    }
    return res;
  }).catch(() => null);
  if (cached) { network.catch(() => {}); return cached; }
  const res = await network;
  return res || Response.error();
}

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = req.url;

  /* Firestore, Auth, and Storage uploads must never be intercepted */
  if (url.indexOf("firestore.googleapis.com") >= 0 ||
      url.indexOf("identitytoolkit.googleapis.com") >= 0 ||
      url.indexOf("securetoken.googleapis.com") >= 0 ||
      url.indexOf("googleapis.com/google.firestore") >= 0) return;

  if (LIB_HOSTS.some(h => url.startsWith(h))) { event.respondWith(staleWhileRevalidate(req, LIB_CACHE)); return; }

  /* product photos (download links under loadout/products/) */
  if (url.startsWith("https://firebasestorage.googleapis.com/") && url.indexOf("/o/loadout%2Fproducts%2F") >= 0 && url.indexOf("alt=media") >= 0) {
    event.respondWith(staleWhileRevalidate(req, IMG_CACHE, IMG_MAX)); return;
  }

  if (new URL(url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});
