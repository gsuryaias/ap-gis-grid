import type { FeatureCollection } from "geojson";
import type {
  DataQuality,
  FeatureProps,
  GridData,
  LineProps,
  Meta,
  SearchItem,
  SubstationProps,
} from "./types.ts";

/** Resolve a /data asset against the Vite base path (works on GitHub Pages project sites). */
function dataUrl(file: string): string {
  return `${import.meta.env.BASE_URL}data/${file}`;
}

async function getJson<T>(file: string): Promise<T> {
  const res = await fetch(dataUrl(file));
  if (!res.ok) throw new Error(`Failed to load ${file}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export async function loadGridData(): Promise<GridData> {
  const [substationsFc, linesFc, meta, quality, searchIndex] = await Promise.all([
    getJson<FeatureCollection>("substations.geojson"),
    getJson<FeatureCollection>("lines.geojson"),
    getJson<Meta>("meta.json"),
    getJson<DataQuality>("data-quality.json"),
    getJson<SearchItem[]>("search-index.json"),
  ]);

  const substations = substationsFc.features.map((f) => f.properties as unknown as SubstationProps);
  const lines = linesFc.features.map((f) => f.properties as unknown as LineProps);

  const byId = new Map<string, FeatureProps>();
  for (const s of substations) byId.set(s.id, s);
  for (const l of lines) byId.set(l.id, l);

  return { substations, lines, substationsFc, linesFc, byId, meta, quality, searchIndex };
}
