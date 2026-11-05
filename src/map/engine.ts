// The map sync engine (Atlas 2.0 phase 1): mounts registry `LayerDef`s and keeps the map in line
// with them. One `reconcile()` per animation frame, scheduled by state changes, `styledata` and
// `idle`. EVERY write is conditional — setFilter / setLayoutProperty / moveLayer / setData all emit
// `styledata` (or a render → `idle`), which re-schedules a reconcile, so an unconditional write
// would loop forever. A no-op reconcile therefore makes zero writes (tested in engine.test.ts).
//
// Cheap when nothing changed (it runs on every hover): a def whose spec / feature-state objects
// are the same as last time (defs memoise them) and whose layers are the same instances is
// skipped without reading the map back.
//
// Z-order: four empty sentinel layers close the bands (`BANDS`); a def's layers are kept inside
// their band, bottom → top in the order the defs (and their layers) are listed.
import type { GeoJSONSource, LayerSpecification, Map as MlMap, RasterTileSource } from "maplibre-gl";
import { BANDS, sourceIdOf, type Band, type LayerDef } from "./registry/types.ts";
import { applySpec, syncFeatureState, type FeatureStateSpec, type MapSpec } from "./spec.ts";

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
  /** Called once the sentinels are (re)created — i.e. on the first mount and after every `setStyle`. */
  onStyleReload?: () => void;
}

export interface Engine {
  /** Bring the map in line now; returns the number of writes made (0 when already in sync). */
  reconcile: () => number;
  /** Schedule a reconcile on the next animation frame. */
  schedule: () => void;
  /** The defs as of the last reconcile (for the interaction handler). */
  defs: () => LayerDef<unknown>[];
  detach: () => void;
}

/** Keep the four sentinels present, in band order, with `top` the topmost layer. */
function placeSentinels(map: EngineMap): number {
  let writes = 0;
  for (const band of BANDS) {
    if (map.getLayer(SENTINEL[band])) continue;
    map.addLayer({ id: SENTINEL[band], type: "background", layout: { visibility: "none" } } as LayerSpecification);
    writes++;
  }
  let order = map.getLayersOrder();
  if (order[order.length - 1] !== SENTINEL.top) {
    map.moveLayer(SENTINEL.top);
    writes++;
    order = map.getLayersOrder();
  }
  // Top → bottom: each sentinel directly beneath-or-below the next one up.
  for (let b = BANDS.length - 2; b >= 0; b--) {
    const id = SENTINEL[BANDS[b]];
    const above = SENTINEL[BANDS[b + 1]];
    if (order.indexOf(id) > order.indexOf(above)) {
      map.moveLayer(id, above);
      writes++;
      order = map.getLayersOrder();
    }
  }
  return writes;
}

