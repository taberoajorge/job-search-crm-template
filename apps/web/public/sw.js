// Static assets only. Authenticated API traffic never enters this cache.
const CACHE = "crm-static-v2";
const STATIC_ASSETS = [
  "/",
  "/icon.svg",
  "/icon-180.png",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest",
  "/appearance.js",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .catch(async (error) => {
        await caches.delete(CACHE);
        throw error;
      }),
  );
  // Activate after existing clients close, keeping their versioned shell consistent.
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("crm-static-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    (!event.request.mode.includes("navigate") &&
      !/^\/assets\//.test(url.pathname) &&
      !STATIC_ASSETS.includes(url.pathname))
  )
    return;
  // Hashed /assets/ files never change: serve them from cache without a network round trip.
  if (/^\/assets\//.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then(
        async (cache) =>
          // Precached copies were stored without the Origin a module request sends (Vary: Origin).
          (await cache.match(event.request, { ignoreVary: true })) ||
          fetch(event.request).then((response) => {
            if (response.ok && response.type === "basic")
              event.waitUntil(cache.put(event.request, response.clone()));
            return response;
          }),
      ),
    );
    return;
  }
  // Every navigation returns the same SPA shell: keep it under "/" only, so record, consent and
  // callback query strings never become cache keys that outlive logout.
  const key = event.request.mode === "navigate" ? "/" : event.request;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const clone = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(key, clone)));
        }
        return response;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE);
        return (
          (await cache.match(event.request, { ignoreVary: true })) ||
          (event.request.mode === "navigate" ? await cache.match("/") : undefined) ||
          Response.error()
        );
      }),
  );
});
self.addEventListener("push", (event) => {
  // Ignore server-provided content: device notifications remain generic and private.
  let tag = "crm-task-completion";
  try {
    const candidate = event.data?.json()?.tag;
    if (/^crm-task-[\da-f-]{36}$/i.test(candidate)) tag = candidate;
  } catch {}
  event.waitUntil(
    self.registration.showNotification("Job Search CRM", {
      body: "Una tarea terminó. Abre tu CRM para revisar el resultado.",
      icon: "/icon.svg",
      tag,
      data: { url: "/?screen=settings" },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const client = clients.find((client) => new URL(client.url).origin === self.location.origin);
      if (client) {
        await client.focus();
        client.postMessage({ type: "crm-task-completed" });
      } else await self.clients.openWindow("/?screen=settings");
    }),
  );
});
