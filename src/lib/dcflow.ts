// Pure, dependency-free **indicative DC power flow** over the inferred grid graph — the
// analytical foundation of the Planning Studio (design spec §3, milestone M5). Same
// discipline as graph.ts / capacity.ts: side-effect-free, unit-tested in the `node`
// environment, no deps.
//
// HONESTY NOTE — THIS IS A RESEARCH-GRADE SCREENING TOOL, NEVER A REAL STUDY. Every number
// it produces is indicative and must be labelled as such in any UI. The model stacks
// assumption on assumption, deliberately and visibly:
//
//   1. CONNECTIVITY IS INFERRED (geometric endpoint snapping — see graph.ts), not an
//      authoritative network model.
//   2. IMPEDANCES ARE ASSUMED. The source data has no electrical parameters, so per-line
//      series reactance comes from TYPICAL Indian transmission construction by voltage
//      class (overridable via options):
//        · 400 kV ≈ 0.332 Ω/km (twin/quad ACSR bundles — bundling lowers reactance)
//        · 220 kV ≈ 0.399 Ω/km (single/twin Zebra-class)
//        · 132 kV ≈ 0.410 Ω/km (single Panther-class)
//      x = Ω/km × lengthKm. A missing/zero lengthKm falls back to a documented default
//      (30 km) and the line is flagged `assumedLength` in the result.
//   3. DC APPROXIMATION: flat 1.0 pu voltage everywhere, lossless lines (R ≪ X ignored),
//      small angle differences (sin θ ≈ θ). Reactive power does not exist in this model.
//   4. DISPATCH IS A CRUDE SCENARIO (see `uniformInjections`), not market/merit-order data.
//   5. RATINGS ARE INDICATIVE (capacity.ts conductor ampacity — see its own honesty note).
//
// Per-unit convention: 100 MVA system base; x_pu = x_Ω × baseMVA / kV²; branch
// susceptance b = 1/x_pu. The network is the LARGEST CONNECTED COMPONENT of the inferred
// multigraph; parallel circuits stay separate edges, so their susceptances parallel
// naturally (two equal circuits ⇒ each carries half the corridor flow). Self-loops carry
// no defined DC flow and are excluded.
import type { LineProps, SubstationProps, Voltage } from "../data/types.ts";
import type { GridGraph } from "./graph.ts";
import { connectedComponents } from "./graph.ts";
import { lineCapacityFor } from "./capacity.ts";

/**
 * Typical series reactance (Ω/km) per voltage class for Indian transmission construction.
 * 400 kV lines are twin/quad-bundled (lower reactance); 220/132 kV mostly single conductor.
 * Indicative textbook values — overridable per voltage via `DcNetworkOptions.ohmPerKm`.
 */
export const DEFAULT_OHM_PER_KM: Record<Voltage, number> = {
  400: 0.332,
  220: 0.399,
  132: 0.41,
};

/** Fallback route length (km) when a line has missing/zero `lengthKm` (flagged `assumedLength`). */
export const DEFAULT_ASSUMED_LENGTH_KM = 30;

/** System MVA base for the per-unit conversion. */
export const DEFAULT_BASE_MVA = 100;

export interface DcNetworkOptions {
  /** Per-voltage Ω/km overrides (defaults: `DEFAULT_OHM_PER_KM`). */
  ohmPerKm?: Partial<Record<Voltage, number>>;
  /** Fallback length (km) for lines with missing/zero `lengthKm` (default 30). */
  assumedLengthKm?: number;
  /** Slack substation id (must be in the largest component, or this throws). */
  slackId?: string;
  /** Per-unit MVA base (default 100). */
  baseMva?: number;
}

/** One DC branch: a fully-resolved, non-self-loop line inside the largest component. */
export interface DcEdge {
  lineId: string;
  /** `fromSS` substation id — positive flow is a → b. */
  a: string;
  /** `toSS` substation id. */
  b: string;
  voltage: Voltage;
  /** Series reactance, per-unit on `baseMva`. */
  xPu: number;
  /** Branch susceptance = 1 / xPu. */
  susceptancePu: number;
  /** True when `lengthKm` was missing/zero and `assumedLengthKm` was used instead. */
  assumedLength: boolean;
}

export interface DcNetwork {
  /** Substation ids of the largest connected component (solver node set). */
  nodes: string[];
  edges: DcEdge[];
  /** Angle-reference node; also absorbs any injection imbalance. */
  slack: string;
  baseMva: number;
  /** Line ids whose reactance rests on the assumed default length (sorted). */
  assumedLengthLineIds: string[];
}

