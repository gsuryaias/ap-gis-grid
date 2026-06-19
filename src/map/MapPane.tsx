import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl, { Map as MlMap, type LngLatBoundsLike } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { GridData } from "../data/types.ts";
import { useAppStore } from "../state/store.ts";
import { graphAnalysis, spotlightFor, type SpotlightSets } from "../data/graph-data.ts";
import { assetsInCone } from "../lib/weather.ts";
import { loadWindZones } from "../workspaces/risk/model.ts";
import { BASEMAPS } from "./basemaps.ts";
import type { LayerPreset } from "./layer-presets.ts";
import {
  addGenerationLayers,
  addGridLayers,
  addPowerGridLayers,
  addRiskLayers,
  addWeatherLayers,
  ALL_INTERACTIVE,
  applyFilters,
  applyRiskScores,
  applyRiskVisibility,
  applySpotlight,
  applyWeatherVisibility,
  INTERACTIVE_LAYERS,
  LAYER,
  POWERGRID_INTERACTIVE,
  WX_LAYER,
} from "./layer-presets.ts";
import { fitToCircle, flyToFeature, setFeatState } from "./map-helpers.ts";
import { MeasureController } from "./measure.ts";

/** Module-level handle for the live map instance (embedded or full). */
let liveMap: MlMap | null = null;

/** Capture the current map canvas as a PNG data URL (null when no map is mounted). */
export async function captureMapSnapshot(): Promise<string | null> {
  const map = liveMap;
  if (!map) return null;
  try {
    map.triggerRepaint();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return map.getCanvas().toDataURL("image/png");
  } catch {
    return null;
  }
}

export type MapPaneMode = "full" | "embedded" | "hidden";

/** Optional choropleth paint on core substations (feature `property` → colour stops). */
export interface ChoroplethSource {
  property: string;
  stops: [string | number, string][];
}

export interface MapPaneProps {
  data: GridData;
  mode: MapPaneMode;
  layers: LayerPreset;
  interactive: boolean;
  highlightIds?: string[];
  choroplethSource?: ChoroplethSource;
}

/** Feature hover/selection is suppressed while a click-capturing tool is active. */
const clickSuppressed = (): boolean => {
  const s = useAppStore.getState();
  return s.measureMode != null || s.nearbyMode;
};

function choroplethColor(src: ChoroplethSource): unknown {
  const pairs: unknown[] = ["match", ["get", src.property]];
  for (const [value, color] of src.stops) pairs.push(value, color);
  pairs.push("#888888");
  return pairs;
}

const CYCLONE_LAYERS = [
  WX_LAYER.cycloneAlert,
  WX_LAYER.cycloneCone,
  WX_LAYER.cycloneConeOutline,
  WX_LAYER.cycloneTrack,
  WX_LAYER.cyclonePosition,
  WX_LAYER.riskSubstations,
] as const;

/** In Risk Room, GDACS cone geometry is shown only under the Active event scenario. */
function applyWeatherLayersVisibility(map: MlMap, showCycloneInRisk: boolean): void {
  const st = useAppStore.getState();
  applyWeatherVisibility(map, st.filters);
  if (st.workspace !== "risk" || showCycloneInRisk) return;
  for (const id of CYCLONE_LAYERS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
  }
}

