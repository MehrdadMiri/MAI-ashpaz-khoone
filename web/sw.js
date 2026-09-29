// Shell cache for installability. Recipe generation and fridge vision stay on
// the network (/api/ is never intercepted). The GapGPT key is not in this file.

const CACHE = "ashpaz-shell-v2";

const SHELL = [
  "/",
  "/index.html",
  "/pantry.css",
  "/household.js",
  "/pantry.js",
  "/fridge.js",
  "/recipes.js",
  "/plan.js",
  "/shop.js",
  "/persist.js",
  "/pwa.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/fonts/vazirmatn-arabic-400.woff2",
  "/fonts/vazirmatn-arabic-600.woff2",
  "/fonts/vazirmatn-arabic-700.woff2",
  "/fonts/vazirmatn-latin-400.woff2",
  "/fonts/vazirmatn-latin-600.woff2",
  "/fonts/vazirmatn-latin-700.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function cacheable(pathname) {
  return SHELL.includes(pathname);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/health" || url.pathname === "/sw.js") return;
  if (!cacheable(url.pathname)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && response.type === "basic") {
          const type = response.headers.get("content-type") || "";
          const html = type.includes("text/html");
          const document = url.pathname === "/" || url.pathname === "/index.html";
          if (!html || document) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          const shell = await caches.match("/index.html");
          if (shell) return shell;
        }
        return new Response("", { status: 504, statusText: "offline" });
      })
  );
});
