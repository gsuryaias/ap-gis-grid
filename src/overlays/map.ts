// Catalog overlays on the map: the layers themselves are registry defs (`map/registry/overlays.ts`)
// kept in sync by the engine (`map/engine.ts`); this module adds the tap popups, the hover cursor
// and the one-shot fit (all of which fold into the single interaction handler in phase 1.5).
import maplibregl, { type Map as MlMap, type MapGeoJSONFeature } from "maplibre-gl";
import { attachEngine } from "../map/engine.ts";
import { overlayLayerIds, overlayRegistry } from "../map/registry/overlays.ts";
import { useAppStore } from "../state/store.ts";
import { DISCOM_NAME, fieldLabel, type DiscomId, type OverlayDef } from "./catalog.ts";
import { overlayLayer, useOverlayStore } from "./store.ts";
import { towerPopupHtml } from "./towers.ts";

const overlayDefs = overlayRegistry((id) => overlayLayer.peek(id));

function interactiveLayers(map: MlMap): string[] {
  const s = useOverlayStore.getState();
  const out: string[] = [];
  // Points first, then lines, then fills — the most specific feature wins a tap.
  for (const kind of ["circle", "line", "fill"] as const)
    for (const def of Object.values(s.defs)) {
      if (!s.enabled[def.id]) continue;
      // Outline-only boundaries are informative but shouldn't eat every map tap.
      if (kind === "line" && def.geometry === "polygon" && !def.style.fillOpacity) continue;
      const lid = overlayLayerIds(def.id)[kind];
      if (map.getLayer(lid)) out.push(lid);
    }
  return out;
}

const LINK_LABEL: Record<string, string> = {
  recorded: "recorded 33/11 kV SS id",
  name: "recorded source SS (name match)",
  proximity: "feeder end at the SS (≤ 1.5 km)",
  "feeder-group": "another run of the same feeder",
};

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
  const skip = new Set(["name", "id", "kind", "lng", "lat", "transcoSsId"]);
  // Connectivity first — it's what ties the 33 kV network to the TRANSCO grid.
  const PRIORITY = ["discom", "transcoSs", "linkMethod", "sourceSs", "feeders", "nearestTranscoSs", "servesSsCount", "servesSs"];
  const rank = (k: string) => (PRIORITY.includes(k) ? PRIORITY.indexOf(k) : PRIORITY.length);
  const rows = Object.entries(p)
    .filter(([k]) => !skip.has(k))
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([k, v]) => [k, fieldLabel(k), formatValue(k, v)] as const)
    .filter(([, , v]) => v != null)
    .slice(0, 18)
    .map(([k, label, v]) => {
      const cell =
        k === "transcoSs" && p.transcoSsId
          ? `<button type="button" class="ov-link" data-select="${esc(String(p.transcoSsId))}">${esc(v!)}</button>`
          : k === "linkMethod"
            ? esc(LINK_LABEL[String(v)] ?? v!)
            : esc(v!);
      return `<tr><th>${esc(label)}</th><td>${cell}</td></tr>`;
    })
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
  // The overlay layers re-sync on `layers`-slice changes (a basemap switch reloads the style, which
  // the engine sees as `styledata`), on `styledata` and on `idle`.
  const engine = attachEngine(map, {
    getState: useAppStore.getState,
    subscribe: (fn) => useOverlayStore.subscribe(fn),
    defs: overlayDefs,
  });

  const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "300px", className: "ov-popup-wrap", focusAfterOpen: false });

  const onClick = (ev: maplibregl.MapMouseEvent) => {
    if (opts.suppressed()) return;
    const layers = interactiveLayers(map);
    if (!layers.length) return;
    // A small hit box makes thin lines and small dots tappable on touch screens.
    const pad = 6;
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [
      [ev.point.x - pad, ev.point.y - pad],
      [ev.point.x + pad, ev.point.y + pad],
    ];
    // Towers sit on the core lines, so a tower hit wins over the line beneath it (the line still
    // gets selected by the core handler — the popup links back to it).
    const towerLayers = layers.filter((l) => /^ov-towers-.*-circle$/.test(l));
    const towerHit = towerLayers.length
      ? map.queryRenderedFeatures([[ev.point.x - 4, ev.point.y - 4], [ev.point.x + 4, ev.point.y + 4]], { layers: towerLayers })[0]
      : undefined;
    if (towerHit) {
      const def = defForLayer(towerHit.layer.id);
      if (def) return openPopup(ev.lngLat, towerPopupHtml(def.id, Number(towerHit.properties?.i), def.label));
    }
    const core = opts.coreLayers.filter((l) => map.getLayer(l));
    if (core.length && map.queryRenderedFeatures(ev.point, { layers: core }).length) return;
    let hit: MapGeoJSONFeature | undefined;
    for (const lid of layers) {
      const geomBox = lid.endsWith("-fill") ? ev.point : box;
      hit = map.queryRenderedFeatures(geomBox, { layers: [lid] })[0];
      if (hit) break;
    }
    if (!hit) return;
    const def = defForLayer(hit.layer.id);
    if (!def) return;
    openPopup(ev.lngLat, popupHtml(def, hit));
  };

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

  let lastFit = 0;
  const unsubFit = useOverlayStore.subscribe((st) => {
    if (!st.fitSignal || st.fitSignal.ts === lastFit) return;
    lastFit = st.fitSignal.ts;
    const narrow = map.getContainer().clientWidth < 640;
    map.fitBounds(st.fitSignal.bounds, {
      padding: narrow ? { top: 190, bottom: 120, left: 20, right: 20 } : { top: 60, bottom: 60, left: 320, right: 380 },
      maxZoom: st.fitSignal.maxZoom ?? 12,
      duration: 900,
    });
  });
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
    engine.detach();
    unsubFit();
    if (moveRaf) cancelAnimationFrame(moveRaf);
    map.off("click", onClick);
    map.off("mousemove", onMove);
    popup.remove();
  };
}
