// Planning Studio map overlays — indicative DC-flow utilisation choropleth, N-1 outage
// preview, and headroom-corridor pulse. Pure paint expressions + feature-state helpers;
// MapPane drives the animation timer and sandbox pick clicks.
import type { ExpressionSpecification, Map as MlMap } from "maplibre-gl";
import type { GridData } from "../data/types.ts";
import { VOLTAGE_COLOR } from "../theme/palette.ts";
import { LAYER, planningSsRadius, SRC } from "./layers.ts";

/** Headroom threshold (%) — corridors at or above this pulse on the map. */
export const HEADROOM_PULSE_PCT = 80;

/** Indicative utilisation colours (outside the voltage palette — screening readout only). */
export const UTIL_COLOR = {
  low: "#16a34a",
  warn: "#f59e0b",
  crit: "#dc2626",
  overload: "#991b1b",
  outage: "#94a3b8",
  islanded: "#dc2626",
} as const;

const e = (x: unknown): ExpressionSpecification => x as ExpressionSpecification;

const voltColor = e([
  "match",
  ["get", "voltage"],
  400,
  VOLTAGE_COLOR[400],
  220,
  VOLTAGE_COLOR[220],
  132,
  VOLTAGE_COLOR[132],
  "#888888",
]);

/** Line colour: indicative utilisation tier when `utilPct` feature-state is set, else voltage. */
export function utilLineColorExpr(): ExpressionSpecification {
  return e([
    "case",
    ["boolean", ["feature-state", "outage"], false],
    UTIL_COLOR.outage,
    ["boolean", ["feature-state", "hasUtil"], false],
    [
      "step",
      ["feature-state", "utilPct"],
      UTIL_COLOR.low,
      HEADROOM_PULSE_PCT,
      UTIL_COLOR.warn,
      100,
      UTIL_COLOR.crit,
    ],
    voltColor,
  ]);
}

/** Compose utilisation / N-1 / pulse modifiers on top of the default line-opacity expression. */
export function utilLineOpacityExpr(baseOpacity: unknown): ExpressionSpecification {
  return e([
    "case",
    ["boolean", ["feature-state", "outage"], false],
    0.28,
    ["boolean", ["feature-state", "pulse"], false],
    0.42,
    baseOpacity,
  ]);
}

/** Substation fill for N-1 islanding and sandbox endpoint markers. */
export function islandedSsColorExpr(): ExpressionSpecification {
  return e([
    "case",
    ["boolean", ["feature-state", "islanded"], false],
    UTIL_COLOR.islanded,
    ["boolean", ["feature-state", "sandboxEndpoint"], false],
    "#7c3aed",
    voltColor,
  ]);
}

export function islandedSsStrokeExpr(baseStroke: unknown): ExpressionSpecification {
  return e([
    "case",
    ["boolean", ["feature-state", "islanded"], false],
    "#fef2f2",
    baseStroke,
  ]);
}

export interface N1Preview {
  outageLineId: string;
  islandedSsIds: string[];
}

let prevUtilIds = new Set<string>();
let prevPulseIds = new Set<string>();
let prevN1: N1Preview | null = null;
let prevSandboxIds = new Set<string>();

/** False when the map has been removed or its style is not yet loaded. */
function mapReady(map: MlMap): boolean {
  try {
    return map.getStyle() != null;
  } catch {
    return false;
  }
}

function clearFeatState(map: MlMap, source: string, id: string, keys: string[]): void {
  if (!mapReady(map) || !map.getSource(source)) return;
  try {
    const state: Record<string, false> = {};
    for (const k of keys) state[k] = false;
    map.setFeatureState({ source, id }, state);
  } catch {
    /* feature not yet present */
  }
}

function setLineState(
  map: MlMap,
  id: string,
  state: Record<string, boolean | number>,
): void {
  if (!mapReady(map) || !map.getSource(SRC.lines)) return;
  try {
    map.setFeatureState({ source: SRC.lines, id }, state);
  } catch {
    /* feature not yet present */
  }
}

function setSsState(map: MlMap, id: string, state: Record<string, boolean>): void {
  if (!mapReady(map) || !map.getSource(SRC.substations)) return;
  try {
    map.setFeatureState({ source: SRC.substations, id }, state);
  } catch {
    /* feature not yet present */
  }
}

/** Push indicative utilisation % onto line features (null → clear util state). */
export function applyUtilisation(
  map: MlMap,
  utilByLine: Record<string, number | null>,
): void {
  const nextIds = new Set(Object.keys(utilByLine));
  for (const id of prevUtilIds) {
    if (!nextIds.has(id)) clearFeatState(map, SRC.lines, id, ["utilPct", "hasUtil"]);
  }
  for (const [id, pct] of Object.entries(utilByLine)) {
    if (pct === null) clearFeatState(map, SRC.lines, id, ["utilPct", "hasUtil"]);
    else setLineState(map, id, { utilPct: pct, hasUtil: true });
  }
  prevUtilIds = nextIds;
}

/** Toggle the pulse flag on headroom corridors (call on a ~600 ms timer). */
export function applyPulsePhase(map: MlMap, lineIds: readonly string[], on: boolean): void {
  const next = new Set(lineIds);
  for (const id of prevPulseIds) {
    if (!next.has(id)) clearFeatState(map, SRC.lines, id, ["pulse"]);
  }
  for (const id of next) setLineState(map, id, { pulse: on });
  prevPulseIds = next;
}

