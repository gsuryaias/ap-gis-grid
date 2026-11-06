// Overlay data resources. Deliberately independent of the store: an overlay's definition is
// either static (DISCOM / 11 kV / towers) or comes from the RTGS catalogue, so the loader never
// needs to read state (and the store can import this module without a cycle).
//
// Heavy layers are drawn from static vector tiles when `public/tiles/index.json` lists them
// (`npm run build:tiles`, built in CI); anything else — and every layer in a dev checkout without
// tiles — falls back to its GeoJSON. Attributes always come from JSON: the sharded sidecars of a
// tiled id-keyed layer, else the layer's own file.
import type { Feature, FeatureCollection } from "geojson";
import { DISCOM11_DEF, DISCOM_DEFS, refDef, TOWER_DEFS, type OverlayDef, type RefCatalogEntry } from "./catalog.ts";
import { rowsPath, shardOf, tilePath, type TileIndex, type TileInfo } from "./tiles-core.ts";
import { decodeTowers, type WebTowersFile } from "./towers.ts";
import { dataUrl, defineResource, fetchJson, HttpError, isTransient } from "../data/resources.ts";
import { isAbort } from "../data/fetch.ts";

/** Overlay defs known without any fetch. */
export const STATIC_OVERLAY_DEFS: Record<string, OverlayDef> = Object.fromEntries(
  [...DISCOM_DEFS, DISCOM11_DEF, ...TOWER_DEFS].map((d) => [d.id, d]),
);

/** RTGS reference-layer catalogue (public/data/ref/catalog.json). */
export const refCatalog = defineResource<RefCatalogEntry[]>("ref-catalog", {
  load: (_p, signal) => fetchJson<RefCatalogEntry[]>(dataUrl("ref/catalog.json"), signal),
});

async function overlayDef(id: string): Promise<OverlayDef> {
  const known = STATIC_OVERLAY_DEFS[id];
  if (known) return known;
  const entry = (await refCatalog.ensure()).find((e) => e.id === id);
  if (!entry) throw new Error(`unknown overlay "${id}"`);
  return refDef(entry);
}

/**
 * A site-relative asset path → absolute URL (MapLibre fetches tiles from a worker). The path is
 * appended verbatim: `new URL()` would percent-encode a tile template's `{z}/{x}/{y}`.
 */
export const siteUrl = (path: string): string => new URL(import.meta.env.BASE_URL, globalThis.location?.href ?? "http://localhost/").href + path;

const EMPTY_INDEX: TileIndex = { generatedAt: "", layers: {} };

/**
 * Which layers have tiles. A missing index (dev without `build:tiles`) is not an error — it means
 * "no tiles": every layer then draws from GeoJSON.
 */
export const tileIndex = defineResource<TileIndex>("tile-index", {
  load: async (_p, signal) => {
    try {
      const idx = await fetchJson<TileIndex>(siteUrl("tiles/index.json"), signal);
      return idx && typeof idx.layers === "object" ? idx : EMPTY_INDEX;
    } catch (e) {
      // Network blips / 5xx retry (and surface); a 404 (Pages) or Vite's dev server answering an
      // unknown path with index.html (a JSON parse error) just means "no tiles here".
      if (isTransient(e) || isAbort(e) || (e instanceof HttpError && e.status !== 404)) throw e;
      return EMPTY_INDEX;
    }
  },
});

/**
 * One overlay layer's full features, by overlay id — the single fetch for every consumer that needs
 * the whole file (the GeoJSON fallback on the map, the tower / RTGS Inspector, the DISCOM download).
 * Towers ship grouped by line and are decoded to GeoJSON here.
 */
export const overlayLayer = defineResource<FeatureCollection>("overlay", {
  load: async (id, signal) => {
    const def = await overlayDef(id);
    const json = await fetchJson<FeatureCollection | WebTowersFile>(dataUrl(def.file), signal);
    return def.format === "towers" ? decodeTowers(id, json as WebTowersFile) : (json as FeatureCollection);
  },
});

/** What the map draws a layer from: its tiles (nothing else downloaded) or its whole GeoJSON. */
export type OverlayView = { kind: "tiles"; info: TileInfo; url: string } | { kind: "geojson"; fc: FeatureCollection };

export const overlayView = defineResource<OverlayView>("overlay-view", {
  load: async (id, signal) => {
    const info = (await tileIndex.ensure()).layers[id];
    if (info) return { kind: "tiles", info, url: siteUrl(tilePath(id, info)) };
    return { kind: "geojson", fc: await overlayLayer.ensure(id, { signal }) };
  },
});

/** One attribute-sidecar shard of a tiled layer (param `<layer>/<shard>`). */
const rowShard = defineResource<FeatureCollection>("overlay-rows", {
  load: async (param, signal) => {
    const cut = param.lastIndexOf("/");
    const layer = param.slice(0, cut);
    const info = (await tileIndex.ensure()).layers[layer];
    if (!info) throw new Error(`no tiles for "${layer}"`);
    return fetchJson<FeatureCollection>(siteUrl(rowsPath(layer, Number(param.slice(cut + 1)), info)), signal);
  },
});

export const rowKey = (layer: string, id: string) => `${layer}\n${id}`;

/**
 * One feature (full attributes + geometry) of an id-keyed overlay layer (param `rowKey(layer, id)`),
 * or null when it isn't there. Reads only that feature's sidecar shard when the layer is tiled, else
 * the layer's whole GeoJSON (the dev fallback — the map has usually loaded it anyway).
 */
export const featureRow = defineResource<Feature | null>("overlay-row", {
  load: async (param, signal) => {
    const [layer, id] = param.split("\n");
    const info = (await tileIndex.ensure()).layers[layer];
    const fc = info?.shards
      ? await rowShard.ensure(`${layer}/${shardOf(id, info.shards)}`, { signal })
      : await overlayLayer.ensure(layer, { signal });
    return fc.features.find((f) => f.properties?.id === id || f.id === id) ?? null;
  },
});

/** Several features of one id-keyed layer (downloads) — only the shards they live in when tiled. */
export async function featureRows(layer: string, ids: Iterable<string>): Promise<Feature[]> {
  const want = new Set(ids);
  const info = (await tileIndex.ensure()).layers[layer];
  const fcs = info?.shards
    ? await Promise.all([...new Set([...want].map((id) => shardOf(id, info.shards)))].map((k) => rowShard.ensure(`${layer}/${k}`)))
    : [await overlayLayer.ensure(layer)];
  return fcs.flatMap((fc) => fc.features.filter((f) => want.has(String(f.properties?.id))));
}
