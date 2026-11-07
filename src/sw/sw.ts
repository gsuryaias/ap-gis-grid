// AP-TRANSCO Grid Atlas service worker (Atlas 2.0 phase 4 PR 13). Bundled to `dist/sw.js` by
// `scripts/vite-sw.ts` (IIFE, production builds only) with the build constants below injected.
// Routing and budgets live in `policy.ts`, the LRU caches in `bounded-cache.ts` — both unit-tested.
import { BoundedCache } from "./bounded-cache.ts";
import { cacheNames, cachesToDelete, isBounded, LIMITS, PACK_HEADER, route, type BoundedId, type Route } from "./policy.ts";
import { isStaleVersion, type DataVersions } from "../data/data-version.ts";

/** Hash of this build's asset list + data versions — names the per-build caches. */
declare const __SW_BUILD__: string;
/** Every hashed `assets/*` file of this build (site-relative). */
declare const __SW_PRECACHE__: string[];
declare const __DATA_VERSIONS__: DataVersions;

// Minimal service-worker typings (the project compiles against the DOM lib, not WebWorker).
interface SwEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface SwFetchEvent extends SwEvent {
  readonly request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface SwGlobal {
  readonly registration: { readonly scope: string };
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", fn: (e: SwEvent) => void): void;
  addEventListener(type: "fetch", fn: (e: SwFetchEvent) => void): void;
}

const sw = self as unknown as SwGlobal;
const SCOPE = sw.registration.scope; // e.g. https://host/ap-gis-grid/
const NAMES = cacheNames(__SW_BUILD__);
const SHELL_FILES = ["", "manifest.webmanifest", "favicon.svg", "icon-maskable.svg"];

const bounded: Record<BoundedId, BoundedCache> = {
  data: lru("data"),
  vtiles: lru("vtiles"),
  basemap: lru("basemap"),
};
function lru(id: BoundedId): BoundedCache {
  return new BoundedCache(caches, NAMES[id], LIMITS[id], { metaCache: NAMES.meta, metaKey: `${SCOPE}__sw/lru/${id}` });
}

sw.addEventListener("install", (event) => {
  event.waitUntil(install().then(() => sw.skipWaiting()));
});

async function install(): Promise<void> {
  // The shell must come from the network (not the HTTP cache) so it matches this build.
  const shell = await caches.open(NAMES.shell);
  await shell.addAll(SHELL_FILES.map((f) => new Request(SCOPE + f, { cache: "reload" })));
  // Precache every hashed asset — lazily-loaded lenses and dialogs then work offline too. Unchanged
  // chunks are copied from an earlier build's cache instead of downloaded again.
  const assets = await caches.open(NAMES.assets);
  const earlier = (await caches.keys()).filter((k) => k.startsWith("assets-") && k !== NAMES.assets);
  await Promise.all(
    __SW_PRECACHE__.map(async (path) => {
      const url = SCOPE + path;
      if (await assets.match(url)) return;
      for (const name of earlier) {
        const hit = await (await caches.open(name)).match(url);
        if (hit) return assets.put(url, hit);
      }
      try {
        const res = await fetch(url);
        if (res.ok) await assets.put(url, res);
      } catch {
        /* cached on first use instead */
      }
    }),
  );
}

sw.addEventListener("activate", (event) => {
  event.waitUntil(activate().then(() => sw.clients.claim()));
});

async function activate(): Promise<void> {
  await Promise.all(cachesToDelete(await caches.keys(), __SW_BUILD__).map((k) => caches.delete(k)));
  // Data this build no longer references (its content version changed) is dead weight.
  await bounded.data.purge((url) => isStaleVersion(url, SCOPE, __DATA_VERSIONS__));
}

sw.addEventListener("fetch", (event) => {
  const req = event.request;
  const r = route({ url: req.url, method: req.method, mode: req.mode, range: req.headers.has("range"), pack: req.headers.has(PACK_HEADER) }, SCOPE);
  if (!r) return;
  const store = storeFor(r.cache);
  const bg = new Background();
  const res = respond(req, r, store, bg);
  event.respondWith(res);
  // Keep the worker alive until the cache writes (and the LRU index save) behind this response finish.
  event.waitUntil(res.catch(() => undefined).then(() => bg.settle()).then(() => store.idle()));
});

/** Collects the background work (cache writes, revalidation) a response leaves behind. */
class Background {
  private readonly jobs: Promise<unknown>[] = [];
  add<T>(p: Promise<T>): Promise<T> {
    this.jobs.push(p);
    return p;
  }
  /** Waits for every job, including ones added while waiting. */
  async settle(): Promise<void> {
    let n: number;
    do {
      n = this.jobs.length;
      await Promise.allSettled(this.jobs.slice());
    } while (this.jobs.length !== n);
  }
}

/** A cache the strategies can read and write: a bounded LRU cache, or a plain per-build one. */
interface Store {
  match(req: Request | string): Promise<Response | undefined>;
  put(req: Request | string, res: Response): Promise<void>;
  idle(): Promise<void>;
}

/** The Field offline packs (written by the page) — the fallback of every store. */
const offlineMatch = (req: Request | string) => caches.match(req, { cacheName: NAMES.offline }); // never creates it

function storeFor(id: Route["cache"]): Store {
  if (isBounded(id)) {
    const b = bounded[id];
    return { match: async (req) => (await b.match(req)) ?? (await offlineMatch(req)), put: (req, res) => b.put(req, res), idle: () => b.idle() };
  }
  const name = NAMES[id];
  return {
    // Assets: any build's cache will do (hashed names) — a tab on the previous build finds its chunks.
    match: (req) => (id === "assets" ? caches.match(req) : caches.open(name).then((c) => c.match(req))),
    put: (req, res) => caches.open(name).then((c) => c.put(req, res)),
    idle: () => Promise.resolve(),
  };
}

function respond(req: Request, r: Route, store: Store, bg: Background): Promise<Response> {
  switch (r.strategy) {
    case "cache-first":
      return cacheFirst(req, store, bg);
    case "stale-while-revalidate":
      return staleWhileRevalidate(req, store, bg);
    case "network-first":
      return networkFirst(req, store, bg, r.timeoutMs);
  }
}

async function cacheFirst(req: Request, store: Store, bg: Background): Promise<Response> {
  const hit = await store.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) bg.add(store.put(req, res.clone()));
  return res;
}

