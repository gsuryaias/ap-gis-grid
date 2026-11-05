// Network MIS — drill-down catalog (pure). Every number the MIS prints is backed by a MetricId
// that resolves to the exact records behind it, so an analyst can always answer "which ones?".
//
// Contract (enforced by drill.test.ts against the real network): the records a metric returns
// reconcile to the number it labels — a count metric returns that many records; a sum metric
// (circuit-km, route-km, Σ rating) returns the rows whose values sum to it; the mean line age is
// the ckm-weighted mean of the rows returned.
import type { ConnectivityIndex } from "../../data/connectivity.ts";
import type { Voltage } from "../../data/types.ts";
import { interfaceSecurity, type InterfaceFeed } from "../../lib/supply-security.ts";
import {
  isRadial,
  LINE_USEFUL_LIFE_YRS,
  NONE,
  type DimId,
  type LineRow,
  type MapFocus,
  type MisModel,
  type Scope,
  type ScopeFilter,
  type SsRow,
} from "./model.ts";

export type RecordKind = "ss" | "lines" | "discom" | "feeders" | "ifaces";

export type MetricId =
  | "ss"
  | "ss400"
  | "ss220"
  | "ss132"
  | "lines"
  | "ckm400"
  | "ckm220"
  | "ckm132"
  | "route"
  | "mva"
  | "unrated"
  | "age"
  | "past"
  | "ageUnknown"
  | "radial"
  | "radialSc"
  | "radialDc"
  | "radialDiscom"
  | "bridges"
  | "bridgeDiscom"
  | "singleFed"
  | "cut"
  | "feedingSs"
  | "feeders"
  | "discomSs"
  | "ifaceWeak"
  | "ifaceGen"
  | "ifaceRail";

export interface MetricDef {
  kind: RecordKind;
  /** Noun phrase for the list title ("Radially fed substations"). */
  title: string;
  /** What the list is ranked by / what to read from it. */
  hint: string;
  /** The same set expressed as a page filter, when a dimension captures it exactly. */
  asFilter?: ScopeFilter;
}

const kvSs = (v: Voltage): MetricDef => ({
  kind: "ss",
  title: `${v} kV substations`,
  hint: "Substations are classed by their highest voltage.",
  asFilter: { dim: "voltage", values: [String(v)] },
});
const kvLines = (v: Voltage): MetricDef => ({
  kind: "lines",
  title: `${v} kV line rows`,
  hint: "Ranked by circuit-km.",
  asFilter: { dim: "voltage", values: [String(v)] },
});

