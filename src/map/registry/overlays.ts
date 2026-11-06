// Registry defs for the catalog overlays — DISCOM 33 / 11 kV, transmission towers, RTGS reference
// layers — plus the amber DISCOM focus highlight. Pure: built from the `layers` slice + basemap and
// a data getter (the `overlayLayer` resource), so it is unit-testable without a map or a store.
import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { DISCOM_COLOR, DISCOMS, type DiscomId, type OverlayDef } from "../../overlays/catalog.ts";
import type { Basemap, OverlayFocus } from "../../state/types.ts";
import type { MapSpec } from "../spec.ts";
import type { LayerDef } from "./types.ts";

/** The state the overlay defs read (the app store satisfies it). */
export interface OverlayRegistryState {
  basemap: Basemap;
  layers: {
    defs: Record<string, OverlayDef>;
    enabled: Record<string, boolean>;
    discoms: Record<DiscomId, boolean>;
    focus: OverlayFocus | null;
  };
}
type S = OverlayRegistryState;

const e = (x: unknown) => x as ExpressionSpecification;
export const overlaySourceId = (id: string) => `ov-src-${id}`;
export const overlayLayerIds = (id: string) => ({
  fill: `ov-${id}-fill`,
  line: `ov-${id}-line`,
  circle: `ov-${id}-circle`,
  label: `ov-${id}-label`,
});

function colorExpr(def: OverlayDef): string | ExpressionSpecification {
  if (def.style.color !== "discom") return def.style.color;
  return e(["match", ["get", "discom"], ...DISCOMS.flatMap((d) => [d, DISCOM_COLOR[d]]), "#64748b"]);
}

export function discomFilter(discoms: Record<DiscomId, boolean>): ExpressionSpecification {
  return e(["in", ["get", "discom"], ["literal", DISCOMS.filter((d) => discoms[d])]]);
}

/** The style layers of one catalog overlay (bottom → top). */
export function overlayLayers(def: OverlayDef, s: S): LayerSpecification[] {
  const L = overlayLayerIds(def.id);
  const source = overlaySourceId(def.id);
  const color = colorExpr(def);
  const st = def.style;
  const dark = s.basemap !== "light";
  const minzoom = st.minzoom ?? 0;
  const isTower = def.format === "towers";
  const filter = def.style.color === "discom" ? { filter: discomFilter(s.layers.discoms) } : {};
  const out: LayerSpecification[] = [];

  if (def.geometry === "polygon") {
    if (st.fillOpacity) {
      out.push({ id: L.fill, type: "fill", source, minzoom, paint: { "fill-color": color, "fill-opacity": st.fillOpacity } });
    }
    out.push({
      id: L.line,
      type: "line",
      source,
      minzoom,
      paint: {
        "line-color": color,
        "line-width": e(["interpolate", ["linear"], ["zoom"], 6, (st.width ?? 1) * 0.7, 10, st.width ?? 1, 14, (st.width ?? 1) * 1.8]),
        "line-opacity": 0.9,
        ...(st.dash ? { "line-dasharray": st.dash } : {}),
      },
    });
  } else if (def.geometry === "line") {
    out.push({
      id: L.line,
      type: "line",
      source,
      minzoom,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": color,
        "line-width": e(["interpolate", ["linear"], ["zoom"], 6, (st.width ?? 1) * 0.6, 10, st.width ?? 1, 14, (st.width ?? 1) * 2.4]),
        "line-opacity": 0.92,
        ...(st.dash ? { "line-dasharray": st.dash } : {}),
      },
      ...filter,
    });
  } else {
    const r = st.radius ?? 3;
    // Towers: cut / angle points (CP) drawn larger with a contrasting ring so line deviations read.
    const cp = (k: number) => (isTower ? ["case", ["==", ["get", "cp"], "CP"], r * k * 1.5, r * k] : r * k);
    out.push({
      id: L.circle,
      type: "circle",
      source,
      minzoom,
      paint: {
        "circle-color": color,
        "circle-radius": e(["interpolate", ["linear"], ["zoom"], 6, cp(0.6), 10, cp(1), 14, cp(1.9)]),
        "circle-stroke-color": isTower
          ? e(["case", ["==", ["get", "cp"], "CP"], dark ? "#f8fafc" : "#0f172a", dark ? "#0e1622" : "#ffffff"])
          : dark ? "#0e1622" : "#ffffff",
        "circle-stroke-width": isTower ? e(["case", ["==", ["get", "cp"], "CP"], 1.6, 1]) : 1,
        "circle-opacity": 0.95,
      },
      ...filter,
    });
  }

  if (def.labelField && st.labelMinzoom != null) {
    out.push({
      id: L.label,
      type: "symbol",
      source,
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
      ...filter,
    } as LayerSpecification);
  }
  return out;
}