/**
 * Slack selection: the highest-degree substation that touches a 400 kV line (substation
 * voltage itself isn't passed in, so "400 kV SS" is inferred from incident 400 kV edges).
 * If the component has no 400 kV line at all, the highest-degree node overall. Degree is
 * counted in edges (circuits), ties break to the lexicographically smallest id.
 */
function pickSlack(nodes: string[], edges: DcEdge[], slackId?: string): string {
  if (slackId !== undefined) {
    if (!nodes.includes(slackId)) {
      throw new Error(`slackId "${slackId}" is not in the largest connected component`);
    }
    return slackId;
  }
  const degree = new Map<string, number>();
  const at400 = new Set<string>();
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
    if (e.voltage === 400) {
      at400.add(e.a);
      at400.add(e.b);
    }
  }
  const pool = (at400.size > 0 ? [...at400] : [...nodes]).sort();
  let best = pool[0];
  for (const id of pool) {
    if ((degree.get(id) ?? 0) > (degree.get(best) ?? 0)) best = id;
  }
  return best;
}

/**
 * Build the DC network from the inferred multigraph: nodes are the LARGEST connected
 * component; edges are the lines that resolved to graph edges with both ends in that
 * component (self-loops excluded — they carry no defined DC flow). Reactance per the
 * module-level assumptions; susceptances of parallel circuits parallel naturally because
 * each circuit stays its own edge.
 */
export function buildDcNetwork(
  g: GridGraph,
  lines: LineProps[],
  opts: DcNetworkOptions = {},
): DcNetwork {
  const largest = connectedComponents(g)[0] ?? [];
  if (largest.length === 0) throw new Error("buildDcNetwork: empty graph");
  const inComponent = new Set(largest);

  const baseMva = opts.baseMva ?? DEFAULT_BASE_MVA;
  const fallbackKm = opts.assumedLengthKm ?? DEFAULT_ASSUMED_LENGTH_KM;

  const edges: DcEdge[] = [];
  const assumedIds: string[] = [];
  for (const line of lines) {
    const ge = g.edges.get(line.id);
    if (!ge || ge.a === ge.b) continue; // unresolved end, or self-loop
    if (!inComponent.has(ge.a) || !inComponent.has(ge.b)) continue;

    const ohmPerKm = opts.ohmPerKm?.[line.voltage] ?? DEFAULT_OHM_PER_KM[line.voltage];
    const assumedLength = !(typeof line.lengthKm === "number" && line.lengthKm > 0);
    const lengthKm = assumedLength ? fallbackKm : line.lengthKm!;
    const xOhm = ohmPerKm * lengthKm;
    const xPu = (xOhm * baseMva) / (line.voltage * line.voltage);
    edges.push({
      lineId: line.id,
      a: ge.a,
      b: ge.b,
      voltage: line.voltage,
      xPu,
      susceptancePu: 1 / xPu,
      assumedLength,
    });
    if (assumedLength) assumedIds.push(line.id);
  }

  return {
    nodes: largest,
    edges,
    slack: pickSlack(largest, edges, opts.slackId),
    baseMva,
    assumedLengthLineIds: assumedIds.sort(),
  };
}

export interface DcSolution {
  /** Substation id → bus angle (radians; slack = 0). */
  angles: Map<string, number>;
  /** Line id → signed MW flow; positive means a → b (the line's fromSS → toSS). */
  flowsMw: Map<string, number>;
  slack: string;
  /**
   * MW the slack ends up injecting = −(sum of all other specified injections). Any
   * injection the caller specified AT the slack node is overridden — the slack always
   * absorbs the imbalance, which is also how a non-zero-sum scenario is auto-balanced.
   */
  slackInjectionMw: number;
}

/**
 * Dense Gaussian elimination with partial pivoting on an n×n row-major matrix (mutates
 * its inputs). ~376 nodes ⇒ trivially fast; no factorisation reuse needed for screening.
 */
function solveLinear(a: Float64Array, rhs: Float64Array, n: number): Float64Array {
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotAbs = Math.abs(a[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r * n + col]);
      if (v > pivotAbs) {
        pivotAbs = v;
        pivotRow = r;
      }
    }
    if (pivotAbs < 1e-12) {
      throw new Error("solveDcFlow: singular susceptance matrix (disconnected network?)");
    }
    if (pivotRow !== col) {
      for (let c = col; c < n; c++) {
        const tmp = a[col * n + c];
        a[col * n + c] = a[pivotRow * n + c];
        a[pivotRow * n + c] = tmp;
      }
      const tmp = rhs[col];
      rhs[col] = rhs[pivotRow];
      rhs[pivotRow] = tmp;
    }
    const pivot = a[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const factor = a[r * n + col] / pivot;
      if (factor === 0) continue;
      for (let c = col; c < n; c++) a[r * n + c] -= factor * a[col * n + c];
      rhs[r] -= factor * rhs[col];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let sum = rhs[r];
    for (let c = r + 1; c < n; c++) sum -= a[r * n + c] * x[c];
    x[r] = sum / a[r * n + r];
  }
  return x;
}

