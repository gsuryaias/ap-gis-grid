import { useCallback, useEffect, useRef } from "react";
import maplibregl, { type LngLatBoundsLike, Map as MlMap } from "maplibre-gl";
import type { GenerationData, GridData } from "../data/types.ts";
import { useAppStore } from "../state/store.ts";
import { BASEMAPS } from "./basemaps.ts";
import { addGenerationLayers, addGridLayers, ALL_INTERACTIVE, applyFilters, INTERACTIVE_LAYERS, LAYER, SRC } from "./layers.ts";

function sourceForId(data: GridData, gen: GenerationData | null, id: string): string | null {
  if (gen?.byId.has(id)) return SRC.generation;
  const f = data.byId.get(id);
  if (!f) return null;
  return f.kind === "line" ? SRC.lines : SRC.substations;
}

function setFeatState(
  map: MlMap,
  data: GridData,
  gen: GenerationData | null,
  id: string | null,
  key: string,
  value: boolean,
): void {
  if (!id) return;
  const source = sourceForId(data, gen, id);
  if (!source || !map.getSource(source)) return; // generation source may not be added yet
  try {
    map.setFeatureState({ source, id }, { [key]: value });
  } catch {
    /* feature not yet present (e.g. mid style reload) */
  }
}

function flyToFeature(map: MlMap, data: GridData, gen: GenerationData | null, id: string): void {
  const plant = gen?.byId.get(id);
  if (plant) {
    map.flyTo({ center: [plant.lng, plant.lat], zoom: Math.max(map.getZoom(), 11.5), speed: 1.2, essential: true });
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
  const readyRef = useRef(false);
  const prevHover = useRef<string | null>(null);
  const prevSelected = useRef<string | null>(null);
  const genBound = useRef(false);

  const basemap = useAppStore((s) => s.basemap);
  const filters = useAppStore((s) => s.filters);
  const selectedId = useAppStore((s) => s.selectedId);
  const hoverId = useAppStore((s) => s.hoverId);
  const flySignal = useAppStore((s) => s.flySignal);
  const generation = useAppStore((s) => s.generation);

  // Add the generation source/layers (when loaded) and bind its interaction handlers once.
  // Idempotent: safe to call after the initial load and after every basemap style reload.
  const mountGeneration = useCallback(
    (map: MlMap) => {
      const st = useAppStore.getState();
      if (!st.generation) return;
      addGenerationLayers(map, st.generation.fc, st.basemap);
      applyFilters(map, st.filters);
      setFeatState(map, data, st.generation, st.selectedId, "selected", true);
      setFeatState(map, data, st.generation, st.hoverId, "hover", true);
      if (genBound.current) return; // handlers live on the map, so they survive style reloads
      const select = st.select;
      const setHover = st.setHover;
      map.on("mousemove", LAYER.generation, (ev) => {
        const f = ev.features?.[0];
        if (f?.id != null) {
          setHover(String(f.id));
          map.getCanvas().style.cursor = "pointer";
        }
      });
      map.on("mouseleave", LAYER.generation, () => {
        setHover(null);
        map.getCanvas().style.cursor = "";
      });
      map.on("click", LAYER.generation, (ev) => {
        const f = ev.features?.[0];
        if (f?.id != null) select(String(f.id));
      });
      genBound.current = true;
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
      maxZoom: 16,
    });
    mapRef.current = map;
    genBound.current = false;

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
          const f = ev.features?.[0];
          if (f?.id != null) {
            setHover(String(f.id));
            map.getCanvas().style.cursor = "pointer";
          }
        });
        map.on("mouseleave", lid, () => {
          setHover(null);
          map.getCanvas().style.cursor = "";
        });
        map.on("click", lid, (ev) => {
          const f = ev.features?.[0];
          if (f?.id != null) select(String(f.id));
        });
      }
      map.on("click", (ev) => {
        // Only the interactive layers actually present (generation may not be loaded).
        const layers = ALL_INTERACTIVE.filter((l) => map.getLayer(l));
        const hits = map.queryRenderedFeatures(ev.point, { layers });
        if (!hits.length) select(null);
      });

      // apply any deep-linked selection / pending fly
      const st = useAppStore.getState();
      setFeatState(map, data, st.generation, st.selectedId, "selected", true);
      prevSelected.current = st.selectedId;
      mountGeneration(map); // no-op unless a gen=1 deep link already finished loading
      if (st.flySignal) flyToFeature(map, data, st.generation, st.flySignal.id);
    });

    return () => {
      disposed = true;
      readyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, [data, mountGeneration]);

  // --- Basemap switch -------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const def = BASEMAPS[basemap];
    map.setStyle(def.style);
    const onStyle = () => {
      addGridLayers(map, data, basemap);
      mountGeneration(map); // setStyle drops custom sources/layers — re-add the overlay
      applyFilters(map, useAppStore.getState().filters);
      const st = useAppStore.getState();
      setFeatState(map, data, st.generation, st.selectedId, "selected", true);
      setFeatState(map, data, st.generation, st.hoverId, "hover", true);
    };
    map.once("styledata", onStyle);
  }, [basemap, data, mountGeneration]);

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

  // --- Selection highlight --------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (prevSelected.current && prevSelected.current !== selectedId)
      setFeatState(map, data, generation, prevSelected.current, "selected", false);
    setFeatState(map, data, generation, selectedId, "selected", true);
    prevSelected.current = selectedId;
  }, [selectedId, data, generation]);

  // --- Hover highlight ------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (prevHover.current && prevHover.current !== hoverId)
      setFeatState(map, data, generation, prevHover.current, "hover", false);
    setFeatState(map, data, generation, hoverId, "hover", true);
    prevHover.current = hoverId;
  }, [hoverId, data, generation]);

  // --- Fly-to ---------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current && flySignal) flyToFeature(map, data, generation, flySignal.id);
  }, [flySignal, data, generation]);

  // NB: use h-full/w-full, not `absolute inset-0` — MapLibre's unlayered
  // `.maplibregl-map { position: relative }` overrides Tailwind's layered `.absolute`.
  return <div ref={containerRef} className="h-full w-full" aria-label="AP-TRANSCO network map" role="application" />;
}
