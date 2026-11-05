// The map sync engine (Atlas 2.0 phase 1.4): mounts registry `LayerDef`s and keeps the map in line
// with them. One `reconcile()` per animation frame, scheduled by store changes, `styledata` and
// `idle`. EVERY write is conditional — setFilter / setLayoutProperty / moveLayer / setData all emit
// `styledata` (or a render → `idle`), which re-schedules a reconcile, so an unconditional write
// would loop forever. A no-op reconcile therefore makes zero writes (tested in engine.test.ts).
//
// Z-order: four empty sentinel layers close the bands (`BANDS`); a def's layers are kept inside
// their band, bottom → top in the order the defs (and their layers) are listed.
import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, LayerSpecification, Map as MlMap } from "maplibre-gl";
import { LAYER } from "./layers.ts";
import { BANDS, sourceIdOf, type Band, type LayerDef } from "./registry/types.ts";
import { applySpec, mergeSpecs, type MapSpec } from "./spec.ts";

export const SENTINEL: Record<Band, string> = {
  beneath: "band-beneath",
  grid: "band-grid",
  "above-grid": "band-above-grid",
  top: "band-top",
};

/** The slice of the MapLibre API the engine uses (lets tests drive it with a fake map). */
export type EngineMap = Pick<
  MlMap,
  | "isStyleLoaded"
  | "getLayer"
  | "addLayer"
  | "moveLayer"
  | "getLayersOrder"
  | "getSource"
  | "addSource"
  | "getFilter"
  | "setFilter"
  | "getLayoutProperty"
  | "setLayoutProperty"
  | "getPaintProperty"
  | "setPaintProperty"
  | "setFeatureState"
  | "removeFeatureState"
  | "on"
  | "off"
>;

export interface EngineOptions<S> {
  getState: () => S;
  /** Fires when state the defs read may have changed; returns an unsubscribe. */
  subscribe: (fn: () => void) => () => void;
  /** The defs to mount, bottom → top within each band. */
  defs: (s: S) => LayerDef<S>[];
}

export interface Engine {
  /** Bring the map in line now; returns the number of writes made (0 when already in sync). */
  reconcile: () => number;
  /** Schedule a reconcile on the next animation frame. */
  schedule: () => void;
  detach: () => void;
}

const sentinelSpec = (band: Band): LayerSpecification => ({
  id: SENTINEL[band],
  type: "background",
  layout: { visibility: "none" },
});

/**
 * Keep the sentinels in band order, anchored to the core grid layers (which are mounted outside
 * the engine until phase 1.5). Rules run top → bottom, so a later move never breaks an earlier one.
 */
function placeSentinels(map: EngineMap): number {
  let writes = 0;
  for (const band of BANDS) {
    if (!map.getLayer(SENTINEL[band])) {
      map.addLayer(sentinelSpec(band));
      writes++;
    }
  }
  const idx = (id: string) => map.getLayersOrder().indexOf(id);
  const has = (id: string) => !!map.getLayer(id);
  const move = (id: string, before?: string) => {
    map.moveLayer(id, before);
    writes++;
  };
  const order = map.getLayersOrder();
  // `top` stays the topmost layer.
  if (order[order.length - 1] !== SENTINEL.top) move(SENTINEL.top);
  // `above-grid` sits between the grid lines and the substation dots.
  if (has(LAYER.substations)) {
    const s = idx(SENTINEL["above-grid"]);
    if (s > idx(LAYER.substations) || (has(LAYER.linesDC) && s < idx(LAYER.linesDC))) move(SENTINEL["above-grid"], LAYER.substations);
  } else if (idx(SENTINEL["above-grid"]) > idx(SENTINEL.top)) move(SENTINEL["above-grid"], SENTINEL.top);
  // `grid` closes the grid lines, just beneath `above-grid`.
  {
    const s = idx(SENTINEL.grid);
    if (s > idx(SENTINEL["above-grid"]) || (has(LAYER.linesDC) && s < idx(LAYER.linesDC))) move(SENTINEL.grid, SENTINEL["above-grid"]);
  }
  // `beneath` stays under the whole grid.
  {
    const floor = has(LAYER.linesCasing) ? LAYER.linesCasing : SENTINEL.grid;
    if (idx(SENTINEL.beneath) > idx(floor)) move(SENTINEL.beneath, floor);
  }
  return writes;
}

