import { dataUrl, defineResource, fetchJson } from "./resources.ts";

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

export const CONNECTIVITY_CSV_URL = dataUrl("transco-33kv-connectivity.csv");

/** TRANSCO SS → 33 kV feeders → 33/11 kV SS index (~460 KB, fetched once, on first need). */
export const connectivity = defineResource<ConnectivityIndex>("connectivity", {
  load: (_p, signal) => fetchJson<ConnectivityIndex>(dataUrl("transco-33kv.json"), signal),
});

export const LINK_METHOD_LABEL: Record<string, string> = {
  name: "recorded source",
  proximity: "feeder end at SS",
  "feeder-group": "same feeder",
};
