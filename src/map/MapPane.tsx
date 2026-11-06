// The one map. Layers are registry defs (`registry/core.ts` + `registry/overlays.ts`) kept in sync
// by the engine (`engine.ts`); taps and hover go through the one interaction handler
// (`interaction.ts`); the camera, measure tool, nearby marker and resizing are hooks (`hooks.ts`).
// This component only owns the MapLibre instance and wires those together.
import { useEffect, useRef, useState } from "react";
import maplibregl, { Map as MlMap, type LngLatBoundsLike } from "maplibre-gl";
import { generationRes, powerGridRes } from "../data/load.ts";
import { useResource } from "../data/resources.ts";
import type { GridData } from "../data/types.ts";
import { weatherRes } from "../data/weather.ts";
import { overlayView } from "../overlays/resources.ts";
import { useAppStore } from "../state/store.ts";
import type { AppState } from "../state/types.ts";
import { BASEMAPS } from "./basemaps.ts";
import { attachEngine, type Engine } from "./engine.ts";
import { useMapCamera, useMapResize, useMeasure, useNearbyMarker } from "./hooks.ts";
import { attachInteraction } from "./interaction.ts";
import type { LayerPreset } from "./layer-presets.ts";
import type { MeasureController } from "./measure.ts";
import { mapRegistry, type MapState } from "./registry/core.ts";

export type MapPaneMode = "full" | "embedded" | "hidden";

export interface MapPaneProps {
  data: GridData;
  mode: MapPaneMode;
  layers: LayerPreset;
}

/** Feature hover/selection is suppressed while a click-capturing tool is active. */
const clickSuppressed = (): boolean => {
  const s = useAppStore.getState();
  return s.measureMode != null || s.nearbyMode;
};

/** The store fields the map's defs read — a change to anything else (e.g. a panel) never reconciles. */
const MAP_INPUTS: ((s: AppState) => unknown)[] = [
  (s) => s.filters,
  (s) => s.basemap,
  (s) => s.selectedId,
  (s) => s.hoverId,
  (s) => s.spotlight,
  (s) => s.lens,
  (s) => s.workspaceContext.misMap,
  (s) => s.layers,
];

function subscribeMapInputs(fn: () => void): () => void {
  const unsubs = [
    useAppStore.subscribe((s, prev) => {
      if (MAP_INPUTS.some((get) => get(s) !== get(prev))) fn();
    }),
    // Lazy overlay data landing (or refreshing) — observed passively, never loaded from here.
    generationRes.subscribe("", fn, { passive: true }),
    powerGridRes.subscribe("", fn, { passive: true }),
    weatherRes.subscribe("", fn, { passive: true }),
  ];
  return () => unsubs.forEach((u) => u());
}

const registry = mapRegistry((id) => overlayView.peek(id));

export function MapPane({ data, mode, layers }: MapPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const measureRef = useRef<MeasureController | null>(null);
  const presetRef = useRef(layers);
  presetRef.current = layers;
  const hiddenRef = useRef(mode === "hidden");
  hiddenRef.current = mode === "hidden";
  const [map, setMap] = useState<MlMap | null>(null);
  const isFull = mode === "full";
  const isHidden = mode === "hidden";

  // Whoever draws lazy data loads it: the overlays load while switched on (weather re-polls).
  const filters = useAppStore((s) => s.filters);
  useResource(generationRes, filters.showGeneration ? "" : null);
  useResource(powerGridRes, filters.showPowerGrid ? "" : null);
  useResource(weatherRes, filters.showWeather ? "" : null);

  // --- Map lifecycle (once per data — survives lens / mode switches) ----
  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    const m = new MlMap({
      container: containerRef.current,
      style: BASEMAPS[useAppStore.getState().basemap].style,
      center: [80.4, 15.9],
      zoom: 6,
      attributionControl: false,
      minZoom: 4,
      maxZoom: 19,
      // Resizing is ours (useMapResize, debounced) — MapLibre's own fires on every frame of a drag.
      trackResize: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    m.addControl(new maplibregl.AttributionControl({ compact: false }), "bottom-right");
    m.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

    let detachInteraction: (() => void) | null = null;
    m.on("load", () => {
      if (disposed) return;
      const getState = (): MapState => ({
        app: useAppStore.getState(),
        data,
        gen: generationRes.peek(),
        pg: powerGridRes.peek(),
        wx: weatherRes.peek(),
        preset: presetRef.current,
      });
      const engine = attachEngine(m, {
        getState,
        subscribe: subscribeMapInputs,
        defs: registry,
        // setStyle dropped every custom layer: the engine re-mounts its own; the measure tool's too.
        onStyleReload: () => measureRef.current?.ensureLayers(useAppStore.getState().basemap),
      });
      engineRef.current = engine;
      detachInteraction = attachInteraction(m, { defs: engine.defs, suppressed: clickSuppressed });
      // A link's camera (`@lng,lat,zoom`) wins; otherwise fit AP — on phones into what the
      // search/tools stack (top) and the bottom sheet title row leave visible.
      const linked = useAppStore.getState().cameraSignal?.camera;
      const narrow = (containerRef.current?.clientWidth ?? 1024) < 640;
      if (linked) m.jumpTo({ center: [linked.lng, linked.lat], zoom: linked.zoom });
      else
        m.fitBounds(data.meta.bounds as LngLatBoundsLike, {
          padding: narrow ? { top: 130, bottom: 100, left: 12, right: 12 } : 60,
          duration: 0,
        });
      // The settled camera goes to the URL (replace, debounced) — not while the pane is hidden.
      m.on("moveend", () => {
        if (!hiddenRef.current) useAppStore.getState().setCamera({ ...m.getCenter(), zoom: m.getZoom() });
      });
      // End-to-end test hook (e2e/*.spec.ts) — only exposed when the page is opened with `?e2e`.
      if (new URLSearchParams(window.location.search).has("e2e")) (window as unknown as { __map?: MlMap }).__map = m;
      setMap(m);
    });

    return () => {
      disposed = true;
      setMap(null);
      engineRef.current?.detach();
      engineRef.current = null;
      detachInteraction?.();
      m.remove();
    };
  }, [data]);

  // Basemap switch: the engine re-mounts every def on the new style's `styledata`.
  const basemap = useAppStore((s) => s.basemap);
  const styled = useRef<{ map: MlMap; basemap: string } | null>(null);
  useEffect(() => {
    if (!map) return;
    if (styled.current?.map === map && styled.current.basemap !== basemap) map.setStyle(BASEMAPS[basemap].style);
    styled.current = { map, basemap };
  }, [map, basemap]);

  // A different lens preset can mount different layer groups.
  useEffect(() => engineRef.current?.schedule(), [layers]);

  useMapCamera(map, data, isHidden, isFull);
  useMeasure(map, isFull, measureRef);
  useNearbyMarker(map, isFull);
  useMapResize(containerRef, map, mode);

  return (
    <div
      className={isHidden ? "pointer-events-none invisible h-full w-full" : "relative h-full w-full"}
      aria-hidden={isHidden}
    >
      <div ref={containerRef} className="h-full w-full" aria-label="AP-TRANSCO network map" role="application" />
    </div>
  );
}
