// Network search tier — DISCOM 33 kV feeders, 33/11 kV substations, 11 kV feeders, sections and
// distribution transformers (written by build-data `buildNetwork`; see scripts/etl-network.ts).
// Two lazy tiers, both outside the initial payload:
//   search-network.json  ~450 KB gz — fetched on first focus of the search box (like places)
//   net-dtr-<shard>.json small shards — fetched only when a typed query looks like a DTR code /
//                        serial (APEPDCL: first 4 characters; APSPDCL: first 2)
// Coverage: APEPDCL full; APSPDCL routes from its pole survey (Kadapa partial); APCPDCL has no 11 kV data — the UI says so.
import { useEffect, useState } from "react";

const url = (f: string) => `${import.meta.env.BASE_URL}data/${f}`;

/** [ssId, ssName, f33Id, f33Name, transcoId, transcoLabel] */
export type Chain = [string | null, string | null, string | null, string | null, string | null, string | null];
export type NetKind = "ss33" | "f33" | "f11" | "sec" | "dtr";

export interface NetItem {
  label: string;
  kind: NetKind;
  sub: string;
  lng: number;
  lat: number;
  /** Overlay feature id (ds-* / dl-* / f11-*), "" for sections. */
  ref: string;
  chain: Chain | null;
  /** DTR only: decoded attributes + its 11 kV feeder. */
  dtr?: { attrs: Record<string, string | number>; feederId: string | null; feederName: string | null; discom: string };
}

interface IndexFile {
  shards: Record<string, number>;
  chains: Chain[];
  items: Array<[string, NetKind, string, number, number, string, number]>;
}

export interface NetIndex {
  items: NetItem[];
  chains: Chain[];
  shards: Set<string>;
  byRef: Map<string, NetItem>;
}

let index: NetIndex | null = null;
let indexP: Promise<NetIndex> | null = null;
const listeners = new Set<() => void>();

export function loadNetworkIndex(): Promise<NetIndex> {
  indexP ??= fetch(url("search-network.json"))
    .then((r) => {
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json() as Promise<IndexFile>;
    })
    .then((f) => {
      const items = f.items.map(([label, kind, sub, lng, lat, ref, ci]) => ({ label, kind, sub, lng, lat, ref, chain: ci >= 0 ? f.chains[ci] : null }));
      index = { items, chains: f.chains, shards: new Set(Object.keys(f.shards)), byRef: new Map(items.filter((i) => i.ref).map((i) => [i.ref, i])) };
      listeners.forEach((l) => l());
      return index;
    });
  indexP.catch(() => (indexP = null));
  return indexP;
}

export function useNetworkIndex(): NetIndex | null {
  const [s, set] = useState(index);
  useEffect(() => {
    const l = () => set(index);
    listeners.add(l);
    l();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return s;
}

interface ShardFile {
  cols: string[];
  dicts: string[][];
  feeders: Array<[string | null, string | null, number, string]>;
  rows: unknown[][];
}

const shardCache = new Map<string, Promise<NetItem[]>>();

const DTR_LABEL: Record<string, string> = {
  dtr_capacity: "Capacity",
  dtr_phase: "Phase",
  phase: "Phase",
  dtr_structure: "Structure",
  mounting_type: "Mounting",
  type_of_load: "Load type",
  pole_no: "Pole no.",
  dtr_make: "Make",
  make: "Make",
  record_status: "Status",
  no_of_lt_feeders: "LT feeders",
};

function decodeShard(f: ShardFile, chains: Chain[]): NetItem[] {
  return f.rows.map((r) => {
    const fd = f.feeders[r[3] as number];
    const attrs: Record<string, string | number> = {};
    f.cols.forEach((c, i) => {
      const v = r[4 + i];
      if (v == null) return;
      attrs[DTR_LABEL[c] ?? c] = f.dicts[i][v as number] ?? String(v);
    });
    const chain = fd[2] >= 0 ? chains[fd[2]] : null;
    const cap = attrs.Capacity ? ` · ${attrs.Capacity}` : "";
    return {
      label: String(r[0]),
      kind: "dtr" as const,
      sub: `${fd[3]} transformer${cap}${fd[1] ? ` · ${fd[1]}` : ""}`,
      lng: r[1] as number,
      lat: r[2] as number,
      ref: "",
      chain,
      dtr: { attrs, feederId: fd[0], feederName: fd[1], discom: fd[3] },
    };
  });
}

/** Shards a query could hit: APEPDCL by its first 4 characters, APSPDCL by its first 2. */
export function dtrShardsFor(q: string, available: Set<string>): string[] {
  const s = q.trim().toLowerCase().replace(/[^a-z0-9]/g, "_");
  const out: string[] = [];
  if (s.length >= 4 && available.has(`ep-${s.slice(0, 4)}`)) out.push(`ep-${s.slice(0, 4)}`);
  if (s.length >= 4 && available.has(`sp-${s.slice(0, 2)}`)) out.push(`sp-${s.slice(0, 2)}`);
  return out;
}

/** A query "looks like" a DTR code / serial: ≥ 4 chars, contains digits, no spaces. */
export const looksLikeDtrCode = (q: string) => /^(?=.*\d)[A-Za-z0-9/_-]{4,}$/.test(q.trim());

export function loadDtrShard(key: string, chains: Chain[]): Promise<NetItem[]> {
  let p = shardCache.get(key);
  if (!p) {
    p = fetch(url(`net-dtr-${key}.json`))
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json() as Promise<ShardFile>;
      })
      .then((f) => decodeShard(f, chains));
    p.catch(() => shardCache.delete(key));
    shardCache.set(key, p);
  }
  return p;
}

export const NET_KIND_LABEL: Record<NetKind, string> = {
  ss33: "33/11 kV SS",
  f33: "33 kV feeder",
  f11: "11 kV feeder",
  sec: "Section",
  dtr: "Transformer",
};