export const METRICS: Record<MetricId, MetricDef> = {
  ss: { kind: "ss", title: "Substations", hint: "TRANSCO substations, highest voltage first." },
  ss400: kvSs(400),
  ss220: kvSs(220),
  ss132: kvSs(132),
  lines: { kind: "lines", title: "Line rows", hint: "Ranked by circuit-km. A DC tower line digitised as Ckt-1 + Ckt-2 is two rows." },
  ckm400: kvLines(400),
  ckm220: kvLines(220),
  ckm132: kvLines(132),
  route: { kind: "lines", title: "Line rows by route-km", hint: "Ranked by route-km (sibling circuits on one tower line share the route)." },
  mva: { kind: "lines", title: "Rated line rows", hint: "Ranked by indicative thermal rating (conductor nominal ampacity × circuits)." },
  unrated: {
    kind: "lines",
    title: "Line rows without a rating",
    hint: "Conductor not recognised (UG cable, alloy, blank) — no indicative rating.",
    asFilter: { dim: "conductor", values: [NONE] },
  },
  age: { kind: "lines", title: "Line rows with a commissioning year", hint: "Oldest first. Fleet age is the circuit-km-weighted mean of these." },
  past: {
    kind: "lines",
    title: `Line rows ≥ ${LINE_USEFUL_LIFE_YRS} yrs (past CERC useful life)`,
    hint: "Oldest first. Candidates for condition assessment / R&M.",
    asFilter: { dim: "age", values: ["3"] },
  },
  ageUnknown: {
    kind: "lines",
    title: "Line rows with no commissioning year",
    hint: "Excluded from the fleet-age figures.",
    asFilter: { dim: "age", values: ["unknown"] },
  },
  radial: {
    kind: "ss",
    title: "Radially fed substations",
    hint: "Single-circuit feeds first, then by 33/11 kV substations depending on them.",
    asFilter: { dim: "supply", values: ["radial-sc", "radial-dc"] },
  },
  radialSc: {
    kind: "ss",
    title: "Radial on a single circuit",
    hint: "One circuit trip interrupts supply (N-1 insecure). Ranked by 33/11 kV load behind them.",
    asFilter: { dim: "supply", values: ["radial-sc"] },
  },
  radialDc: {
    kind: "ss",
    title: "Radial on one multi-circuit corridor",
    hint: "Survives a circuit trip, not a tower-line failure. Ranked by 33/11 kV load behind them.",
    asFilter: { dim: "supply", values: ["radial-dc"] },
  },
  radialDiscom: { kind: "discom", title: "33/11 kV substations behind radial feeds", hint: "Fed (via traced 33 kV feeders) from a radially fed TRANSCO substation." },
  bridges: { kind: "lines", title: "Bridge lines (inferred N-1)", hint: "A single trip islands substations. Ranked by substations islanded." },
  bridgeDiscom: { kind: "discom", title: "33/11 kV substations exposed to a bridge outage", hint: "Fed from a TRANSCO substation that a single line trip would island." },
  singleFed: {
    kind: "ss",
    title: "Single-fed substations",
    hint: "One neighbouring source in the inferred graph.",
    asFilter: { dim: "role", values: ["single-fed"] },
  },
  cut: {
    kind: "ss",
    title: "Cut-point substations",
    hint: "A bus outage here splits the grid. Ranked by substations it would island.",
    asFilter: { dim: "role", values: ["articulation"] },
  },
  feedingSs: { kind: "ss", title: "TRANSCO substations with traced 33 kV feeders", hint: "Ranked by 33/11 kV substations served." },
  feeders: { kind: "feeders", title: "33 kV feeders (traced)", hint: "Inferred TRANSCO source; ranked by 33/11 kV substations on the feeder." },
  discomSs: { kind: "discom", title: "33/11 kV substations fed", hint: "Distinct DISCOM substations on the traced 33 kV feeders." },
  ifaceWeak: { kind: "ifaces", title: "Interfaces on a single circuit", hint: "Generating stations and traction substations tied to the grid by one circuit." },
  ifaceGen: { kind: "ifaces", title: "Generating stations on a single circuit", hint: "Evacuation-insecure: one trip backs the station down." },
  ifaceRail: { kind: "ifaces", title: "Traction substations on a single circuit", hint: "Normally given two independent feeds." },
};

/** A drill request: a metric, optionally narrowed to one breakdown group. */
export interface DrillSpec {
  metric: MetricId;
  group?: { dim: DimId; key: string; label: string };
}

export interface DiscomRec {
  id: string;
  name: string;
  discom: string;
  lng: number;
  lat: number;
  /** TRANSCO substations whose traced feeders reach it. */
  sourceIds: string[];
  feeders: string[];
}

export interface FeederRec {
  id: string;
  name: string;
  discom: string;
  km: number;
  method: string;
  sourceId: string;
  served: number;
}

export type DrillRecords =
  | { kind: "ss"; rows: SsRow[] }
  | { kind: "lines"; rows: LineRow[] }
  | { kind: "discom"; rows: DiscomRec[] }
  | { kind: "feeders"; rows: FeederRec[] }
  | { kind: "ifaces"; rows: InterfaceFeed[] };

