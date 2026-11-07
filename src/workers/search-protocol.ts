// Message contract between data/search-client.ts and workers/search.worker.ts.
import type { NetItem } from "../data/network-search.ts";
import type { SearchHits } from "../data/search-core.ts";

export type SearchOp =
  | { op: "places" }
  | { op: "network" }
  | { op: "search"; q: string }
  | { op: "byRef"; ref: string }
  | { op: "below"; ref: string };

export type SearchResult = { places: number; network: number; search: SearchHits; byRef: NetItem | null; below: NetItem[] };

export type SearchRequest = SearchOp & { id: number; base: string };

/** Errors cross the worker boundary as data; the client rebuilds HttpError/TypeError so retries still work. */
export interface WireError {
  name: string;
  message: string;
  status?: number;
}

export type SearchResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: WireError };
