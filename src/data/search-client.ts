// Main-thread side of the search worker. Exposes the two lazy search tiers as resources (so the UI
// gets status/retry/de-dupe from the one loader) plus `searchTiers()` / `lookupNetRef()`.
// If module workers are unavailable (or the worker dies), the same SearchEngine runs in-thread.
import type { NetItem } from "./network-search.ts";
import { dataUrl, fetchJson, HttpError } from "./fetch.ts";
import { defineResource } from "./resources.ts";
import { SearchEngine, type SearchHits } from "./search-core.ts";
import type { SearchOp, SearchRequest, SearchResponse, SearchResult, WireError } from "../workers/search-protocol.ts";

type Pending = { op: SearchOp; resolve: (v: unknown) => void; reject: (e: unknown) => void };

let worker: Worker | null = null;
let workerFailed = typeof Worker === "undefined";
let fallback: SearchEngine | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function unwire(e: WireError): Error {
  if (e.status != null) return new HttpError(e.status, "", e.message);
  const err = e.name === "TypeError" ? new TypeError(e.message) : new Error(e.message);
  err.name = e.name;
  return err;
}

function inThread(): SearchEngine {
  fallback ??= new SearchEngine(<T,>(file: string) => fetchJson<T>(dataUrl(file)));
  return fallback;
}

function runInThread(op: SearchOp): Promise<unknown> {
  const e = inThread();
  switch (op.op) {
    case "places":
      return e.loadPlaces();
    case "network":
      return e.loadNetwork();
    case "search":
      return e.search(op.q);
    case "byRef":
      return e.byRef(op.ref);
    case "below":
      return e.below(op.ref);
  }
}

function getWorker(): Worker | null {
  if (workerFailed) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("../workers/search.worker.ts", import.meta.url), { type: "module", name: "search" });
  } catch {
    workerFailed = true;
    return null;
  }
  worker.onmessage = (ev: MessageEvent<SearchResponse>) => {
    const msg = ev.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(unwire(msg.error));
  };
  worker.onerror = () => {
    // Worker failed to start / crashed: re-run everything outstanding on the main thread.
    workerFailed = true;
    worker?.terminate();
    worker = null;
    for (const [id, p] of pending) {
      pending.delete(id);
      runInThread(p.op).then(p.resolve, p.reject);
    }
  };
  return worker;
}

const BASE = () => new URL(dataUrl(""), location.href).href;

function call<K extends SearchOp["op"]>(op: Extract<SearchOp, { op: K }>): Promise<SearchResult[K]> {
  const w = getWorker();
  if (!w) return runInThread(op) as Promise<SearchResult[K]>;
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { op, resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ ...op, id, base: BASE() } satisfies SearchRequest);
  });
}

/** AP place gazetteer (~33k rows) — loaded into the worker on first search focus. Value = row count. */
export const placesTier = defineResource<number>("search:places", { load: () => call({ op: "places" }) });
/** Distribution-network search tier — loaded into the worker on first search focus. Value = item count. */
export const networkTier = defineResource<number>("search:network", { load: () => call({ op: "network" }) });

/** Ranked place / network / transformer hits for a query (tiers not yet loaded yield []). */
export function searchTiers(q: string): Promise<SearchHits> {
  return call({ op: "search", q });
}

/** The network items directly below a ref (a 33/11 kV SS's 11 kV feeders). */
export function lookupNetBelow(ref: string): Promise<NetItem[]> {
  return call({ op: "below", ref });
}

/** Network search item by overlay feature id (loads the network tier if needed). */
export function lookupNetRef(ref: string): Promise<NetItem | null> {
  return call({ op: "byRef", ref });
}
