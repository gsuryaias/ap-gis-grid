/**
 * DISCOM 11 kV network ETL (pure builders; orchestration in etl-distribution.ts `buildNetwork`).
 *
 * Inputs: data/raw/live/net-*.{geojson,json} (scripts/sync-network.mts) + the already-built 33 kV
 * layer (discom-ss / discom-lines / transco-33kv). Outputs:
 *   discom-11kv-lines.geojson  lazy overlay — APEPDCL one feature per 11 kV feeder; APSPDCL spans
 *                              grouped by (feeder, division) then split into connected runs
 *   net-dtr-<shard>.json       distribution transformers for search (APEPDCL sharded by the 2-digit
 *                              DTR-code prefix = circle; APSPDCL one shard keyed by serial number)
 *   search-network.json        the lazy "network" search tier + the upstream trace chains
 * Every 11 kV feeder is linked to its 33/11 kV SS (APEPDCL: recorded sub_station_id; APSPDCL:
 * recorded substation name within 5 km, else a run end ≤ 500 m from a 33/11 kV SS), which the
 * 33 kV connectivity already ties to a 33 kV feeder and a TRANSCO SS — giving the full trace
 * TRANSCO SS → 33 kV feeder → 33/11 kV SS → 11 kV feeder → DTR. All links are INFERRED.
 */
import type { Position } from "geojson";
import { connectedParts, pathKm, simplifyLine, titleCase } from "./etl-discom.ts";
import { distKm, namesMatch, normSsName } from "./etl-connectivity.ts";
import { ungroupPoints, type GroupedFile } from "./net-lib.ts";

export interface SsRef {
  id: string;
  discom: string;
  name: string;
  lng: number;
  lat: number;
}

/** Upstream chain for a 33/11 kV SS: [ssId, ssName, f33Id, f33Name, transcoId, transcoLabel]. */
export type Chain = [string | null, string | null, string | null, string | null, string | null, string | null];

export interface F11 {
  id: string;
  discom: string;
  name: string;
  code: string | null;
  ssName: string | null;
  ssId: string | null;
  linkMethod: "recorded" | "name" | "proximity" | null;
  section: string | null;
  subdivision: string | null;
  division: string | null;
  circle: string | null;
  lengthKm: number;
  poles: number | null;
  parts: Position[][];
}

const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
const txt = (v: unknown) => (v == null ? null : String(v).trim() || null);
const partsOf = (g: { type: string; coordinates: unknown } | null): Position[][] =>
  !g ? [] : g.type === "LineString" ? [g.coordinates as Position[]] : g.type === "MultiLineString" ? (g.coordinates as Position[][]) : [];

/**
 * Line-merge: join parts end-to-end through every node where exactly two parts meet, so a feeder
 * digitised as hundreds of 2-point pole-to-pole spans becomes a handful of chains that
 * Douglas–Peucker can actually simplify. Branch points (degree ≠ 2) stay chain ends.
 */
export function mergeParts(parts: Position[][]): Position[][] {
  const key = (c: Position) => `${Math.round(c[0] * 1e5)},${Math.round(c[1] * 1e5)}`;
  const at = new Map<string, number[]>();
  parts.forEach((p, i) => {
    for (const k of [key(p[0]), key(p[p.length - 1])]) (at.get(k) ?? at.set(k, []).get(k)!).push(i);
  });
  const used = new Uint8Array(parts.length);
  const out: Position[][] = [];
  const extend = (chain: Position[]) => {
    for (;;) {
      const k = key(chain[chain.length - 1]);
      const touching = at.get(k) ?? [];
      if (touching.length !== 2) return;
      const nxt = touching.find((i) => !used[i]);
      if (nxt == null) return;
      used[nxt] = 1;
      const p = parts[nxt];
      const fwd = key(p[0]) === k ? p : [...p].reverse();
      for (let j = 1; j < fwd.length; j++) chain.push(fwd[j]);
    }
  };
  parts.forEach((p, i) => {
    if (used[i]) return;
    used[i] = 1;
    const chain = [...p];
    extend(chain);
    chain.reverse();
    extend(chain);
    out.push(chain);
  });
  return out;
}

/** 4 dp ≈ 11 m — matched to the ~15 m simplification tolerance (11 kV is drawn from z10). */
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function simplifyParts(parts: Position[][], tol: number): Position[][] {
  return mergeParts(parts)
    .map((p) => simplifyLine(p, tol).map((c): Position => [r4(c[0]), r4(c[1])]))
    .filter((p) => p.length >= 2 && !(p.length === 2 && p[0][0] === p[1][0] && p[0][1] === p[1][1]));
}

/** "11KV 11K.V.TIRUMALAPURAM" → "11KV Tirumalapuram". */
export function feederLabel(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.replace(/^(11\s*k\.?\s*v\.?\s*)+/i, "").replace(/\s+/g, " ").trim();
  return s ? `11KV ${titleCase(s)}` : null;
}

/** APEPDCL 33/11 kV SS id → its recorded sub_station_id (the suffix after "-ss-"). */
export function epSsIdIndex(ss: SsRef[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of ss) {
    if (s.discom !== "APEPDCL") continue;
    const k = /-ss-(\d+)(?:-\d+)?$/.exec(s.id)?.[1];
    if (k && !m.has(k)) m.set(k, s.id);
  }
  return m;
}