/** Generating stations / traction SS hanging on ONE circuit whose line is in `lines`. */
export function scopeInterfaces(model: MisModel, lines: readonly LineRow[]): InterfaceFeed[] {
  const inScope = new Set(lines.map((r) => r.id));
  return model.sec.interfaces.filter(
    (f) =>
      f.category !== "HT consumer" &&
      f.lineIds.some((id) => inScope.has(id)) &&
      interfaceSecurity(f) === "single-circuit",
  );
}

const byName = (a: SsRow, b: SsRow) => b.voltage - a.voltage || a.ss.name.localeCompare(b.ss.name);
const byLoad = (a: SsRow, b: SsRow) => b.discomSsIds.length - a.discomSsIds.length || byName(a, b);
const byCkm = (a: LineRow, b: LineRow) => b.ckm - a.ckm || a.line.name.localeCompare(b.line.name);
const byAge = (a: LineRow, b: LineRow) => (b.age ?? -1) - (a.age ?? -1) || byCkm(a, b);

function discomOf(conn: Pick<ConnectivityIndex, "bySs" | "ss"> | null, sources: readonly SsRow[]): DiscomRec[] {
  if (!conn) return [];
  const out = new Map<string, DiscomRec>();
  for (const s of sources) {
    for (const f of conn.bySs[s.id] ?? []) {
      for (const id of f[5]) {
        let r = out.get(id);
        if (!r) {
          const t = conn.ss[id];
          r = { id, name: t?.[0] ?? id, discom: t?.[1] ?? f[2], lng: t?.[2] ?? NaN, lat: t?.[3] ?? NaN, sourceIds: [], feeders: [] };
          out.set(id, r);
        }
        if (!r.sourceIds.includes(s.id)) r.sourceIds.push(s.id);
        const fn = f[1] ?? f[0];
        if (!r.feeders.includes(fn)) r.feeders.push(fn);
      }
    }
  }
  return [...out.values()].sort((a, b) => a.discom.localeCompare(b.discom) || a.name.localeCompare(b.name));
}

