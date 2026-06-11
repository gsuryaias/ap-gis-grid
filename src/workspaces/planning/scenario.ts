// Pure scenario model for the Planning Studio (DSS revamp spec §4, milestone M5 v1).
// Everything here is serialisable + side-effect-free so the SAME code runs on the main
// thread (spec building, KPI/delta derivation, unit tests in the `node` env) and inside
// the flow worker (the actual DC solves) — the worker boundary only ever carries the
// plain-object types below (no Maps/Sets cross postMessage; results use arrays).
//
// HONESTY NOTE — the whole studio is a RESEARCH-GRADE SCREENING AID, never a system
// study. On top of dcflow.ts's own assumption stack (inferred topology, assumed
// impedances, indicative ratings, DC approximation) this module adds two more, equally
// crude and equally deliberate:
//
//   · DEMAND IS UNIFORM-SPREAD: a fixed indicative statewide base demand
//     (`BASE_DEMAND_MW`) is divided EQUALLY over every load substation, then each
//     substation's share is grown by its circle's CAGR to the horizon year. Real demand
//     is nothing like uniform — this only gives the screen a defensible, documented base
//     case (mirrors dcflow's `uniformInjections`, adding the per-circle growth knob).
//   · GENERATION IS A GUESS: "generator" substations are merely those with a line whose
//     external (non-TRANSCO) endpoint is categorised "Generation" in the source data —
//     no capacity, no merit order, no dispatch. Total generation is spread evenly over
//     them (or balanced wholly at the slack bus in "slack" mode).
import type { Circuit, LineProps, SubstationProps, Voltage } from "../../data/types.ts";
import {
  buildDcNetwork,
  lineUtilisation,
  n1Screen,
  solveDcFlow,
  type DcNetwork,
  type N1Result,
} from "../../lib/dcflow.ts";
import { buildGridGraph } from "../../lib/graph.ts";
import { haversineMeters } from "../../lib/geo.ts";

export type { N1Result } from "../../lib/dcflow.ts";

/** First scenario year — "no growth" — and the horizon-selector bounds. */
export const BASE_YEAR = 2026;
export const HORIZON_MAX_YEAR = 2040;

/**
 * Indicative statewide peak-demand scale (MW) spread uniformly over the load
 * substations. AP's evening peak is ≈ 12–13 GW (Grid-India PSP, FY 2025-26) — the value
 * only sets the SCALE of every flow figure, the screen's *ranking* is what matters.
 */
export const BASE_DEMAND_MW = 12_000;

/** Default per-circle demand CAGR (%/yr) and the slider range. */
export const DEFAULT_CAGR_PCT = 5;
export const CAGR_MIN_PCT = 0;
export const CAGR_MAX_PCT = 12;

export const MAX_SANDBOX_LINES = 3;

/**
 * Typical conductor assumed for a what-if sandbox line, per voltage class (the standard
 * Indian construction dcflow/capacity.ts also assume) — gives the hypothetical line an
 * indicative thermal rating without asking the user for conductor details.
 */
export const SANDBOX_CONDUCTOR: Record<Voltage, string> = {
  400: "Twin Moose",
  220: "Zebra",
  132: "Panther",
};

/** One-line honesty label used verbatim on every table footnote AND inside the CSV exports. */
export const HONESTY_NOTE =
  "Indicative screening only — inferred (geometric) topology, assumed impedances (typical Ω/km by " +
  "voltage class), indicative conductor thermal ratings, and a uniform-spread demand / evenly-spread " +
  "generation scenario. A research aid for where to look first, never a load-flow or N-1 study.";

// ---------------------------------------------------------------------------
// Serialisable network spec (what crosses the worker boundary)
// ---------------------------------------------------------------------------

/** Substation slice the solver needs: identity + the circle that drives demand growth. */
export interface WireSubstation {
  id: string;
  circle: string | null;
}

/** Line slice the solver needs (real or sandbox); `a`/`b` are the snapped endpoint SS ids. */
export interface WireLine {
  id: string;
  name: string;
  voltage: Voltage;
  circuit: Circuit;
  conductor: string | null;
  lengthKm: number | null;
  a: string | null;
  b: string | null;
  /** True for hypothetical what-if lines (not real assets — never deep-linked). */
  sandbox?: boolean;
}

