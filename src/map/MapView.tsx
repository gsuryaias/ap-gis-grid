import { useCallback, useEffect, useRef } from "react";
import maplibregl, { type LngLatBoundsLike, Map as MlMap } from "maplibre-gl";
import type { GenerationData, GridData, PowerGridData } from "../data/types.ts";
import { useAppStore } from "../state/store.ts";
import { BASEMAPS } from "./basemaps.ts";
import {
  addGenerationLayers,
  addGridLayers,
  addPowerGridLayers,
  ALL_INTERACTIVE,
  applyFilters,
  INTERACTIVE_LAYERS,
  LAYER,
  POWERGRID_INTERACTIVE,
  SRC,
} from "./layers.ts";
import { MeasureController } from "./measure.ts";

/** Feature hover/selection is suppressed while a measurement tool is active. */
const isMeasuring = (): boolean => useAppStore.getState().measureMode != null;

function sourceForId(
  data: GridData,
  gen: GenerationData | null,
  pg: PowerGridData | null,
  id: string,
): string | null {
  if (gen?.byId.has(id)) return SRC.generation;
  const pgf = pg?.byId.get(id);
  if (pgf) {
    switch (pgf.kind) {
      case "pg-line":
        return SRC.powergridLines;
      case "pg-substation":
        return SRC.powergridSubstations;
      case "rail-substation":
        return SRC.railwaySubstations;
      case "bulk-substation":
        return SRC.bulkloadSubstations;
    }
  }
  const f = data.byId.get(id);
  if (!f) return null;
  return f.kind === "line" ? SRC.lines : SRC.substations;
}

function setFeatState(
  map: MlMap,
  data: GridData,
  gen: GenerationData | null,
  pg: PowerGridData | null,
  id: string | null,
  key: string,
  value: boolean,
): void {
  if (!id) return;
  const source = sourceForId(data, gen, pg, id);
  if (!source || !map.getSource(source)) return; // overlay source may not be added yet
  try {
    map.setFeatureState({ source, id }, { [key]: value });
  } catch {
    /* feature not yet present (e.g. mid style reload) */
  }
}

function flyToFeature(
  map: MlMap,
  data: GridData,
  gen: GenerationData | null,
  pg: PowerGridData | null,
  id: string,
): void {
  const plant = gen?.byId.get(id);
  if (plant) {
    map.flyTo({ center: [plant.lng, plant.lat], zoom: Math.max(map.getZoom(), 11.5), speed: 1.2, essential: true });
    return;
  }
  const pgf = pg?.byId.get(id);
  if (pgf) {
    // Every Power-grid-group class except the PGCIL lines is a point → flyTo.
    if (pgf.kind !== "pg-line") {
      map.flyTo({ center: [pgf.lng, pgf.lat], zoom: Math.max(map.getZoom(), 11.5), speed: 1.2, essential: true });
      return;
    }
    const lineFeat = pg!.linesFc.features.find((ft) => ft.properties?.id === id);
    if (lineFeat) {
      const b = new maplibregl.LngLatBounds();
      const geom = lineFeat.geometry;
      if (geom.type === "LineString") for (const c of geom.coordinates) b.extend([c[0], c[1]]);
      else if (geom.type === "MultiLineString") for (const ring of geom.coordinates) for (const c of ring) b.extend([c[0], c[1]]);
      if (!b.isEmpty()) map.fitBounds(b, { padding: 140, maxZoom: 12, duration: 900 });
    }
    return;
  }
  const f = data.byId.get(id);
  if (!f) return;
  if (f.kind === "substation") {
    map.flyTo({ center: [f.lng, f.lat], zoom: Math.max(map.getZoom(), 11.5), speed: 1.2, essential: true });
    return;
  }
  const feat = data.linesFc.features.find((ft) => ft.properties?.id === id);
  if (!feat || feat.geometry.type !== "LineString") return;
  const b = new maplibregl.LngLatBounds();
  for (const c of feat.geometry.coordinates) b.extend([c[0], c[1]]);
  map.fitBounds(b, { padding: 140, maxZoom: 13, duration: 900 });
}

