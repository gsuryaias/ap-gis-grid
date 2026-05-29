import type { ExpressionSpecification, LayerSpecification, Map as MlMap } from "maplibre-gl";
import type { FilterState } from "../data/selectors.ts";
import { VOLTAGES, type GridData } from "../data/types.ts";
import { VOLTAGE_COLOR } from "../theme/palette.ts";
import { BASEMAPS, SELECT_HALO } from "./basemaps.ts";
import type { Basemap } from "../state/store.ts";

export const SRC = { lines: "src-lines", substations: "src-substations" } as const;
export const LAYER = {
  linesCasing: "grid-lines-casing",
  linesSC: "grid-lines-sc",
  linesDC: "grid-lines-dc",
  substations: "grid-substations",
  ssLabels: "grid-substation-labels",
} as const;

export const INTERACTIVE_LAYERS = [LAYER.linesSC, LAYER.linesDC, LAYER.substations];

const e = (x: unknown): ExpressionSpecification => x as ExpressionSpecification;

const voltColor = e([
  "match",
  ["get", "voltage"],
  400, VOLTAGE_COLOR[400],
  220, VOLTAGE_COLOR[220],
  132, VOLTAGE_COLOR[132],
  "#888888",
]);

// MapLibre requires ["zoom"] to be the TOP-LEVEL input of interpolate/step, so the
// feature-state selection factor is folded into each stop output rather than wrapping
// the interpolate (which would be rejected as "zoom may only be a top-level input").
type Quad = [number, number, number, number, number]; // [zoom, v400, v220, v132, default]

const matchV = (a: number, b: number, c: number, d: number): unknown => [
  "match", ["get", "voltage"], 400, a, 220, b, 132, c, d,
];

const LINE_SEL: unknown = [
  "case",
  ["boolean", ["feature-state", "selected"], false], 1.7,
  ["boolean", ["feature-state", "hover"], false], 1.3,
  1,
];
const SS_SEL: unknown = [
  "case",
  ["boolean", ["feature-state", "selected"], false], 1.55,
  ["boolean", ["feature-state", "hover"], false], 1.25,
  1,
];
const CASE_EXTRA: unknown = [
  "case",
  ["boolean", ["feature-state", "selected"], false], 6,
  ["boolean", ["feature-state", "hover"], false], 3,
  1.4,
];

const LINE_STOPS: Quad[] = [
  [5, 1.4, 1.0, 0.6, 1.0],
  [9, 3.0, 2.0, 1.3, 1.5],
  [13, 6.0, 4.2, 2.8, 2.5],
];
const SS_STOPS: Quad[] = [
  [5, 3.6, 2.8, 2.0, 2.4],
  [10, 7.0, 5.4, 3.8, 4.0],
  [14, 11.0, 9.0, 6.8, 6.0],
];

function zoomInterp(stops: Quad[], wrap: (perVoltage: unknown) => unknown): ExpressionSpecification {
  const out: unknown[] = ["interpolate", ["linear"], ["zoom"]];
  for (const [z, a, b, c, d] of stops) out.push(z, wrap(matchV(a, b, c, d)));
  return e(out);
}

const lineWidth = zoomInterp(LINE_STOPS, (v) => ["*", v, LINE_SEL]);
const casingWidth = zoomInterp(LINE_STOPS, (v) => ["+", ["*", v, LINE_SEL], CASE_EXTRA]);
const ssRadius = zoomInterp(SS_STOPS, (v) => ["*", v, SS_SEL]);

function casingColor(def: (typeof BASEMAPS)[Basemap]): ExpressionSpecification {
  return e([
    "case",
    ["boolean", ["feature-state", "selected"], false], SELECT_HALO,
    ["boolean", ["feature-state", "hover"], false], def.hoverCasing,
    def.casing,
  ]);
}