async function networkFirst(req: Request, store: Store, bg: Background, timeoutMs?: number): Promise<Response> {
  const fallback = async () => (await store.match(req)) ?? (req.mode === "navigate" ? await store.match(SCOPE) : undefined);
  const network = bg.add(
    fetch(req).then((res) => {
      if (res.ok) bg.add(store.put(req, res.clone()));
      return res;
    }),
  );
  if (!timeoutMs) {
    try {
      return await network;
    } catch (e) {
      const hit = await fallback();
      if (hit) return hit;
      throw e;
    }
  }
  // Slow field network: after `timeoutMs`, answer from the cache if it has a copy (the network
  // response still lands in the cache for next time).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<Response | undefined>((resolve) => {
    timer = setTimeout(() => fallback().then(resolve, () => resolve(undefined)), timeoutMs);
  });
  try {
    const first = await Promise.race([network, slow]);
    if (first) return first;
    return await network;
  } catch (e) {
    const hit = await fallback();
    if (hit) return hit;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function staleWhileRevalidate(req: Request, store: Store, bg: Background): Promise<Response> {
  const hit = await store.match(req);
  const update = bg.add(
    fetch(req).then(
      (res) => {
        if (res.ok || res.type === "opaque") bg.add(store.put(req, res.clone()));
        return res;
      },
      () => hit ?? Response.error(),
    ),
  );
  return hit ?? update;
}
