// Supply security of the transmission grid — which substations are RADIALLY fed, how weak that
// radial feed is, and what hangs off it. Pure, dependency-free, unit-tested (node env).
//
// Planner's framing (CEA Manual on Transmission Planning Criteria): a substation is N-1 secure when
// losing any single element leaves it supplied. Two distinct failure modes matter for a radial feed:
//   - a CIRCUIT trip (most common): a substation fed over ONE circuit loses supply;
//   - a CORRIDOR / TOWER failure (cyclone, tower collapse, ROW fire): a double-circuit line on
//     common towers survives a circuit trip but not the loss of the tower line.
// So the analysis runs on a CORRIDOR graph — one edge per substation pair, carrying the number of
// circuits between them — rather than on the per-circuit multigraph (`graph.ts`), where a DC line's
// second circuit hides the corridor-level single point of failure.
//
//   meshed      ≥ 2 corridor-independent paths to the meshed core (survives circuit + corridor loss)
//   radial-dc   hangs off the core through a corridor of ≥ 2 circuits — circuit N-1 secure, but one
//               tower line away from losing supply
//   radial-sc   somewhere between it and the core there is a corridor of ONE circuit — a single
//               trip interrupts it (N-1 insecure)
//   unconnected no inferred path to the main grid (usually a digitisation gap)
//
// The meshed core = the largest 2-edge-connected component of the corridor graph. Removing the
// corridor bridges leaves 2-edge-connected blocks that form a tree ("bridge tree") around the core;
// every block other than the core is a radial pocket (possibly containing a local loop).
//
// Generation switchyards that terminate TRANSCO lines (external endpoints, category "Generation")
// are added as graph nodes: a line through a plant switchyard is a real path. Railway-traction and
// HT-consumer endpoints are loads (leaves) and never create a path.
//
// HONESTY: everything is INFERRED from geometric endpoint snapping. PGCIL inter-state ties that the
// snapping did not resolve, 33 kV back-feeds and normally-open points are not modelled. Screening
// only — not a contingency study.
import type { GridEdge, GridGraph } from "./graph.ts";
import { articulationSubstations, bridgeLines } from "./graph.ts";

export type SupplyClass = "meshed" | "radial-dc" | "radial-sc" | "unconnected";
export const SUPPLY_ORDER: SupplyClass[] = ["radial-sc", "radial-dc", "meshed", "unconnected"];
export const SUPPLY_LABEL: Record<SupplyClass, string> = {
  "radial-sc": "Radial · single circuit",
  "radial-dc": "Radial · single corridor",
  meshed: "Meshed (N-1 secure)",
  unconnected: "No path to grid",
};
export const SUPPLY_HINT: Record<SupplyClass, string> = {
  "radial-sc": "A single circuit trip somewhere on its feed interrupts supply (N-1 insecure)",
  "radial-dc": "Survives a circuit trip, but every path crosses one multi-circuit corridor — a tower failure interrupts supply",
  meshed: "At least two corridor-independent paths to the meshed grid",
  unconnected: "No inferred path to the main grid (usually a digitisation gap)",
};

/** Minimal line shape the analysis needs (a subset of `LineProps`). */
export interface SecLine {
  id: string;
  fromSS: { ssId: string } | null;
  toSS: { ssId: string } | null;
  circuits?: number;
  circuit?: string;
  lengthKm?: number | null;
  routeKm?: number | null;
  externalEndpoints?: { name: string; category: string }[];
}

/** All circuits between one node pair. */
export interface Corridor {
  key: string;
  a: string;
  b: string;
  lineIds: string[];
  circuits: number;
  /** Physical route km (sum of the rows' route shares; sibling Ckt rows split one route). */
  routeKm: number;
  /** Removing this corridor disconnects the corridor graph. */
  bridge: boolean;
}

export interface SsSupply {
  cls: SupplyClass;
  /** Corridor bridges crossed between this node and the meshed core (0 = meshed). */
  depth: number;
  /** Fewest circuits on any bridge corridor along the radial feed (null when meshed/unconnected). */
  bottleneck: number | null;
  /** Route km of the bridge corridors on the radial feed. */
  radialKm: number;
  /** Core-side substation the radial feed hangs from. */
  headId: string | null;
  /** Bridge corridor keys from the core outward to this node. */
  path: string[];
  /** Pocket key = the first (core-side) bridge corridor of the feed. */
  pocket: string | null;
}

export interface Pocket {
  key: string;
  /** Core substation the pocket hangs from. */
  headId: string;
  /** TRANSCO substations inside the pocket (generation nodes excluded). */
  ssIds: string[];
  /** Generation switchyards inside the pocket (names). */
  generation: string[];
  /** Every line touching a pocket node (includes the entry corridor). */
  lineIds: string[];
  /** Circuits on the entry corridor. */
  entryCircuits: number;
  /** Route km of the entry corridor. */
  entryKm: number;
  /** Physical route km of all lines in the pocket (incl. entry). */
  routeKm: number;
  /** Longest chain of bridge corridors inside the pocket. */
  maxDepth: number;
  /** Pocket substations on a single-circuit feed. */
  scCount: number;
}

