// Pure connectivity-graph helpers for the transmission network. Dependency-free and
// side-effect-free so they unit-test in the `node` environment (same discipline as geo.ts
// and the ETL helpers).
//
// HONESTY NOTE: connectivity is geometric/INFERRED (endpoint snapping against the SS
// polygons), never an authoritative network model. Everything derived here — feed degree,
// bridges, outage islanding — is indicative screening only, not a load-flow result.
//
// The graph is a MULTIGRAPH over substation ids: lines are per-circuit features, so
// parallel edges between the same SS pair are common and deliberately kept — losing one
// circuit (N-1) is not the same as losing the whole corridor. A line is an edge only when
// BOTH endpoint snaps resolved (`fromSS` and `toSS` non-null); a one-ended line still
// feeds its single substation in the real world, but it carries no graph connectivity.
import type { LineProps, SubstationProps } from "../data/types.ts";

/** One inferred edge: a fully-resolved line between two substation ids. */
export interface GridEdge {
  lineId: string;
  /** `fromSS.ssId` of the source line. */
  a: string;
  /** `toSS.ssId` of the source line. */
  b: string;
}

/** Inferred multigraph over substation ids; edges keyed by line id. */
export interface GridGraph {
  /** All substation ids, including isolated ones (no resolved line). */
  nodes: Set<string>;
  /** Edge per fully-resolved line, keyed by line id. */
  edges: Map<string, GridEdge>;
  /** ssId → incident edges. Parallel edges repeat; a self-loop appears once. */
  adjacency: Map<string, GridEdge[]>;
}

/**
 * Build the inferred connectivity multigraph. Only lines with BOTH endpoint snaps
 * resolved become edges; an endpoint ssId missing from `substations` (shouldn't happen —
 * snap refs point at real TRANSCO SS) is added as a node so the graph stays consistent.
 */
export function buildGridGraph(
  substations: Pick<SubstationProps, "id">[],
  lines: Pick<LineProps, "id" | "fromSS" | "toSS">[],
): GridGraph {
  const nodes = new Set<string>();
  const adjacency = new Map<string, GridEdge[]>();
  const addNode = (id: string): void => {
    if (!nodes.has(id)) {
      nodes.add(id);
      adjacency.set(id, []);
    }
  };
  for (const ss of substations) addNode(ss.id);

  const edges = new Map<string, GridEdge>();
  for (const line of lines) {
    if (!line.fromSS || !line.toSS) continue;
    const edge: GridEdge = { lineId: line.id, a: line.fromSS.ssId, b: line.toSS.ssId };
    addNode(edge.a);
    addNode(edge.b);
    edges.set(line.id, edge);
    adjacency.get(edge.a)!.push(edge);
    if (edge.b !== edge.a) adjacency.get(edge.b)!.push(edge);
  }
  return { nodes, edges, adjacency };
}

/** The endpoint of `edge` opposite to `ssId` (equals `ssId` for a self-loop). */
function otherEnd(edge: GridEdge, ssId: string): string {
  return edge.a === ssId ? edge.b : edge.a;
}

/**
 * The k-hop ego network around a substation (for the map "spotlight"): every substation
 * within `hops` BFS levels of the origin (origin included), plus all lines BOTH of whose
 * ends fall inside that set (induced subgraph — parallel circuits and cross-links between
 * two hop-k neighbours are included).
 */
export function neighborhood(
  g: GridGraph,
  ssId: string,
  hops: number,
): { ssIds: Set<string>; lineIds: Set<string> } {
  const ssIds = new Set<string>([ssId]);
  let frontier: string[] = [ssId];
  for (let h = 0; h < hops && frontier.length > 0; h++) {
    const next: string[] = [];
    for (const u of frontier) {
      for (const edge of g.adjacency.get(u) ?? []) {
        const v = otherEnd(edge, u);
        if (!ssIds.has(v)) {
          ssIds.add(v);
          next.push(v);
        }
      }
    }
    frontier = next;
  }
  const lineIds = new Set<string>();
  for (const edge of g.edges.values()) {
    if (ssIds.has(edge.a) && ssIds.has(edge.b)) lineIds.add(edge.lineId);
  }
  return { ssIds, lineIds };
}

/**
 * Connected components as arrays of substation ids, largest first (ids sorted within each
 * component; equal-sized components ordered by their first id for determinism).
 */
export function connectedComponents(g: GridGraph): string[][] {
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const start of g.nodes) {
    if (seen.has(start)) continue;
    const component: string[] = [];
    const queue: string[] = [start];
    seen.add(start);
    while (queue.length > 0) {
      const u = queue.pop()!;
      component.push(u);
      for (const edge of g.adjacency.get(u) ?? []) {
        const v = otherEnd(edge, u);
        if (!seen.has(v)) {
          seen.add(v);
          queue.push(v);
        }
      }
    }
    component.sort();
    components.push(component);
  }
  components.sort((x, y) => y.length - x.length || x[0].localeCompare(y[0]));
  return components;
}