/** One self-contained flow case — fully serialisable, structured-clone friendly. */
export interface FlowCaseSpec {
  substations: WireSubstation[];
  lines: WireLine[];
  /** Generator-bus candidates; empty ⇒ the whole injection balances at the slack bus. */
  generatorIds: string[];
  /** Demand CAGR (%/yr) per circle name; a circle absent here grows at the mean of the map. */
  cagrPctByCircle: Record<string, number>;
  /** Years of growth past BASE_YEAR (0 = the no-growth base). */
  years: number;
  baseDemandMw: number;
}

export function toWireSubstations(
  substations: ReadonlyArray<Pick<SubstationProps, "id" | "circle">>,
): WireSubstation[] {
  return substations.map((s) => ({ id: s.id, circle: s.circle }));
}

export function toWireLines(lines: readonly LineProps[]): WireLine[] {
  return lines.map((l) => ({
    id: l.id,
    name: l.name,
    voltage: l.voltage,
    circuit: l.circuit,
    conductor: l.conductor ?? null,
    lengthKm: l.lengthKm,
    a: l.fromSS?.ssId ?? null,
    b: l.toSS?.ssId ?? null,
  }));
}

/**
 * Rehydrate a WireLine into the LineProps shape dcflow/capacity.ts consume. Endpoint
 * SnapRefs are synthesised (dist 0 / high) — the wire format only exists because real
 * SnapRefs carry fields the solver never reads.
 */
export function wireToLineProps(w: WireLine): LineProps {
  return {
    id: w.id,
    kind: "line",
    name: w.name,
    voltage: w.voltage,
    circuit: w.circuit,
    lengthKm: w.lengthKm,
    ckm: null,
    circle: null,
    connectsSS: [],
    endpointLabels: null,
    fromSS: w.a ? { ssId: w.a, distM: 0, confidence: "high" } : null,
    toSS: w.b ? { ssId: w.b, distM: 0, confidence: "high" } : null,
    circuitAmbiguous: false,
    voltageMismatch: false,
    conductor: w.conductor,
  };
}

/**
 * Generator-bus candidates: TRANSCO substations touching at least one line whose
 * external (non-TRANSCO) endpoint is categorised "Generation". CRUDE BY DESIGN — it
 * flags "a plant connects somewhere near here", with no capacity or dispatch behind it.
 */
export function generatorCandidates(
  lines: ReadonlyArray<Pick<LineProps, "fromSS" | "toSS" | "externalEndpoints">>,
): string[] {
  const ids = new Set<string>();
  for (const l of lines) {
    if (!(l.externalEndpoints ?? []).some((e) => e.category === "Generation")) continue;
    if (l.fromSS) ids.add(l.fromSS.ssId);
    if (l.toSS) ids.add(l.toSS.ssId);
  }
  return [...ids].sort();
}

/** Compound growth multiplier after `years` at `cagrPct` %/yr (years clamped to ≥ 0). */
export function growthFactor(cagrPct: number, years: number): number {
  return Math.pow(1 + cagrPct / 100, Math.max(0, years));
}

/**
 * Scenario injections — dcflow's `uniformInjections` with a per-circle growth knob on
 * the load side. Base demand is spread EQUALLY over every load substation (uniform-
 * spread screening assumption, see the module honesty note), each share grown by its
 * circle's CAGR; total generation (= total grown load, so the case balances) is spread
 * evenly over the generator buses, or placed at the slack when none are given/survive.
 * Substations without a circle grow at the mean CAGR of the provided map.
 */
export function scenarioInjections(
  net: DcNetwork,
  substations: readonly WireSubstation[],
  spec: Pick<FlowCaseSpec, "generatorIds" | "cagrPctByCircle" | "years" | "baseDemandMw">,
): Map<string, number> {
  const inNet = new Set(net.nodes);
  const gens = spec.generatorIds.filter((id) => inNet.has(id));
  if (gens.length === 0) gens.push(net.slack);
  const genSet = new Set(gens);

  const loads = substations.filter((s) => inNet.has(s.id) && !genSet.has(s.id));
  const injections = new Map<string, number>();
  if (loads.length === 0) return injections;

  const cagrs = Object.values(spec.cagrPctByCircle);
  const meanCagr = cagrs.length > 0 ? cagrs.reduce((a, b) => a + b, 0) / cagrs.length : 0;
  const perSsBaseMw = spec.baseDemandMw / loads.length;

  let totalLoadMw = 0;
  for (const s of loads) {
    const cagr = (s.circle !== null ? spec.cagrPctByCircle[s.circle] : undefined) ?? meanCagr;
    const mw = perSsBaseMw * growthFactor(cagr, spec.years);
    injections.set(s.id, -mw);
    totalLoadMw += mw;
  }
  for (const id of gens) injections.set(id, totalLoadMw / gens.length);
  return injections;
}