export interface InterfaceFeed {
  category: string;
  name: string;
  lineIds: string[];
  circuits: number;
  /** Distinct TRANSCO substations it is connected to. */
  ssIds: string[];
}

export interface SupplySecurity {
  bySs: Map<string, SsSupply>;
  corridors: Map<string, Corridor>;
  /** Line id → its corridor key (lines with two resolved nodes only). */
  corridorOfLine: Map<string, string>;
  pockets: Pocket[];
  pocketByKey: Map<string, Pocket>;
  coreIds: Set<string>;
  /** Cut-point substation → TRANSCO substations islanded by its total loss (bus outage), sorted. */
  cutImpacts: Map<string, string[]>;
  /** Substation → lines touching it whose far end resolved to nothing (data gap near it). */
  openEnds: Map<string, number>;
  /** Non-TRANSCO terminals (generation / traction / HT consumer) and how they are connected. */
  interfaces: InterfaceFeed[];
}

export const GEN_PREFIX = "gen:";
const genNode = (name: string) => `${GEN_PREFIX}${name.trim().toLowerCase()}`;
export const isGenNode = (id: string) => id.startsWith(GEN_PREFIX);

/** The graph nodes a line joins: resolved TRANSCO ends + generation switchyards. */
function lineNodes(l: SecLine): string[] {
  const out: string[] = [];
  if (l.fromSS) out.push(l.fromSS.ssId);
  if (l.toSS) out.push(l.toSS.ssId);
  for (const e of l.externalEndpoints ?? []) if (e.category === "Generation") out.push(genNode(e.name));
  return out;
}

const circuitsOf = (l: SecLine) => l.circuits ?? (l.circuit === "DC" ? 2 : 1);
const routeOf = (l: SecLine) => l.routeKm ?? l.lengthKm ?? 0;