/**
 * Count of DISTINCT neighbouring substations (not edge count — a double-circuit corridor
 * to one SS is still feed degree 1, i.e. single-fed). Self-loops don't count.
 */
export function feedDegree(g: GridGraph, ssId: string): number {
  const neighbours = new Set<string>();
  for (const edge of g.adjacency.get(ssId) ?? []) {
    const v = otherEnd(edge, ssId);
    if (v !== ssId) neighbours.add(v);
  }
  return neighbours.size;
}

/** Substations fed from exactly one neighbouring SS (inferred), sorted by id. */
export function singleFedSubstations(g: GridGraph): string[] {
  return [...g.nodes].filter((id) => feedDegree(g, id) === 1).sort();
}

/**
 * Shared iterative Tarjan-style lowlink DFS over the multigraph. Tracks the ENTRY EDGE id
 * (not the parent node) so a parallel circuit back to the parent counts as a back-edge —
 * which is exactly why a single circuit of a multi-circuit corridor is never a bridge.
 * Iterative by convention (recursion would also be fine at ~376 nodes / ~1190 edges).
 */
function lowlinkAnalysis(g: GridGraph): { bridges: string[]; articulations: string[] } {
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const bridges: string[] = [];
  const articulations = new Set<string>();
  let timer = 0;

  interface Frame {
    node: string;
    /** Line id of the tree edge used to enter this node (null at a DFS root). */
    entryEdge: string | null;
    /** Next adjacency index to scan. */
    idx: number;
  }

  for (const root of g.nodes) {
    if (disc.has(root)) continue;
    let rootChildren = 0;
    disc.set(root, timer);
    low.set(root, timer);
    timer++;
    const stack: Frame[] = [{ node: root, entryEdge: null, idx: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const u = frame.node;
      const adj = g.adjacency.get(u) ?? [];
      if (frame.idx < adj.length) {
        const edge = adj[frame.idx++];
        if (edge.lineId === frame.entryEdge) continue; // the tree edge itself, not a back-edge
        const v = otherEnd(edge, u);
        if (!disc.has(v)) {
          disc.set(v, timer);
          low.set(v, timer);
          timer++;
          stack.push({ node: v, entryEdge: edge.lineId, idx: 0 });
          if (u === root) rootChildren++;
        } else {
          low.set(u, Math.min(low.get(u)!, disc.get(v)!));
        }
      } else {
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent) {
          const p = parent.node;
          low.set(p, Math.min(low.get(p)!, low.get(u)!));
          if (low.get(u)! > disc.get(p)!) bridges.push(frame.entryEdge!);
          if (p !== root && low.get(u)! >= disc.get(p)!) articulations.add(p);
        }
      }
    }
    if (rootChildren >= 2) articulations.add(root);
  }
  return { bridges: bridges.sort(), articulations: [...articulations].sort() };
}

/**
 * Line ids whose individual removal disconnects the graph, sorted. In the multigraph a
 * line is a bridge only when it's the ONLY edge between its endpoints AND that pair-edge
 * is a bridge in the simple graph — the entry-edge-tracking lowlink handles both at once.
 */
export function bridgeLines(g: GridGraph): string[] {
  return lowlinkAnalysis(g).bridges;
}

/**
 * Cut vertices: substations whose removal disconnects an otherwise-connected part of the
 * grid (inferred), sorted by id.
 */
export function articulationSubstations(g: GridGraph): string[] {
  return lowlinkAnalysis(g).articulations;
}

/** BFS over `g` from `start`, ignoring the edge `skipLineId`. */
function reachableWithout(g: GridGraph, start: string, skipLineId: string): Set<string> {
  const seen = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length > 0) {
    const u = queue.pop()!;
    for (const edge of g.adjacency.get(u) ?? []) {
      if (edge.lineId === skipLineId) continue;
      const v = otherEnd(edge, u);
      if (!seen.has(v)) {
        seen.add(v);
        queue.push(v);
      }
    }
  }
  return seen;
}

/**
 * N-1 screening for one line: the substations cut off from the largest remaining piece of
 * the line's component if that single line were out. Empty when the line is not a bridge
 * (or unknown). On an exact size tie, the side containing the smallest substation id is
 * the one kept. Indicative only — this is pure topology, not a load-flow study.
 */
export function lineOutageImpact(g: GridGraph, lineId: string): { islanded: string[] } {
  const edge = g.edges.get(lineId);
  if (!edge || edge.a === edge.b) return { islanded: [] };
  const sideA = reachableWithout(g, edge.a, lineId);
  if (sideA.has(edge.b)) return { islanded: [] }; // parallel circuit or loop keeps it whole
  const sideB = reachableWithout(g, edge.b, lineId);
  let islanded: Set<string>;
  if (sideA.size !== sideB.size) {
    islanded = sideA.size < sideB.size ? sideA : sideB;
  } else {
    const minOf = (s: Set<string>): string => [...s].sort()[0];
    islanded = minOf(sideA) < minOf(sideB) ? sideB : sideA;
  }
  return { islanded: [...islanded].sort() };
}
