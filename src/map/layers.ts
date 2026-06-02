import type { ExpressionSpecification, LayerSpecification, Map as MlMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { FilterState } from "../data/selectors.ts";
import { ENERGY_TYPES, VOLTAGES, type GridData } from "../data/types.ts";
import {
  BULKLOAD_COLOR,
  ENERGY_COLOR,
  POWERGRID_COLOR,
  POWERGRID_HALO,
  RAILWAY_COLOR,
  VOLTAGE_COLOR,
} from "../theme/palette.ts";
import { BASEMAPS, SELECT_HALO } from "./basemaps.ts";
import type { Basemap } from "../state/store.ts";

export const SRC = {
  lines: "src-lines",
  substations: "src-substations",
  generation: "src-generation",
  powergridLines: "src-powergrid-lines",
  powergridSubstations: "src-powergrid-substations",
  railwaySubstations: "src-railway-substations",
  bulkloadSubstations: "src-bulkload-substations",
} as const;
export const LAYER = {
  linesCasing: "grid-lines-casing",
  linesSC: "grid-lines-sc",
  linesDC: "grid-lines-dc",
  substations: "grid-substations",
  ssLabels: "grid-substation-labels",
  generation: "grid-generation",
  genLabels: "grid-generation-labels",
  pgLines: "powergrid-lines",
  pgSubstations: "powergrid-substations",
  pgLabels: "powergrid-labels",
  railwaySubstations: "railway-substations",
  railwayLabels: "railway-labels",
  bulkloadSubstations: "bulkload-substations",
  bulkloadLabels: "bulkload-labels",
} as const;

/** Bound at map load — these layers always exist. (Overlays are bound separately when lazily added.) */
export const INTERACTIVE_LAYERS = [LAYER.linesSC, LAYER.linesDC, LAYER.substations];
/** "Power grid" overlay-group clickable layers (lazily added — all three classes). */
export const POWERGRID_INTERACTIVE = [
  LAYER.pgLines,
  LAYER.pgSubstations,
  LAYER.railwaySubstations,
  LAYER.bulkloadSubstations,
];
/** All clickable layers; filter by existence before querying (overlays may not be loaded yet). */
export const ALL_INTERACTIVE = [...INTERACTIVE_LAYERS, LAYER.generation, ...POWERGRID_INTERACTIVE];

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

// ---- Generation overlay (lazy) ---------------------------------------------
const energyColor = e([
  "match",
  ["get", "energy"],
  "Thermal", ENERGY_COLOR.Thermal,
  "Gas", ENERGY_COLOR.Gas,
  "Hydro", ENERGY_COLOR.Hydro,
  "Solar", ENERGY_COLOR.Solar,
  "Wind", ENERGY_COLOR.Wind,
  ENERGY_COLOR.Other,
]);

const GEN_SEL: unknown = [
  "case",
  ["boolean", ["feature-state", "selected"], false], 1.5,
  ["boolean", ["feature-state", "hover"], false], 1.25,
  1,
];
// Plants run a touch larger than substations so the overlay reads as its own layer.
const genRadius = e([
  "interpolate", ["linear"], ["zoom"],
  5, ["*", 4.2, GEN_SEL],
  10, ["*", 7.5, GEN_SEL],
  14, ["*", 11, GEN_SEL],
]);

function buildGenerationLayers(basemap: Basemap): LayerSpecification[] {
  const def = BASEMAPS[basemap];
  return [
    {
      id: LAYER.generation,
      type: "circle",
      source: SRC.generation,
      paint: {
        "circle-color": energyColor,
        "circle-radius": genRadius,
        // Square-ish read isn't possible with circles, so we lean on a heavy contrasting ring
        // (plus the distinct energy palette) to separate plants from substation dots.
        "circle-stroke-color": e([
          "case",
          ["boolean", ["feature-state", "selected"], false], SELECT_HALO,
          def.ssStroke,
        ]),
        "circle-stroke-width": e([
          "case",
          ["boolean", ["feature-state", "selected"], false], 3.5,
          ["boolean", ["feature-state", "hover"], false], 2.5,
          1.8,
        ]),
        "circle-opacity": 0.96,
      },
    },
    {
      id: LAYER.genLabels,
      type: "symbol",
      source: SRC.generation,
      minzoom: 8,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Open Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 14, 13],
        "text-offset": [0, 1.2],
        "text-anchor": "top",
        "text-optional": true,
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": def.labelColor,
        "text-halo-color": def.labelHalo,
        "text-halo-width": 1.4,
      },
    },
  ] as LayerSpecification[];
}

