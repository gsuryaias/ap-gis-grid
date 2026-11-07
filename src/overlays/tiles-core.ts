// Static vector-tile directories (Atlas 2.0 phase 4) — the pure contract shared by the tile build
// (`scripts/build-tiles.mts`) and the app. No DOM, no `import.meta.env`, so scripts can import it.
//
//   public/tiles/index.json                       TileIndex (absent ⇒ every layer falls back to GeoJSON)
//   public/tiles/<layer>/{z}/{x}/{y}.pbf          uncompressed MVT, one source-layer named <layer>
//   public/tiles/<layer>/tiles.json               TileList: which tiles exist (empty ones are never written) —
//                                                 read only by the Field offline pack planner
//   public/tiles/<layer>/rows/<shard>.json        attribute sidecar: full features (props + geometry),
//                                                 sharded by `shardOf(id)` — the Inspector, fly-to
//                                                 bounds and downloads read these, never clipped tiles
//
// Tiles are built in CI (and locally via Docker when present) and never committed.

export interface TileInfo {
  /** Tiles exist for z ∈ [minzoom, maxzoom]; MapLibre over-zooms above maxzoom. */
  minzoom: number;
  maxzoom: number;
  /** [w, s, e, n] — MapLibre requests no tile outside it. */
  bounds: [number, number, number, number];
  count: number;
  /** Content hash of the layer's input — cache-busts tile and sidecar URLs. */
  v: string;
  /** Number of attribute-sidecar shards (id-keyed layers only; 0 = no sidecar). */
  shards: number;
}

export interface TileIndex {
  generatedAt: string;
  layers: Record<string, TileInfo>;
}

/** FNV-1a (32-bit) of a string — a stable, dependency-free shard key. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The sidecar shard a feature id lives in. */
export const shardOf = (id: string, shards: number): number => (shards > 0 ? fnv1a(id) % shards : 0);

/** Path of a layer's tile template, relative to the site base (`{z}/{x}/{y}` left for MapLibre). */
export const tilePath = (layer: string, info: Pick<TileInfo, "v">): string => `tiles/${layer}/{z}/{x}/{y}.pbf?v=${info.v}`;

/** Path of one attribute-sidecar shard, relative to the site base. */
export const rowsPath = (layer: string, shard: number, info: Pick<TileInfo, "v">): string => `tiles/${layer}/rows/${shard}.json?v=${info.v}`;

/** The tiles a layer has, by zoom: `tileKey(z, x, y)` numbers, ascending. */
export type TileList = Record<string, number[]>;

/** A tile's number within its zoom (unique per z). */
export const tileKey = (z: number, x: number, y: number): number => x * 2 ** z + y;

/** Path of a layer's tile list, relative to the site base. */
export const tileListPath = (layer: string, info: Pick<TileInfo, "v">): string => `tiles/${layer}/tiles.json?v=${info.v}`;
