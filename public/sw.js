/* Service worker (Iteration 12): an offline page, cached static assets, and push notifications.
   It never caches pages or data: pages carry personal information and a per-request CSP nonce. Only content-hashed
   files under /_next/static (immutable) and the offline page are kept. Registered as /sw.js?static=1 in production;
   in development static files aren't cached because their URLs aren't content-hashed. */
const VERSION = "v1";
const CACHE = `app-${VERSION}`;
const OFFLINE = "/offline.html";
const CACHE_STATIC = new URL(self.location.href).searchParams.get("static") === "1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, "/icon.svg", "/icon-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // pages: always from the network; the offline page when there isn't one
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
    return;
  }
  if (CACHE_STATIC && url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
  }
});

// payload: { title, body, href, tag } (encrypted end to end; see src/server/push)
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = typeof data.title === "string" && data.title ? data.title : "New notification";
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === "string" ? data.body : "",
    tag: typeof data.tag === "string" ? data.tag : undefined,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { href: typeof data.href === "string" ? data.href : "/orgs" },
  }));
});

// opens the notification's page in this app only (same origin), reusing an open window when there is one
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data && event.notification.data.href ? event.notification.data.href : "/orgs", self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    for (const w of windows) {
      if (w.url.startsWith(self.location.origin) && "focus" in w) return w.navigate(target.href).then((c) => (c || w).focus());
    }
    return self.clients.openWindow(target.href);
  }));
});
