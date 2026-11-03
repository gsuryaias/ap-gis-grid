import maplibregl, { type ExpressionSpecification, type Map as MlMap, type MapGeoJSONFeature } from "maplibre-gl";
import { useAppStore } from "../state/store.ts";
import { DISCOM_COLOR, DISCOM_NAME, DISCOMS, fieldLabel, type DiscomId, type OverlayDef } from "./catalog.ts";
import { useOverlayStore } from "./store.ts";

/** Overlays always sit BENEATH the transmission grid so the core network stays legible. */
const GRID_FLOOR = "grid-lines-casing";

const e = (x: unknown) => x as ExpressionSpecification;
const srcId = (id: string) => `ov-src-${id}`;
const ids = (id: string) => ({
  fill: `ov-${id}-fill`,
  line: `ov-${id}-line`,
  circle: `ov-${id}-circle`,
  label: `ov-${id}-label`,
});

function colorExpr(def: OverlayDef): string | ExpressionSpecification {
  if (def.style.color !== "discom") return def.style.color;
  return e(["match", ["get", "discom"], ...DISCOMS.flatMap((d) => [d, DISCOM_COLOR[d]]), "#64748b"]);
}

function discomFilter(): ExpressionSpecification {
  const on = DISCOMS.filter((d) => useOverlayStore.getState().discoms[d]);
  return e(["in", ["get", "discom"], ["literal", on]]);
}

function addLayersFor(map: MlMap, def: OverlayDef): void {
  const L = ids(def.id);
  const color = colorExpr(def);
  const st = def.style;
  const dark = useAppStore.getState().basemap !== "light";
  const minzoom = st.minzoom ?? 0;
  const before = map.getLayer(GRID_FLOOR) ? GRID_FLOOR : undefined;
  const isDiscom = def.style.color === "discom";

  if (def.geometry === "polygon") {
    if (st.fillOpacity) {
      map.addLayer(
        { id: L.fill, type: "fill", source: srcId(def.id), minzoom, paint: { "fill-color": color, "fill-opacity": st.fillOpacity } },
        before,
      );
    }
    map.addLayer(
      {
        id: L.line,
        type: "line",
        source: srcId(def.id),
        minzoom,
        paint: {
          "line-color": color,
          "line-width": e(["interpolate", ["linear"], ["zoom"], 6, (st.width ?? 1) * 0.7, 10, st.width ?? 1, 14, (st.width ?? 1) * 1.8]),
          "line-opacity": 0.9,
          ...(st.dash ? { "line-dasharray": st.dash } : {}),
        },
      },
      before,
    );
  } else if (def.geometry === "line") {
    map.addLayer(
      {
        id: L.line,
        type: "line",
        source: srcId(def.id),
        minzoom,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": color,
          "line-width": e(["interpolate", ["linear"], ["zoom"], 6, (st.width ?? 1) * 0.6, 10, st.width ?? 1, 14, (st.width ?? 1) * 2.4]),
          "line-opacity": 0.92,
          ...(st.dash ? { "line-dasharray": st.dash } : {}),
        },
        ...(isDiscom ? { filter: discomFilter() } : {}),
      },
      before,
    );
  } else {
    const r = st.radius ?? 3;
    map.addLayer(
      {
        id: L.circle,
        type: "circle",
        source: srcId(def.id),
        minzoom,
        paint: {
          "circle-color": color,
          "circle-radius": e(["interpolate", ["linear"], ["zoom"], 6, r * 0.6, 10, r, 14, r * 1.9]),
          "circle-stroke-color": dark ? "#0e1622" : "#ffffff",
          "circle-stroke-width": 1,
          "circle-opacity": 0.95,
        },
        ...(isDiscom ? { filter: discomFilter() } : {}),
      },
      before,
    );
  }

  if (def.labelField && st.labelMinzoom != null) {
    map.addLayer(
      {
        id: L.label,
        type: "symbol",
        source: srcId(def.id),
        minzoom: st.labelMinzoom,
        layout: {
          "text-field": ["coalesce", ["get", def.labelField], ""],
          "text-font": ["Open Sans Bold"],
          "text-size": def.group === "Boundaries" ? 11.5 : 10.5,
          "text-max-width": 9,
          "text-optional": true,
          ...(def.geometry === "point"
            ? { "text-anchor": "top", "text-offset": [0, 0.7] }
            : def.geometry === "line"
              ? { "symbol-placement": "line" }
              : {}),
        },
        paint: {
          "text-color": dark ? "#e2e8f0" : def.group === "Boundaries" ? "#1e293b" : "#334155",
          "text-halo-color": dark ? "rgba(14,22,34,0.9)" : "rgba(255,255,255,0.92)",
          "text-halo-width": 1.4,
        },
        ...(isDiscom ? { filter: discomFilter() } : {}),
      },
      before,
    );
  }
}