/**
 * Solve the DC power flow B′θ = P (reduced susceptance matrix, slack row/column removed,
 * slack angle = 0). Injections are MW, positive = generation, negative = load; ids not in
 * the network are silently ignored (overlay plants etc. are not solver nodes). Injections
 * that don't sum to ~0 are auto-balanced at the slack — see `DcSolution.slackInjectionMw`.
 */
export function solveDcFlow(net: DcNetwork, injectionsMw: Map<string, number>): DcSolution {
  const { nodes, slack, baseMva } = net;
  const reduced = new Map<string, number>();
  for (const id of nodes) {
    if (id !== slack) reduced.set(id, reduced.size);
  }
  const n = reduced.size;

  const bPrime = new Float64Array(n * n);
  for (const e of net.edges) {
    const ia = e.a === slack ? -1 : reduced.get(e.a)!;
    const ib = e.b === slack ? -1 : reduced.get(e.b)!;
    const y = e.susceptancePu;
    if (ia >= 0) bPrime[ia * n + ia] += y;
    if (ib >= 0) bPrime[ib * n + ib] += y;
    if (ia >= 0 && ib >= 0) {
      bPrime[ia * n + ib] -= y;
      bPrime[ib * n + ia] -= y;
    }
  }

  const p = new Float64Array(n);
  let specifiedSumMw = 0;
  for (const [id, mw] of injectionsMw) {
    if (id === slack) continue; // slack injection is solved, not specified
    const i = reduced.get(id);
    if (i === undefined) continue; // outside the solved component
    p[i] += mw / baseMva;
    specifiedSumMw += mw;
  }

  const theta = n > 0 ? solveLinear(bPrime, p, n) : new Float64Array(0);

  const angles = new Map<string, number>();
  angles.set(slack, 0);
  for (const [id, i] of reduced) angles.set(id, theta[i]);

  const flowsMw = new Map<string, number>();
  for (const e of net.edges) {
    const flowPu = e.susceptancePu * (angles.get(e.a)! - angles.get(e.b)!);
    flowsMw.set(e.lineId, flowPu * baseMva);
  }

  return { angles, flowsMw, slack, slackInjectionMw: -specifiedSumMw };
}

/**
 * Default scenario helper — a deliberately CRUDE screening assumption, not a dispatch:
 * `totalMw` of generation is spread evenly over `generatorIds` (those inside the network;
 * the slack alone if none survive the filter), and the same total of load is spread
 * UNIFORMLY over every other provided substation inside the network. Real load is nothing
 * like uniform — this exists only to give the screen a defensible, documented base case.
 */
export function uniformInjections(
  net: DcNetwork,
  substations: Pick<SubstationProps, "id">[],
  totalMw: number,
  generatorIds?: string[],
): Map<string, number> {
  const inNet = new Set(net.nodes);
  const gens = (generatorIds ?? []).filter((id) => inNet.has(id));
  if (gens.length === 0) gens.push(net.slack);
  const genSet = new Set(gens);

  const loadIds = substations.map((s) => s.id).filter((id) => inNet.has(id) && !genSet.has(id));

  const injections = new Map<string, number>();
  for (const id of gens) injections.set(id, totalMw / gens.length);
  if (loadIds.length > 0) {
    const perLoad = -totalMw / loadIds.length;
    for (const id of loadIds) injections.set(id, perLoad);
  }
  return injections;
}

export interface LineUtilisation {
  /** Signed MW flow from the solution. */
  flowMw: number;
  /** Indicative per-circuit thermal rating (capacity.ts), or null when unratable. */
  ratingMva: number | null;
  /** |flow| / rating × 100 (PERCENT), or null when the line has no rating. */
  pct: number | null;
}

/**
 * Per-line loading against the INDICATIVE thermal rating from capacity.ts. Lines are
 * already per-circuit features, so the per-circuit MVA is the right comparator (a "DC"
 * circuit type still describes ONE circuit feature here). DC MW vs thermal MVA ignores
 * reactive flow — consistent with the rest of the approximation, indicative only.
 */