export function MapPane({ data, mode, layers, interactive, highlightIds, choroplethSource }: MapPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const measureRef = useRef<MeasureController | null>(null);
  const nearbyMarkerRef = useRef<maplibregl.Marker | null>(null);
  const readyRef = useRef(false);
  const prevHover = useRef<string | null>(null);
  const prevSelected = useRef<string | null>(null);
  const prevHighlights = useRef<string[]>([]);
  const prevRiskScoreIds = useRef<string[]>([]);
  const prevCircle = useRef<string | null>(null);
  const genBound = useRef(false);
  const pgBound = useRef(false);
  const interactiveBound = useRef(false);
  const [windZones, setWindZones] = useState<FeatureCollection | null>(null);

  const isFull = mode === "full";
  const isHidden = mode === "hidden";

  const basemap = useAppStore((s) => s.basemap);
  const filters = useAppStore((s) => s.filters);
  const selectedId = useAppStore((s) => s.selectedId);
  const hoverId = useAppStore((s) => s.hoverId);
  const flySignal = useAppStore((s) => s.flySignal);
  const generation = useAppStore((s) => s.generation);
  const powergrid = useAppStore((s) => s.powergrid);
  const weather = useAppStore((s) => s.weather);
  const measureMode = useAppStore((s) => s.measureMode);
  const measureClearNonce = useAppStore((s) => s.measureClearNonce);
  const regionCircle = useAppStore((s) => s.filters.circle);
  const nearbyMode = useAppStore((s) => s.nearbyMode);
  const nearbyOrigin = useAppStore((s) => s.nearbyOrigin);
  const spotlight = useAppStore((s) => s.spotlight);
  const workspaceContext = useAppStore((s) => s.workspaceContext);
  const workspace = useAppStore((s) => s.workspace);

  const currentSpotlight = useCallback((): SpotlightSets | null => {
    const st = useAppStore.getState();
    if (!st.spotlight || !st.selectedId) return null;
    const f = data.byId.get(st.selectedId);
    if (!f || f.kind === "generation") return null;
    return spotlightFor(graphAnalysis(data), f);
  }, [data]);

  const riskScenario = workspaceContext.scenario ?? workspaceContext.hazard;
  const showCycloneInRisk =
    riskScenario === "active" && (weather?.cyclones.some((c) => c.conePolygons.length > 0) ?? false);

  useEffect(() => {
    if (workspace !== "risk") {
      setWindZones(null);
      return;
    }
    let on = true;
    loadWindZones()
      .then((z) => on && setWindZones(z))
      .catch(() => on && setWindZones(null));
    return () => {
      on = false;
    };
  }, [workspace]);

  const mountRisk = useCallback(
    (map: MlMap) => {
      if (workspace !== "risk" || !windZones) {
        applyRiskVisibility(map, false);
        return;
      }
      addRiskLayers(map, windZones);
      applyRiskVisibility(map, true);
      applyRiskScores(map, workspaceContext.riskScores, prevRiskScoreIds.current);
      prevRiskScoreIds.current = workspaceContext.riskScores ? Object.keys(workspaceContext.riskScores) : [];
    },
    [workspace, windZones, workspaceContext.riskScores],
  );

  const mountGeneration = useCallback(
    (map: MlMap) => {
      if (!layers.generation) return;
      const st = useAppStore.getState();
      if (!st.generation) return;
      addGenerationLayers(map, st.generation.fc, st.basemap);
      applyFilters(map, st.filters);
      setFeatState(map, data, st.generation, st.powergrid, st.selectedId, "selected", true);
      setFeatState(map, data, st.generation, st.powergrid, st.hoverId, "hover", true);
      if (!interactive || genBound.current) return;
      const select = st.select;
      const setHover = st.setHover;
      map.on("mousemove", LAYER.generation, (ev) => {
        if (clickSuppressed()) return;
        const f = ev.features?.[0];
        if (f?.id != null) {
          setHover(String(f.id));
          map.getCanvas().style.cursor = "pointer";
        }
      });
      map.on("mouseleave", LAYER.generation, () => {
        if (clickSuppressed()) return;
        setHover(null);
        map.getCanvas().style.cursor = "";
      });
      map.on("click", LAYER.generation, (ev) => {
        if (clickSuppressed()) return;
        const f = ev.features?.[0];
        if (f?.id != null) select(String(f.id));
      });
      genBound.current = true;
    },
    [data, interactive, layers.generation],
  );

  const mountPowerGrid = useCallback(
    (map: MlMap) => {
      if (!layers.powergrid) return;
      const st = useAppStore.getState();
      if (!st.powergrid) return;
      const pgd = st.powergrid;
      addPowerGridLayers(map, pgd.linesFc, pgd.substationsFc, pgd.railwayFc, pgd.bulkloadFc, st.basemap);
      applyFilters(map, st.filters);
      setFeatState(map, data, st.generation, st.powergrid, st.selectedId, "selected", true);
      setFeatState(map, data, st.generation, st.powergrid, st.hoverId, "hover", true);
      if (!interactive || pgBound.current) return;
      const select = st.select;
      const setHover = st.setHover;
      for (const lid of POWERGRID_INTERACTIVE) {
        map.on("mousemove", lid, (ev) => {
          if (clickSuppressed()) return;
          const f = ev.features?.[0];
          if (f?.id != null) {
            setHover(String(f.id));
            map.getCanvas().style.cursor = "pointer";
          }
        });
        map.on("mouseleave", lid, () => {
          if (clickSuppressed()) return;
          setHover(null);
          map.getCanvas().style.cursor = "";
        });
        map.on("click", lid, (ev) => {
          if (clickSuppressed()) return;
          const f = ev.features?.[0];
          if (f?.id != null) select(String(f.id));
        });
      }
      pgBound.current = true;
    },
    [data, interactive, layers.powergrid],
  );

  const mountWeather = useCallback(
    (map: MlMap) => {
      if (!layers.weather) return;
      const st = useAppStore.getState();
      if (!st.weather) return;
      const cones = st.weather.cyclones.flatMap((ev) => ev.conePolygons);
      const riskIds = cones.length ? assetsInCone(data.substations, cones).map((s) => s.id) : [];
      addWeatherLayers(map, st.weather, riskIds);
      const scenario = st.workspaceContext.scenario ?? st.workspaceContext.hazard;
      const showCy =
        st.workspace !== "risk" ||
        (scenario === "active" && st.weather.cyclones.some((c) => c.conePolygons.length > 0));
      applyWeatherLayersVisibility(map, showCy);
    },
    [data, layers.weather],
  );

  const bindCoreInteractive = useCallback(
    (map: MlMap) => {
      if (!interactive || interactiveBound.current) return;
      const select = useAppStore.getState().select;
      const setHover = useAppStore.getState().setHover;
      for (const lid of INTERACTIVE_LAYERS) {
        map.on("mousemove", lid, (ev) => {
          if (clickSuppressed()) return;
          const f = ev.features?.[0];
          if (f?.id != null) {
            setHover(String(f.id));
            map.getCanvas().style.cursor = "pointer";
          }
        });
        map.on("mouseleave", lid, () => {
          if (clickSuppressed()) return;
          setHover(null);
          map.getCanvas().style.cursor = "";
        });
        map.on("click", lid, (ev) => {
          if (clickSuppressed()) return;
          const f = ev.features?.[0];
          if (f?.id != null) select(String(f.id));
        });
      }
      map.on("click", (ev) => {
        const st2 = useAppStore.getState();
        if (st2.measureMode != null) return;
        if (st2.nearbyMode) {
          st2.setNearbyOrigin({ lng: ev.lngLat.lng, lat: ev.lngLat.lat, label: "Picked point", fly: false });
          return;
        }
        const layerIds = ALL_INTERACTIVE.filter((l) => map.getLayer(l));
        const hits = map.queryRenderedFeatures(ev.point, { layers: layerIds });
        if (!hits.length) select(null);
      });
      interactiveBound.current = true;
    },
    [interactive],
  );

  // --- Map lifecycle (once per data — survives workspace / mode switches) ----
  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    const def = BASEMAPS[useAppStore.getState().basemap];
    const map = new MlMap({
      container: containerRef.current,
      style: def.style,
      center: [80.4, 15.9],
      zoom: 6,
      attributionControl: false,
      minZoom: 4,
      maxZoom: 19,
      // MapLibre's built-in auto-resize fires resize() on EVERY container size change — i.e. every
      // frame of a split-pane drag — and each resize() clears the GL canvas → flicker. We own resize
      // ourselves via the debounced ResizeObserver below (covers drag + window resize + collapse).
      trackResize: false,
    });
    mapRef.current = map;
    liveMap = map;
    genBound.current = false;
    pgBound.current = false;
    interactiveBound.current = false;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new maplibregl.AttributionControl({ compact: false }), "bottom-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

    map.on("load", () => {
      if (disposed) return;
      if (layers.grid) {
        addGridLayers(map, data, useAppStore.getState().basemap);
        applyFilters(map, useAppStore.getState().filters);
        bindCoreInteractive(map);
      }
      map.fitBounds(data.meta.bounds as LngLatBoundsLike, { padding: 60, duration: 0 });
      readyRef.current = true;

      const st = useAppStore.getState();
      setFeatState(map, data, st.generation, st.powergrid, st.selectedId, "selected", true);
      prevSelected.current = st.selectedId;
      prevCircle.current = st.filters.circle;
      mountGeneration(map);
      mountPowerGrid(map);
      mountWeather(map);
      mountRisk(map);
      if (st.flySignal) flyToFeature(map, data, st.generation, st.powergrid, st.flySignal.id);
      else if (st.filters.circle) fitToCircle(map, data, st.filters.circle);
    });

    return () => {
      disposed = true;
      readyRef.current = false;
      measureRef.current?.destroy();
      measureRef.current = null;
      nearbyMarkerRef.current?.remove();
      nearbyMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
      if (liveMap === map) liveMap = null;
    };
  }, [data, bindCoreInteractive, layers.grid, mountGeneration, mountPowerGrid, mountWeather, mountRisk]);

  // --- Risk Room overlays (wind zones + composite halos) --------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    mountRisk(map);
  }, [mountRisk]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || workspace === "risk") return;
    applyRiskVisibility(map, false);
    applyRiskScores(map, undefined, prevRiskScoreIds.current);
    prevRiskScoreIds.current = [];
  }, [workspace]);

  // --- Measure overlay (Atlas / full mode only; attach without remounting map) -
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (isFull && !measureRef.current) {
      const measure = new MeasureController(map, {
        onStats: (s) => useAppStore.getState().setMeasureStats(s),
        onExit: () => useAppStore.getState().setMeasureMode(null),
      });
      measure.setBasemapGetter(() => useAppStore.getState().basemap);
      measure.ensureLayers(useAppStore.getState().basemap);
      measureRef.current = measure;
    } else if (!isFull && measureRef.current) {
      measureRef.current.destroy();
      measureRef.current = null;
      useAppStore.getState().setMeasureMode(null);
    }
  }, [isFull]);

  // Resize when pane visibility / layout changes (split ↔ collapsed ↔ atlas).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const t = window.setTimeout(() => map.resize(), 50);
    return () => window.clearTimeout(t);
  }, [mode, isHidden]);

  // Keep the canvas in sync with container size changes (split-pane drag, window resize).
  // MapLibre CLEARS + re-renders its GL canvas on every resize(), so calling it each animation
  // frame during a drag produces a blank frame each time → flicker. Instead we DEBOUNCE: while the
  // size is actively changing the canvas simply CSS-stretches (smooth, GPU-composited, never
  // cleared); a single crisp resize() fires once motion settles (~90 ms after the last change).
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let settle = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(settle);
      settle = window.setTimeout(() => mapRef.current?.resize(), 90);
    });
    ro.observe(el);
    return () => {
      window.clearTimeout(settle);
      ro.disconnect();
    };
  }, []);

  // Toggle pointer handlers when `interactive` flips (embedded read-only ↔ selectable).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const handlers = interactive
      ? undefined
      : (["dragPan", "dragRotate", "scrollZoom", "boxZoom", "doubleClickZoom", "keyboard", "touchZoomRotate"] as const);
    if (interactive) {
      map.dragPan.enable();
      map.scrollZoom.enable();
      map.doubleClickZoom.enable();
      map.touchZoomRotate.enable();
    } else {
      for (const h of handlers!) map[h].disable();
    }
  }, [interactive]);

  // --- Basemap switch -------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const def = BASEMAPS[basemap];
    map.setStyle(def.style);
    const onStyle = () => {
      if (layers.grid) {
        addGridLayers(map, data, basemap);
        bindCoreInteractive(map);
      }
      mountGeneration(map);
      mountPowerGrid(map);
      mountWeather(map);
      mountRisk(map);
      measureRef.current?.ensureLayers(basemap);
      applyFilters(map, useAppStore.getState().filters);
      applySpotlight(map, currentSpotlight());
      const st = useAppStore.getState();
      setFeatState(map, data, st.generation, st.powergrid, st.selectedId, "selected", true);
      setFeatState(map, data, st.generation, st.powergrid, st.hoverId, "hover", true);
      if (choroplethSource && map.getLayer(LAYER.substations)) {
        map.setPaintProperty(LAYER.substations, "circle-color", choroplethColor(choroplethSource) as maplibregl.ExpressionSpecification);
      }
    };
    map.once("styledata", onStyle);
  }, [basemap, bindCoreInteractive, choroplethSource, currentSpotlight, data, layers.grid, mountGeneration, mountPowerGrid, mountWeather, mountRisk]);

  // --- Choropleth paint (optional workspace overlay) ------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !map.getLayer(LAYER.substations)) return;
    if (choroplethSource) {
      map.setPaintProperty(LAYER.substations, "circle-color", choroplethColor(choroplethSource) as maplibregl.ExpressionSpecification);
    }
  }, [choroplethSource]);

  // --- Measurement tool (full / Atlas mode only) ----------------------------
  useEffect(() => {
    if (!isFull || !readyRef.current) return;
    measureRef.current?.setMode(measureMode);
  }, [isFull, measureMode]);

  useEffect(() => {
    if (!isFull || !measureClearNonce) return;
    measureRef.current?.clear();
  }, [isFull, measureClearNonce]);

  // --- Nearest-substation tool (full mode only) -----------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !isFull) return;
    if (nearbyMode) map.getCanvas().style.cursor = "crosshair";
    else if (useAppStore.getState().measureMode == null) map.getCanvas().style.cursor = "";
  }, [isFull, nearbyMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !isFull || !nearbyOrigin?.fly) return;
    const center: [number, number] = [nearbyOrigin.lng, nearbyOrigin.lat];
    if (nearbyOrigin.zoom != null) map.flyTo({ center, zoom: nearbyOrigin.zoom, speed: 1.6, essential: true });
    else map.easeTo({ center, zoom: Math.max(map.getZoom(), 10), duration: 800 });
  }, [isFull, nearbyOrigin]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !isFull) return;
    if (!nearbyOrigin) {
      nearbyMarkerRef.current?.remove();
      nearbyMarkerRef.current = null;
      return;
    }
    const lngLat: [number, number] = [nearbyOrigin.lng, nearbyOrigin.lat];
    if (nearbyMarkerRef.current) {
      nearbyMarkerRef.current.setLngLat(lngLat);
    } else {
      const el = document.createElement("div");
      el.className = "nearby-dot";
      el.setAttribute("aria-label", "Nearby query origin");
      nearbyMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
    }
  }, [isFull, nearbyOrigin]);

  // --- Filters --------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    applyFilters(map, filters);
    if (layers.weather) applyWeatherLayersVisibility(map, showCycloneInRisk);
  }, [filters, layers.weather, showCycloneInRisk]);

  // --- Workspace context: fly to circle when analysis focus changes ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !workspaceContext.circle) return;
    if (workspaceContext.circle !== prevCircle.current) {
      prevCircle.current = workspaceContext.circle;
      fitToCircle(map, data, workspaceContext.circle);
    }
  }, [workspaceContext.circle, data]);

  // --- Region slice: zoom to the selected circle (or back out) on change ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || prevCircle.current === regionCircle) return;
    prevCircle.current = regionCircle;
    fitToCircle(map, data, regionCircle);
  }, [regionCircle, data]);

  // --- Lazy overlays --------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current && generation && layers.generation) mountGeneration(map);
  }, [generation, layers.generation, mountGeneration]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current && powergrid && layers.powergrid) mountPowerGrid(map);
  }, [powergrid, layers.powergrid, mountPowerGrid]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current && weather && layers.weather) mountWeather(map);
  }, [weather, layers.weather, mountWeather, showCycloneInRisk, riskScenario]);

  // --- Connection spotlight -------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !layers.grid) return;
    applySpotlight(map, currentSpotlight());
  }, [spotlight, selectedId, currentSpotlight, layers.grid]);

  // --- Selection / hover / highlights ---------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (prevSelected.current && prevSelected.current !== selectedId)
      setFeatState(map, data, generation, powergrid, prevSelected.current, "selected", false);
    setFeatState(map, data, generation, powergrid, selectedId, "selected", true);
    prevSelected.current = selectedId;
  }, [selectedId, data, generation, powergrid]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (prevHover.current && prevHover.current !== hoverId)
      setFeatState(map, data, generation, powergrid, prevHover.current, "hover", false);
    setFeatState(map, data, generation, powergrid, hoverId, "hover", true);
    prevHover.current = hoverId;
  }, [hoverId, data, generation, powergrid]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const ids = highlightIds ?? workspaceContext.highlightIds ?? [];
    const gen = generation;
    const pg = powergrid;
    for (const id of prevHighlights.current) {
      if (!ids.includes(id)) setFeatState(map, data, gen, pg, id, "highlight", false);
    }
    for (const id of ids) setFeatState(map, data, gen, pg, id, "highlight", true);
    prevHighlights.current = ids;
  }, [highlightIds, workspaceContext.highlightIds, data, generation, powergrid]);

  // --- Fly-to ---------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current && flySignal) flyToFeature(map, data, generation, powergrid, flySignal.id);
  }, [flySignal, data, generation, powergrid]);

  return (
    <div
      className={isHidden ? "pointer-events-none invisible h-full w-full" : "relative h-full w-full"}
      aria-hidden={isHidden}
    >
      <div ref={containerRef} className="h-full w-full" aria-label="AP-TRANSCO network map" role="application" />
    </div>
  );
}
