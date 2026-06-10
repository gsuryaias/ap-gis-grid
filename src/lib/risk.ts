// Pure, side-effect-free helpers deriving an *indicative* vulnerability screening score for a
// substation from data the app already carries — coastal exposure, inferred feed redundancy,
// asset age and voltage class. THIS IS INDICATIVE ONLY: a screening proxy, not a hazard model,
// reliability study or load-flow result, per the repo's honesty convention.

import type { Voltage } from "../data/types.ts";

export type CoastalBand = 0 | 1 | 2 | 3;

/** Display label for each coastal-exposure band (straight-line distance to the coastline). */
export const COASTAL_BAND_LABEL: Record<CoastalBand, string> = {
  0: "<10 km",
  1: "10–25 km",
  2: "25–50 km",
  3: "≥50 km",
};

export interface RiskInput {
  /** Coastal-exposure band (0 = <10 km … 3 = inland); undefined = unknown, treated as inland. */
  coastalBand: CoastalBand | undefined;
  /** Asset age in whole years, or null when the commissioning date is unknown. */
  ageYears: number | null;
  /** Inferred feed degree (distinct neighbouring substations) from the connectivity graph. */
  feedDegree: number;
  voltage: Voltage;
}

export interface RiskResult {
  /** Indicative 0–100 screening score (rounded sum of the four weighted components). */
  score: number;
  /** Short human list of the non-zero contributors, e.g. "coastal <10 km", "single-fed". */
  factors: string[];
}

/**
 * Indicative 0–100 vulnerability screening score for a substation. Weighting:
 * - Coastal exposure, up to 40 pts: band 0 (<10 km) → 40, band 1 (10–25) → 25,
 *   band 2 (25–50) → 12, band 3 / unknown → 0.
 * - Redundancy, up to 30 pts: feedDegree ≤ 1 → 30, = 2 → 15, ≥ 3 → 0.
 * - Age, up to 20 pts: linear ramp from 0 pts at ≤ 10 yrs to 20 pts at ≥ 40 yrs;
 *   null/unknown age → 10 (unknown age is mild risk).
 * - Criticality, up to 10 pts by voltage: 400 → 10, 220 → 6, 132 → 3
 *   (higher voltage = bigger consequence of an outage).
 * The score is the rounded sum; `factors` lists the non-zero contributors.
 */
export function substationRisk(input: RiskInput): RiskResult {
  const factors: string[] = [];

  const coastPts =
    input.coastalBand === 0 ? 40 : input.coastalBand === 1 ? 25 : input.coastalBand === 2 ? 12 : 0;
  if (coastPts > 0) factors.push(`coastal ${COASTAL_BAND_LABEL[input.coastalBand as CoastalBand]}`);

  const feedPts = input.feedDegree <= 1 ? 30 : input.feedDegree === 2 ? 15 : 0;
  if (input.feedDegree <= 1) factors.push("single-fed");
  else if (input.feedDegree === 2) factors.push("double-fed");

  let agePts: number;
  if (input.ageYears == null) {
    agePts = 10;
    factors.push("age unknown");
  } else {
    agePts = 20 * Math.min(1, Math.max(0, (input.ageYears - 10) / 30));
    if (agePts > 0) factors.push(`${input.ageYears} yrs old`);
  }

  const voltPts = input.voltage === 400 ? 10 : input.voltage === 220 ? 6 : 3;
  factors.push(`${input.voltage} kV`);

  return { score: Math.round(coastPts + feedPts + agePts + voltPts), factors };
}

export type RiskTier = "low" | "moderate" | "elevated" | "high";

/** Tier word for a screening score: <25 low, 25–49 moderate, 50–69 elevated, ≥70 high. */
export function riskTier(score: number): RiskTier {
  if (score >= 70) return "high";
  if (score >= 50) return "elevated";
  if (score >= 25) return "moderate";
  return "low";
}