export function MapView({ data }: { data: GridData }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const measureRef = useRef<MeasureController | null>(null);
  const readyRef = useRef(false);
  const prevHover = useRef<string | null>(null);
  const prevSelected = useRef<string | null>(null);
  const genBound = useRef(false);
  const pgBound = useRef(false);

  const basemap = useAppStore((s) => s.basemap);
  const filters = useAppStore((s) => s.filters);
  const selectedId = useAppStore((s) => s.selectedId);
  const hoverId = useAppStore((s) => s.hoverId);
  const flySignal = useAppStore((s) => s.flySignal);
  const generation = useAppStore((s) => s.generation);
  const powergrid = useAppStore((s) => s.powergrid);
  const measureMode = useAppStore((s) => s.measureMode);
  const measureClearNonce = useAppStore((s) => s.measureClearNonce);

  // Add the generation source/layers (when loaded) and bind its interaction handlers once.
  // Idempotent: safe to call after the initial load and after every basemap style reload.
  const mountGeneration = useCallback(
    (map: MlMap) => {
      const st = useAppStore.getState();
      if (!st.generation) return;
      addGenerationLayers(map, st.generation.fc, st.basemap);
      applyFilters(map, st.filters);
      setFeatState(map, data, st.generation, st.powergrid, st.selectedId, "selected", true);
      setFeatState(map, data, st.generation, st.powergrid, st.hoverId, "hover", true);
      if (genBound.current) return; // handlers live on the map, so they survive style reloads
      const select = st.select;
      const setHover = st.setHover;
      map.on("mousemove", LAYER.generation, (ev) => {
        if (isMeasuring()) return;
        const f = ev.features?.[0];
        if (f?.id != null) {
          setHover(String(f.id));
          map.getCanvas().style.cursor = "pointer";
        }
      });
      map.on("mouseleave", LAYER.generation, () => {
        if (isMeasuring()) return;
        setHover(null);
        map.getCanvas().style.cursor = "";
      });
      map.on("click", LAYER.generation, (ev) => {
        if (isMeasuring()) return;
        const f = ev.features?.[0];
        if (f?.id != null) select(String(f.id));
      });
      genBound.current = true;
    },
    [data],
  );

  // Add the PowerGrid sources/layers (when loaded) and bind its interaction handlers once.
  // Idempotent: safe after the initial load and after every basemap style reload.
  const mountPowerGrid = useCallback(
    (map: MlMap) => {
      const st = useAppStore.getState();
      if (!st.powergrid) return;
      const pgd = st.powergrid;
      addPowerGridLayers(map, pgd.linesFc, pgd.substationsFc, pgd.railwayFc, pgd.bulkloadFc, st.basemap);
      applyFilters(map, st.filters);
      setFeatState(map, data, st.generation, st.powergrid, st.selectedId, "selected", true);
      setFeatState(map, data, st.generation, st.powergrid, st.hoverId, "hover", true);
      if (pgBound.current) return; // handlers live on the map, so they survive style reloads
      const select = st.select;
      const setHover = st.setHover;
      for (const lid of POWERGRID_INTERACTIVE) {
        map.on("mousemove", lid, (ev) => {
          if (isMeasuring()) return;
          const f = ev.features?.[0];
          if (f?.id != null) {
            setHover(String(f.id));
            map.getCanvas().style.cursor = "pointer";
          }
        });
        map.on("mouseleave", lid, () => {
          if (isMeasuring()) return;
          setHover(null);
          map.getCanvas().style.cursor = "";
        });
        map.on("click", lid, (ev) => {
          if (isMeasuring()) return;
          const f = ev.features?.[0];
          if (f?.id != null) select(String(f.id));
        });
      }
      pgBound.current = true;
    },
    [data],
  );

  // --- Map lifecycle (once) -------------------------------------------------
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
      // 19 is Esri World Imagery's native ceiling (sub-metre over AP towns); the CARTO
      // vector basemaps scale cleanly to it too. Lets users zoom in for site-level detail.
      maxZoom: 19,
    });
    mapRef.current = map;
    genBound.current = false;
    pgBound.current = false;
    const measure = new MeasureController(map, {
      onStats: (s) => useAppStore.getState().setMeasureStats(s),
      onExit: () => useAppStore.getState().setMeasureMode(null),
    });
    measure.setBasemapGetter(() => useAppStore.getState().basemap);
    measureRef.current = measure;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    // CARTO's GL style already carries the mandatory OSM + CARTO attribution, so we let
    // AttributionControl surface it rather than duplicating via customAttribution.
    map.addControl(new maplibregl.AttributionControl({ compact: false }), "bottom-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

    const select = useAppStore.getState().select;
    const setHover = useAppStore.getState().setHover;

    map.on("load", () => {
      if (disposed) return;
      addGridLayers(map, data, useAppStore.getState().basemap);
      applyFilters(map, useAppStore.getState().filters);
      map.fitBounds(data.meta.bounds as LngLatBoundsLike, { padding: 60, duration: 0 });
      readyRef.current = true;

      for (const lid of INTERACTIVE_LAYERS) {
        map.on("mousemove", lid, (ev) => {
          if (isMeasuring()) return;
          const f = ev.features?.[0];
          if (f?.id != null) {
            setHover(String(f.id));
            map.getCanvas().style.cursor = "pointer";
          }
        });
        map.on("mouseleave", lid, () => {
          if (isMeasuring()) return;
          setHover(null);
          map.getCanvas().style.cursor = "";
        });
        map.on("click", lid, (ev) => {
          if (isMeasuring()) return;
          const f = ev.features?.[0];
          if (f?.id != null) select(String(f.id));
        });
      }
      map.on("click", (ev) => {
        if (isMeasuring()) return; // clicks place measurement vertices, not (de)select
        // Only the interactive layers actually present (generation may not be loaded).
        const layers = ALL_INTERACTIVE.filter((l) => map.getLayer(l));
        const hits = map.queryRenderedFeatures(ev.point, { layers });
        if (!hits.length) select(null);
      });

      // apply any deep-linked selection / pending fly
      const st = useAppStore.getState();
      setFeatState(map, data, st.generation, st.powergrid, st.selectedId, "selected", true);
      prevSelected.current = st.selectedId;
      mountGeneration(map); // no-op unless a gen=1 deep link already finished loading
      mountPowerGrid(map); // no-op unless a pg=1 deep link already finished loading
      if (st.flySignal) flyToFeature(map, data, st.generation, st.powergrid, st.flySignal.id);
    });

    return () => {
      disposed = true;
      readyRef.current = false;
      measure.destroy();
      measureRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [data, mountGeneration, mountPowerGrid]);

  // --- Basemap switch -------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const def = BASEMAPS[basemap];
    map.setStyle(def.style);
    const onStyle = () => {
      addGridLayers(map, data, basemap);
      mountGeneration(map); // setStyle drops custom sources/layers — re-add the overlays
      mountPowerGrid(map);
      measureRef.current?.ensureLayers(basemap); // ...same for the measurement overlay
      applyFilters(map, useAppStore.getState().filters);
      const st = useAppStore.getState();
      setFeatState(map, data, st.generation, st.powergrid, st.selectedId, "selected", true);
      setFeatState(map, data, st.generation, st.powergrid, st.hoverId, "hover", true);
    };
    map.once("styledata", onStyle);
  }, [basemap, data, mountGeneration, mountPowerGrid]);

  // --- Measurement tool -----------------------------------------------------
  useEffect(() => {
    if (readyRef.current) measureRef.current?.setMode(measureMode);
  }, [measureMode]);

  useEffect(() => {
    if (measureClearNonce) measureRef.current?.clear();
  }, [measureClearNonce]);

  // --- Filters --------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) applyFilters(map, filters);
  }, [filters]);

  // --- Generation overlay arrives (lazy) ------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current && generation) mountGeneration(map);
  }, [generation, mountGeneration]);

  // --- PowerGrid overlay arrives (lazy) -------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current && powergrid) mountPowerGrid(map);
  }, [powergrid, mountPowerGrid]);

  // --- Selection highlight --------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (prevSelected.current && prevSelected.current !== selectedId)
      setFeatState(map, data, generation, powergrid, prevSelected.current, "selected", false);
    setFeatState(map, data, generation, powergrid, selectedId, "selected", true);
    prevSelected.current = selectedId;
  }, [selectedId, data, generation, powergrid]);

  // --- Hover highlight ------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (prevHover.current && prevHover.current !== hoverId)
      setFeatState(map, data, generation, powergrid, prevHover.current, "hover", false);
    setFeatState(map, data, generation, powergrid, hoverId, "hover", true);
    prevHover.current = hoverId;
  }, [hoverId, data, generation, powergrid]);

  // --- Fly-to ---------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current && flySignal) flyToFeature(map, data, generation, powergrid, flySignal.id);
  }, [flySignal, data, generation, powergrid]);

  // NB: use h-full/w-full, not `absolute inset-0` — MapLibre's unlayered
  // `.maplibregl-map { position: relative }` overrides Tailwind's layered `.absolute`.
  return <div ref={containerRef} className="h-full w-full" aria-label="AP-TRANSCO network map" role="application" />;
}
