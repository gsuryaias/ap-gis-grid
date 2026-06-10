// Memoised access to the inferred connectivity graph (src/lib/graph.ts) for the UI layer.
// The graph + its expensive aggregates are computed ONCE per GridData instance (WeakMap memo,
// same pattern as the radar-URL memo in weather-layers.ts) — components/MapView consume this,
// never rebuilding per render. Everything here is INFERRED from geometric endpoint snapping —
// indicative screening only, per the repo's honesty convention.
import {
  articulationSubstations,
  bridgeLines,
  buildGridGraph,
  feedDegree,
  lineOutageImpact,
  neighborhood,
  singleFedSubstations,
  type GridGraph,
} from "../lib/graph.ts";
import type { GridData, LineProps, SubstationProps } from "./types.ts";

export interface GraphAnalysis {
  graph: GridGraph;
  /** Bridge line id → substation ids islanded by that single-line outage (always non-empty). */
  bridgeImpacts: Map<string, string[]>;
  /** Substations whose removal would split the inferred network. */
  articulationIds: Set<string>;
  /** Substations fed from exactly one neighbouring SS. */
  singleFedIds: Set<string>;
  /** ssId → distinct-neighbour count (inferred feed degree). */
  feedDegrees: Map<string, number>;
}

const cache = new WeakMap<GridData, GraphAnalysis>();

/** Build (once per GridData instance) the inferred graph and its precomputed aggregates. */
export function graphAnalysis(data: GridData): GraphAnalysis {
  let a = cache.get(data);
  if (a) return a;
  const graph = buildGridGraph(data.substations, data.lines);
  const bridgeImpacts = new Map<string, string[]>();
  for (const lineId of bridgeLines(graph)) {
    bridgeImpacts.set(lineId, lineOutageImpact(graph, lineId).islanded);
  }
  const feedDegrees = new Map<string, number>();
  for (const ssId of graph.nodes) feedDegrees.set(ssId, feedDegree(graph, ssId));
  a = {
    graph,
    bridgeImpacts,
    articulationIds: new Set(articulationSubstations(graph)),
    singleFedIds: new Set(singleFedSubstations(graph)),
    feedDegrees,
  };
  cache.set(data, a);
  return a;
}

/** Core-grid ids kept at full opacity while the map spotlight is armed. */
export interface SpotlightSets {
  ssIds: Set<string>;
  lineIds: Set<string>;
}

/**
 * The inferred neighborhood to spotlight for a selection: a substation lights up its 1-hop ego
 * network (its lines + directly-connected SS, origin included); a line lights up itself, its two
 * endpoint SS, and any parallel circuits between the same pair. A line with an unresolved end
 * still lights whichever endpoint(s) snapped.
 */
export function spotlightFor(analysis: GraphAnalysis, feature: SubstationProps | LineProps): SpotlightSets {
  const g = analysis.graph;
  if (feature.kind === "substation") return neighborhood(g, feature.id, 1);

  const ssIds = new Set<string>();
  const lineIds = new Set<string>([feature.id]);
  const edge = g.edges.get(feature.id);
  if (edge) {
    ssIds.add(edge.a);
    ssIds.add(edge.b);
    // Parallel circuits between the same SS pair travel together in the spotlight.
    for (const sib of g.adjacency.get(edge.a) ?? []) {
      const samePair =
        (sib.a === edge.a && sib.b === edge.b) || (sib.a === edge.b && sib.b === edge.a);
      if (samePair) lineIds.add(sib.lineId);
    }
  } else {
    // Not a graph edge (an endpoint didn't snap) — light whichever end(s) resolved.
    if (feature.fromSS) ssIds.add(feature.fromSS.ssId);
    if (feature.toSS) ssIds.add(feature.toSS.ssId);
  }
  return { ssIds, lineIds };
}