/** Lazily add the generation source + layers (idempotent — safe to call after every style reload). */
export function addGenerationLayers(map: MlMap, fc: FeatureCollection, basemap: Basemap): void {
  if (!map.getSource(SRC.generation)) {
    map.addSource(SRC.generation, { type: "geojson", data: fc, promoteId: "id" });
  }
  for (const layer of buildGenerationLayers(basemap)) {
    if (!map.getLayer(layer.id)) map.addLayer(layer);
  }
}

// ---- POWERGRID (PGCIL) overlay (lazy) --------------------------------------
// A single rose hue for every feature — the inter-state grid reads as one distinct layer
// (no per-voltage palette here, unlike the AP-TRANSCO grid).
const PG_LINE_SEL: unknown = [
  "case",
  ["boolean", ["feature-state", "selected"], false], 1.7,
  ["boolean", ["feature-state", "hover"], false], 1.3,
  1,
];
const PG_SS_SEL: unknown = [
  "case",
  ["boolean", ["feature-state", "selected"], false], 1.5,
  ["boolean", ["feature-state", "hover"], false], 1.25,
  1,
];
// Slightly bolder than the AP-TRANSCO grid lines so the overlay stands out.
const pgLineWidth = e([
  "interpolate", ["linear"], ["zoom"],
  5, ["*", 1.8, PG_LINE_SEL],
  9, ["*", 3.6, PG_LINE_SEL],
  13, ["*", 7.0, PG_LINE_SEL],
]);
const pgSsRadius = e([
  "interpolate", ["linear"], ["zoom"],
  5, ["*", 4.4, PG_SS_SEL],
  10, ["*", 7.8, PG_SS_SEL],
  14, ["*", 11.5, PG_SS_SEL],
]);

function buildPowerGridLayers(basemap: Basemap): LayerSpecification[] {
  const def = BASEMAPS[basemap];
  return [
    {
      id: LAYER.pgLines,
      type: "line",
      source: SRC.powergridLines,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": POWERGRID_COLOR,
        "line-width": pgLineWidth,
        "line-opacity": e([
          "case",
          ["boolean", ["feature-state", "selected"], false], 1,
          ["boolean", ["feature-state", "hover"], false], 0.95,
          0.85,
        ]),
      },
    },
    {
      id: LAYER.pgSubstations,
      type: "circle",
      source: SRC.powergridSubstations,
      paint: {
        "circle-color": POWERGRID_COLOR,
        "circle-radius": pgSsRadius,
        // Heavy contrasting ring so PowerGrid substations separate clearly from grid dots.
        "circle-stroke-color": e([
          "case",
          ["boolean", ["feature-state", "selected"], false], SELECT_HALO,
          POWERGRID_HALO,
        ]),
        "circle-stroke-width": e([
          "case",
          ["boolean", ["feature-state", "selected"], false], 4,
          ["boolean", ["feature-state", "hover"], false], 3,
          2.2,
        ]),
        "circle-opacity": 0.96,
      },
    },
    {
      id: LAYER.pgLabels,
      type: "symbol",
      source: SRC.powergridSubstations,
      minzoom: 7,
      layout: {
        "text-field": ["coalesce", ["get", "fullName"], ["get", "name"]],
        "text-font": ["Open Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 8, 10, 14, 13],
        "text-offset": [0, 1.2],
        "text-anchor": "top",
        "text-optional": true,
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": def.labelColor,
        "text-halo-color": def.labelHalo,
        "text-halo-width": 1.4,
      },
    },
  ] as LayerSpecification[];
}

// ---- Railway-traction (RTSS) + bulk-load / HT-consumer substations ----------
// Two more classes inside the same lazy "Power grid" group. They're loads (not backbone), so they
// render as solid circles SMALLER than the PowerGrid markers in their own restrained hues.
const LOAD_SEL: unknown = [
  "case",
  ["boolean", ["feature-state", "selected"], false], 1.5,
  ["boolean", ["feature-state", "hover"], false], 1.25,
  1,
];
const loadRadius = e([
  "interpolate", ["linear"], ["zoom"],
  5, ["*", 2.8, LOAD_SEL],
  10, ["*", 4.8, LOAD_SEL],
  14, ["*", 7.2, LOAD_SEL],
]);

/** A small solid-circle point layer (+ its label) for a load class inside the Power grid group. */
function buildLoadLayers(
  basemap: Basemap,
  source: string,
  circleId: string,
  labelId: string,
  color: string,
): LayerSpecification[] {
  const def = BASEMAPS[basemap];
  return [
    {
      id: circleId,
      type: "circle",
      source,
      paint: {
        "circle-color": color,
        "circle-radius": loadRadius,
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
      id: labelId,
      type: "symbol",
      source,
      minzoom: 9.5,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Open Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 10, 9, 14, 12],
        "text-offset": [0, 1.1],
        "text-anchor": "top",
        "text-optional": true,
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": def.labelColor,
        "text-halo-color": def.labelHalo,
        "text-halo-width": 1.4,
      },
    },
  ] as LayerSpecification[];
}

