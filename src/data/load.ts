import type { FeatureCollection } from "geojson";
import { dataUrl, fetchJson } from "./fetch.ts";
import type {
  BulkLoadSubstationProps,
  DataQuality,
  FeatureProps,
  GenerationData,
  GenerationProps,
  GridData,
  LineProps,
  Meta,
  PowerGridData,
  PowerGridLineProps,
  PowerGridProps,
  PowerGridSubstationProps,
  RailwaySubstationProps,
  SearchItem,
  SubstationProps,
} from "./types.ts";

const getJson = <T,>(file: string): Promise<T> => fetchJson<T>(dataUrl(file));

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

/**
 * Fetch the generation-plant overlay. Called lazily — only when the user first enables the
 * layer — so the initial transmission payload stays lean.
 */
export async function loadGeneration(): Promise<GenerationData> {
  const fc = await getJson<FeatureCollection>("generation.geojson");
  const plants = fc.features.map((f) => f.properties as unknown as GenerationProps);
  const byId = new Map<string, GenerationProps>();
  for (const p of plants) byId.set(p.id, p);
  return { plants, fc, byId };
}

/**
 * Fetch the whole lazy "Power grid" overlay group in one shot: POWERGRID (PGCIL) lines +
 * substations, railway-traction substations, and bulk-load / HT-consumer substations. Fetched
 * only when the user first enables the group, so the initial transmission payload stays lean.
 */
export async function loadPowerGrid(): Promise<PowerGridData> {
  const [linesFc, substationsFc, railwayFc, bulkloadFc] = await Promise.all([
    getJson<FeatureCollection>("powergrid-lines.geojson"),
    getJson<FeatureCollection>("powergrid-ss.geojson"),
    getJson<FeatureCollection>("railway-ss.geojson"),
    getJson<FeatureCollection>("bulkload-ss.geojson"),
  ]);
  const lines = linesFc.features.map((f) => f.properties as unknown as PowerGridLineProps);
  const substations = substationsFc.features.map((f) => f.properties as unknown as PowerGridSubstationProps);
  const railway = railwayFc.features.map((f) => f.properties as unknown as RailwaySubstationProps);
  const bulkload = bulkloadFc.features.map((f) => f.properties as unknown as BulkLoadSubstationProps);
  const byId = new Map<string, PowerGridProps>();
  for (const l of lines) byId.set(l.id, l);
  for (const s of substations) byId.set(s.id, s);
  for (const s of railway) byId.set(s.id, s);
  for (const s of bulkload) byId.set(s.id, s);
  return { lines, substations, railway, bulkload, linesFc, substationsFc, railwayFc, bulkloadFc, byId };
}
