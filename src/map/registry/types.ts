// Layer registry types (Atlas 2.0 phase 1.4). A `LayerDef` declares a map layer group — its
// source, its style layers, which z-band it lives in, and (as pure functions of state) whether it
// is visible and what its dynamic filter / paint are. The engine (`map/engine.ts`) mounts and
// reconciles defs; nothing else mutates their layers.
import type { LayerSpecification, SourceSpecification } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { MapSpec } from "../spec.ts";

/**
 * Z-bands, bottom → top. Each band is closed by an empty sentinel layer; a def's layers sit inside
 * its band. Until the core grid joins the registry (phase 1.5) the sentinels are anchored to it:
 * `beneath` < grid lines < `grid` < `above-grid` < grid substations … < `top` (always topmost).
 */
export type Band = "beneath" | "grid" | "above-grid" | "top";
export const BANDS: readonly Band[] = ["beneath", "grid", "above-grid", "top"];

export type SourceSpec<S> =
  /** Data from a lazy resource; the def mounts once it has loaded (`undefined` = not yet). */
  | { kind: "geojson"; id: string; data: () => FeatureCollection | undefined; options?: Partial<SourceSpecification> }
  /** Data derived from state; `setData` runs whenever `key(s)` changes. */
  | { kind: "computed"; id: string; data: (s: S) => FeatureCollection; key: (s: S) => string }
  /** Reuse another def's source; the def mounts once that source exists. */
  | { kind: "ride"; on: string };

export interface LayerDef<S> {
  id: string;
  band: Band;
  source: SourceSpec<S>;
  /** The style layers (built when mounted; a style reload re-mounts with the then-current state). */
  layers: (s: S) => LayerSpecification[];
  /** A hidden def is not mounted until it is first shown; once mounted it is only hidden. */
  visible: (s: S) => boolean;
  /** Dynamic per-layer state (filter / paint), applied conditionally. Visibility comes from `visible`. */
  spec?: (s: S) => MapSpec;
}

export const sourceIdOf = <S>(def: LayerDef<S>): string => (def.source.kind === "ride" ? def.source.on : def.source.id);
