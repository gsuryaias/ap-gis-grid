// Pure, side-effect-free risk engine generalising the vulnerability index in risk.ts to the
// hazard × vulnerability × criticality model from the DSS design spec (§3). Each axis is an
// independent 0–100 screening score with a human factor breakdown (same `factors` pattern as
// `substationRisk`); `compositeRisk` blends the three. THIS IS INDICATIVE ONLY — a screening
// proxy built on a hand-digitised wind-zone map and inferred connectivity, not a hazard model,
// reliability study or load-flow result, per the repo's honesty convention.
//
// Nothing is re-exported from risk.ts: consumers compose `substationRisk` (the vulnerability
// axis) with the hazard/criticality scores here.

import type { FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import type { Voltage } from "../data/types.ts";
import { pointInPolygonGeom } from "./geo.ts";
import type { CoastalBand } from "./risk.ts";

/** IS 875 (Part 3) basic wind speed, m/s — the three classes present over AP. */
export type WindVb = 50 | 44 | 39;

/**
 * Basic wind speed at a point from the indicative IS 875 zone polygons
 * (public/data/wind-zones.geojson). Zones may overlap (they butt-join generously), so the
 * HIGHEST vb among containing polygons wins; null when the point is outside every zone.
 */
export function windZoneAt(lng: number, lat: number, zones: FeatureCollection): WindVb | null {
  const pt: Position = [lng, lat];
  let best: WindVb | null = null;
  for (const f of zones.features) {
    const vb = f.properties?.vb as WindVb | undefined;
    if (vb !== 50 && vb !== 44 && vb !== 39) continue;
    if (best != null && vb <= best) continue;
    const geom = f.geometry;
    if (geom == null || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) continue;
    if (pointInPolygonGeom(pt, geom as Polygon | MultiPolygon)) best = vb;
  }
  return best;
}

export interface HazardInput {
  /** IS 875 basic wind speed at the asset, or null when outside every digitised zone. */
  windVb: WindVb | null;
  /** Coastal-exposure band from risk.ts (0 = <10 km … 3 = inland); undefined = unknown/inland. */
  coastalBand: CoastalBand | undefined;
  /** True while the asset sits inside an active GDACS cyclone forecast cone. */
  inCycloneCone: boolean;
}

export interface ScoreResult {
  /** Indicative 0–100 screening score. */
  score: number;
  /** Short human list of the non-zero contributors. */
  factors: string[];
}

/**
 * Indicative 0–100 hazard exposure score. Weighting:
 * - Wind zone, up to 40 pts: vb 50 → 40, 44 → 20, 39 → 8; null (outside the digitised
 *   zones — only border assets) falls back to the mildest class, 8.
 * - Coastal surge/flood proxy, up to 30 pts: band 0 (<10 km) → 30, band 1 (10–25) → 18,
 *   band 2 (25–50) → 8, band 3 / unknown → 0.
 * - Active cyclone cone: +30 pts while the asset is inside a live forecast envelope.
 */
export function hazardScore(input: HazardInput): ScoreResult {
  const factors: string[] = [];

  const windPts = input.windVb === 50 ? 40 : input.windVb === 44 ? 20 : 8;
  factors.push(input.windVb == null ? "wind zone unknown" : `wind zone ${input.windVb} m/s`);

  const coastPts =
    input.coastalBand === 0 ? 30 : input.coastalBand === 1 ? 18 : input.coastalBand === 2 ? 8 : 0;
  if (coastPts > 0) factors.push(`coastal band ${input.coastalBand}`);

  const conePts = input.inCycloneCone ? 30 : 0;
  if (conePts > 0) factors.push("in active cyclone cone");

  return { score: windPts + coastPts + conePts, factors };
}

export interface CriticalityInput {
  /** Inferred feed degree (distinct neighbouring substations) from the connectivity graph. */
  feedDegree: number;
  voltage: Voltage;
  /** Lines terminating at the asset (inferred geometric adjacency). */
  connectedLineCount: number;
}

/**
 * Indicative 0–100 criticality score — how much the network cares if this asset is lost.
 * Weighting:
 * - Voltage class, up to 40 pts: 400 → 40, 220 → 25, 132 → 10.
 * - Hub size, up to 30 pts: connectedLineCount ≥ 8 → 30, ≥ 5 → 20, ≥ 3 → 10, else 0.
 * - Redundancy inverse, up to 30 pts: feedDegree ≤ 1 → 30, = 2 → 15, ≥ 3 → 0.
 *
 * TODO(M5): replace the hub-size proxy with DC-flow betweenness once the graph worker lands —
 * topological betweenness captures transit importance that raw line counts miss.
 */
export function criticalityScore(input: CriticalityInput): ScoreResult {
  const factors: string[] = [];

  const voltPts = input.voltage === 400 ? 40 : input.voltage === 220 ? 25 : 10;
  factors.push(`${input.voltage} kV`);

  const hubPts =
    input.connectedLineCount >= 8
      ? 30
      : input.connectedLineCount >= 5
        ? 20
        : input.connectedLineCount >= 3
          ? 10
          : 0;
  if (hubPts > 0) factors.push(`${input.connectedLineCount}-line hub`);

  const feedPts = input.feedDegree <= 1 ? 30 : input.feedDegree === 2 ? 15 : 0;
  if (input.feedDegree <= 1) factors.push("single-fed");
  else if (input.feedDegree === 2) factors.push("double-fed");

  return { score: voltPts + hubPts + feedPts, factors };
}

export interface CompositeInput {
  /** Hazard exposure 0–100 (hazardScore). */
  hazard: number;
  /** Vulnerability 0–100 (substationRisk from risk.ts). */
  vulnerability: number;
  /** Criticality 0–100 (criticalityScore). */
  criticality: number;
}

/**
 * Combined 0–100 risk: round(100 × (h/100)^0.4 × (v/100)^0.4 × (c/100)^0.2).
 *
 * A weighted geometric blend (rather than a weighted sum) so risk requires hazard AND
 * vulnerability together — a perfectly safe asset in a cyclone path, or a fragile asset
 * nowhere near a hazard, both score low. Criticality gets the smaller 0.2 exponent: it
 * scales consequence but shouldn't dominate exposure.
 *
 * Each component is clamped to ≥ 5 before blending: a pure geometric mean zeroes the whole
 * product when any one input is 0, which would hide e.g. a highly hazard-exposed, fragile
 * asset just because its criticality proxy bottomed out at 0. The floor keeps every axis a
 * dampener, never an absolute veto.
 */
export function compositeRisk(input: CompositeInput): number {
  const h = Math.max(5, input.hazard) / 100;
  const v = Math.max(5, input.vulnerability) / 100;
  const c = Math.max(5, input.criticality) / 100;
  return Math.round(100 * h ** 0.4 * v ** 0.4 * c ** 0.2);
}