// ---------------------------------------------------------------------------
// Worker result (plain arrays — no Maps across postMessage)
// ---------------------------------------------------------------------------

export interface UtilRow {
  lineId: string;
  flowMw: number;
  ratingMva: number | null;
  pct: number | null;
}

export interface FlowCaseResult {
  nodes: number;
  edgesSolved: number;
  slack: string;
  slackInjectionMw: number;
  /** Total modelled demand (MW) after growth — generation matches it by construction. */
  totalLoadMw: number;
  generatorCount: number;
  /** Lines solved on the documented fallback length (missing/zero lengthKm). */
  assumedLengthLines: number;
  util: UtilRow[];
  /** Full N-1 screen (every in-service circuit outaged once), in dcflow candidate order. */
  n1: N1Result[];
}

/**
 * Run one complete flow case: build the inferred network, solve the DC base case, rate
 * every line, then screen ALL N-1 contingencies (a full fresh solve per outage — ~770
 * solves complete in well under a second off the main thread). `onPhase` reports the
 * coarse stage for the UI's computing state.
 */
export function runFlowCase(spec: FlowCaseSpec, onPhase?: (phase: string) => void): FlowCaseResult {
  onPhase?.("Building network");
  const lines = spec.lines.map(wireToLineProps);
  const graph = buildGridGraph(spec.substations, lines);
  const net = buildDcNetwork(graph, lines);
  const injections = scenarioInjections(net, spec.substations, spec);

  onPhase?.("Solving DC base case");
  const sol = solveDcFlow(net, injections);
  const util = lineUtilisation(sol, lines);

  onPhase?.(`Screening ${net.edges.length} N\u22121 contingencies`);
  const n1 = n1Screen(net, lines, injections);

  let totalLoadMw = 0;
  let generatorCount = 0;
  for (const mw of injections.values()) {
    if (mw < 0) totalLoadMw -= mw;
    else if (mw > 0) generatorCount++;
  }

  return {
    nodes: net.nodes.length,
    edgesSolved: net.edges.length,
    slack: net.slack,
    slackInjectionMw: sol.slackInjectionMw,
    totalLoadMw,
    generatorCount,
    assumedLengthLines: net.assumedLengthLineIds.length,
    util: [...util.entries()].map(([lineId, u]) => ({ lineId, ...u })),
    n1,
  };
}

// ---------------------------------------------------------------------------
// Worker protocol
// ---------------------------------------------------------------------------

export interface FlowWorkerRequest {
  reqId: number;
  spec: FlowCaseSpec;
}

export type FlowWorkerResponse =
  | { type: "phase"; reqId: number; phase: string }
  | { type: "result"; reqId: number; result: FlowCaseResult }
  | { type: "error"; reqId: number; message: string };

// ---------------------------------------------------------------------------
// What-if sandbox
// ---------------------------------------------------------------------------

/** One user-drawn hypothetical line (the panel caps these at MAX_SANDBOX_LINES). */
export interface SandboxLine {
  fromId: string;
  toId: string;
  voltage: Voltage;
  circuit: Circuit;
}

/** Sandbox wire ids are namespaced so the UI never deep-links / looks them up in real data. */
export const SANDBOX_ID_PREFIX = "sb-";

/**
 * Expand sandbox entries into solver wire lines. Length is the great-circle distance
 * between the two substations (an assumed typical route — real routes run longer);
 * conductor is the typical construction for the voltage (SANDBOX_CONDUCTOR). A "DC"
 * entry becomes TWO parallel single-circuit wires — matching the dataset convention that
 * every line feature is one circuit, so the pair's susceptances parallel in the solver.
 * Entries whose endpoints are missing or identical (self-loop) are skipped.
 */