function layerIdsOf(def: OverlayDef): string[] {
  const L = ids(def.id);
  return [L.fill, L.line, L.circle, L.label];
}

const appliedDiscomKey = new WeakMap<MlMap, string>();

/**
 * Bring the map in line with the overlay store. Idempotent, and every mutation is conditional:
 * setLayoutProperty / moveLayer / setFilter emit `styledata`, which re-schedules this — so an
 * unconditional write would loop forever.
 */
function sync(map: MlMap): void {
  if (!map.isStyleLoaded()) return;
  const s = useOverlayStore.getState();
  const discomKey = DISCOMS.filter((d) => s.discoms[d]).join(",");
  const discomChanged = appliedDiscomKey.get(map) !== discomKey;
  let order: string[] | null = null;
  for (const def of Object.values(s.defs)) {
    const on = !!s.enabled[def.id];
    const fc = s.data[def.id];
    let added = false;
    if (on && fc && !map.getSource(srcId(def.id))) {
      map.addSource(srcId(def.id), { type: "geojson", data: fc, tolerance: 0.5 });
      addLayersFor(map, def);
      added = true;
    }
    for (const lid of layerIdsOf(def)) {
      const layer = map.getLayer(lid);
      if (!layer) continue;
      const vis = on ? "visible" : "none";
      if (map.getLayoutProperty(lid, "visibility") !== vis) map.setLayoutProperty(lid, "visibility", vis);
      if (def.style.color === "discom" && layer.type !== "fill" && discomChanged && !added) map.setFilter(lid, discomFilter());
      // Keep beneath the grid even if the grid was (re)added after us.
      if (map.getLayer(GRID_FLOOR)) {
        order ??= map.getLayersOrder();
        if (order.indexOf(lid) > order.indexOf(GRID_FLOOR)) {
          map.moveLayer(lid, GRID_FLOOR);
          order = null;
        }
      }
    }
  }
  appliedDiscomKey.set(map, discomKey);
}

