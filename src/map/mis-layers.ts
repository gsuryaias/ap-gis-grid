// Network MIS thematic map layers (embedded MapPane, MIS workspace only).
//
// Two layers ride on the CORE sources and are driven by feature-state, so the grid geometry is
// never duplicated:
//   - `mis-line-theme`  — a line layer over the voltage-coloured lines, coloured by `misC`
//                         (class index). Lines without a class stay transparent → voltage shows.
//   - `mis-ss-theme`    — a circle layer under the substation dots: status rings (N-1 role) or
//                         proportional symbols sized by `misV` (33/11 kV substations served).
// Both are filtered to the MIS scope (the drill path); the engine re-mounts them after a style reload.
import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import type { Basemap } from "../state/store.ts";
import { SRC } from "./layers.ts";
import type { FeatureStateSpec, MapSpec } from "./spec.ts";

export const MIS_LAYER = { lines: "mis-line-theme", ss: "mis-ss-theme" } as const;

export type MisTheme = "voltage" | "supply" | "age" | "n1" | "downstream";
export const MIS_THEMES: MisTheme[] = ["voltage", "supply", "age", "n1", "downstream"];

export function isMisTheme(v: unknown): v is MisTheme {
  return typeof v === "string" && (MIS_THEMES as string[]).includes(v);
}

export const MIS_THEME_LABEL: Record<MisTheme, string> = {
  voltage: "Voltage",
  supply: "Radial feeds",
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
export const STATUS = { critical: "#d03b3b", serious: "#ec835a", muted: "#9aa0a6" } as const;
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
  if (theme === "supply") {
    return [
      { label: "Single-circuit radial feed", color: STATUS.critical, shape: "line" },
      { label: "Single-corridor (multi-circuit) radial feed", color: STATUS.serious, shape: "line" },
      { label: "Radial SS · single circuit", color: STATUS.critical, shape: "ring" },
      { label: "Radial SS · single corridor", color: STATUS.serious, shape: "ring" },
      { label: "No path to grid", color: STATUS.muted, shape: "ring" },
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
  /** Line id → class index (age band 0–4; N-1: 0 = bridge; supply: 0 = single-circuit, 1 = multi-circuit radial corridor). */
  lineClass: Record<string, number>;
  /** SS id → class index (N-1: 0 = cut point, 1 = single-fed; supply: 0 = radial SC, 1 = radial DC, 2 = unconnected). */
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
  if (theme === "supply") return e(["match", ["feature-state", "misC"], 0, STATUS.critical, STATUS.serious]);
  return e(["literal", STATUS.critical]);
}

const lineWidth = e(["interpolate", ["linear"], ["zoom"], 5, 1.6, 9, 3.4, 13, 6.5]);

/** The two MIS theme layers — both ride on the core sources and start hidden. */
export function misLineLayers(): LayerSpecification[] {
  return [
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
  ];
}

export function misSsLayers(): LayerSpecification[] {
  return [
    {
      id: MIS_LAYER.ss,
      type: "circle",
      source: SRC.substations,
      layout: { visibility: "none" },
      paint: { "circle-radius": 0, "circle-opacity": 0, "circle-stroke-opacity": 0 },
    },
  ];
}

/** Pure: the MIS theme's layer state + the feature-state it puts on the core sources. */
export interface MisThemeSpec {
  layers: MapSpec;
  lines: FeatureStateSpec;
  ss: FeatureStateSpec;
}

/**
 * Pure: the layer + feature-state for a MIS theme (`null` / "voltage" = no theme: both layers
 * hidden, every `misC` / `misV` state cleared).
 */
export function misThemeSpec(state: MisMapState | null, basemap: Basemap): MisThemeSpec {
  const theme = state?.theme ?? "voltage";
  if (!state || theme === "voltage") {
    return {
      layers: { [MIS_LAYER.lines]: { visibility: "none" }, [MIS_LAYER.ss]: { visibility: "none" } },
      lines: { source: SRC.lines, keys: ["misC"], states: {} },
      ss: { source: SRC.substations, keys: ["misC", "misV"], states: {} },
    };
  }

  const lineStates: Record<string, Record<string, number>> = {};
  for (const [id, c] of Object.entries(state.lineClass)) if (c != null) lineStates[id] = { misC: c };
  const ssStates: Record<string, Record<string, number>> = {};
  for (const [id, c] of Object.entries(state.ssClass)) if (c != null) (ssStates[id] ??= {}).misC = c;
  for (const [id, v] of Object.entries(state.ssValue)) if (v != null) (ssStates[id] ??= {}).misV = v;

  let ssPaint: Record<string, unknown>;
  if (theme === "downstream") {
    const has = ["!=", ["feature-state", "misV"], null];
    ssPaint = {
      "circle-radius": ["case", has, ["+", 3, ["*", 2.4, ["sqrt", ["to-number", ["feature-state", "misV"], 0]]]], 0],
      "circle-color": DOWNSTREAM_COLOR,
      "circle-opacity": ["case", has, 0.22, 0],
      "circle-stroke-color": DOWNSTREAM_COLOR,
      "circle-stroke-width": 1.2,
      "circle-stroke-opacity": ["case", has, 0.9, 0],
    };
  } else {
    const has = ["!=", ["feature-state", "misC"], null];
    ssPaint = {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 6.5, 10, 10.5, 14, 15],
      "circle-color": "#000",
      "circle-opacity": 0,
      "circle-stroke-color": ["match", ["feature-state", "misC"], 0, STATUS.critical, 1, STATUS.serious, STATUS.muted],
      "circle-stroke-width": 2.5,
      "circle-stroke-opacity": ["case", has, 0.95, 0],
    };
  }

  return {
    layers: {
      [MIS_LAYER.lines]: {
        filter: state.scopeLineIds ? ["in", ["get", "id"], ["literal", state.scopeLineIds]] : null,
        paint: { "line-color": lineColor(theme, basemap) },
        visibility: Object.keys(lineStates).length ? "visible" : "none",
      },
      [MIS_LAYER.ss]: {
        filter: state.scopeSsIds ? ["in", ["get", "id"], ["literal", state.scopeSsIds]] : null,
        paint: ssPaint,
        visibility: Object.keys(ssStates).length ? "visible" : "none",
      },
    },
    lines: { source: SRC.lines, keys: ["misC"], states: lineStates },
    ss: { source: SRC.substations, keys: ["misC", "misV"], states: ssStates },
  };
}
