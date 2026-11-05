/* Replaces the old Loadout service worker: wipes its caches, unregisters, and reloads open tabs onto the redirect stub.
   Must stay at this path (the old app's /work/loadout/sw.js) so installed workers pick it up as an update. */
self.addEventListener("install", () => { self.skipWaiting(); });

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.clients.claim();
    await self.registration.unregister();
    const list = await self.clients.matchAll({ type: "window" });
    list.forEach(client => client.navigate(client.url));
  })());
});