/** Keep every mounted def layer inside its band, in listed order (moves only what is out of place). */
function orderBands<S>(map: EngineMap, defs: LayerDef<S>[], layerIds: (d: LayerDef<S>) => string[]): number {
  let writes = 0;
  let order = map.getLayersOrder();
  for (let b = 0; b < BANDS.length; b++) {
    const band = BANDS[b];
    const wanted = defs
      .filter((d) => d.band === band)
      .flatMap(layerIds)
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

interface Mounted {
  /** The source instance the layers were mounted on (a style reload replaces it). */
  src: unknown;
  ids: string[];
  /** Last applied spec / visibility / feature-state, and the layer instances they went to. */
  spec?: MapSpec;
  visible?: boolean;
  layerObjs?: unknown[];
  fs?: FeatureStateSpec[];
}

export function attachEngine<S>(map: EngineMap, opts: EngineOptions<S>): Engine {
  const mounted = new Map<string, Mounted>();
  /** Computed-source keys / raster URLs, per source instance. */
  const sourceKeys = new Map<string, { src: unknown; key: string }>();
  let lastDefs: LayerDef<S>[] = [];
  let lastOrder = "";

  const sourceKey = (id: string, src: unknown, key: string): boolean => {
    const rec = sourceKeys.get(id);
    if (rec && rec.src === src && rec.key === key) return false;
    sourceKeys.set(id, { src, key });
    return true;
  };

  /** Make sure the def's source exists (when it should); false = not mountable yet. */
  const ensureSource = (def: LayerDef<S>, s: S, visible: boolean): { ok: boolean; writes: number } => {
    const src = def.source;
    const id = sourceIdOf(def);
    const existing = map.getSource(id);
    if (src.kind === "ride") return { ok: !!existing, writes: 0 };
    if (!existing) {
      if (!visible) return { ok: false, writes: 0 };
      if (src.kind === "raster") {
        const tiles = src.tiles(s);
        if (!tiles) return { ok: false, writes: 0 };
        map.addSource(id, { ...src.options, type: "raster", tiles } as never);
        sourceKey(id, map.getSource(id), tiles.join("\n"));
      } else {
        const data = src.data(s);
        if (!data) return { ok: false, writes: 0 };
        map.addSource(id, { ...(src.kind === "geojson" ? src.options : {}), type: "geojson", data } as never);
        if (src.kind === "computed") sourceKey(id, map.getSource(id), src.key(s));
      }
      return { ok: true, writes: 1 };
    }
    if (src.kind === "computed") {
      const data = src.data(s);
      if (data && sourceKey(id, existing, src.key(s))) {
        (existing as GeoJSONSource).setData(data);
        return { ok: true, writes: 1 };
      }
    } else if (src.kind === "raster") {
      const tiles = src.tiles(s);
      if (tiles && sourceKey(id, existing, tiles.join("\n"))) {
        (existing as RasterTileSource).setTiles(tiles);
        return { ok: true, writes: 1 };
      }
    }
    return { ok: true, writes: 0 };
  };

  const reconcile = (): number => {
    if (!map.isStyleLoaded()) return 0;
    const s = opts.getState();
    const defs = opts.defs(s);
    lastDefs = defs;
    // A missing `top` sentinel = a fresh style (first mount or after setStyle). Let the caller re-add
    // its own layers first, so the sentinels land above them in this same pass.
    if (!map.getLayer(SENTINEL.top)) opts.onStyleReload?.();
    let writes = placeSentinels(map);

    // Source owners first, then the defs that ride their sources (stacking is by list order, below).
    for (const def of [...defs.filter((d) => d.source.kind !== "ride"), ...defs.filter((d) => d.source.kind === "ride")]) {
      const visible = def.visible(s);
      const src = ensureSource(def, s, visible);
      writes += src.writes;
      if (!src.ok) continue;
      const source = map.getSource(sourceIdOf(def));

      let rec = mounted.get(def.id);
      if (!rec || rec.src !== source || rec.ids.some((id) => !map.getLayer(id))) {
        const layers = def.layers(s);
        for (const layer of layers) {
          if (map.getLayer(layer.id)) continue;
          map.addLayer(layer, SENTINEL[def.band]);
          writes++;
        }
        rec = { src: source, ids: layers.map((l) => l.id) };
        mounted.set(def.id, rec);
      }

      const layerObjs = rec.ids.map((id) => map.getLayer(id));
      const sameLayers = !!rec.layerObjs && rec.layerObjs.every((o, i) => o === layerObjs[i]);
      const spec = def.spec?.(s);
      if (!sameLayers || rec.spec !== spec || rec.visible !== visible) {
        const full: MapSpec = {};
        for (const id of rec.ids) {
          const own = spec?.[id];
          full[id] = { ...own, visibility: visible ? (own?.visibility ?? "visible") : "none" };
        }
        writes += applySpec(map, full);
        rec.spec = spec;
        rec.visible = visible;
        rec.layerObjs = layerObjs;
      }
      const fs = def.featureState?.(s);
      if (fs && (!sameLayers || rec.fs !== fs)) {
        for (const f of fs) writes += syncFeatureState(map, def.id, f);
        rec.fs = fs;
      }
    }

    const order = map.getLayersOrder().join("\n");
    if (writes || order !== lastOrder) {
      writes += orderBands(map, defs, (d) => mounted.get(d.id)?.ids ?? []);
      lastOrder = map.getLayersOrder().join("\n");
    }
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
    defs: () => lastDefs as LayerDef<unknown>[],
    detach: () => {
      unsub();
      if (raf) cancelAnimationFrame(raf);
      map.off("styledata", schedule);
      map.off("idle", schedule);
    },
  };
}
