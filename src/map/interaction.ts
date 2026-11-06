// The one map click / hover handler. Every tappable def declares an `interaction` (priority, kind,
// layers, tap tolerance, pick → Inspector ref). A tap:
//   - selects the best hit under the pointer, defs tried best priority first: tower 0 · core SS 10 ·
//     core line 20 · plant / power grid 30 · overlay points 40 · overlay lines 50 · overlay fills 60;
//   - lists every feature within a ~16 px box as "What's here" (thin lines are hard to hit exactly,
//     especially on a phone): with no exact hit, one box hit is selected directly, several are listed;
//   - right-click lists what's here without selecting.
// Hover highlights the best hoverable feature under the pointer and sets the cursor.
import type { Map as MlMap, MapGeoJSONFeature, MapMouseEvent, PointLike } from "maplibre-gl";
import { useAppStore } from "../state/store.ts";
import type { HereItem } from "../state/types.ts";
import type { Interaction, LayerDef } from "./registry/types.ts";

export interface InteractionOptions {
  /** The current defs (the engine's last reconcile). */
  defs: () => LayerDef<unknown>[];
  /** True while a click-capturing tool (measure / nearest SS) owns the map. */
  suppressed: () => boolean;
}

/** Half-size of the "What's here" box, px. */
export const HERE_PAD = 8;
const HERE_MAX = 12;

const byPriority = new WeakMap<LayerDef<unknown>[], Interaction[]>();
function interactionsOf(defs: LayerDef<unknown>[]): Interaction[] {
  let out = byPriority.get(defs);
  if (!out) {
    out = defs.flatMap((d) => (d.interaction ? [d.interaction] : [])).sort((a, b) => a.priority - b.priority);
    byPriority.set(defs, out);
  }
  return out;
}

function hitBox(p: { x: number; y: number }, pad: number): PointLike | [PointLike, PointLike] {
  return pad > 0 ? [[p.x - pad, p.y - pad], [p.x + pad, p.y + pad]] : [p.x, p.y];
}

/**
 * Every distinct feature in `features` that some interaction can pick, best priority first (ties
 * keep MapLibre's top-most-first order). Pure — unit-tested.
 */
export function rankHits(its: Interaction[], features: Pick<MapGeoJSONFeature, "id" | "properties" | "layer">[]): HereItem[] {
  const seen = new Set<string>();
  const out: Array<HereItem & { priority: number; n: number }> = [];
  features.forEach((f, n) => {
    const it = its.find((i) => i.layers.includes(f.layer.id));
    const pick = it?.pick(f as MapGeoJSONFeature);
    if (!it || !pick || seen.has(pick.ref)) return;
    seen.add(pick.ref);
    out.push({ ref: pick.ref, label: pick.label, kind: it.kind, priority: it.priority, n });
  });
  return out
    .sort((a, b) => a.priority - b.priority || a.n - b.n)
    .slice(0, HERE_MAX)
    .map(({ ref, label, kind }) => ({ ref, label, kind }));
}

export function attachInteraction(map: MlMap, opts: InteractionOptions): () => void {
  const present = (ids: string[]) => ids.filter((id) => map.getLayer(id));

  /** Everything in the "What's here" box, best first. */
  const hereAt = (point: { x: number; y: number }): HereItem[] => {
    const its = interactionsOf(opts.defs());
    const layers = present(its.flatMap((it) => it.layers));
    return layers.length ? rankHits(its, map.queryRenderedFeatures(hitBox(point, HERE_PAD), { layers })) : [];
  };

  /** The best exact hit (each def's own tap tolerance). */
  const bestAt = (point: { x: number; y: number }): HereItem | null => {
    for (const it of interactionsOf(opts.defs())) {
      const layers = present(it.layers);
      if (!layers.length) continue;
      for (const f of map.queryRenderedFeatures(hitBox(point, it.pad ?? 0), { layers })) {
        const pick = it.pick(f);
        if (pick) return { ref: pick.ref, label: pick.label, kind: it.kind };
      }
    }
    return null;
  };

  const onClick = (ev: MapMouseEvent) => {
    const st = useAppStore.getState();
    if (st.measureMode != null) return;
    if (st.nearbyMode) {
      st.setNearbyOrigin({ lng: ev.lngLat.lng, lat: ev.lngLat.lat, label: "Picked point", fly: false });
      return;
    }
    const best = bestAt(ev.point);
    const here = hereAt(ev.point);
    if (best) {
      st.select(best.ref);
      st.setHere(here.some((h) => h.ref !== best.ref) ? [best, ...here.filter((h) => h.ref !== best.ref)] : null);
    } else if (here.length === 1) {
      st.select(here[0].ref);
    } else {
      st.select(null);
      st.setHere(here);
    }
  };

  const onContext = (ev: MapMouseEvent) => {
    if (opts.suppressed()) return;
    const here = hereAt(ev.point);
    if (!here.length) return;
    ev.preventDefault();
    const st = useAppStore.getState();
    st.select(null);
    st.setHere(here);
  };

  let ownHover: string | null = null;
  let ownCursor = false;
  let raf = 0;
  const setCursor = (on: boolean) => {
    const canvas = map.getCanvas();
    if (on && !canvas.style.cursor) {
      canvas.style.cursor = "pointer";
      ownCursor = true;
    } else if (!on && ownCursor) {
      canvas.style.cursor = "";
      ownCursor = false;
    }
  };
  const setHover = (id: string | null) => {
    if (id === ownHover) return;
    ownHover = id;
    useAppStore.getState().setHover(id);
  };

  const onMove = (ev: MapMouseEvent) => {
    if (raf) return;
    const point = ev.point;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (opts.suppressed()) return;
      const its = interactionsOf(opts.defs());
      const layers = present(its.flatMap((it) => it.layers));
      const hits = layers.length ? map.queryRenderedFeatures([point.x, point.y], { layers }) : [];
      setCursor(hits.length > 0);
      let best: { priority: number; id: string } | null = null;
      for (const f of hits) {
        const it = its.find((i) => i.hover && i.layers.includes(f.layer.id));
        const pick = it?.pick(f);
        if (it && pick && (!best || it.priority < best.priority)) best = { priority: it.priority, id: pick.ref };
      }
      setHover(best?.id ?? null);
    });
  };
  const onOut = () => {
    if (opts.suppressed()) return;
    setHover(null);
    setCursor(false);
  };

  map.on("click", onClick);
  map.on("contextmenu", onContext);
  map.on("mousemove", onMove);
  map.on("mouseout", onOut);
  return () => {
    if (raf) cancelAnimationFrame(raf);
    map.off("click", onClick);
    map.off("contextmenu", onContext);
    map.off("mousemove", onMove);
    map.off("mouseout", onOut);
  };
}
