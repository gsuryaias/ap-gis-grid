// Layer registry types (Atlas 2.0 phase 1). A `LayerDef` declares a map layer group — its source,
// its style layers, which z-band it lives in, how a tap / hover on it behaves, and (as pure
// functions of state) whether it is visible, its dynamic filter / paint and its feature-state.
// The engine (`map/engine.ts`) mounts and reconciles defs; the interaction handler
// (`map/interaction.ts`) reads `interaction`. Nothing else mutates their layers.
import type { LayerSpecification, MapGeoJSONFeature, SourceSpecification } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { FeatureStateSpec, MapSpec } from "../spec.ts";

/**
 * Z-bands, bottom → top, each closed by an empty sentinel layer; a def's layers sit inside its
 * band in listed order:
 *   beneath    — weather radar / cyclone fills, DISCOM + reference overlays, the focus highlight
 *   grid       — the transmission lines (+ the MIS line theme)
 *   above-grid — towers, the MIS substation rings (on the lines, under the dots)
 *   top        — substation dots + labels, plants, power grid, cyclone track, the focus pin
 */
export type Band = "beneath" | "grid" | "above-grid" | "top";
export const BANDS: readonly Band[] = ["beneath", "grid", "above-grid", "top"];

export type SourceSpec<S> =
  /** GeoJSON data from state or a lazy resource; the def mounts once it is there. */
  | { kind: "geojson"; id: string; data: (s: S) => FeatureCollection | undefined; options?: Partial<SourceSpecification> }
  /** GeoJSON derived from state; `setData` runs whenever `key(s)` changes. */
  | { kind: "computed"; id: string; data: (s: S) => FeatureCollection | undefined; key: (s: S) => string }
  /** Raster tiles; `setTiles` runs whenever the URL list changes. */
  | { kind: "raster"; id: string; tiles: (s: S) => string[] | undefined; options?: Record<string, unknown> }
  /** Reuse another def's source; the def mounts once that source exists. */
  | { kind: "ride"; on: string };

/** What a tap on a feature selects: an Inspector ref (`inspector/refs.ts`) + a label for "What's here". */
export type Pick = { ref: string; label: string } | null;

export interface Interaction {
  /** Lower wins: the best hit under a tap is selected, the rest are listed as "What's here". */
  priority: number;
  /** What the feature is, for the "What's here" list ("TRANSCO substation", "400 kV towers", …). */
  kind: string;
  /** The def's tappable layer ids. */
  layers: string[];
  /** Tap tolerance in px around the pointer (0 = exact point). */
  pad?: number;
  /** Hovering a feature highlights it (sets the store's hover id to its ref). */
  hover?: boolean;
  pick: (f: MapGeoJSONFeature) => Pick;
}

export interface LayerDef<S> {
  id: string;
  band: Band;
  source: SourceSpec<S>;
  /** The style layers — built when (re)mounted, so they may read the then-current state. */
  layers: (s: S) => LayerSpecification[];
  /** A hidden def is not mounted until first shown (ride defs mount with their source); once mounted it is only hidden. */
  visible: (s: S) => boolean;
  /**
   * Dynamic per-layer state (filter / paint / visibility within a visible def). Return the SAME
   * object for unchanged inputs (memoise) — the engine skips a def whose spec object is unchanged.
   */
  spec?: (s: S) => MapSpec;
  /** Feature-state this def owns (diffed per source). Memoise like `spec`. */
  featureState?: (s: S) => FeatureStateSpec[];
  interaction?: Interaction;
}

export const sourceIdOf = <S>(def: LayerDef<S>): string => (def.source.kind === "ride" ? def.source.on : def.source.id);

/** Single-entry memo by argument identity — keeps spec objects stable between reconciles. */
export function memo<A extends readonly unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  let last: { a: A; r: R } | null = null;
  return (...a: A) => {
    if (last && last.a.length === a.length && last.a.every((x, i) => x === a[i])) return last.r;
    const r = fn(...a);
    last = { a, r };
    return r;
  };
}
