// Risk Room map layers (embedded MapPane): indicative IS 875 wind-zone choropleth +
// composite-score halos on core substations. Inserted beneath grid-lines-casing (zones) and
// above SS dots (halos). All scores are INDICATIVE SCREENING VALUES per the honesty convention.
import type { ExpressionSpecification, GeoJSONSource, Map as MlMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { LAYER, SRC } from "./layers.ts";

export const RISK_SRC = { windZones: "src-wind-zones" } as const;

export const RISK_LAYER = {
  windZones: "risk-wind-zones",
  halos: "risk-ss-halos",
} as const;

const e = (x: unknown): ExpressionSpecification => x as ExpressionSpecification;

// Muted wind-zone fills — outside the voltage palette; indicative digitisation only.
const WIND_FILL = e([
  "match",
  ["get", "vb"],
  50,
  "rgba(225, 29, 72, 0.14)",
  44,
  "rgba(245, 158, 11, 0.11)",
  39,
  "rgba(148, 163, 184, 0.09)",
  "rgba(148, 163, 184, 0.06)",
]);

const riskHaloColor = e([
  "case",
  ["!", ["has", ["feature-state", "riskScore"]]],
  "rgba(0,0,0,0)",
  [
    "interpolate",
    ["linear"],
    ["feature-state", "riskScore"],
    0,
    "#94a3b8",
    25,
    "#fbbf24",
    50,
    "#f97316",
    70,
    "#ef4444",
    100,
    "#991b1b",
  ],
]);

const haloWidth = e([
  "case",
  ["boolean", ["feature-state", "highlight"], false],
  3.5,
  ["boolean", ["feature-state", "selected"], false],
  3,
  2,
]);

const haloOpacity = e([
  "case",
  ["boolean", ["feature-state", "highlight"], false],
  1,
  ["boolean", ["feature-state", "selected"], false],
  0.95,
  0.72,
]);

/**
 * Add (or update) the wind-zone choropleth + risk halo layer. Idempotent — re-run after every
 * `styledata` / basemap switch, mirroring the weather / generation overlays.
 */
export function addRiskLayers(map: MlMap, zones: FeatureCollection): void {
  const under = map.getLayer(LAYER.linesCasing) ? LAYER.linesCasing : undefined;

  const wzSrc = map.getSource(RISK_SRC.windZones) as GeoJSONSource | undefined;
  if (!wzSrc) map.addSource(RISK_SRC.windZones, { type: "geojson", data: zones });
  else wzSrc.setData(zones);

  if (!map.getLayer(RISK_LAYER.windZones)) {
    map.addLayer(
      {
        id: RISK_LAYER.windZones,
        type: "fill",
        source: RISK_SRC.windZones,
        paint: { "fill-color": WIND_FILL },
      },
      under,
    );
  }

  if (!map.getLayer(RISK_LAYER.halos) && map.getSource(SRC.substations)) {
    map.addLayer({
      id: RISK_LAYER.halos,
      type: "circle",
      source: SRC.substations,
      paint: {
        "circle-color": "rgba(0,0,0,0)",
        "circle-radius": e(["interpolate", ["linear"], ["zoom"], 5, 8, 10, 12, 14, 16]),
        "circle-stroke-color": riskHaloColor,
        "circle-stroke-width": haloWidth,
        "circle-stroke-opacity": haloOpacity,
      },
    });
  }
}

export function applyRiskVisibility(map: MlMap, visible: boolean): void {
  const vis = visible ? "visible" : "none";
  for (const id of [RISK_LAYER.windZones, RISK_LAYER.halos]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
  }
}

/** Push composite scores onto core substation features via feature-state (`riskScore`). */
export function applyRiskScores(
  map: MlMap,
  scores: Record<string, number> | undefined,
  prevIds: readonly string[],
): void {
  if (!map.getSource(SRC.substations)) return;
  for (const id of prevIds) {
    try {
      map.removeFeatureState({ source: SRC.substations, id }, "riskScore");
    } catch {
      /* feature not yet present (e.g. mid style reload) */
    }
  }
  if (!scores) return;
  for (const [id, score] of Object.entries(scores)) {
    try {
      map.setFeatureState({ source: SRC.substations, id }, { riskScore: score });
    } catch {
      /* feature not yet present */
    }
  }
}