export function buildLayers(basemap: Basemap): LayerSpecification[] {
  const def = BASEMAPS[basemap];
  return [
    {
      id: LAYER.linesCasing,
      type: "line",
      source: SRC.lines,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": casingColor(def),
        "line-width": casingWidth,
        "line-opacity": e([
          "case",
          ["boolean", ["feature-state", "selected"], false], 0.95,
          ["boolean", ["feature-state", "hover"], false], 0.85,
          0.75,
        ]),
      },
    },
    {
      id: LAYER.linesSC,
      type: "line",
      source: SRC.lines,
      filter: e(["==", ["get", "circuit"], "SC"]),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": voltColor, "line-width": lineWidth, "line-opacity": 0.95 },
    },
    {
      id: LAYER.linesDC,
      type: "line",
      source: SRC.lines,
      filter: e(["==", ["get", "circuit"], "DC"]),
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": voltColor,
        "line-width": lineWidth,
        "line-opacity": 0.95,
        "line-dasharray": [2.2, 1.4],
      },
    },
    {
      id: LAYER.substations,
      type: "circle",
      source: SRC.substations,
      paint: {
        "circle-color": voltColor,
        "circle-radius": ssRadius,
        "circle-stroke-color": e([
          "case",
          ["boolean", ["feature-state", "selected"], false], SELECT_HALO,
          def.ssStroke,
        ]),
        "circle-stroke-width": e([
          "case",
          ["boolean", ["feature-state", "selected"], false], 3,
          ["boolean", ["feature-state", "hover"], false], 2,
          1.1,
        ]),
        "circle-opacity": 0.95,
      },
    },
    {
      id: LAYER.ssLabels,
      type: "symbol",
      source: SRC.substations,
      minzoom: 8.5,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Open Sans Semibold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 14, 13],
        "text-offset": [0, 1.1],
        "text-anchor": "top",
        "text-optional": true,
        "text-allow-overlap": false,
        "symbol-sort-key": e(["-", 0, ["get", "voltage"]]),
      },
      paint: {
        "text-color": def.labelColor,
        "text-halo-color": def.labelHalo,
        "text-halo-width": 1.4,
      },
    },
  ] as LayerSpecification[];
}

export function addGridLayers(map: MlMap, data: GridData, basemap: Basemap): void {
  if (!map.getSource(SRC.lines)) {
    map.addSource(SRC.lines, { type: "geojson", data: data.linesFc, promoteId: "id" });
  }
  if (!map.getSource(SRC.substations)) {
    map.addSource(SRC.substations, { type: "geojson", data: data.substationsFc, promoteId: "id" });
  }
  for (const layer of buildLayers(basemap)) {
    if (!map.getLayer(layer.id)) map.addLayer(layer);
  }
}

export function applyFilters(map: MlMap, filters: FilterState): void {
  const enabledV = VOLTAGES.filter((v) => filters.voltages[v]);
  const voltFilter = e(["in", ["get", "voltage"], ["literal", enabledV]]);
  const enabledCircuits = (["SC", "DC"] as const).filter((c) => filters.circuits[c]);
  const circuitFilter = e(["in", ["get", "circuit"], ["literal", enabledCircuits]]);

  if (map.getLayer(LAYER.linesCasing))
    map.setFilter(LAYER.linesCasing, e(["all", voltFilter, circuitFilter]));
  if (map.getLayer(LAYER.linesSC))
    map.setFilter(LAYER.linesSC, e(["all", ["==", ["get", "circuit"], "SC"], voltFilter]));
  if (map.getLayer(LAYER.linesDC))
    map.setFilter(LAYER.linesDC, e(["all", ["==", ["get", "circuit"], "DC"], voltFilter]));
  if (map.getLayer(LAYER.substations)) map.setFilter(LAYER.substations, voltFilter);
  if (map.getLayer(LAYER.ssLabels)) map.setFilter(LAYER.ssLabels, voltFilter);

  const vis = (on: boolean) => (on ? "visible" : "none");
  const set = (id: string, on: boolean) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis(on));
  };
  set(LAYER.linesCasing, filters.showLines);
  set(LAYER.linesSC, filters.showLines && filters.circuits.SC);
  set(LAYER.linesDC, filters.showLines && filters.circuits.DC);
  set(LAYER.substations, filters.showSubstations);
  set(LAYER.ssLabels, filters.showSubstations);
}
