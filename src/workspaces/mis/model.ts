// Network MIS — pure analytics model (no React, no map). Joins the core grid with the inferred
// connectivity graph, line age / conductor / capacity, and the TRANSCO → 33 kV downstream index
// into per-asset rows, then answers pivot questions over them: filter a scope by any stack of
// (dimension = value) drill steps and aggregate it by any dimension.
//
// Why a pivot rather than a fixed Zone → Circle → Division tree: the source groupings do NOT nest
// (three circles straddle two zones; nine divisions span several circles — circle is derived from
// lines, zone/division are SS attributes). Drilling by "add a filter, then regroup" stays correct
// whether or not two dimensions nest.
//
// Everything topological is INFERRED from geometric endpoint snapping, capacity is INDICATIVE
// (conductor nominal ampacity), and 33 kV links are inferred — the UI labels them accordingly.
import type { GraphAnalysis } from "../../data/graph-data.ts";
import type { ConnectivityIndex } from "../../data/connectivity.ts";
import type { GridData, LineProps, SubstationProps, Voltage } from "../../data/types.ts";
import { conductorRating, lineCapacityFor } from "../../lib/capacity.ts";
import { commissionYear } from "../../lib/format.ts";

// ---------------------------------------------------------------------------------------------
// Rows

export type NetworkRole = "articulation" | "single-fed" | "double-fed" | "meshed" | "isolated";

export const ROLE_ORDER: NetworkRole[] = ["articulation", "single-fed", "double-fed", "meshed", "isolated"];
export const ROLE_LABEL: Record<NetworkRole, string> = {
  articulation: "Cut-point SS",
  "single-fed": "Single-fed (radial)",
  "double-fed": "Double-fed",
  meshed: "Meshed (3+ feeds)",
  isolated: "No inferred link",
};
export const ROLE_HINT: Record<NetworkRole, string> = {
  articulation: "Losing this substation splits the inferred network",
  "single-fed": "Fed from exactly one neighbouring substation",
  "double-fed": "Two distinct neighbouring substations",
  meshed: "Three or more distinct neighbouring substations",
  isolated: "No line snapped to it in the inferred graph",
};

/** CERC tariff regulations: useful life of a transmission line = 35 years (substations 25). */
export const LINE_USEFUL_LIFE_YRS = 35;
export type AgeBand = "0" | "1" | "2" | "3" | "unknown";
export const AGE_BAND_ORDER: AgeBand[] = ["0", "1", "2", "3", "unknown"];
export const AGE_BAND_LABEL: Record<AgeBand, string> = {
  "0": "< 15 yrs",
  "1": "15–24 yrs",
  "2": "25–34 yrs",
  "3": "≥ 35 yrs (past useful life)",
  unknown: "Year not recorded",
};

export function ageBand(age: number | null): AgeBand {
  if (age == null) return "unknown";
  if (age < 15) return "0";
  if (age < 25) return "1";
  if (age < LINE_USEFUL_LIFE_YRS) return "2";
  return "3";
}

export interface SsRow {
  ss: SubstationProps;
  id: string;
  voltage: Voltage;
  circle: string | null;
  zone: string | null;
  division: string | null;
  feedDegree: number;
  role: NetworkRole;
  /** Inferred 33 kV feeder runs originating here (0 when none traced). */
  feeders: number;
  feederKm: number;
  /** Distinct 33/11 kV substations on those feeders. */
  discomSsIds: string[];
  /** DISCOMs whose feeders originate here. */
  discoms: string[];
}

export interface LineRow {
  line: LineProps;
  id: string;
  voltage: Voltage;
  circle: string | null;
  /** Zone / division of the line's first resolved end substation (lines carry neither). */
  zone: string | null;
  division: string | null;
  circuits: number;
  ckm: number;
  routeKm: number;
  year: number | null;
  age: number | null;
  ageBand: AgeBand;
  /** Conductor family, e.g. "Panther", "Twin Moose"; null when unrecognised. */
  conductor: string | null;
  /** Indicative thermal MVA for the circuits this row carries; null when unrated. */
  mva: number | null;
  /** Inferred N-1 bridge: losing this line islands `islanded` substations. */
  islanded: string[];
  /** Non-TRANSCO terminal categories (Generation / Railway / PowerGrid / HT consumer). */
  external: string[];
}

