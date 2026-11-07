// Content versions for site data (Atlas 2.0 phase 4 PR 13) — the pure contract shared by the build
// (`scripts/data-versions.ts`, injected by `scripts/vite-sw.ts`), the app (`dataUrl`) and the service worker.
//
// Every `public/data/*` file (and `tiles/index.json`) is fetched as `<path>?v=<content hash>` in a
// production build, so a URL names exactly one version of a file: the service worker can serve it
// cache-first, and the first view after a deploy can never mix new code with stale data. `live-status.json`
// is the exception — it is polled to detect newer deploys, so it stays unversioned and network-first.
// The ~380 DTR search shards share one version (they are regenerated together by `sync:network`), which
// keeps the injected map small.

/** Site-relative path (or group key) → content hash. Empty in dev / tests: URLs stay unversioned. */
export type DataVersions = Record<string, string>;

/** Paths that are never versioned. */
export const UNVERSIONED: ReadonlySet<string> = new Set(["data/live-status.json"]);

const DTR_SHARD = /^data\/net-dtr-[^/]+\.json$/;

/** The key a site-relative path's version is stored under. */
export const versionKey = (path: string): string => (DTR_SHARD.test(path) ? "data/net-dtr-*" : path);

/** `?v=<hash>` for a site-relative path, or "" when the build has no version for it. */
export function versionQuery(path: string, versions: DataVersions): string {
  if (UNVERSIONED.has(path)) return "";
  const v = versions[versionKey(path)];
  return v ? `?v=${v}` : "";
}

/** Is `url` (absolute) a versioned site asset whose version is no longer the current one? */
export function isStaleVersion(url: string, scope: string, versions: DataVersions): boolean {
  if (!url.startsWith(scope)) return false;
  const u = new URL(url);
  const v = u.searchParams.get("v");
  if (!v) return false;
  const path = u.pathname.slice(new URL(scope).pathname.length);
  return versions[versionKey(path)] !== v;
}
