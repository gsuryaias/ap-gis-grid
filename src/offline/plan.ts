// Field offline pack (Atlas 2.0 phase 4 PR 14) — what "Save circle for offline" downloads. Pure, unit-tested.
//
// A pack = the circle's vector tiles (every zoom the tiles exist at; MapLibre over-zooms the deepest one)
// for the Field layers + 11 kV + roads / rail / mandals for context + whatever overlay is on, plus the
// statewide files those layers need offline: the core grid, the attribute sidecars (they are sharded by id,
// not by place, so all of them), tower files (Inspector), search tiers and the basemap style / glyphs.
// Third-party basemap TILES are not bulk-downloaded (their terms don't allow it): the places already
// viewed stay in the worker's basemap cache, and the RTGS roads / rail / mandals give context offline.
import { rowsPath, tileKey, tilePath, type TileIndex, type TileList } from "../overlays/tiles-core.ts";
import { versionQuery, type DataVersions } from "../data/data-version.ts";
import { LENS_BY_ID } from "../lenses/registry.ts";

export type BBox = [number, number, number, number]; // [w, s, e, n]

/** Layers every pack carries (beyond the core grid): Field's defaults, 11 kV, and offline context. */
export const PACK_LAYERS: readonly string[] = [
  ...(LENS_BY_ID.field.defaults.overlays ?? []),
  "discom-11kv-lines",
  "national-highways",
  "state-highways",
  "railways",
  "mandals",
  "mandal-hq",
];

/** Statewide data files every pack carries (site-relative under data/). */
export const PACK_FILES: readonly string[] = [
  "substations.geojson",
  "lines.geojson",
  "meta.json",
  "data-quality.json",
  "search-index.json",
  "live-status.json",
  "transco-33kv.json",
  "places.json",
  "search-network.json",
  "generation.geojson",
  "powergrid-lines.geojson",
  "powergrid-ss.geojson",
  "railway-ss.geojson",
  "bulkload-ss.geojson",
  "ref/catalog.json",
];

/** Glyph ranges the app's own labels ("Open Sans Bold") use: Latin, Latin-ext, punctuation. */
export const PACK_FONT = "Open Sans Bold";
export const PACK_GLYPH_RANGES = ["0-255", "256-511", "8192-8447"];

/** Slippy-map tile of a point at zoom z. */
export function tileOf(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}

/** Every tile at zoom z covering a bbox, as [x, y]. */
export function tilesIn(b: BBox, z: number): [number, number][] {
  const [x0, y0] = tileOf(b[0], b[3], z); // north-west
  const [x1, y1] = tileOf(b[2], b[1], z); // south-east
  const out: [number, number][] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y]);
  return out;
}

export function intersect(a: BBox, b: BBox): BBox | null {
  const r: BBox = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[0] <= r[2] && r[1] <= r[3] ? r : null;
}

/**
 * A circle's extent: its substations, padded (~17 km at 0.15°) so the network around them comes too.
 * (Lines are left out: a circle's 400 kV corridors run far beyond it.) Null for a circle with no substations.
 */
export function circleBBox(substations: readonly { circle?: string | null; lng: number; lat: number }[], circle: string, pad = 0.15): BBox | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const ss of substations) {
    if (ss.circle !== circle) continue;
    w = Math.min(w, ss.lng);
    e = Math.max(e, ss.lng);
    s = Math.min(s, ss.lat);
    n = Math.max(n, ss.lat);
  }
  if (!Number.isFinite(w)) return null;
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return [r(w - pad), r(s - pad), r(e + pad), r(n + pad)];
}

export interface PackInput {
  bbox: BBox;
  index: TileIndex;
  /** Overlay ids to carry (tiled ⇒ tiles in the bbox + sidecars; else their whole file). */
  layers: readonly string[];
  /** Overlay id → its data file (`OverlayDef.file`); `towers` format files are also needed by the Inspector. */
  fileOf: (layer: string) => { file: string; towers?: boolean } | undefined;
  versions: DataVersions;
  /** Per layer, the tiles that exist (`<layer>/tiles.json`) — without one, every tile in the box is tried. */
  lists?: Record<string, TileList | undefined>;
}

export interface PackPlan {
  /** Site-relative paths (with their `?v=`): tiles + sidecar shards. */
  tiles: string[];
  /** Site-relative paths (with their `?v=`): data files + tiles/index.json. */
  files: string[];
}

/** Everything a circle pack downloads from the site (the basemap style is added by the runner). */
export function packPlan(p: PackInput): PackPlan {
  const tiles: string[] = [];
  const files = new Set<string>(PACK_FILES.map((f) => `data/${f}${versionQuery(`data/${f}`, p.versions)}`));
  files.add(`tiles/index.json${versionQuery("tiles/index.json", p.versions)}`);
  for (const id of new Set(p.layers)) {
    const info = p.index.layers[id];
    const src = p.fileOf(id);
    if (info) {
      const box = intersect(p.bbox, info.bounds);
      if (box) {
        const tpl = tilePath(id, info);
        const list = p.lists?.[id];
        for (let z = info.minzoom; z <= info.maxzoom; z++) {
          const have = list ? new Set(list[z] ?? []) : null;
          for (const [x, y] of tilesIn(box, z))
            if (!have || have.has(tileKey(z, x, y))) tiles.push(tpl.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)));
        }
      }
      for (let k = 0; k < info.shards; k++) tiles.push(rowsPath(id, k, info));
      if (src?.towers) files.add(`data/${src.file}${versionQuery(`data/${src.file}`, p.versions)}`);
    } else if (src) {
      files.add(`data/${src.file}${versionQuery(`data/${src.file}`, p.versions)}`);
    }
  }
  return { tiles, files: [...files] };
}

/** Basemap style extras for offline: the style, its sprites and the app's label glyphs. */
export function styleExtras(styleUrl: string, style: { sprite?: unknown; glyphs?: unknown }): string[] {
  const out = [styleUrl];
  const sprites = typeof style.sprite === "string" ? [style.sprite] : Array.isArray(style.sprite) ? style.sprite.map((s: { url?: string }) => s?.url).filter((u): u is string => typeof u === "string") : [];
  for (const s of sprites) for (const suffix of ["", "@2x"]) for (const ext of [".json", ".png"]) out.push(`${s}${suffix}${ext}`);
  if (typeof style.glyphs === "string") out.push(...glyphUrls(style.glyphs));
  return out;
}

export function glyphUrls(template: string): string[] {
  return PACK_GLYPH_RANGES.map((r) => new URL(template.replace("{fontstack}", PACK_FONT).replace("{range}", r)).href);
}
