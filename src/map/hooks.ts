// The imperative bits of the map that are not layers (those are the engine's): the camera
// (one-shot fly / fit requests), the measure tool, the nearest-substation marker and canvas
// resizing. Each hook is a no-op until the map has loaded (`map` = null).
import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import maplibregl, { type LngLatBoundsLike, type Map as MlMap } from "maplibre-gl";
import { generationRes, powerGridRes } from "../data/load.ts";
import { useResourceSnapshot } from "../data/resources.ts";
import type { GridData } from "../data/types.ts";
import { useAppStore } from "../state/store.ts";
import { fitToCircle, flyToFeature } from "./map-helpers.ts";
import { MeasureController } from "./measure.ts";

/** One-shot camera requests: fly to a feature, fit a circle / MIS scope / overlay focus, nearby. */
export function useMapCamera(map: MlMap | null, data: GridData, isHidden: boolean, isFull: boolean): void {
  const flySignal = useAppStore((s) => s.flySignal);
  const circle = useAppStore((s) => s.filters.circle);
  const fitRequest = useAppStore((s) => s.workspaceContext.fit);
  const fitSignal = useAppStore((s) => s.layers.fitSignal);
  const nearbyOrigin = useAppStore((s) => s.nearbyOrigin);
  // A deep-linked plant / power-grid id can only be flown to once its overlay data has loaded.
  const gen = useResourceSnapshot(generationRes).data;
  const pg = useResourceSnapshot(powerGridRes).data;

  useEffect(() => {
    if (map && flySignal) flyToFeature(map, data, gen, pg, flySignal.id);
  }, [map, flySignal, data, gen, pg]);

  // Region slice: zoom to the circle on change. On load a deep-linked circle is fitted unless a
  // fly-to (deep-linked selection) takes the camera.
  const lastCircle = useRef<{ map: MlMap; circle: string | null } | null>(null);
  useEffect(() => {
    if (!map) return;
    const prev = lastCircle.current;
    lastCircle.current = { map, circle };
    if (prev?.map === map) {
      if (prev.circle !== circle) fitToCircle(map, data, circle);
    } else if (circle && !useAppStore.getState().flySignal) fitToCircle(map, data, circle);
  }, [map, circle, data]);

  // Network MIS: fit to the drill-down scope once per new request key.
  const lastFitKey = useRef<string | null>(null);
  useEffect(() => {
    if (!map || isHidden || !fitRequest || fitRequest.key === lastFitKey.current) return;
    lastFitKey.current = fitRequest.key;
    map.fitBounds((fitRequest.bounds ?? data.meta.bounds) as LngLatBoundsLike, { padding: 50, maxZoom: 11, duration: 700 });
  }, [map, fitRequest, data, isHidden]);

  // Overlay focus (network search pick / downstream feeders).
  const lastFitTs = useRef(0);
  useEffect(() => {
    if (!map || !fitSignal || fitSignal.ts === lastFitTs.current) return;
    lastFitTs.current = fitSignal.ts;
    const narrow = map.getContainer().clientWidth < 640;
    map.fitBounds(fitSignal.bounds, {
      padding: narrow ? { top: 190, bottom: 120, left: 20, right: 20 } : { top: 60, bottom: 60, left: 320, right: 380 },
      maxZoom: fitSignal.maxZoom ?? 12,
      duration: 900,
    });
  }, [map, fitSignal]);

  // Nearest-substation origin (GPS / picked point / place search).
  useEffect(() => {
    if (!map || !isFull || !nearbyOrigin?.fly) return;
    const center: [number, number] = [nearbyOrigin.lng, nearbyOrigin.lat];
    if (nearbyOrigin.zoom != null) map.flyTo({ center, zoom: nearbyOrigin.zoom, speed: 1.6, essential: true });
    else map.easeTo({ center, zoom: Math.max(map.getZoom(), 10), duration: 800 });
  }, [map, isFull, nearbyOrigin]);
}

/** The distance / area tool — full (Atlas) mode only. Its layers are re-added via `ref` on style reload. */
export function useMeasure(map: MlMap | null, isFull: boolean, ref: MutableRefObject<MeasureController | null>): void {
  const mode = useAppStore((s) => s.measureMode);
  const clearNonce = useAppStore((s) => s.measureClearNonce);

  useEffect(() => {
    if (!map || !isFull) return;
    const measure = new MeasureController(map, {
      onStats: (s) => useAppStore.getState().setMeasureStats(s),
      onExit: () => useAppStore.getState().setMeasureMode(null),
    });
    measure.setBasemapGetter(() => useAppStore.getState().basemap);
    measure.ensureLayers(useAppStore.getState().basemap);
    ref.current = measure;
    return () => {
      measure.destroy();
      ref.current = null;
      useAppStore.getState().setMeasureMode(null);
    };
  }, [map, isFull, ref]);

  useEffect(() => {
    if (map && isFull) ref.current?.setMode(mode);
  }, [map, isFull, mode, ref]);

  useEffect(() => {
    if (map && isFull && clearNonce) ref.current?.clear();
  }, [map, isFull, clearNonce, ref]);
}

/** The nearest-substation tool: crosshair while picking + the azure origin marker (full mode only). */
export function useNearbyMarker(map: MlMap | null, isFull: boolean): void {
  const nearbyMode = useAppStore((s) => s.nearbyMode);
  const origin = useAppStore((s) => s.nearbyOrigin);
  const marker = useRef<maplibregl.Marker | null>(null);

  useEffect(() => {
    if (!map || !isFull) return;
    if (nearbyMode) map.getCanvas().style.cursor = "crosshair";
    else if (useAppStore.getState().measureMode == null) map.getCanvas().style.cursor = "";
  }, [map, isFull, nearbyMode]);

  useEffect(() => {
    if (!map || !isFull || !origin) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    const lngLat: [number, number] = [origin.lng, origin.lat];
    if (marker.current) {
      marker.current.setLngLat(lngLat);
    } else {
      const el = document.createElement("div");
      el.className = "nearby-dot";
      el.setAttribute("aria-label", "Nearby query origin");
      marker.current = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
    }
  }, [map, isFull, origin]);

  useEffect(
    () => () => {
      marker.current?.remove();
      marker.current = null;
    },
    [map],
  );
}

/**
 * Keep the canvas sized to its container. MapLibre CLEARS + re-renders its GL canvas on every
 * resize(), so calling it each frame of a split-pane drag flickers. Instead the canvas
 * CSS-stretches while the size is changing and one crisp resize() fires once it settles (~90 ms).
 */
export function useMapResize(container: RefObject<HTMLDivElement | null>, map: MlMap | null, mode: string): void {
  useEffect(() => {
    if (!map) return;
    const t = window.setTimeout(() => map.resize(), 50);
    return () => window.clearTimeout(t);
  }, [map, mode]);

  useEffect(() => {
    const el = container.current;
    if (!el || !map || typeof ResizeObserver === "undefined") return;
    let settle = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(settle);
      settle = window.setTimeout(() => map.resize(), 90);
    });
    ro.observe(el);
    return () => {
      window.clearTimeout(settle);
      ro.disconnect();
    };
  }, [container, map]);
}
