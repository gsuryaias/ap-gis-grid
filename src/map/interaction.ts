// The one map click / hover handler (Atlas 2.0 phase 1.5). Every tappable def declares an
// `interaction` (priority, layers, tap tolerance, pick); this resolves a tap to at most one
// selection and one popup:
//   - defs are tried best priority first: tower 0 · core SS 10 · core line 20 · plant / power
//     grid 30 · overlay points 40 · overlay lines 50 · overlay fills 60;
//   - the first selectable hit is selected (none → the selection is cleared);
//   - a popup opens only if it out-ranks that selection — so a tower's popup opens over the line
//     it sits on (which is still selected), while a core feature hides the overlays beneath it.
// Hover highlights the best hoverable feature under the pointer and sets the cursor.
import maplibregl, { type MapGeoJSONFeature, type Map as MlMap, type PointLike } from "maplibre-gl";
import { useAppStore } from "../state/store.ts";
import type { Interaction, LayerDef } from "./registry/types.ts";

export interface InteractionOptions {
  /** The current defs (the engine's last reconcile). */
  defs: () => LayerDef<unknown>[];
  /** True while a click-capturing tool (measure / nearest SS) owns the map. */
  suppressed: () => boolean;
}

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

export function attachInteraction(map: MlMap, opts: InteractionOptions): () => void {
  const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "300px", className: "ov-popup-wrap", focusAfterOpen: false });
  const present = (ids: string[]) => ids.filter((id) => map.getLayer(id));

  const openPopup = (at: maplibregl.LngLat, html: string) => {
    if (!html) return;
    popup.setLngLat(at).setHTML(html).addTo(map);
    popup.getElement()?.querySelectorAll<HTMLButtonElement>("[data-select]").forEach((b) =>
      b.addEventListener("click", () => {
        popup.remove();
        useAppStore.getState().select(b.dataset.select!, { fly: true });
      }),
    );
  };

  const onClick = (ev: maplibregl.MapMouseEvent) => {
    const st = useAppStore.getState();
    if (st.measureMode != null) return;
    if (st.nearbyMode) {
      st.setNearbyOrigin({ lng: ev.lngLat.lng, lat: ev.lngLat.lat, label: "Picked point", fly: false });
      return;
    }
    let selected: string | null = null;
    let html: string | null = null;
    for (const it of interactionsOf(opts.defs())) {
      const layers = present(it.layers);
      if (!layers.length) continue;
      const f: MapGeoJSONFeature | undefined = map.queryRenderedFeatures(hitBox(ev.point, it.pad ?? 0), { layers })[0];
      const pick = f ? it.pick(f) : null;
      if (!pick) continue;
      if ("select" in pick) {
        selected = pick.select;
        break; // anything after ranks lower: no popup can out-rank this any more
      }
      html ??= pick.popup;
    }
    if (html) openPopup(ev.lngLat, html);
    st.select(selected);
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

  const onMove = (ev: maplibregl.MapMouseEvent) => {
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
        if (it && pick && "select" in pick && (!best || it.priority < best.priority)) best = { priority: it.priority, id: pick.select };
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
  map.on("mousemove", onMove);
  map.on("mouseout", onOut);
  return () => {
    if (raf) cancelAnimationFrame(raf);
    map.off("click", onClick);
    map.off("mousemove", onMove);
    map.off("mouseout", onOut);
    popup.remove();
  };
}