/**
 * Lazily add the whole "Power grid" overlay group — PowerGrid lines+SS plus the railway-traction
 * and bulk-load substation classes (idempotent — safe to call after every style reload).
 */
export function addPowerGridLayers(
  map: MlMap,
  linesFc: FeatureCollection,
  substationsFc: FeatureCollection,
  railwayFc: FeatureCollection,
  bulkloadFc: FeatureCollection,
  basemap: Basemap,
): void {
  if (!map.getSource(SRC.powergridLines)) {
    map.addSource(SRC.powergridLines, { type: "geojson", data: linesFc, promoteId: "id" });
  }
  if (!map.getSource(SRC.powergridSubstations)) {
    map.addSource(SRC.powergridSubstations, { type: "geojson", data: substationsFc, promoteId: "id" });
  }
  if (!map.getSource(SRC.railwaySubstations)) {
    map.addSource(SRC.railwaySubstations, { type: "geojson", data: railwayFc, promoteId: "id" });
  }
  if (!map.getSource(SRC.bulkloadSubstations)) {
    map.addSource(SRC.bulkloadSubstations, { type: "geojson", data: bulkloadFc, promoteId: "id" });
  }
  for (const layer of buildPowerGridLayers(basemap)) {
    if (!map.getLayer(layer.id)) map.addLayer(layer);
  }
  const loadLayers = [
    ...buildLoadLayers(basemap, SRC.railwaySubstations, LAYER.railwaySubstations, LAYER.railwayLabels, RAILWAY_COLOR),
    ...buildLoadLayers(basemap, SRC.bulkloadSubstations, LAYER.bulkloadSubstations, LAYER.bulkloadLabels, BULKLOAD_COLOR),
  ];
  for (const layer of loadLayers) {
    if (!map.getLayer(layer.id)) map.addLayer(layer);
  }
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
        "text-font": ["Open Sans Bold"], // CARTO + satellite glyph servers both provide this
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
  // Regional slice (core network): both lines and substations carry `circle`.
  const circleParts: unknown[] = filters.circle ? [["==", ["get", "circle"], filters.circle]] : [];

  if (map.getLayer(LAYER.linesCasing))
    map.setFilter(LAYER.linesCasing, e(["all", voltFilter, circuitFilter, ...circleParts]));
  if (map.getLayer(LAYER.linesSC))
    map.setFilter(LAYER.linesSC, e(["all", ["==", ["get", "circuit"], "SC"], voltFilter, ...circleParts]));
  if (map.getLayer(LAYER.linesDC))
    map.setFilter(LAYER.linesDC, e(["all", ["==", ["get", "circuit"], "DC"], voltFilter, ...circleParts]));
  if (map.getLayer(LAYER.substations)) map.setFilter(LAYER.substations, e(["all", voltFilter, ...circleParts]));
  if (map.getLayer(LAYER.ssLabels)) map.setFilter(LAYER.ssLabels, e(["all", voltFilter, ...circleParts]));

  const vis = (on: boolean) => (on ? "visible" : "none");
  const set = (id: string, on: boolean) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis(on));
  };
  set(LAYER.linesCasing, filters.showLines);
  set(LAYER.linesSC, filters.showLines && filters.circuits.SC);
  set(LAYER.linesDC, filters.showLines && filters.circuits.DC);
  set(LAYER.substations, filters.showSubstations);
  set(LAYER.ssLabels, filters.showSubstations);

  // Generation overlay (only present once lazily added).
  if (map.getLayer(LAYER.generation)) {
    const enabledTypes = ENERGY_TYPES.filter((t) => filters.genTypes[t]);
    const genFilter = e(["in", ["get", "energy"], ["literal", enabledTypes]]);
    map.setFilter(LAYER.generation, genFilter);
    map.setFilter(LAYER.genLabels, genFilter);
    set(LAYER.generation, filters.showGeneration);
    set(LAYER.genLabels, filters.showGeneration);
  }

  // "Power grid" overlay group: master gate × per-class sub-toggle (independent of voltage/circuit).
  const pgOn = filters.showPowerGrid;
  set(LAYER.pgLines, pgOn && filters.pgClasses.powergrid);
  set(LAYER.pgSubstations, pgOn && filters.pgClasses.powergrid);
  set(LAYER.pgLabels, pgOn && filters.pgClasses.powergrid);
  set(LAYER.railwaySubstations, pgOn && filters.pgClasses.railway);
  set(LAYER.railwayLabels, pgOn && filters.pgClasses.railway);
  set(LAYER.bulkloadSubstations, pgOn && filters.pgClasses.bulkload);
  set(LAYER.bulkloadLabels, pgOn && filters.pgClasses.bulkload);
}
