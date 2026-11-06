import maplibregl, { type LngLatBoundsLike, type Map as MlMap } from "maplibre-gl";
import type { GenerationData, GridData, PowerGridData } from "../data/types.ts";
import { SRC } from "./layers.ts";

export function sourceForId(
  data: GridData,
  gen: GenerationData | null | undefined,
  pg: PowerGridData | null | undefined,
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

/**
 * On a phone the search stack covers the top ~130 px and the bottom sheet opens to half height, so a
 * feature is framed in the band between them rather than at the canvas centre.
 */
function framing(map: MlMap): { offset: [number, number]; padding: number | { top: number; bottom: number; left: number; right: number } } {
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  if (w >= 640) return { offset: [0, 0], padding: 140 };
  return { offset: [0, Math.round(65 - h / 4)], padding: { top: 140, bottom: Math.round(h / 2) + 20, left: 24, right: 24 } };
}

export function flyToFeature(
  map: MlMap,
  data: GridData,
  gen: GenerationData | null | undefined,
  pg: PowerGridData | null | undefined,
  id: string,
): void {
  const { offset, padding } = framing(map);
  const plant = gen?.byId.get(id);
  if (plant) {
    map.flyTo({ center: [plant.lng, plant.lat], zoom: Math.max(map.getZoom(), 11.5), speed: 1.2, essential: true, offset });
    return;
  }
  const pgf = pg?.byId.get(id);
  if (pgf) {
    if (pgf.kind !== "pg-line") {
      map.flyTo({ center: [pgf.lng, pgf.lat], zoom: Math.max(map.getZoom(), 11.5), speed: 1.2, essential: true, offset });
      return;
    }
    const lineFeat = pg!.linesFc.features.find((ft) => ft.properties?.id === id);
    if (lineFeat) {
      const b = new maplibregl.LngLatBounds();
      const geom = lineFeat.geometry;
      if (geom.type === "LineString") for (const c of geom.coordinates) b.extend([c[0], c[1]]);
      else if (geom.type === "MultiLineString") for (const ring of geom.coordinates) for (const c of ring) b.extend([c[0], c[1]]);
      if (!b.isEmpty()) map.fitBounds(b, { padding, maxZoom: 12, duration: 900 });
    }
    return;
  }
  const f = data.byId.get(id);
  if (!f) return;
  if (f.kind === "substation") {
    map.flyTo({ center: [f.lng, f.lat], zoom: Math.max(map.getZoom(), 11.5), speed: 1.2, essential: true, offset });
    return;
  }
  const feat = data.linesFc.features.find((ft) => ft.properties?.id === id);
  if (!feat || feat.geometry.type !== "LineString") return;
  const b = new maplibregl.LngLatBounds();
  for (const c of feat.geometry.coordinates) b.extend([c[0], c[1]]);
  map.fitBounds(b, { padding, maxZoom: 13, duration: 900 });
}

/** Fit the map to a circle's substations (or the full network bounds when circle is null). */
export function fitToCircle(map: MlMap, data: GridData, circle: string | null): void {
  if (!circle) {
    map.fitBounds(data.meta.bounds as LngLatBoundsLike, { padding: 60, duration: 700 });
    return;
  }
  const b = new maplibregl.LngLatBounds();
  for (const s of data.substations) if (s.circle === circle) b.extend([s.lng, s.lat]);
  if (!b.isEmpty()) map.fitBounds(b, { padding: 80, maxZoom: 11, duration: 700 });
}