/** Keep every mounted def layer inside its band, in listed order (moves only what is out of place). */
function orderBands<S>(map: EngineMap, defs: LayerDef<S>[], layerIds: Map<string, string[]>): number {
  let writes = 0;
  let order = map.getLayersOrder();
  for (let b = 0; b < BANDS.length; b++) {
    const band = BANDS[b];
    const wanted = defs
      .filter((d) => d.band === band)
      .flatMap((d) => layerIds.get(d.id) ?? [])
      .filter((id) => map.getLayer(id));
    const floor = b > 0 ? SENTINEL[BANDS[b - 1]] : null;
    // Walk top → bottom: each layer must sit below the one listed after it (or the band sentinel)
    // and above the band's floor. Moving a layer directly beneath its target fixes both.
    let target = SENTINEL[band];
    for (let i = wanted.length - 1; i >= 0; i--) {
      const id = wanted[i];
      const at = order.indexOf(id);
      if (at > order.indexOf(target) || (floor != null && at < order.indexOf(floor))) {
        map.moveLayer(id, target);
        writes++;
        order = map.getLayersOrder();
      }
      target = id;
    }
  }
  return writes;
}

export function attachEngine<S>(map: EngineMap, opts: EngineOptions<S>): Engine {
  /** Computed-source data keys, per source instance (a style reload replaces the instance). */
  const computed = new Map<string, { src: unknown; key: string }>();

  const reconcile = (): number => {
    if (!map.isStyleLoaded()) return 0;
    const s = opts.getState();
    const defs = opts.defs(s);
    let writes = placeSentinels(map);
    const layerIds = new Map<string, string[]>();
    const specs: MapSpec[] = [];

    for (const def of defs) {
      const src = def.source;
      const srcId = sourceIdOf(def);
      const visible = def.visible(s);
      const source = map.getSource(srcId);

      if (!source) {
        if (src.kind === "ride" || !visible) continue;
        if (src.kind === "geojson") {
          const data = src.data();
          if (!data) continue;
          map.addSource(srcId, { ...src.options, type: "geojson", data } as never);
        } else {
          map.addSource(srcId, { type: "geojson", data: src.data(s) });
          computed.set(srcId, { src: map.getSource(srcId), key: src.key(s) });
        }
        writes++;
      } else if (src.kind === "computed") {
        const key = src.key(s);
        const rec = computed.get(srcId);
        if (!rec || rec.src !== source || rec.key !== key) {
          (source as GeoJSONSource).setData(src.data(s) as FeatureCollection);
          computed.set(srcId, { src: source, key });
          writes++;
        }
      }

      const layers = def.layers(s);
      layerIds.set(def.id, layers.map((l) => l.id));
      for (const layer of layers.filter((l) => !map.getLayer(l.id))) {
        map.addLayer(layer, SENTINEL[def.band]);
        writes++;
      }
      const vis = visible ? "visible" : "none";
      specs.push(Object.fromEntries(layers.map((l) => [l.id, { visibility: vis }])) as MapSpec);
      if (def.spec) specs.push(def.spec(s));
    }

    writes += applySpec(map, mergeSpecs(...specs));
    writes += orderBands(map, defs, layerIds);
    return writes;
  };

  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      reconcile();
    });
  };
  const unsub = opts.subscribe(schedule);
  // isStyleLoaded() is false while ANY source is still loading, so a reconcile can bail early —
  // `idle` guarantees a retry once the map settles (a no-op reconcile writes nothing, so no loop).
  map.on("styledata", schedule);
  map.on("idle", schedule);
  schedule();

  return {
    reconcile,
    schedule,
    detach: () => {
      unsub();
      if (raf) cancelAnimationFrame(raf);
      map.off("styledata", schedule);
      map.off("idle", schedule);
    },
  };
}
