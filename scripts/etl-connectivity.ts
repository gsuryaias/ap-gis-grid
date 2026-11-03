/**
 * TRANSCO → DISCOM connectivity (pure; unit-tested in connectivity.test.ts).
 *
 *   220 / 132 kV TRANSCO substation ──(33 kV feeder)──▶ 33/11 kV DISCOM substation
 *
 * 1. Feeder → source TRANSCO SS
 *    a. "name"      — the DISCOM GIS records the source EHT SS (APEPDCL `eht_ss_name`, APCPDCL `SUBSTN`):
 *                     normalised name match against TRANSCO SS within 40 km of the feeder (nearest wins,
 *                     voltage hint honoured).
 *    b. "proximity" — otherwise a feeder end within 1.5 km of a TRANSCO SS (APSPDCL records no source).
 *    c. "feeder-group" — an unlinked run of a named feeder inherits the source of another run of the same
 *                     feeder (APSPDCL feeders arrive fragmented).
 * 2. Feeder → 33/11 kV SS it serves: same-DISCOM 33/11 kV SS within 300 m of the feeder route.
 *
 * Everything is INFERRED from geometry + recorded names — never an authoritative single-line diagram.
 */
import type { Position } from "geojson";

export type LinkMethod = "name" | "proximity" | "feeder-group";

export interface TranscoNode {
  id: string;
  name: string;
  descriptiveName: string | null;
  voltage: number;
  lng: number;
  lat: number;
}
export interface FeederIn {
  id: string;
  discom: string;
  name: string | null;
  division: string | null;
  sourceSs: string | null;
  parts: Position[][];
}
export interface DiscomSsIn {
  id: string;
  discom: string;
  lng: number;
  lat: number;
}
export interface FeederLink {
  transcoSsId: string;
  method: LinkMethod;
  distKm: number;
}

export const NAME_MATCH_RADIUS_KM = 40;
export const PROXIMITY_KM = 1.5;
export const SERVES_M = 300;

const R = 6371.0088;
const toR = Math.PI / 180;