/** Dim the outaged circuit and highlight islanded substations for an N-1 preview. */
export function applyN1Preview(map: MlMap, preview: N1Preview | null): void {
  if (prevN1) {
    clearFeatState(map, SRC.lines, prevN1.outageLineId, ["outage"]);
    for (const id of prevN1.islandedSsIds) clearFeatState(map, SRC.substations, id, ["islanded"]);
  }
  if (preview) {
    setLineState(map, preview.outageLineId, { outage: true });
    for (const id of preview.islandedSsIds) setSsState(map, id, { islanded: true });
  }
  prevN1 = preview;
}

/** Highlight sandbox endpoint substations while the user is picking on the map. */
export function applySandboxMarkers(
  map: MlMap,
  fromId: string | null,
  toId: string | null,
): void {
  const next = new Set([fromId, toId].filter((x): x is string => x != null));
  for (const id of prevSandboxIds) {
    if (!next.has(id)) clearFeatState(map, SRC.substations, id, ["sandboxEndpoint"]);
  }
  for (const id of next) setSsState(map, id, { sandboxEndpoint: true });
  prevSandboxIds = next;
}

interface SavedPaint {
  lines: { color: unknown; opacity: unknown };
  ss: { color: unknown; stroke: unknown; radius: unknown };
}

const savedPaint = new WeakMap<MlMap, SavedPaint>();

/** Swap core grid line/substation paint to planning overlay expressions. */
export function enablePlanningPaint(map: MlMap): void {
  if (!mapReady(map)) return;
  if (!savedPaint.has(map)) {
    savedPaint.set(map, {
      lines: {
        color: map.getPaintProperty(LAYER.linesSC, "line-color"),
        opacity: map.getPaintProperty(LAYER.linesSC, "line-opacity"),
      },
      ss: {
        color: map.getPaintProperty(LAYER.substations, "circle-color"),
        stroke: map.getPaintProperty(LAYER.substations, "circle-stroke-color"),
        radius: map.getPaintProperty(LAYER.substations, "circle-radius"),
      },
    });
  }
  const snap = savedPaint.get(map)!;
  const utilColor = utilLineColorExpr();
  const utilOpacity = utilLineOpacityExpr(snap.lines.opacity ?? 0.95);

  for (const lid of [LAYER.linesSC, LAYER.linesDC]) {
    if (map.getLayer(lid)) {
      map.setPaintProperty(lid, "line-color", utilColor);
      map.setPaintProperty(lid, "line-opacity", utilOpacity);
    }
  }
  if (map.getLayer(LAYER.substations)) {
    map.setPaintProperty(LAYER.substations, "circle-color", islandedSsColorExpr());
    map.setPaintProperty(
      LAYER.substations,
      "circle-stroke-color",
      islandedSsStrokeExpr(snap.ss.stroke ?? "#ffffff"),
    );
    map.setPaintProperty(LAYER.substations, "circle-radius", planningSsRadius);
  }
}

/** Restore default voltage palette paint after leaving Planning Studio. */
export function disablePlanningPaint(map: MlMap): void {
  if (!mapReady(map)) return;
  const snap = savedPaint.get(map);
  if (!snap) return;
  for (const lid of [LAYER.linesSC, LAYER.linesDC]) {
    if (!map.getLayer(lid)) continue;
    map.setPaintProperty(lid, "line-color", snap.lines.color as ExpressionSpecification);
    map.setPaintProperty(lid, "line-opacity", snap.lines.opacity as ExpressionSpecification);
  }
  if (map.getLayer(LAYER.substations)) {
    map.setPaintProperty(LAYER.substations, "circle-color", snap.ss.color as ExpressionSpecification);
    map.setPaintProperty(LAYER.substations, "circle-stroke-color", snap.ss.stroke as ExpressionSpecification);
    map.setPaintProperty(LAYER.substations, "circle-radius", snap.ss.radius as ExpressionSpecification);
  }
  savedPaint.delete(map);
}

/** Clear every planning feature-state key (workspace exit / style reload). */
export function resetPlanningStates(map: MlMap, data: GridData): void {
  if (!mapReady(map)) {
    prevUtilIds = new Set();
    prevPulseIds = new Set();
    prevN1 = null;
    prevSandboxIds = new Set();
    return;
  }
  for (const id of prevUtilIds) clearFeatState(map, SRC.lines, id, ["utilPct", "hasUtil", "pulse", "outage"]);
  for (const id of prevPulseIds) clearFeatState(map, SRC.lines, id, ["pulse"]);
  if (prevN1) {
    clearFeatState(map, SRC.lines, prevN1.outageLineId, ["outage"]);
    for (const id of prevN1.islandedSsIds) clearFeatState(map, SRC.substations, id, ["islanded"]);
  }
  for (const id of prevSandboxIds) clearFeatState(map, SRC.substations, id, ["sandboxEndpoint"]);
  prevUtilIds = new Set();
  prevPulseIds = new Set();
  prevN1 = null;
  prevSandboxIds = new Set();
  void data;
}