export function buildEpdclFeeders(feats: Array<{ geometry: { type: string; coordinates: unknown } | null; properties: Record<string, unknown> }>, ssIdx: Map<string, string>, tol: number): F11[] {
  const out: F11[] = [];
  const used = new Set<string>();
  for (const f of feats) {
    const p = f.properties;
    const raw = partsOf(f.geometry).filter((x) => x.length >= 2);
    const parts = simplifyParts(raw, tol);
    if (!parts.length) continue;
    const code = txt(p.feeder_id);
    let id = `f11-ep-${(code ?? String(out.length)).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    for (let n = 2; used.has(id); n++) id = `f11-ep-${code}-${n}`;
    used.add(id);
    const ssId = ssIdx.get(String(txt(p.sub_station_id) ?? "")) ?? null;
    out.push({
      id,
      discom: "APEPDCL",
      name: feederLabel(txt(p.feeder_name)) ?? "Unnamed 11 kV feeder",
      code,
      ssName: titleCase(txt(p.sub_station_name)),
      ssId,
      linkMethod: ssId ? "recorded" : null,
      section: titleCase(txt(p.section_name)),
      subdivision: titleCase(txt(p.sub_division_name)),
      division: titleCase(txt(p.division_name)),
      circle: titleCase(txt(p.circle_name)),
      lengthKm: Math.round((Number(p.length_km) || pathKm(raw)) * 100) / 100,
      poles: Number(p.pole_count) || null,
      parts,
    });
  }
  return out;
}

export function buildSpdclFeeders(
  feats: Array<{ geometry: { type: string; coordinates: unknown } | null; properties: Record<string, unknown> }>,
  spSs: SsRef[],
  tol: number,
): F11[] {
  const groups = new Map<string, { props: Record<string, unknown>; parts: Position[][] }>();
  for (const f of feats) {
    const p = f.properties;
    const parts = partsOf(f.geometry).filter((x) => x.length >= 2);
    if (!parts.length) continue;
    const key = `${(txt(p.feeder_name) ?? "").toLowerCase()}|${(txt(p.division) ?? "").toLowerCase()}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { props: p, parts: [] }));
    g.parts.push(...parts);
  }
  const out: F11[] = [];
  for (const g of [...groups.keys()].sort()) {
    const { props: p, parts: all } = groups.get(g)!;
    for (const comp of connectedParts(all)) {
      const parts = simplifyParts(comp, tol);
      if (!parts.length) continue;
      const lengthKm = Math.round(pathKm(comp) * 100) / 100;
      if (lengthKm <= 0) continue;
      const ssName = titleCase(txt(p.substation));
      const link = linkSpdcl(ssName, comp, spSs);
      out.push({
        id: `f11-sp-${String(out.length).padStart(5, "0")}`,
        discom: "APSPDCL",
        name: feederLabel(txt(p.feeder_name)) ?? "Unnamed 11 kV line",
        code: txt(p.feeder_code),
        ssName,
        ssId: link?.id ?? null,
        linkMethod: link?.method ?? null,
        section: titleCase(txt(p.section_)),
        subdivision: titleCase(txt(p.subdivision)),
        division: titleCase(txt(p.division)),
        circle: titleCase(txt(p.circle)),
        lengthKm,
        poles: null,
        parts,
      });
    }
  }
  return out;
}

/** APSPDCL 11 kV run → 33/11 kV SS: recorded name within 5 km, else a run end ≤ 500 m away. */
export function linkSpdcl(ssName: string | null, parts: Position[][], ss: SsRef[]): { id: string; method: "name" | "proximity" } | null {
  const ends = parts.flatMap((p) => [p[0], p[p.length - 1]]);
  const near = (s: SsRef) => Math.min(...ends.map((e) => distKm(e, [s.lng, s.lat])));
  const want = ssName ? normSsName(ssName) : "";
  if (want) {
    let best: { id: string; d: number } | null = null;
    for (const s of ss) {
      if (!namesMatch(normSsName(s.name), want)) continue;
      const d = near(s);
      if (d <= 5 && (!best || d < best.d)) best = { id: s.id, d };
    }
    if (best) return { id: best.id, method: "name" };
  }
  let best: { id: string; d: number } | null = null;
  for (const s of ss) {
    const d = near(s);
    if (d <= 0.5 && (!best || d < best.d)) best = { id: s.id, d };
  }
  return best ? { id: best.id, method: "proximity" } : null;
}

/** kVA from "100 KVA" / "100" / "25KVA"; null when unparseable. */
export function kva(v: unknown): number | null {
  const m = /([\d.]+)/.exec(String(v ?? ""));
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 && n < 100000 ? n : null;
}

export interface DtrRow {
  code: string;
  lng: number;
  lat: number;
  feederKey: string;
  kva: number | null;
  attrs: Record<string, unknown>;
}

export function dtrRows(file: GroupedFile, codeField: string): DtrRow[] {
  const out: DtrRow[] = [];
  for (const p of ungroupPoints(file)) {
    const code = txt(p.props[codeField]);
    out.push({
      code: code ?? "",
      lng: r5(p.lng),
      lat: r5(p.lat),
      feederKey: String(p.props[file.groupBy] ?? ""),
      kva: kva(p.props.dtr_capacity),
      attrs: p.props,
    });
  }
  return out;
}

/** Midpoint vertex of the longest part — a stable on-line anchor for search jumps. */
export function anchorOf(parts: Position[][]): [number, number] {
  const longest = parts.reduce((a, b) => (b.length > a.length ? b : a), parts[0]);
  const c = longest[Math.floor(longest.length / 2)];
  return [c[0], c[1]];
}
