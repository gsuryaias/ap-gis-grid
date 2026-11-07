// Search engine for the big lazy search tiers — the AP place gazetteer (places.json, ~33k rows)
// and the distribution network (search-network.json + DTR shards). Pure apart from the injected
// `fetchJson`, so it runs unchanged in the search worker (workers/search.worker.ts), in the
// main-thread fallback (data/search-client.ts) and in unit tests against the real public/data.
import type { PlaceItem, PlacesFile } from "./types.ts";
import { buildNetIndex, decodeDtrShard, dtrShardsFor, looksLikeDtrCode, type DtrShardFile, type NetIndex, type NetIndexFile, type NetItem } from "./network-search.ts";

/** 0 exact · 1 prefix · 2 word-prefix · 3 substring · 99 no match (q must be lower-cased). */
export function rank(name: string, q: string): number {
  const n = name.toLowerCase();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.split(/[\s-]+/).some((w) => w.startsWith(q))) return 2;
  if (n.includes(q)) return 3;
  return 99;
}

export function parsePlaces(file: PlacesFile): PlaceItem[] {
  return file.places.map(([name, type, district, lng, lat, pop]) => ({ name, type, district: district || null, lng, lat, pop }));
}

export const LIMITS = { places: 8, net: 8, dtr: 6 } as const;

export interface SearchHits {
  places: PlaceItem[];
  net: NetItem[];
  dtr: NetItem[];
}

type Fetch = <T>(file: string, signal?: AbortSignal) => Promise<T>;

/** Top `limit` of `items` by rank, then a caller-supplied tie-break — without sorting everything. */
function topRanked<T>(items: T[], name: (t: T) => string, q: string, limit: number, tie: (a: T, b: T) => number): T[] {
  const hits: Array<{ t: T; r: number }> = [];
  for (const t of items) {
    const r = rank(name(t), q);
    if (r < 99) hits.push({ t, r });
  }
  hits.sort((a, b) => a.r - b.r || tie(a.t, b.t));
  return hits.slice(0, limit).map((h) => h.t);
}

export class SearchEngine {
  private places: PlaceItem[] | null = null;
  private net: NetIndex | null = null;
  private placesP: Promise<number> | null = null;
  private netP: Promise<number> | null = null;
  private shards = new Map<string, Promise<NetItem[]>>();
  private feedersOf: Map<string, NetItem[]> | null = null;
  private readonly fetchJson: Fetch;

  constructor(fetchJson: Fetch) {
    this.fetchJson = fetchJson;
  }

  /** Load + index the gazetteer once; resolves to the row count. */
  loadPlaces(): Promise<number> {
    this.placesP ??= this.fetchJson<PlacesFile>("places.json").then((f) => {
      this.places = parsePlaces(f);
      return this.places.length;
    });
    this.placesP.catch(() => (this.placesP = null));
    return this.placesP;
  }

  /** Load + index the distribution-network tier once; resolves to the item count. */
  loadNetwork(): Promise<number> {
    this.netP ??= this.fetchJson<NetIndexFile>("search-network.json").then((f) => {
      this.net = buildNetIndex(f);
      return this.net.items.length;
    });
    this.netP.catch(() => (this.netP = null));
    return this.netP;
  }

  private shard(key: string): Promise<NetItem[]> {
    let p = this.shards.get(key);
    if (!p) {
      const chains = this.net!.chains;
      p = this.fetchJson<DtrShardFile>(`net-dtr-${key}.json`).then((f) => decodeDtrShard(f, chains));
      p.catch(() => this.shards.delete(key));
      this.shards.set(key, p);
    }
    return p;
  }

  /**
   * Ranked hits for one query across whatever tiers have loaded (a tier still loading yields []).
   * DTR shards are fetched on demand for code-like queries.
   */
  async search(query: string): Promise<SearchHits> {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return { places: [], net: [], dtr: [] };
    const places = this.places
      ? topRanked(this.places, (p) => p.name, q, LIMITS.places, (a, b) => b.pop - a.pop || a.name.localeCompare(b.name))
      : [];
    const net = this.net ? topRanked(this.net.items, (i) => i.label, q, LIMITS.net, (a, b) => a.label.localeCompare(b.label)) : [];
    let dtr: NetItem[] = [];
    if (this.net && looksLikeDtrCode(query)) {
      const all = await Promise.all(dtrShardsFor(query, this.net.shards).map((k) => this.shard(k).catch(() => [] as NetItem[])));
      dtr = all
        .flat()
        .filter((d) => d.label.toLowerCase().startsWith(q))
        .sort((a, b) => a.label.length - b.label.length || a.label.localeCompare(b.label))
        .slice(0, LIMITS.dtr);
    }
    return { places, net, dtr };
  }

  /**
   * A network item by its Inspector ref: an overlay feature id (ds- / dl- / f11-), `dtr:<code>`
   * (fetches only that code's shard) or `sec:<label>`.
   */
  async byRef(ref: string): Promise<NetItem | null> {
    await this.loadNetwork();
    const net = this.net;
    if (!net) return null;
    if (ref.startsWith("sec:")) {
      const label = ref.slice(4);
      return net.items.find((i) => i.kind === "sec" && i.label === label) ?? null;
    }
    if (ref.startsWith("dtr:")) {
      const code = ref.slice(4);
      const all = await Promise.all(dtrShardsFor(code, net.shards).map((k) => this.shard(k).catch(() => [] as NetItem[])));
      return all.flat().find((d) => d.label === code) ?? null;
    }
    return net.byRef.get(ref) ?? null;
  }

  /**
   * What hangs directly below a network asset: a 33/11 kV substation's 11 kV feeders (each 11 kV
   * feeder's chain starts at the one SS it is linked to, so the list is complete for what is
   * traced). Other kinds have no indexed children here (33 kV feeders use the connectivity index).
   */
  async below(ref: string): Promise<NetItem[]> {
    await this.loadNetwork();
    const net = this.net;
    if (!net || !ref.startsWith("ds-")) return [];
    if (!this.feedersOf) {
      const m = new Map<string, NetItem[]>();
      for (const i of net.items) {
        const ss = i.kind === "f11" ? i.chain?.[0] : null;
        if (!ss) continue;
        const arr = m.get(ss);
        if (arr) arr.push(i);
        else m.set(ss, [i]);
      }
      for (const arr of m.values()) arr.sort((a, b) => a.label.localeCompare(b.label));
      this.feedersOf = m;
    }
    return this.feedersOf.get(ref) ?? [];
  }
}
