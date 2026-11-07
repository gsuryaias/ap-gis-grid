// Field offline packs (Atlas 2.0 phase 4 PR 14) — download, list, update and delete circle packs.
//
// Everything lands in ONE Cache API cache (`OFFLINE_CACHE`, never LRU-trimmed) that the service worker
// falls back to whenever its own caches miss. Packs share entries (the statewide files), so an index —
// stored in the same cache, so the browser evicts both together — records each pack's URLs; deleting a
// pack deletes only what no other pack references. The page downloads (progress, cancel) with an
// `x-apgg-pack` header so the worker steps aside instead of copying every tile into its LRU caches too.
// Content-versioned URLs make "update" incremental: a re-save fetches only URLs the pack doesn't hold yet,
// then drops the superseded ones.
import { useSyncExternalStore } from "react";
import { defineResource } from "../data/resources.ts";
import { DATA_VERSIONS, fetchJson } from "../data/fetch.ts";
import { tileListPath, type TileList } from "../overlays/tiles-core.ts";
import type { GridData } from "../data/types.ts";
import { refCatalog, siteUrl, STATIC_OVERLAY_DEFS, tileIndex } from "../overlays/resources.ts";
import { refDef } from "../overlays/catalog.ts";
import { OFFLINE_CACHE, PACK_HEADER } from "../sw/policy.ts";
import { BASEMAPS } from "../map/basemaps.ts";
import type { Basemap } from "../state/types.ts";
import { circleBBox, glyphUrls, packPlan, PACK_LAYERS, styleExtras } from "./plan.ts";

export interface PackRecord {
  circle: string;
  savedAt: string;
  /** Absolute URLs this pack holds. */
  urls: string[];
  /** URLs that don't exist (empty tiles are never written) — not re-tried until their version changes. */
  missing: string[];
  /** URLs that failed to download (network) — the pack is incomplete. */
  failed: number;
}

interface PackIndex {
  v: 1;
  /** Bytes of every stored URL. */
  sizes: Record<string, number>;
  packs: Record<string, PackRecord>;
}

const INDEX_URL = () => siteUrl("__offline/index.json");
const EMPTY: PackIndex = { v: 1, sizes: {}, packs: {} };

/** Packs need the Cache API and a service worker controlling the page (it serves them offline). */
export const offlineSupported = (): boolean => typeof caches !== "undefined" && typeof navigator !== "undefined" && !!navigator.serviceWorker?.controller;

/** `offlineSupported()`, live: the first visit's worker takes control a moment after load. */
export function useOfflineSupported(): boolean {
  return useSyncExternalStore(
    (l) => {
      const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
      sw?.addEventListener("controllerchange", l);
      return () => sw?.removeEventListener("controllerchange", l);
    },
    offlineSupported,
  );
}

async function readIndex(): Promise<PackIndex> {
  if (typeof caches === "undefined") return EMPTY;
  try {
    // `caches.match` with a cacheName never creates the cache (`caches.open` would, after a delete).
    const r = await caches.match(INDEX_URL(), { cacheName: OFFLINE_CACHE });
    const j = r ? ((await r.json()) as PackIndex) : null;
    return j?.v === 1 ? j : { ...EMPTY, sizes: {}, packs: {} };
  } catch {
    return { ...EMPTY, sizes: {}, packs: {} };
  }
}

async function writeIndex(idx: PackIndex): Promise<void> {
  await (await caches.open(OFFLINE_CACHE)).put(INDEX_URL(), new Response(JSON.stringify(idx), { headers: { "content-type": "application/json" } }));
}

/** What a circle's pack should hold right now (absolute URLs), from the loaded grid + this build's tiles. */
export async function planUrls(data: GridData, circle: string, basemap: Basemap, enabled: readonly string[], signal?: AbortSignal): Promise<string[]> {
  const bbox = circleBBox(data.substations, circle);
  if (!bbox) throw new Error(`unknown circle "${circle}"`);
  const [index, catalog] = await Promise.all([tileIndex.ensure(), refCatalog.ensure().catch(() => [])]);
  const refs = new Map(catalog.map((e) => [e.id, e]));
  const fileOf = (id: string) => {
    const def = STATIC_OVERLAY_DEFS[id] ?? (refs.get(id) ? refDef(refs.get(id)!) : undefined);
    return def ? { file: def.file, towers: def.format === "towers" } : undefined;
  };
  const layers = [...new Set([...PACK_LAYERS, ...enabled])];
  // Which tiles exist, so empty ones (never written — each would be a 404 page) aren't requested.
  const lists = Object.fromEntries(
    await Promise.all(
      layers.filter((id) => index.layers[id]).map(async (id) => [id, await fetchJson<TileList>(siteUrl(tileListPath(id, index.layers[id])), signal).catch(() => undefined)] as const),
    ),
  );
  const plan = packPlan({ bbox, index, layers, fileOf, versions: DATA_VERSIONS, lists });
  const urls = [...plan.files, ...plan.tiles].map(siteUrl);
  // Basemap: the style + sprites + the app's label glyphs (no third-party tiles — see plan.ts).
  const style = BASEMAPS[basemap].style;
  if (typeof style === "string") {
    try {
      const json = (await (await fetch(style, { signal })).json()) as { sprite?: unknown; glyphs?: unknown };
      urls.push(...styleExtras(style, json));
    } catch {
      /* offline / blocked — the pack still works over a blank background */
    }
  } else if (typeof style.glyphs === "string") urls.push(...glyphUrls(style.glyphs));
  return [...new Set(urls)];
}

