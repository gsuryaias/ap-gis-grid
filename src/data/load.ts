import type { FeatureCollection } from "geojson";
import { dataUrl, fetchJson } from "./fetch.ts";
import { defineResource } from "./resources.ts";
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

const getJson = <T,>(file: string, signal?: AbortSignal): Promise<T> => fetchJson<T>(dataUrl(file), signal);

export async function loadGridData(signal?: AbortSignal): Promise<GridData> {
  const [substationsFc, linesFc, meta, quality, searchIndex] = await Promise.all([
    getJson<FeatureCollection>("substations.geojson", signal),
    getJson<FeatureCollection>("lines.geojson", signal),
    getJson<Meta>("meta.json", signal),
    getJson<DataQuality>("data-quality.json", signal),
    getJson<SearchItem[]>("search-index.json", signal),
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
export async function loadGeneration(signal?: AbortSignal): Promise<GenerationData> {
  const fc = await getJson<FeatureCollection>("generation.geojson", signal);
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
export async function loadPowerGrid(signal?: AbortSignal): Promise<PowerGridData> {
  const [linesFc, substationsFc, railwayFc, bulkloadFc] = await Promise.all([
    getJson<FeatureCollection>("powergrid-lines.geojson", signal),
    getJson<FeatureCollection>("powergrid-ss.geojson", signal),
    getJson<FeatureCollection>("railway-ss.geojson", signal),
    getJson<FeatureCollection>("bulkload-ss.geojson", signal),
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

// --- Resources (Atlas 2.0 phase 1): the store keeps no copy of these; read them with
// useResource (loads while mounted) or useResourceSnapshot / .peek() (observe only). ---

/** The core transmission grid (initial payload). The store mirrors it as `data` for sync access. */
export const gridRes = defineResource<GridData>("grid", { load: (_p, signal) => loadGridData(signal) });

/** Generation-plant overlay — loaded only while something needs it (the layer is on, MIS interfaces). */
export const generationRes = defineResource<GenerationData>("generation", { load: (_p, signal) => loadGeneration(signal) });

/** "Power grid" overlay group (PGCIL + railway traction + bulk-load HT) — one load for all four files. */
export const powerGridRes = defineResource<PowerGridData>("powergrid", { load: (_p, signal) => loadPowerGrid(signal) });