export function distKm(a: [number, number] | Position, b: [number, number] | Position): number {
  const dLat = (b[1] - a[1]) * toR;
  const dLng = (b[0] - a[0]) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Point → segment distance in metres (local equirectangular — fine at ≤ a few km). */
export function pointSegmentM(p: Position, a: Position, b: Position): number {
  const kx = Math.cos(p[1] * toR) * 111_320;
  const ky = 110_540;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/**
 * "132/33KV AMPOLU", "132 KV  Chirala SS", "220KV SWS ONGOLE", "Chigurukota" → "ampolu" / "chirala" /
 * "ongole" / "chigurukota". Voltage tokens, SS/SWS/substation/EHT words and punctuation are dropped.
 */
export function normSsName(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/[\d.]+\s*(\/\s*[\d.]+\s*)*k\s*v/g, " ")
    .replace(/\b(sub[\s-]*station|ss|sws|s\.s|eht|ehv|switching|station|gis|new)\b/g, " ")
    .replace(/[^a-z]+/g, "")
    .trim();
}

/** Voltage hint from a recorded source name ("220/33KV …" → 220), else null. */
export function voltageHint(raw: string | null | undefined): number | null {
  const m = /(\d{3})\s*(\/\s*\d+\s*)?k\s*v/i.exec(raw ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * Consonant skeleton for Telugu-place transliteration variants: drop vowels and 'h' after the first
 * letter, collapse repeats — "narasapuram"/"narsapuram" → "nrspurm"-style keys compare equal, as do
 * "rentachinthala"/"rentachintala" and "dairyform"/"dairyfarm".
 */
export function skeleton(s: string): string {
  return (s[0] ?? "") + s.slice(1).replace(/[aeiouh]/g, "").replace(/(.)\1+/g, "$1");
}

function editDistanceLe1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export function namesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 5 && l.startsWith(s)) return true; // "chirala" / "chiralaa", compound names
  if (s.length >= 5 && editDistanceLe1(a, b)) return true; // single-letter typos
  return s.length >= 5 && skeleton(a) === skeleton(b); // transliteration variants
}

/**
 * Abbreviated recorded names: "K KOTA" ~ "kamavarapukota", "J R GUDEM" ~ "jangareddygudem",
 * "R.C.PURAM" ~ "ramachandrapuram", "M R Puram" ~ "mogalrajapuram". Leading 1–2-letter initials must
 * prefix the candidate in order-ish (first initial = first letter) and the last word must end it.
 */
export function abbrevMatch(rawRecorded: string | null | undefined, candidateNorm: string): boolean {
  const toks = (rawRecorded ?? "")
    .toLowerCase()
    .replace(/[\d.]+\s*(\/\s*[\d.]+\s*)*k\s*v/g, " ")
    .replace(/\b(sub[\s-]*station|ss|sws|eht|gis)\b/g, " ")
    .split(/[^a-z]+/)
    .filter(Boolean);
  if (toks.length < 2 || !candidateNorm) return false;
  const last = toks[toks.length - 1];
  const initials = toks.slice(0, -1);
  if (last.length < 4 || !initials.every((t) => t.length <= 2)) return false;
  if (!candidateNorm.endsWith(last) || candidateNorm[0] !== initials[0][0]) return false;
  // every initial letter appears, in order, in the part before the last word
  const head = candidateNorm.slice(0, candidateNorm.length - last.length);
  let k = 0;
  for (const ch of initials.join("")) {
    k = head.indexOf(ch, k);
    if (k < 0) return false;
    k++;
  }
  return true;
}

function ends(parts: Position[][]): Position[] {
  const out: Position[] = [];
  for (const p of parts) if (p.length) out.push(p[0], p[p.length - 1]);
  return out;
}

export function linkFeederSources(transco: TranscoNode[], feeders: FeederIn[]): Map<string, FeederLink> {
  const keyed = transco.map((t) => ({ t, keys: [normSsName(t.name), normSsName(t.descriptiveName)].filter(Boolean) }));
  const out = new Map<string, FeederLink>();

  for (const f of feeders) {
    const fe = ends(f.parts);
    if (!fe.length) continue;
    const nearest = (t: TranscoNode) => Math.min(...fe.map((e) => distKm(e, [t.lng, t.lat])));

    // a. recorded source name
    const want = normSsName(f.sourceSs);
    if (want) {
      const vh = voltageHint(f.sourceSs);
      let best: { t: TranscoNode; d: number; vOk: boolean } | null = null;
      for (const { t, keys } of keyed) {
        if (!keys.some((k) => namesMatch(k, want) || abbrevMatch(f.sourceSs, k))) continue;
        const d = nearest(t);
        if (d > NAME_MATCH_RADIUS_KM) continue;
        const vOk = vh == null || vh === t.voltage;
        if (!best || (vOk && !best.vOk) || (vOk === best.vOk && d < best.d)) best = { t, d, vOk };
      }
      if (best) {
        out.set(f.id, { transcoSsId: best.t.id, method: "name", distKm: Math.round(best.d * 100) / 100 });
        continue;
      }
    }

    // b. a feeder end at a TRANSCO SS
    let bestT: TranscoNode | null = null;
    let bestD = PROXIMITY_KM;
    for (const t of transco) {
      // cheap reject: ~0.05° ≈ 5 km
      if (!fe.some((e) => Math.abs(e[0] - t.lng) < 0.05 && Math.abs(e[1] - t.lat) < 0.05)) continue;
      const d = nearest(t);
      if (d <= bestD) { bestD = d; bestT = t; }
    }
    if (bestT) out.set(f.id, { transcoSsId: bestT.id, method: "proximity", distKm: Math.round(bestD * 100) / 100 });
  }

  // c. fragments of the same named feeder inherit the linked run's source
  const groups = new Map<string, FeederIn[]>();
  for (const f of feeders) {
    if (!f.name) continue;
    const k = `${f.discom}|${f.name.toLowerCase()}|${(f.division ?? "").toLowerCase()}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
  }
  for (const g of groups.values()) {
    const linked = g.map((f) => out.get(f.id)).filter((l): l is FeederLink => !!l && l.method !== "feeder-group");
    if (!linked.length) continue;
    const src = linked.find((l) => l.method === "name") ?? linked.sort((a, b) => a.distKm - b.distKm)[0];
    for (const f of g) if (!out.has(f.id)) out.set(f.id, { transcoSsId: src.transcoSsId, method: "feeder-group", distKm: src.distKm });
  }
  return out;
}

/** Feeder id → ids of same-DISCOM 33/11 kV SS within `maxM` of its route (grid-indexed). */
export function linkServedSubstations(feeders: FeederIn[], ss: DiscomSsIn[], maxM = SERVES_M): Map<string, string[]> {
  const CELL = 0.01;
  const grid = new Map<string, DiscomSsIn[]>();
  const cell = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  for (const s of ss) (grid.get(cell(s.lng, s.lat)) ?? grid.set(cell(s.lng, s.lat), []).get(cell(s.lng, s.lat))!).push(s);
  const pad = maxM / 100_000 + 0.001;

  const out = new Map<string, string[]>();
  for (const f of feeders) {
    const hit = new Map<string, number>();
    for (const part of f.parts) {
      for (let i = 0; i < part.length; i++) {
        const a = part[i];
        const b = part[Math.min(i + 1, part.length - 1)];
        const x0 = Math.floor((Math.min(a[0], b[0]) - pad) / CELL), x1 = Math.floor((Math.max(a[0], b[0]) + pad) / CELL);
        const y0 = Math.floor((Math.min(a[1], b[1]) - pad) / CELL), y1 = Math.floor((Math.max(a[1], b[1]) + pad) / CELL);
        for (let x = x0; x <= x1; x++)
          for (let y = y0; y <= y1; y++)
            for (const s of grid.get(`${x},${y}`) ?? []) {
              if (s.discom !== f.discom) continue;
              const d = pointSegmentM([s.lng, s.lat], a, b);
              if (d <= maxM && d < (hit.get(s.id) ?? Infinity)) hit.set(s.id, d);
            }
      }
    }
    if (hit.size) out.set(f.id, [...hit.entries()].sort((p, q) => p[1] - q[1]).map(([id]) => id));
  }
  return out;
}