export function lineUtilisation(sol: DcSolution, lines: LineProps[]): Map<string, LineUtilisation> {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const out = new Map<string, LineUtilisation>();
  for (const [lineId, flowMw] of sol.flowsMw) {
    const line = byId.get(lineId);
    const cap = line ? lineCapacityFor(line) : null;
    const ratingMva = cap ? cap.perCircuitMva : null;
    out.set(lineId, {
      flowMw,
      ratingMva,
      pct: ratingMva ? (Math.abs(flowMw) / ratingMva) * 100 : null,
    });
  }
  return out;
}

export interface N1Overload {
  lineId: string;
  /** Post-contingency signed MW flow. */
  flowMw: number;
  ratingMva: number;
  /** Post-contingency loading, percent. */
  pct: number;
  /** Base-case loading, percent (null when the base solve had no rating — can't happen here, kept for shape). */
  basePct: number | null;
}

export interface N1Result {
  outageLineId: string;
  /**
   * Substations cut off from the slack's side when this outage disconnects the network
   * (same spirit as graph.ts `lineOutageImpact`; here the surviving side is by definition
   * the one containing the slack, whose flows are re-solved with the island's injections
   * dropped — absorbed at the slack). Empty when the network stays connected.
   */
  islanded: string[];
  /** Lines NEWLY above 100% of their indicative rating (base ≤ 100%), worst first. */
  overloads: N1Overload[];
}

/**
 * N-1 contingency screen: for each in-service line (or the `topK` by base-case loading),
 * remove it, re-solve, and report newly-overloaded survivors and islanding. Each outage
 * is a full fresh solve — O(K × solve), no factorisation reuse — correctness and clarity
 * over speed (376 nodes solve in milliseconds). Results follow candidate order: base-case
 * loading descending (unrated lines last), ties by line id.
 *
 * INDICATIVE ONLY — assumed impedances, assumed ratings, crude dispatch. A screening aid
 * for "where to look first", never an operational N-1 study.
 */
export function n1Screen(
  net: DcNetwork,
  lines: LineProps[],
  injectionsMw: Map<string, number>,
  opts: { topK?: number } = {},
): N1Result[] {
  const base = solveDcFlow(net, injectionsMw);
  const baseUtil = lineUtilisation(base, lines);

  const candidates = [...net.edges].sort((x, y) => {
    const px = baseUtil.get(x.lineId)?.pct ?? -1;
    const py = baseUtil.get(y.lineId)?.pct ?? -1;
    return py - px || x.lineId.localeCompare(y.lineId);
  });
  const picked = opts.topK !== undefined ? candidates.slice(0, opts.topK) : candidates;

  const results: N1Result[] = [];
  for (const outage of picked) {
    const remaining = net.edges.filter((e) => e.lineId !== outage.lineId);

    // Reachability from the slack over the surviving edges.
    const adjacency = new Map<string, DcEdge[]>();
    for (const e of remaining) {
      if (!adjacency.has(e.a)) adjacency.set(e.a, []);
      if (!adjacency.has(e.b)) adjacency.set(e.b, []);
      adjacency.get(e.a)!.push(e);
      adjacency.get(e.b)!.push(e);
    }
    const reached = new Set<string>([net.slack]);
    const queue: string[] = [net.slack];
    while (queue.length > 0) {
      const u = queue.pop()!;
      for (const e of adjacency.get(u) ?? []) {
        const v = e.a === u ? e.b : e.a;
        if (!reached.has(v)) {
          reached.add(v);
          queue.push(v);
        }
      }
    }
    const islanded = net.nodes.filter((id) => !reached.has(id)).sort();

    const subnet: DcNetwork = {
      nodes: net.nodes.filter((id) => reached.has(id)),
      edges: remaining.filter((e) => reached.has(e.a) && reached.has(e.b)),
      slack: net.slack,
      baseMva: net.baseMva,
      assumedLengthLineIds: net.assumedLengthLineIds,
    };
    const sol = solveDcFlow(subnet, injectionsMw);
    const util = lineUtilisation(sol, lines);

    const overloads: N1Overload[] = [];
    for (const [lineId, u] of util) {
      if (u.pct === null || u.pct <= 100) continue;
      const basePct = baseUtil.get(lineId)?.pct ?? null;
      if (basePct !== null && basePct > 100) continue; // already overloaded pre-contingency
      overloads.push({ lineId, flowMw: u.flowMw, ratingMva: u.ratingMva!, pct: u.pct, basePct });
    }
    overloads.sort((x, y) => y.pct - x.pct || x.lineId.localeCompare(y.lineId));

    results.push({ outageLineId: outage.lineId, islanded, overloads });
  }
  return results;
}
