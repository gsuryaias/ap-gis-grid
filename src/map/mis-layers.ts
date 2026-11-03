// Network MIS thematic map layers (embedded MapPane, MIS workspace only).
//
// Two layers ride on the CORE sources and are driven by feature-state, so the grid geometry is
// never duplicated:
//   - `mis-line-theme`  — a line layer over the voltage-coloured lines, coloured by `misC`
//                         (class index). Lines without a class stay transparent → voltage shows.
//   - `mis-ss-theme`    — a circle layer under the substation dots: status rings (N-1 role) or
//                         proportional symbols sized by `misV` (33/11 kV substations served).
// Both are filtered to the MIS scope (the drill path) and re-mounted after every style reload.
import type { ExpressionSpecification, Map as MlMap } from "maplibre-gl";
import type { Basemap } from "../state/store.ts";
import { LAYER, SRC } from "./layers.ts";

export const MIS_LAYER = { lines: "mis-line-theme", ss: "mis-ss-theme" } as const;

export type MisTheme = "voltage" | "age" | "n1" | "downstream";
export const MIS_THEMES: MisTheme[] = ["voltage", "age", "n1", "downstream"];

export function isMisTheme(v: unknown): v is MisTheme {
  return typeof v === "string" && (MIS_THEMES as string[]).includes(v);
}

export const MIS_THEME_LABEL: Record<MisTheme, string> = {
  voltage: "Voltage",
  age: "Line age",
  n1: "N-1 exposure",
  downstream: "33 kV load",
};

// Ordinal blue ramp (validated light→dark on white). On dark / satellite basemaps the ramp runs
// the other way so the oldest class is still the one with the most contrast against the ground.
const AGE_LIGHT = ["#86b6ef", "#3987e5", "#1c5cab", "#0d366b"];
const AGE_DARK = ["#184f95", "#3987e5", "#86b6ef", "#cde2fb"];
const AGE_UNKNOWN = "#9aa0a6";
// Status palette (fixed, never themed) — always shown with a text label in the legend.
export const STATUS = { critical: "#d03b3b", serious: "#ec835a" } as const;
export const DOWNSTREAM_COLOR = "#2a78d6";

export interface LegendItem {
  label: string;
  color: string;
  shape: "line" | "ring" | "dot";
}

export function themeLegend(theme: MisTheme, basemap: Basemap): LegendItem[] {
  if (theme === "age") {
    const ramp = basemap === "light" ? AGE_LIGHT : AGE_DARK;
    return [
      { label: "< 15 yrs", color: ramp[0], shape: "line" },
      { label: "15–24 yrs", color: ramp[1], shape: "line" },
      { label: "25–34 yrs", color: ramp[2], shape: "line" },
      { label: "≥ 35 yrs (past useful life)", color: ramp[3], shape: "line" },
      { label: "Year not recorded", color: AGE_UNKNOWN, shape: "line" },
    ];
  }
  if (theme === "n1") {
    return [
      { label: "Bridge line — outage islands SS", color: STATUS.critical, shape: "line" },
      { label: "Cut-point SS — loss splits grid", color: STATUS.critical, shape: "ring" },
      { label: "Single-fed (radial) SS", color: STATUS.serious, shape: "ring" },
    ];
  }
  if (theme === "downstream") {
    return [{ label: "Circle area ∝ 33/11 kV SS served", color: DOWNSTREAM_COLOR, shape: "dot" }];
  }
  return [];
}

/** Per-feature classes/values pushed onto the core sources as feature-state. */
export interface MisMapState {
  theme: MisTheme;
  /** Line id → class index (age band 0–4, or 0 = bridge for N-1). */
  lineClass: Record<string, number>;
  /** SS id → class index (N-1: 0 = cut point, 1 = single-fed). */
  ssClass: Record<string, number>;
  /** SS id → magnitude (33/11 kV SS served) for proportional symbols. */
  ssValue: Record<string, number>;
  /** Scope ids (null = whole network). */
  scopeSsIds: string[] | null;
  scopeLineIds: string[] | null;
}

const e = (x: unknown): ExpressionSpecification => x as ExpressionSpecification;

function lineColor(theme: MisTheme, basemap: Basemap): ExpressionSpecification {
  if (theme === "age") {
    const ramp = basemap === "light" ? AGE_LIGHT : AGE_DARK;
    return e(["match", ["feature-state", "misC"], 0, ramp[0], 1, ramp[1], 2, ramp[2], 3, ramp[3], AGE_UNKNOWN]);
  }
  return e(["literal", STATUS.critical]);
}

const lineWidth = e(["interpolate", ["linear"], ["zoom"], 5, 1.6, 9, 3.4, 13, 6.5]);

