// Live-weather map layers (lazy, like the generation / power-grid overlays):
//   - RainViewer composite rain-radar raster (latest frame, swapped in place on refresh)
//   - GDACS cyclone geometry: alert swaths + forecast cone + track + current position
//   - an amber halo on substations that sit inside a forecast cone (filter on the core SS source)
// All add functions are idempotent and re-run after every basemap style reload (setStyle drops
// custom sources/layers), mirroring addGenerationLayers / addPowerGridLayers.
import type { ExpressionSpecification, Map as MlMap, RasterTileSource } from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";
import type { GeoJSONSource } from "maplibre-gl";
import type { FilterState } from "../data/selectors.ts";
import type { WeatherData } from "../data/weather.ts";
import { WX_ALERT_COLOR, WX_RISK_COLOR, WX_TRACK_COLOR } from "../theme/palette.ts";
import { LAYER, SRC } from "./layers.ts";

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

/** One FeatureCollection with every active cyclone's kept geometry (tagged by `wxKind`). */
function cycloneFc(weather: WeatherData): FeatureCollection {
  const features: Feature[] = weather.cyclones.flatMap((ev) => ev.geometry.features);
  return { type: "FeatureCollection", features };
}

// The latest radar tile URL per map, so a refresh only swaps tiles when the frame advanced.
const radarUrl = new WeakMap<MlMap, string>();

/**
 * Add (or update) every weather source/layer. Idempotent — call after the lazy fetch resolves,
 * after every `styledata`, and after every auto-refresh. `riskIds` are the substations inside an
 * active forecast cone (computed by the caller from store data).
 */
export function addWeatherLayers(map: MlMap, weather: WeatherData, riskIds: string[]): void {
  // Weather paints UNDER the grid so transmission assets stay legible on top of it.
  const under = map.getLayer(LAYER.linesCasing) ? LAYER.linesCasing : undefined;

  // ---- Rain radar (raster) ----
  if (weather.radar) {
    const src = map.getSource(WX_SRC.radar) as RasterTileSource | undefined;
    if (!src) {
      map.addSource(WX_SRC.radar, {
        type: "raster",
        tiles: [weather.radar.tileUrl],
        tileSize: 256,
        // RainViewer's free tier serves up to z7; MapLibre overzooms beyond that.
        maxzoom: 7,
        attribution: "Radar © <a href='https://www.rainviewer.com/'>RainViewer</a>",
      });
      radarUrl.set(map, weather.radar.tileUrl);
    } else if (radarUrl.get(map) !== weather.radar.tileUrl) {
      src.setTiles([weather.radar.tileUrl]);
      radarUrl.set(map, weather.radar.tileUrl);
    }
    if (!map.getLayer(WX_LAYER.radar)) {
      map.addLayer(
        { id: WX_LAYER.radar, type: "raster", source: WX_SRC.radar, paint: { "raster-opacity": 0.6 } },
        under,
      );
    }
  }

  // ---- Cyclones (geojson) ----
  const fc = cycloneFc(weather);
  const cySrc = map.getSource(WX_SRC.cyclone) as GeoJSONSource | undefined;
  if (!cySrc) map.addSource(WX_SRC.cyclone, { type: "geojson", data: fc });
  else cySrc.setData(fc);

  if (!map.getLayer(WX_LAYER.cycloneAlert)) {
    map.addLayer(
      {
        id: WX_LAYER.cycloneAlert,
        type: "fill",
        source: WX_SRC.cyclone,
        filter: e(["==", ["get", "wxKind"], "alert"]),
        paint: { "fill-color": alertColor, "fill-opacity": 0.12 },
      },
      under,
    );
  }
  if (!map.getLayer(WX_LAYER.cycloneCone)) {
    map.addLayer(
      {
        id: WX_LAYER.cycloneCone,
        type: "fill",
        source: WX_SRC.cyclone,
        filter: e(["==", ["get", "wxKind"], "cone"]),
        paint: { "fill-color": WX_TRACK_COLOR, "fill-opacity": 0.08 },
      },
      under,
    );
  }
  if (!map.getLayer(WX_LAYER.cycloneConeOutline)) {
    map.addLayer({
      id: WX_LAYER.cycloneConeOutline,
      type: "line",
      source: WX_SRC.cyclone,
      filter: e(["==", ["get", "wxKind"], "cone"]),
      paint: { "line-color": WX_TRACK_COLOR, "line-width": 1.4, "line-dasharray": [2, 2], "line-opacity": 0.7 },
    });
  }
  if (!map.getLayer(WX_LAYER.cycloneTrack)) {
    map.addLayer({
      id: WX_LAYER.cycloneTrack,
      type: "line",
      source: WX_SRC.cyclone,
      filter: e(["==", ["get", "wxKind"], "track"]),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": WX_TRACK_COLOR, "line-width": 2.4, "line-opacity": 0.9 },
    });
  }
  if (!map.getLayer(WX_LAYER.cyclonePosition)) {
    map.addLayer({
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
    });
  }

  // ---- At-risk substations (amber halo over the core SS source) ----
  if (!map.getLayer(WX_LAYER.riskSubstations) && map.getSource(SRC.substations)) {
    map.addLayer({
      id: WX_LAYER.riskSubstations,
      type: "circle",
      source: SRC.substations,
      paint: {
        "circle-color": "rgba(0,0,0,0)",
        "circle-radius": e(["interpolate", ["linear"], ["zoom"], 5, 7, 10, 11, 14, 15]),
        "circle-stroke-color": WX_RISK_COLOR,
        "circle-stroke-width": 2.5,
        "circle-stroke-opacity": 0.9,
      },
    });
  }
  if (map.getLayer(WX_LAYER.riskSubstations)) {
    map.setFilter(WX_LAYER.riskSubstations, e(["in", ["get", "id"], ["literal", riskIds]]));
  }
}

/** Gate weather-layer visibility on the master toggle × per-layer sub-toggles. */
export function applyWeatherVisibility(map: MlMap, filters: FilterState): void {
  const set = (id: string, on: boolean) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  };
  const on = filters.showWeather;
  set(WX_LAYER.radar, on && filters.wxLayers.radar);
  const cy = on && filters.wxLayers.cyclone;
  set(WX_LAYER.cycloneAlert, cy);
  set(WX_LAYER.cycloneCone, cy);
  set(WX_LAYER.cycloneConeOutline, cy);
  set(WX_LAYER.cycloneTrack, cy);
  set(WX_LAYER.cyclonePosition, cy);
  set(WX_LAYER.riskSubstations, cy);
}
