// Declarative map state (Atlas 2.0 phase 1.3).
//
// The dynamic part of every map layer — visibility, filter, paint overrides, feature-state — is
// described by PURE `…Spec(state)` functions (gridSpec, spotlightSpec, misThemeSpec, weather specs)
// that return plain data. Two small appliers bring a map in line with a spec, and both are
// CONDITIONAL: they read the map's current value back and write only on a difference. That matters
// because setFilter / setLayoutProperty / setPaintProperty all emit `styledata`, and the phase-1
// sync engine re-reconciles on `styledata` — an unconditional write would loop. Reading back from
// the map (rather than caching what was last written) also stays correct after `setStyle`, which
// re-adds layers with their default paint.
import type { Map as MlMap } from "maplibre-gl";

export type Visibility = "visible" | "none";

/** Desired dynamic state of one style layer. Anything left undefined is not managed. */
export interface LayerState {
  visibility?: Visibility;
  /** `null` = no filter. */
  filter?: unknown;
  paint?: Record<string, unknown>;
}

/** Desired state per style-layer id. Layers missing from the map are skipped (lazy overlays). */
export type MapSpec = Record<string, LayerState>;

/**
 * Desired feature-state on one source, for the `keys` this spec owns (other keys — hover,
 * selected — are left alone). A feature absent from `states` has every owned key removed.
 */
export type FeatureStateValue = number | boolean;
export interface FeatureStateSpec {
  source: string;
  keys: readonly string[];
  states: Record<string, Record<string, FeatureStateValue>>;
}

/** The slice of the MapLibre API the appliers need (lets tests drive them with a fake map). */
export type SpecMap = Pick<
  MlMap,
  | "getLayer"
  | "getSource"
  | "getFilter"
  | "setFilter"
  | "getLayoutProperty"
  | "setLayoutProperty"
  | "getPaintProperty"
  | "setPaintProperty"
  | "setFeatureState"
  | "removeFeatureState"
>;

/** Structural equality for style values (expressions are plain JSON). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Merge specs left to right: visibility / filter — last wins; paint — merged per property. */
export function mergeSpecs(...specs: MapSpec[]): MapSpec {
  const out: MapSpec = {};
  for (const spec of specs) {
    for (const [id, s] of Object.entries(spec)) {
      const cur = (out[id] ??= {});
      if (s.visibility !== undefined) cur.visibility = s.visibility;
      if (s.filter !== undefined) cur.filter = s.filter;
      if (s.paint) cur.paint = { ...cur.paint, ...s.paint };
    }
  }
  return out;
}

/** Bring the map's layers in line with `spec`; returns the number of writes made. */
export function applySpec(map: SpecMap, spec: MapSpec): number {
  let writes = 0;
  for (const [id, s] of Object.entries(spec)) {
    if (!map.getLayer(id)) continue;
    if (s.visibility !== undefined && (map.getLayoutProperty(id, "visibility") ?? "visible") !== s.visibility) {
      map.setLayoutProperty(id, "visibility", s.visibility);
      writes++;
    }
    if (s.filter !== undefined && !sameValue(map.getFilter(id), s.filter)) {
      map.setFilter(id, s.filter as Parameters<MlMap["setFilter"]>[1]);
      writes++;
    }
    if (s.paint) {
      for (const [prop, value] of Object.entries(s.paint)) {
        if (sameValue(map.getPaintProperty(id, prop), value)) continue;
        map.setPaintProperty(id, prop, value);
        writes++;
      }
    }
  }
  return writes;
}

interface FsRecord {
  /** The source instance the states were written to — a style reload replaces it (and drops them). */
  src: unknown;
  states: Record<string, Record<string, FeatureStateValue>>;
}
const fsRecords = new WeakMap<object, Map<string, FsRecord>>();

/**
 * Bring one source's feature-state (for the spec's own keys) in line with `spec`, diffing against
 * what this owner last wrote. A re-added source (after `setStyle`) starts from empty, so the whole
 * spec is re-applied. Returns the number of writes made.
 */
export function syncFeatureState(map: SpecMap, owner: string, spec: FeatureStateSpec): number {
  const recordKey = `${owner}\u0000${spec.source}`;
  let records = fsRecords.get(map);
  if (!records) fsRecords.set(map, (records = new Map()));
  const src = map.getSource(spec.source);
  if (!src) {
    records.delete(recordKey);
    return 0;
  }
  const prevRec = records.get(recordKey);
  const prev = prevRec && prevRec.src === src ? prevRec.states : {};
  let writes = 0;
  const target = { source: spec.source };

  for (const [id, old] of Object.entries(prev)) {
    const next = spec.states[id];
    for (const key of spec.keys) {
      if (old[key] == null || next?.[key] != null) continue;
      try {
        map.removeFeatureState({ ...target, id }, key);
      } catch {
        /* feature not present (mid style reload) */
      }
      writes++;
    }
  }
  for (const [id, next] of Object.entries(spec.states)) {
    const old = prev[id];
    const changed: Record<string, FeatureStateValue> = {};
    let any = false;
    for (const key of spec.keys) {
      if (next[key] != null && next[key] !== old?.[key]) {
        changed[key] = next[key];
        any = true;
      }
    }
    if (!any) continue;
    try {
      map.setFeatureState({ ...target, id }, changed);
    } catch {
      /* feature not present (mid style reload) */
    }
    writes++;
  }
  records.set(recordKey, { src, states: spec.states });
  return writes;
}