export function sandboxWireLines(
  sandbox: readonly SandboxLine[],
  ssById: ReadonlyMap<string, Pick<SubstationProps, "name" | "lng" | "lat">>,
): WireLine[] {
  const out: WireLine[] = [];
  sandbox.forEach((sb, i) => {
    const from = ssById.get(sb.fromId);
    const to = ssById.get(sb.toId);
    if (!from || !to || sb.fromId === sb.toId) return;
    const lengthKm = Math.max(
      0.1,
      Math.round(haversineMeters([from.lng, from.lat], [to.lng, to.lat]) / 100) / 10,
    );
    const circuits = sb.circuit === "DC" ? 2 : 1;
    for (let c = 1; c <= circuits; c++) {
      out.push({
        id: `${SANDBOX_ID_PREFIX}${i + 1}-c${c}`,
        name: `What-if: ${from.name} \u2013 ${to.name}${circuits > 1 ? ` Ckt-${c}` : ""}`,
        voltage: sb.voltage,
        circuit: "SC",
        conductor: SANDBOX_CONDUCTOR[sb.voltage],
        lengthKm,
        a: sb.fromId,
        b: sb.toId,
        sandbox: true,
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Readout derivations (KPIs, contingency ranking, sandbox deltas) — main thread
// ---------------------------------------------------------------------------

export interface CaseKpis {
  ratedLines: number;
  over80: number;
  over100: number;
  pctOver80: number;
  pctOver100: number;
  /** Contingencies whose outage NEWLY overloads at least one surviving line. */
  n1OverloadContingencies: number;
  /** Contingencies whose outage islands at least one substation (islanding-prone lines). */
  n1IslandingContingencies: number;
}

export function kpisFor(res: FlowCaseResult): CaseKpis {
  let rated = 0;
  let over80 = 0;
  let over100 = 0;
  for (const u of res.util) {
    if (u.pct === null) continue;
    rated++;
    if (u.pct >= 80) over80++;
    if (u.pct >= 100) over100++;
  }
  return {
    ratedLines: rated,
    over80,
    over100,
    pctOver80: rated > 0 ? (over80 / rated) * 100 : 0,
    pctOver100: rated > 0 ? (over100 / rated) * 100 : 0,
    n1OverloadContingencies: res.n1.filter((r) => r.overloads.length > 0).length,
    n1IslandingContingencies: res.n1.filter((r) => r.islanded.length > 0).length,
  };
}

/**
 * Simple composite severity for ranking contingencies: islanding dominates (200 per
 * cut-off substation — losing supply outranks any overload), each newly-overloaded line
 * adds 20, plus the worst post-outage loading %. A documented screening heuristic,
 * nothing more.
 */
export function n1Severity(r: N1Result): number {
  const worstPct = r.overloads.length > 0 ? r.overloads[0].pct : 0;
  return r.islanded.length * 200 + r.overloads.length * 20 + worstPct;
}

/** The `k` worst consequential contingencies (any islanding or new overload), worst first. */
export function topContingencies(n1: readonly N1Result[], k: number): N1Result[] {
  return n1
    .filter((r) => r.islanded.length > 0 || r.overloads.length > 0)
    .sort((a, b) => n1Severity(b) - n1Severity(a) || a.outageLineId.localeCompare(b.outageLineId))
    .slice(0, k);
}

export interface CorridorDelta {
  lineId: string;
  beforePct: number;
  afterPct: number;
  dropPp: number;
  /** Indicative MVA freed on this circuit = drop × its rating. */
  headroomGainMva: number;
}

/**
 * Sandbox delta: corridors whose base-case utilisation drops by ≥ `minDropPp` percentage
 * points between two cases (before = scenario without the what-if lines), biggest relief
 * first. Only lines rated in BOTH cases compare.
 */
export function relievedCorridors(
  before: FlowCaseResult,
  after: FlowCaseResult,
  minDropPp = 5,
): CorridorDelta[] {
  const afterById = new Map(after.util.map((u) => [u.lineId, u]));
  const out: CorridorDelta[] = [];
  for (const u of before.util) {
    if (u.pct === null || u.ratingMva === null) continue;
    const v = afterById.get(u.lineId);
    if (!v || v.pct === null) continue;
    const dropPp = u.pct - v.pct;
    if (dropPp >= minDropPp) {
      out.push({
        lineId: u.lineId,
        beforePct: u.pct,
        afterPct: v.pct,
        dropPp,
        headroomGainMva: (dropPp / 100) * u.ratingMva,
      });
    }
  }
  return out.sort((a, b) => b.dropPp - a.dropPp || a.lineId.localeCompare(b.lineId));
}
