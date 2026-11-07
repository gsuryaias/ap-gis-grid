// Search worker: owns the big search tiers (places.json ~2 MB, search-network.json ~2.7 MB, DTR
// shards) so their JSON parse, indexing and per-keystroke ranking never block the main thread.
// Only the top-N hits cross back. See data/search-client.ts for the main-thread side.
import { dataQuery, HttpError } from "../data/fetch.ts";
import { SearchEngine } from "../data/search-core.ts";
import type { SearchRequest, SearchResponse, WireError } from "./search-protocol.ts";

let base = "";
const engine = new SearchEngine(async <T,>(file: string) => {
  const res = await fetch(base + file + dataQuery(file));
  if (!res.ok) throw new HttpError(res.status, res.statusText, file);
  return (await res.json()) as T;
});

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<SearchRequest>) => void) | null;
  postMessage(m: SearchResponse): void;
};

function wire(e: unknown): WireError {
  if (e instanceof HttpError) return { name: e.name, message: e.message, status: e.status };
  if (e instanceof Error) return { name: e.name, message: e.message };
  return { name: "Error", message: String(e) };
}

ctx.onmessage = (e) => {
  const req = e.data;
  base = req.base;
  const run = (): Promise<unknown> => {
    switch (req.op) {
      case "places":
        return engine.loadPlaces();
      case "network":
        return engine.loadNetwork();
      case "search":
        return engine.search(req.q);
      case "byRef":
        return engine.byRef(req.ref);
      case "below":
        return engine.below(req.ref);
    }
  };
  run().then(
    (value) => ctx.postMessage({ id: req.id, ok: true, value }),
    (err: unknown) => ctx.postMessage({ id: req.id, ok: false, error: wire(err) }),
  );
};