/** Resolve a metric over a scope into its records (see the reconciliation contract above). */
export function drillRecords(
  model: MisModel,
  conn: Pick<ConnectivityIndex, "bySs" | "ss"> | null,
  scope: Scope,
  metric: MetricId,
): DrillRecords {
  const { ss, lines } = scope;
  const S = (rows: SsRow[]): DrillRecords => ({ kind: "ss", rows });
  const L = (rows: LineRow[]): DrillRecords => ({ kind: "lines", rows });
  switch (metric) {
    case "ss":
      return S([...ss].sort(byName));
    case "ss400":
    case "ss220":
    case "ss132": {
      const v = Number(metric.slice(2));
      return S(ss.filter((r) => r.voltage === v).sort(byName));
    }
    case "lines":
      return L([...lines].sort(byCkm));
    case "ckm400":
    case "ckm220":
    case "ckm132": {
      const v = Number(metric.slice(3));
      return L(lines.filter((r) => r.voltage === v).sort(byCkm));
    }
    case "route":
      return L([...lines].sort((a, b) => b.routeKm - a.routeKm || byCkm(a, b)));
    case "mva":
      return L(lines.filter((r) => r.mva != null).sort((a, b) => b.mva! - a.mva! || byCkm(a, b)));
    case "unrated":
      return L(lines.filter((r) => r.mva == null).sort(byCkm));
    case "age":
      return L(lines.filter((r) => r.age != null).sort(byAge));
    case "past":
      return L(lines.filter((r) => r.age != null && r.age >= LINE_USEFUL_LIFE_YRS).sort(byAge));
    case "ageUnknown":
      return L(lines.filter((r) => r.age == null).sort(byCkm));
    case "radial":
    case "radialSc":
    case "radialDc": {
      const keep = (r: SsRow) =>
        metric === "radial" ? isRadial(r) : r.supply.cls === (metric === "radialSc" ? "radial-sc" : "radial-dc");
      const sev = (r: SsRow) => (r.supply.cls === "radial-sc" ? 0 : 1);
      return S(ss.filter(keep).sort((a, b) => sev(a) - sev(b) || byLoad(a, b)));
    }
    case "radialDiscom":
      return { kind: "discom", rows: discomOf(conn, ss.filter(isRadial)) };
    case "bridges":
      return L(lines.filter((r) => r.islanded.length).sort((a, b) => b.islanded.length - a.islanded.length || byCkm(a, b)));
    case "bridgeDiscom": {
      const islanded = new Map<string, SsRow>();
      for (const r of lines)
        for (const id of r.islanded) {
          const s = model.ssById.get(id);
          if (s) islanded.set(id, s);
        }
      return { kind: "discom", rows: discomOf(conn, [...islanded.values()]) };
    }
    case "singleFed":
      return S(ss.filter((r) => r.role === "single-fed").sort(byLoad));
    case "cut":
      return S(
        ss.filter((r) => r.role === "articulation").sort((a, b) => b.cutIslands.length - a.cutIslands.length || byLoad(a, b)),
      );
    case "feedingSs":
      return S(ss.filter((r) => r.feeders > 0).sort(byLoad));
    case "feeders": {
      const rows: FeederRec[] = [];
      if (conn)
        for (const s of ss)
          for (const f of conn.bySs[s.id] ?? [])
            rows.push({ id: f[0], name: f[1] ?? "Unnamed feeder", discom: f[2], km: f[3], method: f[4], sourceId: s.id, served: f[5].length });
      return { kind: "feeders", rows: rows.sort((a, b) => b.served - a.served || b.km - a.km) };
    }
    case "discomSs":
      return { kind: "discom", rows: discomOf(conn, ss) };
    case "ifaceWeak":
    case "ifaceGen":
    case "ifaceRail": {
      const cat = metric === "ifaceGen" ? "Generation" : metric === "ifaceRail" ? "Railway" : null;
      const rows = scopeInterfaces(model, lines).filter((f) => !cat || f.category === cat);
      return { kind: "ifaces", rows: rows.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)) };
    }
  }
}

/**
 * The map highlight for a record set: substations + lines to keep lit (everything else dims) —
 * a line list lights its end substations; a substation list lights the lines between them (and,
 * for radial lists, the radial feed corridors back to the meshed grid); DISCOM lists light their
 * TRANSCO sources.
 */
export function recordsFocus(model: MisModel, recs: DrillRecords, key: string, label: string): MapFocus {
  const ssIds = new Set<string>();
  const lineIds = new Set<string>();
  switch (recs.kind) {
    case "ss": {
      for (const r of recs.rows) ssIds.add(r.id);
      for (const l of model.lines) if (l.line.connectsSS.length > 1 && l.line.connectsSS.every((id) => ssIds.has(id))) lineIds.add(l.id);
      for (const r of recs.rows) {
        if (!isRadial(r)) continue;
        for (const k of r.supply.path) {
          const c = model.sec.corridors.get(k);
          if (!c) continue;
          for (const id of c.lineIds) lineIds.add(id);
          for (const n of [c.a, c.b]) if (model.ssById.has(n)) ssIds.add(n);
        }
      }
      break;
    }
    case "lines":
      for (const r of recs.rows) {
        lineIds.add(r.id);
        for (const id of r.line.connectsSS) if (model.ssById.has(id)) ssIds.add(id);
      }
      break;
    case "discom":
      for (const r of recs.rows) for (const id of r.sourceIds) ssIds.add(id);
      break;
    case "feeders":
      for (const r of recs.rows) ssIds.add(r.sourceId);
      break;
    case "ifaces":
      for (const f of recs.rows) {
        for (const id of f.ssIds) ssIds.add(id);
        for (const id of f.lineIds) lineIds.add(id);
      }
      break;
  }
  return { key, label, ssIds: [...ssIds], lineIds: [...lineIds] };
}
