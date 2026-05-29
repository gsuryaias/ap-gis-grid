import { useEffect, useRef } from "react";
import maplibregl, { type LngLatBoundsLike, Map as MlMap } from "maplibre-gl";
import type { GridData } from "../data/types.ts";
import { useAppStore } from "../state/store.ts";
import { BASEMAPS } from "./basemaps.ts";
import { addGridLayers, applyFilters, INTERACTIVE_LAYERS, SRC } from "./layers.ts";

function sourceForId(data: GridData, id: string): string | null {
  const f = data.byId.get(id);
  if (!f) return null;
  return f.kind === "line" ? SRC.lines : SRC.substations;
}

function setFeatState(map: MlMap, data: GridData, id: string | null, key: string, value: boolean): void {
  if (!id) return;
  const source = sourceForId(data, id);
  if (!source) return;
  try {
    map.setFeatureState({ source, id }, { [key]: value });
  } catch {
    /* feature not yet present (e.g. mid style reload) */
  }
}

function flyToFeature(map: MlMap, data: GridData, id: string): void {
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

  const basemap = useAppStore((s) => s.basemap);
  const filters = useAppStore((s) => s.filters);
  const selectedId = useAppStore((s) => s.selectedId);
  const hoverId = useAppStore((s) => s.hoverId);
  const flySignal = useAppStore((s) => s.flySignal);

  // --- Map lifecycle (once) -------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    const def = BASEMAPS[useAppStore.getState().basemap];
    const map = new MlMap({
      container: containerRef.current,
      style: def.styleUrl,
      center: [80.4, 15.9],
      zoom: 6,
      attributionControl: false,
      minZoom: 4,
      maxZoom: 16,
    });
    mapRef.current = map;

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
        const hits = map.queryRenderedFeatures(ev.point, { layers: INTERACTIVE_LAYERS });
        if (!hits.length) select(null);
      });

      // apply any deep-linked selection / pending fly
      const st = useAppStore.getState();
      setFeatState(map, data, st.selectedId, "selected", true);
      prevSelected.current = st.selectedId;
      if (st.flySignal) flyToFeature(map, data, st.flySignal.id);
    });

    return () => {
      disposed = true;
      readyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, [data]);

  // --- Basemap switch -------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const def = BASEMAPS[basemap];
    map.setStyle(def.styleUrl);
    const onStyle = () => {
      addGridLayers(map, data, basemap);
      applyFilters(map, useAppStore.getState().filters);
      const st = useAppStore.getState();
      setFeatState(map, data, st.selectedId, "selected", true);
      setFeatState(map, data, st.hoverId, "hover", true);
    };
    map.once("styledata", onStyle);
  }, [basemap, data]);

  // --- Filters --------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) applyFilters(map, filters);
  }, [filters]);

  // --- Selection highlight --------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (prevSelected.current && prevSelected.current !== selectedId)
      setFeatState(map, data, prevSelected.current, "selected", false);
    setFeatState(map, data, selectedId, "selected", true);
    prevSelected.current = selectedId;
  }, [selectedId, data]);

  // --- Hover highlight ------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (prevHover.current && prevHover.current !== hoverId)
      setFeatState(map, data, prevHover.current, "hover", false);
    setFeatState(map, data, hoverId, "hover", true);
    prevHover.current = hoverId;
  }, [hoverId, data]);

  // --- Fly-to ---------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current && flySignal) flyToFeature(map, data, flySignal.id);
  }, [flySignal, data]);

  // NB: use h-full/w-full, not `absolute inset-0` — MapLibre's unlayered
  // `.maplibregl-map { position: relative }` overrides Tailwind's layered `.absolute`.
  return <div ref={containerRef} className="h-full w-full" aria-label="AP-TRANSCO network map" role="application" />;
}