function catalogDef(def: OverlayDef, data: (id: string) => FeatureCollection | undefined): LayerDef<S> {
  const isDiscom = def.style.color === "discom";
  return {
    id: def.id,
    band: def.style.aboveGrid ? "above-grid" : "beneath",
    source: { kind: "geojson", id: overlaySourceId(def.id), data: () => data(def.id), options: { tolerance: 0.5 } },
    layers: (s) => overlayLayers(def, s),
    visible: (s) => !!s.layers.enabled[def.id],
    // The DISCOM sub-filter (fills are never DISCOM-coloured).
    spec: isDiscom
      ? (s) => {
          const L = overlayLayerIds(def.id);
          const f = discomFilter(s.layers.discoms);
          return { [L.line]: { filter: f }, [L.circle]: { filter: f }, [L.label]: { filter: f } };
        }
      : undefined,
  };
}

// ---- DISCOM focus highlight (amber; a network-search pick or a TRANSCO SS's downstream) -------
export const FOCUS_COLOR = "#f59e0b"; // amber — distinct from every DISCOM/voltage colour
export const FOCUS_LAYER = {
  lines: "ov-focus-lines",
  ss: "ov-focus-ss",
  lines11: "ov-focus-lines11",
  point: "ov-focus-point",
} as const;
const FOCUS_PT_SRC = "ov-focus-point-src";
const idsIn = (ids: string[] | undefined) => e(["in", ["get", "id"], ["literal", ids ?? []]]);

function focusRide(id: string, on: string, layer: (filter: ExpressionSpecification) => LayerSpecification, pick: (f: OverlayFocus | null) => string[] | undefined): LayerDef<S> {
  return {
    id,
    band: "beneath",
    source: { kind: "ride", on: overlaySourceId(on) },
    layers: (s) => [layer(idsIn(pick(s.layers.focus)))],
    visible: () => true,
    spec: (s): MapSpec => ({ [id]: { filter: idsIn(pick(s.layers.focus)) } }),
  };
}

const FOCUS_DEFS: LayerDef<S>[] = [
  focusRide(
    FOCUS_LAYER.lines,
    "discom-lines",
    (filter) => ({
      id: FOCUS_LAYER.lines,
      type: "line",
      source: overlaySourceId("discom-lines"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": FOCUS_COLOR,
        "line-width": e(["interpolate", ["linear"], ["zoom"], 6, 2.5, 10, 4, 14, 7]),
        "line-opacity": 0.9,
      },
      filter,
    }),
    (f) => f?.lines,
  ),
  focusRide(
    FOCUS_LAYER.ss,
    "discom-ss",
    (filter) => ({
      id: FOCUS_LAYER.ss,
      type: "circle",
      source: overlaySourceId("discom-ss"),
      paint: {
        "circle-color": "rgba(0,0,0,0)",
        "circle-radius": e(["interpolate", ["linear"], ["zoom"], 6, 4, 10, 7, 14, 11]),
        "circle-stroke-color": FOCUS_COLOR,
        "circle-stroke-width": 2.5,
      },
      filter,
    }),
    (f) => f?.ss,
  ),
  focusRide(
    FOCUS_LAYER.lines11,
    "discom-11kv-lines",
    (filter) => ({
      id: FOCUS_LAYER.lines11,
      type: "line",
      source: overlaySourceId("discom-11kv-lines"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": FOCUS_COLOR,
        "line-width": e(["interpolate", ["linear"], ["zoom"], 8, 2, 12, 3.5, 16, 6]),
        "line-opacity": 0.95,
      },
      filter,
    }),
    (f) => f?.lines11,
  ),
];

const FOCUS_POINT_DEF: LayerDef<S> = {
  id: FOCUS_LAYER.point,
  band: "top",
  source: {
    kind: "computed",
    id: FOCUS_PT_SRC,
    key: (s) => s.layers.focus?.point?.join(",") ?? "",
    data: (s) => ({
      type: "FeatureCollection",
      features: s.layers.focus?.point
        ? [{ type: "Feature", geometry: { type: "Point", coordinates: s.layers.focus.point }, properties: {} }]
        : [],
    }),
  },
  layers: () => [
    {
      id: FOCUS_LAYER.point,
      type: "circle",
      source: FOCUS_PT_SRC,
      paint: {
        "circle-color": "rgba(245,158,11,0.18)",
        "circle-radius": e(["interpolate", ["linear"], ["zoom"], 8, 7, 14, 12, 18, 16]),
        "circle-stroke-color": FOCUS_COLOR,
        "circle-stroke-width": 3,
      },
    },
  ],
  visible: () => true,
};

const GEOMETRY_RANK = { polygon: 0, line: 1, point: 2 } as const;

/**
 * Every overlay def, bottom → top within its band: polygons, then lines, then points (catalog
 * order within each), then the focus highlight above them all — still beneath the grid; the
 * focus pin tops everything.
 */
export function overlayRegistry(data: (id: string) => FeatureCollection | undefined): (s: S) => LayerDef<S>[] {
  return (s) => {
    const catalog = Object.values(s.layers.defs)
      .map((def, i) => ({ def, i }))
      .sort((a, b) => GEOMETRY_RANK[a.def.geometry] - GEOMETRY_RANK[b.def.geometry] || a.i - b.i)
      .map(({ def }) => catalogDef(def, data));
    return [...catalog, ...FOCUS_DEFS, FOCUS_POINT_DEF];
  };
}
