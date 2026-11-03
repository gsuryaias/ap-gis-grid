import type { FeatureCollection } from "geojson";

/** [id, name, discom, km, method, servedSsIds] — see build-data.mts `transco-33kv.json`. */
export type FeederTuple = [string, string | null, string, number, "name" | "proximity" | "feeder-group", string[]];
/** [name, discom, lng, lat] */
export type DiscomSsTuple = [string, string, number, number];

export interface ConnectivityIndex {
  generatedAt: string;
  method: string;
  bySs: Record<string, FeederTuple[]>;
  ss: Record<string, DiscomSsTuple>;
}

const url = (f: string) => `${import.meta.env.BASE_URL}data/${f}`;
export const CONNECTIVITY_CSV_URL = url("transco-33kv-connectivity.csv");

let idx: Promise<ConnectivityIndex> | null = null;
/** TRANSCO SS → 33 kV feeders → 33/11 kV SS index (fetched once, on first need). */
export function loadConnectivity(): Promise<ConnectivityIndex> {
  idx ??= fetch(url("transco-33kv.json")).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json() as Promise<ConnectivityIndex>;
  });
  idx.catch(() => (idx = null)); // allow a retry after a failure
  return idx;
}

let geo: Promise<{ lines: FeatureCollection; ss: FeatureCollection }> | null = null;
/** Full DISCOM geometry (only for GeoJSON downloads). */
export function loadDiscomGeometry(): Promise<{ lines: FeatureCollection; ss: FeatureCollection }> {
  geo ??= Promise.all([
    fetch(url("discom-lines.geojson")).then((r) => r.json() as Promise<FeatureCollection>),
    fetch(url("discom-ss.geojson")).then((r) => r.json() as Promise<FeatureCollection>),
  ]).then(([lines, ss]) => ({ lines, ss }));
  geo.catch(() => (geo = null));
  return geo;
}

export const LINK_METHOD_LABEL: Record<string, string> = {
  name: "recorded source",
  proximity: "feeder end at SS",
  "feeder-group": "same feeder",
};
