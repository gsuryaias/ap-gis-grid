// Overlay data resources. Deliberately independent of the store: an overlay's definition is
// either static (DISCOM / 11 kV / towers) or comes from the RTGS catalogue, so the loader never
// needs to read state (and the store can import this module without a cycle).
import type { FeatureCollection } from "geojson";
import { DISCOM11_DEF, DISCOM_DEFS, refDef, TOWER_DEFS, type OverlayDef, type RefCatalogEntry } from "./catalog.ts";
import { decodeTowers, type WebTowersFile } from "./towers.ts";
import { dataUrl, defineResource, fetchJson } from "../data/resources.ts";

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
 * One overlay layer's features, by overlay id — the single fetch for both the map layer and any
 * other consumer (e.g. the DISCOM GeoJSON download), so a file is never downloaded twice.
 * Towers ship grouped by line and are decoded to GeoJSON here.
 */
export const overlayLayer = defineResource<FeatureCollection>("overlay", {
  load: async (id, signal) => {
    const def = await overlayDef(id);
    const json = await fetchJson<FeatureCollection | WebTowersFile>(dataUrl(def.file), signal);
    return def.format === "towers" ? decodeTowers(id, json as WebTowersFile) : (json as FeatureCollection);
  },
});