export function addMisLayers(map: MlMap): void {
  if (!map.getSource(SRC.lines) || !map.getSource(SRC.substations)) return;
  const beforeSs = map.getLayer(LAYER.substations) ? LAYER.substations : undefined;
  if (!map.getLayer(MIS_LAYER.lines)) {
    map.addLayer(
      {
        id: MIS_LAYER.lines,
        type: "line",
        source: SRC.lines,
        layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
        paint: {
          "line-color": "#000",
          "line-width": lineWidth,
          "line-opacity": e(["case", ["!=", ["feature-state", "misC"], null], 0.95, 0]),
        },
      },
      beforeSs,
    );
  }
  if (!map.getLayer(MIS_LAYER.ss)) {
    map.addLayer(
      {
        id: MIS_LAYER.ss,
        type: "circle",
        source: SRC.substations,
        layout: { visibility: "none" },
        paint: { "circle-radius": 0, "circle-opacity": 0, "circle-stroke-opacity": 0 },
      },
      beforeSs,
    );
  }
}

const prev = new WeakMap<MlMap, { lines: string[]; ss: string[] }>();

function setStates(map: MlMap, source: string, ids: string[], key: string, values: Record<string, number> | null) {
  for (const id of ids) {
    try {
      if (values && values[id] != null) map.setFeatureState({ source, id }, { [key]: values[id] });
      else map.removeFeatureState({ source, id }, key);
    } catch {
      /* feature not present yet (mid style reload) */
    }
  }
}

/**
 * Apply (or clear, with `state = null`) the MIS theme. Idempotent; safe to call after a style
 * reload once `addMisLayers` has re-run.
 */
export function applyMisTheme(map: MlMap, state: MisMapState | null, basemap: Basemap): void {
  if (!map.getLayer(MIS_LAYER.lines) || !map.getLayer(MIS_LAYER.ss)) return;
  const old = prev.get(map) ?? { lines: [], ss: [] };
  setStates(map, SRC.lines, old.lines, "misC", null);
  setStates(map, SRC.substations, old.ss, "misC", null);
  setStates(map, SRC.substations, old.ss, "misV", null);

  const theme = state?.theme ?? "voltage";
  if (!state || theme === "voltage") {
    map.setLayoutProperty(MIS_LAYER.lines, "visibility", "none");
    map.setLayoutProperty(MIS_LAYER.ss, "visibility", "none");
    prev.set(map, { lines: [], ss: [] });
    return;
  }

  const lineIds = Object.keys(state.lineClass);
  const ssIds = [...new Set([...Object.keys(state.ssClass), ...Object.keys(state.ssValue)])];
  setStates(map, SRC.lines, lineIds, "misC", state.lineClass);
  setStates(map, SRC.substations, Object.keys(state.ssClass), "misC", state.ssClass);
  setStates(map, SRC.substations, Object.keys(state.ssValue), "misV", state.ssValue);
  prev.set(map, { lines: lineIds, ss: ssIds });

  const lineFilter = state.scopeLineIds ? e(["in", ["get", "id"], ["literal", state.scopeLineIds]]) : null;
  const ssFilter = state.scopeSsIds ? e(["in", ["get", "id"], ["literal", state.scopeSsIds]]) : null;
  map.setFilter(MIS_LAYER.lines, lineFilter);
  map.setFilter(MIS_LAYER.ss, ssFilter);
  map.setPaintProperty(MIS_LAYER.lines, "line-color", lineColor(theme, basemap));
  map.setLayoutProperty(MIS_LAYER.lines, "visibility", lineIds.length ? "visible" : "none");

  if (theme === "downstream") {
    const has = ["!=", ["feature-state", "misV"], null];
    map.setPaintProperty(MIS_LAYER.ss, "circle-radius", e([
      "case", has, ["+", 3, ["*", 2.4, ["sqrt", ["to-number", ["feature-state", "misV"], 0]]]], 0,
    ]));
    map.setPaintProperty(MIS_LAYER.ss, "circle-color", DOWNSTREAM_COLOR);
    map.setPaintProperty(MIS_LAYER.ss, "circle-opacity", e(["case", has, 0.22, 0]));
    map.setPaintProperty(MIS_LAYER.ss, "circle-stroke-color", DOWNSTREAM_COLOR);
    map.setPaintProperty(MIS_LAYER.ss, "circle-stroke-width", 1.2);
    map.setPaintProperty(MIS_LAYER.ss, "circle-stroke-opacity", e(["case", has, 0.9, 0]));
  } else {
    const has = ["!=", ["feature-state", "misC"], null];
    map.setPaintProperty(MIS_LAYER.ss, "circle-radius", e(["interpolate", ["linear"], ["zoom"], 5, 6.5, 10, 10.5, 14, 15]));
    map.setPaintProperty(MIS_LAYER.ss, "circle-color", "#000");
    map.setPaintProperty(MIS_LAYER.ss, "circle-opacity", 0);
    map.setPaintProperty(MIS_LAYER.ss, "circle-stroke-color", e([
      "match", ["feature-state", "misC"], 0, STATUS.critical, STATUS.serious,
    ]));
    map.setPaintProperty(MIS_LAYER.ss, "circle-stroke-width", 2.5);
    map.setPaintProperty(MIS_LAYER.ss, "circle-stroke-opacity", e(["case", has, 0.95, 0]));
  }
  map.setLayoutProperty(MIS_LAYER.ss, "visibility", ssIds.length ? "visible" : "none");
}
