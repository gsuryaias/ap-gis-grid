// Service-worker policy (Atlas 2.0 phase 4 PR 13) — pure and unit-tested; `sw.ts` wires it to events.
//
//   navigations                      network-first (4 s, then the cached shell) → shell-<build>
//   assets/* (hashed)                cache-first, precached per build            → assets-<build> (+ the previous build's)
//   data/*?v=… · tiles/index.json?v= cache-first (the URL names the content)     → data     (bounded LRU)
//   data/* without v (live-status)   network-first, cached fallback              → data
//   tiles/**?v=… (tiles + sidecars)  cache-first                                 → vtiles   (bounded LRU)
//   CARTO / Esri basemap             stale-while-revalidate                      → basemap  (bounded LRU)
//   Range requests, non-GET, everything else (weather APIs, radar, GDACS) → not handled (the network).

export type Strategy = "network-first" | "cache-first" | "stale-while-revalidate";
export type CacheId = "shell" | "assets" | "data" | "vtiles" | "basemap";
export type BoundedId = Extract<CacheId, "data" | "vtiles" | "basemap">;

export interface Route {
  strategy: Strategy;
  cache: CacheId;
  /** Navigation: give up on a slow network after this long when a cached copy exists. */
  timeoutMs?: number;
}

export interface Limits {
  maxEntries: number;
  maxBytes: number;
}

const MB = 1024 * 1024;

/**
 * Budgets of the LRU caches (≈ 220 MB worst case). A response bigger than a third of its cache's
 * byte budget is served but not cached (it would flush everything else).
 */
export const LIMITS: Record<BoundedId, Limits> = {
  data: { maxEntries: 800, maxBytes: 80 * MB },
  vtiles: { maxEntries: 6000, maxBytes: 60 * MB },
  basemap: { maxEntries: 2000, maxBytes: 80 * MB },
};

export const BOUNDED: readonly BoundedId[] = ["data", "vtiles", "basemap"];
export const isBounded = (id: CacheId): id is BoundedId => (BOUNDED as readonly string[]).includes(id);

export const NAV_TIMEOUT_MS = 4000;

const BASEMAP_HOST = /(^|\.)(basemaps\.cartocdn\.com|arcgisonline\.com)$/;

export interface RouteInput {
  url: string;
  method: string;
  mode?: string;
  /** The request carries a Range header. */
  range?: boolean;
}

/** How the service worker answers a request — null = let the network handle it. */
export function route(req: RouteInput, scope: string): Route | null {
  // Range requests (media, PMTiles-style readers) must reach the network untouched: a cached
  // full 200 is not a valid answer to them, and Pages' CDN slices gzip copies unpredictably.
  if (req.method !== "GET" || req.range) return null;
  const url = new URL(req.url);
  if (url.href.startsWith(scope)) {
    const path = url.pathname.slice(new URL(scope).pathname.length);
    if (req.mode === "navigate") return { strategy: "network-first", cache: "shell", timeoutMs: NAV_TIMEOUT_MS };
    if (path.startsWith("assets/")) return { strategy: "cache-first", cache: "assets" };
    const versioned = url.searchParams.has("v");
    if (path.startsWith("data/") || path === "tiles/index.json") return { strategy: versioned ? "cache-first" : "network-first", cache: "data" };
    if (path.startsWith("tiles/")) return { strategy: versioned ? "cache-first" : "network-first", cache: "vtiles" };
    return { strategy: "network-first", cache: "shell" };
  }
  if (BASEMAP_HOST.test(url.hostname)) return { strategy: "stale-while-revalidate", cache: "basemap" };
  return null;
}

export interface Entry {
  url: string;
  bytes: number;
  /** Last use (ms). */
  t: number;
}

/**
 * Least-recently-used entries to drop once a cache exceeds its count or byte budget. Trims to 90 %
 * of both, so a full cache isn't re-trimmed on every put.
 */
export function evictionPlan(entries: readonly Entry[], lim: Limits, low = 0.9): string[] {
  let n = entries.length;
  let bytes = entries.reduce((s, e) => s + e.bytes, 0);
  if (n <= lim.maxEntries && bytes <= lim.maxBytes) return [];
  const out: string[] = [];
  for (const e of [...entries].sort((a, b) => a.t - b.t)) {
    if (n <= lim.maxEntries * low && bytes <= lim.maxBytes * low) break;
    out.push(e.url);
    n--;
    bytes -= e.bytes;
  }
  return out;
}

export const tooBigToCache = (bytes: number, lim: Limits): boolean => bytes > lim.maxBytes / 3;

/** Cache names: the shell and assets are per build; the LRU caches persist across builds. */
export function cacheNames(build: string) {
  return { shell: `shell-${build}`, assets: `assets-${build}`, data: "data", vtiles: "vtiles", basemap: "basemap", meta: "sw-meta" } as const;
}

/**
 * Caches to delete on activate: anything not current — except the newest previous `assets-*`, so a
 * tab still running the previous build can lazy-load its chunks after the deploy replaced them.
 * `keys` is in creation order (CacheStorage keeps insertion order).
 */
export function cachesToDelete(keys: readonly string[], build: string): string[] {
  const n = cacheNames(build);
  const prevAssets = keys.filter((k) => k.startsWith("assets-") && k !== n.assets).at(-1);
  const keep = new Set<string>([n.shell, n.assets, n.data, n.vtiles, n.basemap, n.meta, ...(prevAssets ? [prevAssets] : [])]);
  return keys.filter((k) => !keep.has(k));
}