export interface MisModel {
  ss: SsRow[];
  lines: LineRow[];
  ssById: Map<string, SsRow>;
  lineById: Map<string, LineRow>;
  /** True once the 33 kV index was folded in (downstream metrics are 0 / empty before). */
  hasDownstream: boolean;
  asOfYear: number;
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export function conductorFamily(conductor: string | null | undefined): string | null {
  const r = conductorRating(conductor);
  if (!r) return null;
  const bundle = r.bundle === 4 ? "Quad " : r.bundle === 3 ? "Triple " : r.bundle === 2 ? "Twin " : "";
  return `${bundle}${titleCase(r.base)}`;
}

export function roleOf(id: string, degree: number, articulation: ReadonlySet<string>): NetworkRole {
  if (articulation.has(id)) return "articulation";
  if (degree === 0) return "isolated";
  if (degree === 1) return "single-fed";
  if (degree === 2) return "double-fed";
  return "meshed";
}

export function buildModel(
  data: Pick<GridData, "substations" | "lines">,
  ga: Pick<GraphAnalysis, "feedDegrees" | "articulationIds" | "bridgeImpacts">,
  conn: Pick<ConnectivityIndex, "bySs"> | null,
  asOfYear: number,
): MisModel {
  const ss: SsRow[] = data.substations.map((s) => {
    const feeders = conn?.bySs[s.id] ?? [];
    const discomSs = new Set<string>();
    const discoms = new Set<string>();
    let feederKm = 0;
    for (const f of feeders) {
      feederKm += f[3];
      discoms.add(f[2]);
      for (const id of f[5]) discomSs.add(id);
    }
    const feedDegree = ga.feedDegrees.get(s.id) ?? 0;
    return {
      ss: s,
      id: s.id,
      voltage: s.voltage,
      circle: s.circle,
      zone: s.zone ?? null,
      division: s.division ?? null,
      feedDegree,
      role: roleOf(s.id, feedDegree, ga.articulationIds),
      feeders: feeders.length,
      feederKm,
      discomSsIds: [...discomSs],
      discoms: [...discoms].sort(),
    };
  });
  const ssById = new Map(ss.map((r) => [r.id, r]));

  const lines: LineRow[] = data.lines.map((l) => {
    const circuits = l.circuits ?? (l.circuit === "DC" ? 2 : 1);
    const lengthKm = l.lengthKm ?? 0;
    const endSs = ssById.get(l.fromSS?.ssId ?? "") ?? ssById.get(l.toSS?.ssId ?? "") ?? null;
    const year = commissionYear(l.commissioned);
    const age = year == null ? null : Math.max(0, asOfYear - year);
    return {
      line: l,
      id: l.id,
      voltage: l.voltage,
      circle: l.circle,
      zone: endSs?.zone ?? null,
      division: endSs?.division ?? null,
      circuits,
      ckm: l.ckm ?? lengthKm * circuits,
      routeKm: l.routeKm ?? lengthKm,
      year,
      age,
      ageBand: ageBand(age),
      conductor: conductorFamily(l.conductor),
      mva: lineCapacityFor(l)?.totalMva ?? null,
      islanded: ga.bridgeImpacts.get(l.id) ?? [],
      external: [...new Set((l.externalEndpoints ?? []).map((e) => e.category))],
    };
  });

  return {
    ss,
    lines,
    ssById,
    lineById: new Map(lines.map((r) => [r.id, r])),
    hasDownstream: conn != null,
    asOfYear,
  };
}

// ---------------------------------------------------------------------------------------------
// Dimensions

export type DimId = "circle" | "zone" | "division" | "voltage" | "age" | "conductor" | "role" | "coastal";

export const NONE = "__none";

export interface Dimension {
  id: DimId;
  label: string;
  /** Key for a substation row; absent when the dimension doesn't apply to substations. */
  ss?: (r: SsRow) => string;
  /** Key for a line row; absent when the dimension doesn't apply to lines. */
  line?: (r: LineRow) => string;
  /** Human label for a key. */
  format: (key: string) => string;
  /** Fixed display order (keys); groups not listed sort by circuit-km after it. */
  order?: string[];
  /** One-line method note shown when grouping by this dimension. */
  note?: string;
}

const COAST_LABEL: Record<string, string> = { "0": "< 10 km", "1": "10–25 km", "2": "25–50 km", "3": "≥ 50 km (inland)" };
const k = (v: string | number | null | undefined) => (v == null || v === "" ? NONE : String(v));

export const DIMENSIONS: Record<DimId, Dimension> = {
  circle: {
    id: "circle",
    label: "Circle",
    ss: (r) => k(r.circle),
    line: (r) => k(r.circle),
    format: (v) => (v === NONE ? "Unassigned" : v),
  },
  zone: {
    id: "zone",
    label: "Zone",
    ss: (r) => k(r.zone),
    line: (r) => k(r.zone),
    format: (v) => (v === NONE ? "Not recorded" : v),
    note: "A line takes the zone of its first resolved end substation (the line layer has no zone).",
  },
  division: {
    id: "division",
    label: "Division",
    ss: (r) => k(r.division),
    line: (r) => k(r.division),
    format: (v) => (v === NONE ? "Not recorded" : v),
    note: "A line takes the division of its first resolved end substation. 22 SS have no division in the source.",
  },
  voltage: {
    id: "voltage",
    label: "Voltage",
    ss: (r) => String(r.voltage),
    line: (r) => String(r.voltage),
    format: (v) => `${v} kV`,
    order: ["400", "220", "132"],
  },
  age: {
    id: "age",
    label: "Line age",
    line: (r) => r.ageBand,
    format: (v) => AGE_BAND_LABEL[v as AgeBand] ?? v,
    order: AGE_BAND_ORDER,
    note: `Age from the line's commissioning year. CERC useful life of a transmission line: ${LINE_USEFUL_LIFE_YRS} years. Substations carry no commissioning date, so they are scoped through the lines that connect to them.`,
  },
  conductor: {
    id: "conductor",
    label: "Conductor",
    line: (r) => k(r.conductor),
    format: (v) => (v === NONE ? "Unrated / other" : v),
    note: "Family = leading ACSR code + bundle (mixed-conductor routes take their first code).",
  },
  role: {
    id: "role",
    label: "N-1 role",
    ss: (r) => r.role,
    format: (v) => ROLE_LABEL[v as NetworkRole] ?? v,
    order: ROLE_ORDER,
    note: "Inferred from the geometric connectivity graph — screening, not a contingency study.",
  },
  coastal: {
    id: "coastal",
    label: "Coastal band",
    ss: (r) => k(r.ss.coastalBand),
    line: (r) => k(r.line.coastalBand),
    format: (v) => COAST_LABEL[v] ?? "Unknown",
    order: ["0", "1", "2", "3"],
  },
};

export const DIM_ORDER: DimId[] = ["circle", "zone", "division", "voltage", "age", "conductor", "role", "coastal"];

export function isDimId(v: unknown): v is DimId {
  return typeof v === "string" && v in DIMENSIONS;
}

// ---------------------------------------------------------------------------------------------
// Scope (drill path)

export interface ScopeFilter {
  dim: DimId;
  value: string;
}

export interface Scope {
  ss: SsRow[];
  lines: LineRow[];
}

/**
 * Apply a drill path. A filter on a dimension that applies to both asset types narrows both;
 * a line-only filter (age, conductor) keeps the substations those lines touch; a substation-only
 * filter (N-1 role) keeps the lines touching those substations.
 */
export function applyScope(model: MisModel, filters: readonly ScopeFilter[]): Scope {
  let ss = model.ss;
  let lines = model.lines;
  for (const f of filters) {
    const d = DIMENSIONS[f.dim];
    if (d.ss && d.line) {
      ss = ss.filter((r) => d.ss!(r) === f.value);
      lines = lines.filter((r) => d.line!(r) === f.value);
    } else if (d.line) {
      lines = lines.filter((r) => d.line!(r) === f.value);
      const touched = new Set(lines.flatMap((r) => r.line.connectsSS));
      ss = ss.filter((r) => touched.has(r.id));
    } else if (d.ss) {
      ss = ss.filter((r) => d.ss!(r) === f.value);
      const keep = new Set(ss.map((r) => r.id));
      lines = lines.filter((r) => r.line.connectsSS.some((id) => keep.has(id)));
    }
  }
  return { ss, lines };
}

// ---------------------------------------------------------------------------------------------
// Aggregation

export interface Metrics {
  ss: number;
  ssByV: Record<Voltage, number>;
  lines: number;
  routeKm: number;
  ckm: number;
  ckmByV: Record<Voltage, number>;
  mva: number;
  ratedLines: number;
  /** ckm-weighted mean age of lines with a known year (null when none). */
  meanAge: number | null;
  /** Share (0–1) of age-known ckm at or past the useful life. */
  pctPastLife: number | null;
  ageKnownCkm: number;
  singleFed: number;
  articulation: number;
  bridges: number;
  feeders: number;
  feederKm: number;
  discomSs: number;
  coastalSs: number;
}

const zeroV = (): Record<Voltage, number> => ({ 400: 0, 220: 0, 132: 0 });

export function metrics(ss: readonly SsRow[], lines: readonly LineRow[]): Metrics {
  const m: Metrics = {
    ss: ss.length,
    ssByV: zeroV(),
    lines: lines.length,
    routeKm: 0,
    ckm: 0,
    ckmByV: zeroV(),
    mva: 0,
    ratedLines: 0,
    meanAge: null,
    pctPastLife: null,
    ageKnownCkm: 0,
    singleFed: 0,
    articulation: 0,
    bridges: 0,
    feeders: 0,
    feederKm: 0,
    discomSs: 0,
    coastalSs: 0,
  };
  const discom = new Set<string>();
  for (const r of ss) {
    m.ssByV[r.voltage]++;
    if (r.role === "single-fed") m.singleFed++;
    if (r.role === "articulation") m.articulation++;
    m.feeders += r.feeders;
    m.feederKm += r.feederKm;
    for (const id of r.discomSsIds) discom.add(id);
    if (r.ss.coastalBand === 0) m.coastalSs++;
  }
  m.discomSs = discom.size;
  let ageCkm = 0;
  let pastCkm = 0;
  for (const r of lines) {
    m.routeKm += r.routeKm;
    m.ckm += r.ckm;
    m.ckmByV[r.voltage] += r.ckm;
    if (r.mva != null) {
      m.mva += r.mva;
      m.ratedLines++;
    }
    if (r.islanded.length) m.bridges++;
    if (r.age != null) {
      m.ageKnownCkm += r.ckm;
      ageCkm += r.age * r.ckm;
      if (r.age >= LINE_USEFUL_LIFE_YRS) pastCkm += r.ckm;
    }
  }
  if (m.ageKnownCkm > 0) {
    m.meanAge = ageCkm / m.ageKnownCkm;
    m.pctPastLife = pastCkm / m.ageKnownCkm;
  }
  return m;
}

export interface GroupRow {
  key: string;
  label: string;
  /** Null when the grouping dimension doesn't apply to substations / lines. */
  m: Metrics;
  hasSs: boolean;
  hasLines: boolean;
}

/** Aggregate a scope by a dimension. Order: the dimension's fixed order, else circuit-km desc. */
export function groupBy(scope: Scope, dimId: DimId): GroupRow[] {
  const d = DIMENSIONS[dimId];
  const ssG = new Map<string, SsRow[]>();
  const lnG = new Map<string, LineRow[]>();
  if (d.ss) for (const r of scope.ss) push(ssG, d.ss(r), r);
  if (d.line) for (const r of scope.lines) push(lnG, d.line(r), r);
  const keys = new Set([...ssG.keys(), ...lnG.keys()]);
  const rows: GroupRow[] = [...keys].map((key) => ({
    key,
    label: d.format(key),
    m: metrics(ssG.get(key) ?? [], lnG.get(key) ?? []),
    hasSs: !!d.ss,
    hasLines: !!d.line,
  }));
  const pos = (key: string) => {
    const i = d.order?.indexOf(key) ?? -1;
    return i < 0 ? Infinity : i;
  };
  rows.sort((a, b) => {
    const pa = pos(a.key);
    const pb = pos(b.key);
    if (pa !== pb) return pa - pb;
    if (a.key === NONE) return 1;
    if (b.key === NONE) return -1;
    return b.m.ckm - a.m.ckm || b.m.ss - a.m.ss || a.label.localeCompare(b.label);
  });
  return rows;
}

function push<T>(m: Map<string, T[]>, key: string, v: T) {
  const a = m.get(key);
  if (a) a.push(v);
  else m.set(key, [v]);
}

// ---------------------------------------------------------------------------------------------
// Thematic views

export interface PeriodBin {
  /** First year of the bin, e.g. 1985 for 1985–1989. */
  start: number;
  ckmByV: Record<Voltage, number>;
  lines: number;
}

/** Circuit-km commissioned per `width`-year period, stacked by voltage (age-known lines only). */
export function commissioningHistogram(lines: readonly LineRow[], width = 5): PeriodBin[] {
  const known = lines.filter((r) => r.year != null);
  if (!known.length) return [];
  const min = Math.floor(Math.min(...known.map((r) => r.year!)) / width) * width;
  const max = Math.floor(Math.max(...known.map((r) => r.year!)) / width) * width;
  const bins: PeriodBin[] = [];
  for (let s = min; s <= max; s += width) bins.push({ start: s, ckmByV: zeroV(), lines: 0 });
  for (const r of known) {
    const b = bins[Math.floor((r.year! - min) / width)];
    b.ckmByV[r.voltage] += r.ckm;
    b.lines++;
  }
  return bins;
}

export interface BridgeImpact {
  row: LineRow;
  /** TRANSCO SS islanded by the outage. */
  islanded: SsRow[];
  /** Distinct 33/11 kV SS downstream of the islanded TRANSCO SS (inferred). */
  discomSs: number;
  feeders: number;
}

/**
 * Inferred N-1 consequence ranking: every bridge line in scope with the TRANSCO substations it
 * would island and the 33 kV network hanging off them. Parallel circuits are separate graph edges,
 * so a double-circuit corridor is NOT a bridge — only true single-path links appear.
 */
export function bridgeImpacts(model: MisModel, lines: readonly LineRow[]): BridgeImpact[] {
  const out: BridgeImpact[] = [];
  for (const row of lines) {
    if (!row.islanded.length) continue;
    const islanded = row.islanded.map((id) => model.ssById.get(id)).filter((r): r is SsRow => !!r);
    const discom = new Set<string>();
    let feeders = 0;
    for (const s of islanded) {
      feeders += s.feeders;
      for (const id of s.discomSsIds) discom.add(id);
    }
    out.push({ row, islanded, discomSs: discom.size, feeders });
  }
  return out.sort(
    (a, b) => b.discomSs - a.discomSs || b.islanded.length - a.islanded.length || b.row.ckm - a.row.ckm,
  );
}

/** Ranked list helper: top `n` by a numeric key (descending), ignoring zeros. */
export function topBy<T>(rows: readonly T[], key: (r: T) => number, n: number): T[] {
  return rows
    .filter((r) => key(r) > 0)
    .slice()
    .sort((a, b) => key(b) - key(a))
    .slice(0, n);
}

// ---------------------------------------------------------------------------------------------
// URL encoding for the drill path (hash key `mf`)

export function encodeFilters(filters: readonly ScopeFilter[]): string {
  return filters.map((f) => `${f.dim}:${f.value}`).join("~");
}

export function decodeFilters(s: string | null | undefined): ScopeFilter[] {
  if (!s) return [];
  const out: ScopeFilter[] = [];
  for (const part of s.split("~")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const dim = part.slice(0, i);
    const value = part.slice(i + 1);
    if (isDimId(dim) && value) out.push({ dim, value });
  }
  return out;
}

/** Bounding box [[w,s],[e,n]] of a set of substations (null when empty). */
export function bboxOf(ss: readonly SsRow[]): [[number, number], [number, number]] | null {
  if (!ss.length) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const r of ss) {
    w = Math.min(w, r.ss.lng);
    e = Math.max(e, r.ss.lng);
    s = Math.min(s, r.ss.lat);
    n = Math.max(n, r.ss.lat);
  }
  return [
    [w, s],
    [e, n],
  ];
}