export function computeSupplySecurity(substations: readonly { id: string }[], lines: readonly SecLine[]): SupplySecurity {
  // ---- Corridor graph ---------------------------------------------------------------------
  const nodes = new Set<string>(substations.map((s) => s.id));
  const corridors = new Map<string, Corridor>();
  const corridorOfLine = new Map<string, string>();
  const openEnds = new Map<string, number>();
  const ifaces = new Map<string, InterfaceFeed>();

  for (const l of lines) {
    const ns = lineNodes(l);
    const resolved = [l.fromSS?.ssId, l.toSS?.ssId].filter((x): x is string => !!x);
    for (const e of l.externalEndpoints ?? []) {
      const k = `${e.category}|${e.name}`;
      const f = ifaces.get(k) ?? { category: e.category, name: e.name, lineIds: [], circuits: 0, ssIds: [] };
      f.lineIds.push(l.id);
      f.circuits += circuitsOf(l);
      for (const s of resolved) if (!f.ssIds.includes(s)) f.ssIds.push(s);
      ifaces.set(k, f);
    }
    if (resolved.length === 1 && !(l.externalEndpoints ?? []).length) {
      openEnds.set(resolved[0], (openEnds.get(resolved[0]) ?? 0) + 1);
    }
    if (ns.length !== 2 || ns[0] === ns[1]) continue;
    const [a, b] = ns[0] < ns[1] ? [ns[0], ns[1]] : [ns[1], ns[0]];
    nodes.add(a);
    nodes.add(b);
    const key = `${a}|${b}`;
    const c = corridors.get(key) ?? { key, a, b, lineIds: [], circuits: 0, routeKm: 0, bridge: false };
    c.lineIds.push(l.id);
    c.circuits += circuitsOf(l);
    c.routeKm += routeOf(l);
    corridors.set(key, c);
    corridorOfLine.set(l.id, key);
  }

  const adjacency = new Map<string, GridEdge[]>();
  for (const n of nodes) adjacency.set(n, []);
  const edges = new Map<string, GridEdge>();
  for (const c of corridors.values()) {
    const e: GridEdge = { lineId: c.key, a: c.a, b: c.b };
    edges.set(c.key, e);
    adjacency.get(c.a)!.push(e);
    adjacency.get(c.b)!.push(e);
  }
  const g: GridGraph = { nodes, edges, adjacency };
  for (const k of bridgeLines(g)) corridors.get(k)!.bridge = true;

  // ---- 2-edge-connected blocks → the meshed core -----------------------------------------
  const block = new Map<string, number>();
  const blockSize: number[] = [];
  for (const start of nodes) {
    if (block.has(start)) continue;
    const id = blockSize.length;
    let size = 0;
    const stack = [start];
    block.set(start, id);
    while (stack.length) {
      const u = stack.pop()!;
      size++;
      for (const e of adjacency.get(u)!) {
        if (corridors.get(e.lineId)!.bridge) continue;
        const v = e.a === u ? e.b : e.a;
        if (!block.has(v)) {
          block.set(v, id);
          stack.push(v);
        }
      }
    }
    blockSize.push(size);
  }
  let coreBlock = -1;
  for (let i = 0; i < blockSize.length; i++) if (coreBlock < 0 || blockSize[i] > blockSize[coreBlock]) coreBlock = i;
  const coreIds = new Set([...nodes].filter((n) => block.get(n) === coreBlock && blockSize[coreBlock] > 1));

  // ---- Walk the bridge tree outward from the core -----------------------------------------
  const bySs = new Map<string, SsSupply>();
  const stack: string[] = [];
  for (const n of coreIds) {
    bySs.set(n, { cls: "meshed", depth: 0, bottleneck: null, radialKm: 0, headId: null, path: [], pocket: null });
    stack.push(n);
  }
  while (stack.length) {
    const u = stack.pop()!;
    const su = bySs.get(u)!;
    for (const e of adjacency.get(u)!) {
      const v = e.a === u ? e.b : e.a;
      if (bySs.has(v)) continue;
      const c = corridors.get(e.lineId)!;
      let sv: SsSupply;
      if (!c.bridge) {
        sv = { ...su, path: su.path };
      } else {
        const bottleneck = su.bottleneck == null ? c.circuits : Math.min(su.bottleneck, c.circuits);
        sv = {
          cls: bottleneck <= 1 ? "radial-sc" : "radial-dc",
          depth: su.depth + 1,
          bottleneck,
          radialKm: su.radialKm + c.routeKm,
          headId: su.headId ?? u,
          path: [...su.path, c.key],
          pocket: su.pocket ?? c.key,
        };
      }
      bySs.set(v, sv);
      stack.push(v);
    }
  }
  for (const n of nodes) {
    if (!bySs.has(n)) {
      bySs.set(n, { cls: "unconnected", depth: 0, bottleneck: null, radialKm: 0, headId: null, path: [], pocket: null });
    }
  }

  // ---- Pockets --------------------------------------------------------------------------
  const members = new Map<string, string[]>();
  for (const [n, s] of bySs) if (s.pocket) (members.get(s.pocket) ?? members.set(s.pocket, []).get(s.pocket)!).push(n);
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const pockets: Pocket[] = [];
  for (const [key, ns] of members) {
    const set = new Set(ns);
    const entry = corridors.get(key)!;
    const lineIds = lines.filter((l) => lineNodes(l).some((n) => set.has(n))).map((l) => l.id);
    const ssIds = ns.filter((n) => !isGenNode(n)).sort();
    pockets.push({
      key,
      headId: bySs.get(ns[0])!.headId!,
      ssIds,
      generation: ns.filter(isGenNode).map((n) => n.slice(GEN_PREFIX.length)),
      lineIds,
      entryCircuits: entry.circuits,
      entryKm: entry.routeKm,
      routeKm: lineIds.reduce((a, id) => a + routeOf(lineById.get(id)!), 0),
      maxDepth: Math.max(...ns.map((n) => bySs.get(n)!.depth)),
      scCount: ssIds.filter((n) => bySs.get(n)!.cls === "radial-sc").length,
    });
  }
  pockets.sort((x, y) => y.ssIds.length - x.ssIds.length || x.key.localeCompare(y.key));

  // ---- Cut-point substations: what a total (bus) outage islands -------------------------
  const cutImpacts = new Map<string, string[]>();
  const anchorFor = (skip: string) => [...coreIds].find((n) => n !== skip) ?? null;
  for (const v of articulationSubstations(g)) {
    if (isGenNode(v)) continue;
    const anchor = anchorFor(v);
    if (!anchor) continue;
    const seen = new Set<string>([v, anchor]);
    const st = [anchor];
    while (st.length) {
      const u = st.pop()!;
      for (const e of adjacency.get(u)!) {
        const w = e.a === u ? e.b : e.a;
        if (!seen.has(w)) {
          seen.add(w);
          st.push(w);
        }
      }
    }
    // Only nodes that WERE connected to the core (through v) count as islanded.
    const islanded = [...nodes].filter(
      (n) => !seen.has(n) && !isGenNode(n) && bySs.get(n)!.cls !== "unconnected",
    );
    if (islanded.length) cutImpacts.set(v, islanded.sort());
  }

  const pocketByKey = new Map(pockets.map((p) => [p.key, p]));
  return {
    bySs,
    corridors,
    corridorOfLine,
    pockets,
    pocketByKey,
    coreIds,
    cutImpacts,
    openEnds,
    interfaces: [...ifaces.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)),
  };
}

/** How a non-TRANSCO terminal is connected: one circuit, several circuits from one SS, or ≥ 2 SS. */
export type InterfaceSecurity = "single-circuit" | "single-ss" | "multi-ss" | "unresolved";
export const IFACE_SEC_LABEL: Record<InterfaceSecurity, string> = {
  "single-circuit": "One circuit",
  "single-ss": "≥ 2 circuits, one SS",
  "multi-ss": "Two or more SS",
  unresolved: "Far end not resolved",
};
export function interfaceSecurity(f: Pick<InterfaceFeed, "circuits" | "ssIds">): InterfaceSecurity {
  if (!f.ssIds.length) return "unresolved";
  if (f.circuits <= 1) return "single-circuit";
  if (f.ssIds.length === 1) return "single-ss";
  return "multi-ss";
}