// ── The running job (one at a time), observable from React ───────────────────────────────────────
export interface PackJob {
  circle: string;
  done: number;
  total: number;
  bytes: number;
  failed: number;
  state: "running" | "done" | "cancelled" | "error";
  error?: string;
}

let job: PackJob | null = null;
let controller: AbortController | null = null;
const listeners = new Set<() => void>();
const emit = (next: PackJob | null) => {
  job = next;
  for (const l of listeners) l();
};

export function usePackJob(): PackJob | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => job,
  );
}

export function cancelPack(): void {
  controller?.abort();
}

/** Saved packs + how many of each pack's current URLs it lacks (0 = up to date). */
export const offlinePacks = defineResource<PackIndex>("offline-packs", { load: () => readIndex() });

/** URLs of `plan` the pack doesn't have yet (neither stored nor known-missing). */
export function staleCount(rec: PackRecord, plan: readonly string[]): number {
  const have = new Set([...rec.urls, ...rec.missing]);
  return plan.filter((u) => !have.has(u)).length;
}

const isTile = (url: string) => /\/tiles\/[^?]+\.pbf(\?|$)/.test(url);

/** Bytes of a pack's own vector tiles (the circle-specific part). */
export function packBytes(idx: PackIndex, rec: PackRecord): number {
  return rec.urls.reduce((s, u) => s + (isTile(u) ? (idx.sizes[u] ?? 0) : 0), 0);
}

/** Bytes of the statewide files every pack shares (stored once). */
export function sharedBytes(idx: PackIndex): number {
  const urls = new Set(Object.values(idx.packs).flatMap((p) => p.urls.filter((u) => !isTile(u))));
  let n = 0;
  for (const u of urls) n += idx.sizes[u] ?? 0;
  return n;
}

const CONCURRENCY = 6;

/** Download (or update) a circle's pack. Resolves when done, cancelled or failed; progress via `usePackJob`. */
export async function savePack(plan: readonly string[], circle: string): Promise<void> {
  if (job?.state === "running") return;
  controller = new AbortController();
  const { signal } = controller;
  const origin = location.origin;
  const cache = await caches.open(OFFLINE_CACHE);
  const idx = await readIndex();
  const stored = new Set((await cache.keys()).map((r) => r.url));
  const prev = idx.packs[circle];
  const knownMissing = new Set(prev?.missing ?? []);
  const todo = plan.filter((u) => !stored.has(u) && !knownMissing.has(u));
  let state: PackJob = { circle, done: plan.length - todo.length, total: plan.length, bytes: 0, failed: 0, state: "running" };
  emit(state);
  // Keep the browser from evicting the packs under storage pressure (best effort).
  void navigator.storage?.persist?.().catch(() => false);

  const planned = new Set(plan);
  const missing = new Set<string>([...knownMissing].filter((u) => planned.has(u)));
  const got = new Set<string>(plan.filter((u) => stored.has(u)));
  let next = 0;
  let lastEmit = 0;
  const worker = async () => {
    while (next < todo.length && !signal.aborted) {
      const url = todo[next++];
      try {
        const res = await fetch(url, { signal, headers: url.startsWith(origin) ? { [PACK_HEADER]: "1" } : undefined });
        if (res.ok) {
          const blob = await res.blob();
          // The body is already decoded: don't carry the transfer encoding / length over.
          const headers = new Headers(res.headers);
          headers.delete("content-encoding");
          headers.delete("content-length");
          await cache.put(url, new Response(blob, { status: res.status, headers }));
          idx.sizes[url] = blob.size;
          got.add(url);
          state = { ...state, bytes: state.bytes + blob.size };
        } else if (res.status === 404) missing.add(url);
        else state = { ...state, failed: state.failed + 1 };
      } catch {
        if (signal.aborted) break;
        state = { ...state, failed: state.failed + 1 };
      }
      state = { ...state, done: state.done + 1 };
      const now = Date.now();
      if (now - lastEmit > 120) {
        lastEmit = now;
        emit(state);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const urls = plan.filter((u) => got.has(u));
    idx.packs[circle] = { circle, savedAt: new Date().toISOString(), urls, missing: [...missing], failed: state.failed };
    await prune(cache, idx);
    await writeIndex(idx);
    emit({ ...state, state: signal.aborted ? "cancelled" : "done" });
  } catch (e) {
    emit({ ...state, state: "error", error: e instanceof Error ? e.message : String(e) });
  } finally {
    controller = null;
    void offlinePacks.refresh();
  }
}

/** Drop stored URLs no pack references any more (superseded versions, deleted packs). */
async function prune(cache: Cache, idx: PackIndex): Promise<void> {
  const keep = new Set(Object.values(idx.packs).flatMap((p) => p.urls));
  keep.add(INDEX_URL());
  for (const req of await cache.keys()) {
    if (keep.has(req.url)) continue;
    await cache.delete(req);
    delete idx.sizes[req.url];
  }
}

export async function deletePack(circle: string): Promise<void> {
  const idx = await readIndex();
  delete idx.packs[circle];
  if (!Object.keys(idx.packs).length) await caches.delete(OFFLINE_CACHE);
  else {
    const cache = await caches.open(OFFLINE_CACHE);
    await prune(cache, idx);
    await writeIndex(idx);
  }
  if (job?.circle === circle && job.state !== "running") emit(null);
  await offlinePacks.refresh();
}

export function dismissPackJob(): void {
  if (job?.state !== "running") emit(null);
}