function interactiveLayers(map: MlMap): string[] {
  const s = useOverlayStore.getState();
  const out: string[] = [];
  // Points first, then lines, then fills — the most specific feature wins a tap.
  for (const kind of ["circle", "line", "fill"] as const)
    for (const def of Object.values(s.defs)) {
      if (!s.enabled[def.id]) continue;
      // Outline-only boundaries are informative but shouldn't eat every map tap.
      if (kind === "line" && def.geometry === "polygon" && !def.style.fillOpacity) continue;
      const lid = ids(def.id)[kind];
      if (map.getLayer(lid)) out.push(lid);
    }
  return out;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function formatValue(k: string, v: unknown): string | null {
  if (v == null || v === "") return null;
  if (k === "discom") return `${v} — ${DISCOM_NAME[v as DiscomId] ?? ""}`.replace(/ — $/, "");
  if (typeof v === "number") return k.toLowerCase().includes("km") || k.toLowerCase().includes("ha") ? v.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : v.toLocaleString("en-IN");
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function popupHtml(def: OverlayDef, f: MapGeoJSONFeature): string {
  const p = (f.properties ?? {}) as Record<string, unknown>;
  const title = (p.name as string) || (def.id.startsWith("discom") ? `Unnamed ${def.label.replace(/s$/, "")}` : def.label);
  const skip = new Set(["name", "id", "kind", "lng", "lat"]);
  const rows = Object.entries(p)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => [fieldLabel(k), formatValue(k, v)] as const)
    .filter(([, v]) => v != null)
    .slice(0, 14)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v!)}</td></tr>`)
    .join("");
  const meta = [def.source, def.vintage ? `vintage ${def.vintage}` : null].filter(Boolean).join(" · ");
  return (
    `<div class="ov-popup"><div class="ov-popup-kicker">${esc(def.group)} · ${esc(def.label)}</div>` +
    `<div class="ov-popup-title">${esc(title)}</div>` +
    (rows ? `<table>${rows}</table>` : "") +
    `<div class="ov-popup-src">${esc(meta)}</div></div>`
  );
}

function defForLayer(layerId: string): OverlayDef | undefined {
  const m = /^ov-(.+)-(fill|line|circle|label)$/.exec(layerId);
  return m ? useOverlayStore.getState().defs[m[1]] : undefined;
}

/**
 * Attach the overlay controller to a map. Returns a detach function.
 * `suppressed()` → true while a click-hijacking tool (measure / nearest) is active.
 * `coreLayers` → the grid's clickable layers; a tap on a core feature always wins.
 */
export function attachOverlays(map: MlMap, opts: { suppressed: () => boolean; coreLayers: readonly string[] }): () => void {
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      sync(map);
    });
  };
  const unsub = useOverlayStore.subscribe(schedule);
  // isStyleLoaded() is false while ANY source is still loading, so a sync can bail early — `idle`
  // guarantees a retry once the map settles (a no-op sync mutates nothing, so this can't loop).
  map.on("styledata", schedule);
  map.on("idle", schedule);
  schedule();

  const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "300px", className: "ov-popup-wrap", focusAfterOpen: false });

  const onClick = (ev: maplibregl.MapMouseEvent) => {
    if (opts.suppressed()) return;
    const layers = interactiveLayers(map);
    if (!layers.length) return;
    const core = opts.coreLayers.filter((l) => map.getLayer(l));
    if (core.length && map.queryRenderedFeatures(ev.point, { layers: core }).length) return;
    // A small hit box makes thin lines and small dots tappable on touch screens.
    const pad = 6;
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [
      [ev.point.x - pad, ev.point.y - pad],
      [ev.point.x + pad, ev.point.y + pad],
    ];
    let hit: MapGeoJSONFeature | undefined;
    for (const lid of layers) {
      const geomBox = lid.endsWith("-fill") ? ev.point : box;
      hit = map.queryRenderedFeatures(geomBox, { layers: [lid] })[0];
      if (hit) break;
    }
    if (!hit) return;
    const def = defForLayer(hit.layer.id);
    if (!def) return;
    popup.setLngLat(ev.lngLat).setHTML(popupHtml(def, hit)).addTo(map);
  };
  map.on("click", onClick);

  let ownCursor = false;
  let moveRaf = 0;
  const onMove = (ev: maplibregl.MapMouseEvent) => {
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      if (opts.suppressed()) return;
      const layers = interactiveLayers(map);
      const canvas = map.getCanvas();
      if (!layers.length) {
        if (ownCursor) canvas.style.cursor = "";
        ownCursor = false;
        return;
      }
      const hit = map.queryRenderedFeatures(ev.point, { layers }).length > 0;
      if (hit && !canvas.style.cursor) {
        canvas.style.cursor = "pointer";
        ownCursor = true;
      } else if (!hit && ownCursor) {
        canvas.style.cursor = "";
        ownCursor = false;
      }
    });
  };
  map.on("mousemove", onMove);

  return () => {
    unsub();
    if (raf) cancelAnimationFrame(raf);
    if (moveRaf) cancelAnimationFrame(moveRaf);
    map.off("styledata", schedule);
    map.off("idle", schedule);
    map.off("click", onClick);
    map.off("mousemove", onMove);
    popup.remove();
  };
}
