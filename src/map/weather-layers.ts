// Live-weather map layers (lazy, like the generation / power-grid overlays) — pure builders + specs;
// the registry (`map/registry/core.ts`) mounts them through the engine:
//   - RainViewer composite rain-radar raster (latest frame; the engine swaps tiles in place)
//   - GDACS cyclone geometry: alert swaths + forecast cone + track + current position
//   - an amber halo on substations that sit inside a forecast cone (filter on the core SS source)
import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";
import type { FilterState } from "../data/selectors.ts";
import type { WeatherData } from "../data/weather.ts";
import { WX_ALERT_COLOR, WX_RISK_COLOR, WX_TRACK_COLOR } from "../theme/palette.ts";
import type { SubstationProps } from "../data/types.ts";
import { assetsInCone } from "../lib/weather.ts";
import { SRC } from "./layers.ts";
import type { MapSpec } from "./spec.ts";

export const WX_SRC = {
  radar: "src-wx-radar",
  cyclone: "src-wx-cyclone",
} as const;

export const WX_LAYER = {
  radar: "wx-radar",
  cycloneAlert: "wx-cyclone-alert",
  cycloneCone: "wx-cyclone-cone",
  cycloneConeOutline: "wx-cyclone-cone-outline",
  cycloneTrack: "wx-cyclone-track",
  cyclonePosition: "wx-cyclone-position",
  riskSubstations: "wx-risk-substations",
} as const;

const e = (x: unknown): ExpressionSpecification => x as ExpressionSpecification;

const alertColor = e([
  "match",
  ["get", "wxLevel"],
  "Red", WX_ALERT_COLOR.Red,
  "Orange", WX_ALERT_COLOR.Orange,
  WX_ALERT_COLOR.Green,
]);

/** Pure: one FeatureCollection with every active cyclone's kept geometry (tagged by `wxKind`). */
export function cycloneFc(weather: WeatherData): FeatureCollection {
  const features: Feature[] = weather.cyclones.flatMap((ev) => ev.geometry.features);
  return { type: "FeatureCollection", features };
}

export const RADAR_SOURCE_OPTIONS = {
  tileSize: 256,
  // RainViewer's free tier serves up to z7; MapLibre overzooms beyond that.
  maxzoom: 7,
  attribution: "Radar © <a href='https://www.rainviewer.com/'>RainViewer</a>",
};

export function radarLayers(): LayerSpecification[] {
  return [{ id: WX_LAYER.radar, type: "raster", source: WX_SRC.radar, paint: { "raster-opacity": RADAR_OPACITY } }];
}

export const RADAR_OPACITY = 0.6;

/** The opacity slider for the radar (`k` 0–1 scales its base opacity). */
export function radarOpacitySpec(k: number): MapSpec {
  return { [WX_LAYER.radar]: { paint: { "raster-opacity": Math.round(RADAR_OPACITY * k * 1000) / 1000 } } };
}

/** Alert swaths + forecast cone fills — beneath the grid so the transmission assets stay legible. */
export function cycloneFillLayers(): LayerSpecification[] {
  return [
    {
      id: WX_LAYER.cycloneAlert,
      type: "fill",
      source: WX_SRC.cyclone,
      filter: e(["==", ["get", "wxKind"], "alert"]),
      paint: { "fill-color": alertColor, "fill-opacity": 0.12 },
    },
    {
      id: WX_LAYER.cycloneCone,
      type: "fill",
      source: WX_SRC.cyclone,
      filter: e(["==", ["get", "wxKind"], "cone"]),
      paint: { "fill-color": WX_TRACK_COLOR, "fill-opacity": 0.08 },
    },
  ];
}

/** Cone outline, track and current position — on top. */
export function cycloneLineLayers(): LayerSpecification[] {
  return [
    {
      id: WX_LAYER.cycloneConeOutline,
      type: "line",
      source: WX_SRC.cyclone,
      filter: e(["==", ["get", "wxKind"], "cone"]),
      paint: { "line-color": WX_TRACK_COLOR, "line-width": 1.4, "line-dasharray": [2, 2], "line-opacity": 0.7 },
    },
    {
      id: WX_LAYER.cycloneTrack,
      type: "line",
      source: WX_SRC.cyclone,
      filter: e(["==", ["get", "wxKind"], "track"]),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": WX_TRACK_COLOR, "line-width": 2.4, "line-opacity": 0.9 },
    },
    {
      id: WX_LAYER.cyclonePosition,
      type: "circle",
      source: WX_SRC.cyclone,
      filter: e(["==", ["get", "wxKind"], "position"]),
      paint: {
        "circle-color": WX_TRACK_COLOR,
        "circle-radius": 6,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    },
  ];
}

/** The amber halo on substations inside a forecast cone (rides the core SS source). */
export function riskSubstationLayers(): LayerSpecification[] {
  return [
    {
      id: WX_LAYER.riskSubstations,
      type: "circle",
      source: SRC.substations,
      filter: e(["in", ["get", "id"], ["literal", []]]),
      paint: {
        "circle-color": "rgba(0,0,0,0)",
        "circle-radius": e(["interpolate", ["linear"], ["zoom"], 5, 7, 10, 11, 14, 15]),
        "circle-stroke-color": WX_RISK_COLOR,
        "circle-stroke-width": 2.5,
        "circle-stroke-opacity": 0.9,
      },
    },
  ];
}

/** Pure: the amber at-risk halo shows exactly the substations inside an active forecast cone. */
export function wxRiskSpec(riskIds: readonly string[]): MapSpec {
  return { [WX_LAYER.riskSubstations]: { filter: ["in", ["get", "id"], ["literal", [...riskIds].sort()]] } };
}

/** Pure: the substations inside any active cyclone's forecast cone (feeds `wxRiskSpec`). */
export function wxRiskIds(weather: WeatherData, substations: SubstationProps[]): string[] {
  const cones = weather.cyclones.flatMap((ev) => ev.conePolygons);
  return cones.length ? assetsInCone(substations, cones).map((s) => s.id) : [];
}

/** Pure: is a weather map layer on? The master toggle × that layer's sub-toggle. */
export function weatherOn(filters: FilterState, layer: "radar" | "cyclone"): boolean {
  return filters.showWeather && filters.wxLayers[layer];
}
