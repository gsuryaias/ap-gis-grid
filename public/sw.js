/* AP-TRANSCO Grid Atlas service worker — offline-capable, freshness-first for network data.
 *
 *  - Hashed build assets (/assets/*)        → cache-first (immutable).
 *  - App shell (navigations, index.html)    → network-first, cached fallback (offline).
 *  - Network data (/data/*.json|geojson)    → stale-while-revalidate, so the map opens instantly
 *    and a fresh live-sync deploy is picked up in the background (live-status.json is always
 *    network-first so the "Live" badge never lies).
 *  - Basemap tiles / glyphs (CARTO, Esri)   → stale-while-revalidate in a size-capped cache, so
 *    places you've viewed keep a basemap in the field with poor connectivity.
 * Bump VERSION to invalidate everything.
 */
const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const ASSETS = `assets-${VERSION}`;
const DATA = `data-${VERSION}`;
const TILES = `tiles-${VERSION}`;
const TILE_MAX = 1500;
const SCOPE = self.registration.scope; // e.g. https://host/ap-gis-grid/

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll([SCOPE, `${SCOPE}manifest.webmanifest`, `${SCOPE}favicon.svg`])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  const keep = new Set([SHELL, ASSETS, DATA, TILES]);
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

async function trim(cacheName, max) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

async function networkFirst(req, cacheName) {
  const c = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = (await c.match(req)) || (req.mode === "navigate" ? await c.match(SCOPE) : undefined);
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(req, cacheName) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) c.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(event, req, cacheName, max) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  const update = fetch(req)
    .then((res) => {
      if (res.ok || res.type === "opaque") {
        c.put(req, res.clone());
        if (max) trim(cacheName, max);
      }
      return res;
    })
    .catch(() => hit);
  if (hit) {
    event.waitUntil(update);
    return hit;
  }
  return update;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.href.startsWith(SCOPE)) {
    const path = url.pathname.slice(new URL(SCOPE).pathname.length);
    if (req.mode === "navigate") return event.respondWith(networkFirst(req, SHELL));
    if (path.startsWith("assets/")) return event.respondWith(cacheFirst(req, ASSETS));
    if (path === "data/live-status.json") return event.respondWith(networkFirst(req, DATA));
    if (path.startsWith("data/")) return event.respondWith(staleWhileRevalidate(event, req, DATA));
    return event.respondWith(networkFirst(req, SHELL));
  }

  // Basemap tiles, styles and glyphs.
  if (/(basemaps\.cartocdn\.com|tiles\.basemaps\.cartocdn\.com|arcgisonline\.com)$/.test(url.hostname)) {
    return event.respondWith(staleWhileRevalidate(event, req, TILES, TILE_MAX));
  }
  // Everything else (weather APIs, radar, GDACS) is live — let the network handle it.
});
