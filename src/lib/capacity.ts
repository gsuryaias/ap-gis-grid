// Pure, side-effect-free helpers that derive an *indicative* thermal power-transfer capability
// for a transmission line from its conductor type — the AP-TRANSCO source carries NO MVA/rating
// data, but conductor ampacity is well-standardised, so capacity can be inferred.
//
// THIS IS INDICATIVE ONLY. Real ratings depend on ambient temperature, conductor max temperature,
// solar gain, wind, sag limits and bundle geometry. We use nominal continuous ratings (~40 °C
// ambient, ~75 °C conductor) for common Indian ACSR conductors, per CEA / utility practice, and
// label every figure as indicative in the UI.

import type { Circuit, LineProps, Voltage } from "../data/types.ts";

/**
 * Nominal continuous current rating (Amps) for a SINGLE sub-conductor, keyed by the lowercase
 * ACSR "animal" code. Values are the widely-published Indian figures (e.g. Panther ≈ 480 A,
 * Zebra ≈ 735 A, Moose ≈ 800 A) at ~40 °C ambient / ~75 °C conductor.
 */
export const CONDUCTOR_AMPACITY: Record<string, number> = {
  squirrel: 115,
  weasel: 150,
  rabbit: 190,
  raccoon: 270,
  dog: 300,
  wolf: 405,
  lynx: 445,
  panther: 480,
  coyote: 520,
  bear: 620,
  deer: 640,
  zebra: 735,
  moose: 800,
  bersimis: 900,
};

const BUNDLE_WORDS: Array<[RegExp, number]> = [
  [/\bquad\b/, 4],
  [/\btriple\b|\bthree\b/, 3],
  [/\btwin\b|\btwo\b|\bdouble\b/, 2],
];

export interface ConductorRating {
  /** Recognised base ACSR code (e.g. "moose"). */
  base: string;
  /** Per-sub-conductor nominal ampacity (Amps). */
  ampacityPerConductor: number;
  /** Sub-conductors per phase (1 plain, 2 twin, 4 quad …). */
  bundle: number;
  /** Total per-phase ampacity = ampacityPerConductor × bundle. */
  ampacity: number;
}

/**
 * Parse a conductor string ("Twin Moose", "AL59 Zebra", "Moose, UG Cable") into a nominal rating.
 * Picks the FIRST recognised base code in the string (the dominant conductor of a mixed route) and
 * a bundle multiplier from a leading "Twin/Quad/…" word. Returns null when no base code is found
 * (e.g. bare "UG Cable" or "AL59"), so the caller shows "—".
 */
export function conductorRating(conductor: string | null | undefined): ConductorRating | null {
  // Lowercase and fold the source's known conductor-name typos ("Zeebra", "Panter").
  const s = (conductor ?? "")
    .toLowerCase()
    .replace(/zeebra/g, "zebra")
    .replace(/panter/g, "panther");
  if (!s) return null;

  // First recognised base code by position in the string.
  let base: string | null = null;
  let bestIdx = Infinity;
  for (const code of Object.keys(CONDUCTOR_AMPACITY)) {
    const idx = s.indexOf(code);
    if (idx >= 0 && idx < bestIdx) {
      bestIdx = idx;
      base = code;
    }
  }
  if (!base) return null;

  let bundle = 1;
  for (const [re, n] of BUNDLE_WORDS) {
    if (re.test(s)) {
      bundle = n;
      break;
    }
  }

  const ampacityPerConductor = CONDUCTOR_AMPACITY[base];
  return { base, ampacityPerConductor, bundle, ampacity: ampacityPerConductor * bundle };
}

/** Circuits per line: DC carries 2, SC carries 1. */
export function circuitCount(circuit: Circuit): number {
  return circuit === "DC" ? 2 : 1;
}

export interface LineCapacity {
  /** Indicative thermal MVA per circuit = √3 · kV · A / 1000. */
  perCircuitMva: number;
  /** Total indicative thermal MVA across all circuits on the line (× circuit count). */
  totalMva: number;
  rating: ConductorRating;
}

/**
 * Indicative thermal capacity for a line, derived from conductor type, voltage and circuit count.
 * Returns null when the conductor can't be rated. MVA = √3 · kV · A / 1000 (three-phase apparent
 * power at nominal voltage), then × circuits for a DC (double-circuit) line.
 */
export function lineCapacity(
  conductor: string | null | undefined,
  voltageKv: Voltage,
  circuit: Circuit,
): LineCapacity | null {
  const rating = conductorRating(conductor);
  if (!rating) return null;
  const perCircuitMva = (Math.sqrt(3) * voltageKv * rating.ampacity) / 1000;
  return {
    perCircuitMva: Math.round(perCircuitMva),
    totalMva: Math.round(perCircuitMva * circuitCount(circuit)),
    rating,
  };
}

/** Convenience overload for a LineProps record. */
export function lineCapacityFor(line: Pick<LineProps, "conductor" | "voltage" | "circuit">): LineCapacity | null {
  return lineCapacity(line.conductor, line.voltage, line.circuit);
}

/** Format an MVA figure as an indicative value, e.g. 280 → "≈ 280 MVA"; >= 1000 → "≈ 1.6 GVA". */
export function formatMva(mva: number | null | undefined): string {
  if (mva == null || !Number.isFinite(mva)) return "—";
  if (mva >= 1000) return `≈ ${(mva / 1000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} GVA`;
  return `≈ ${Math.round(mva).toLocaleString("en-IN")} MVA`;
}

/**
 * Sum the total indicative thermal capacity (MVA) across a set of lines, and report how many of
 * them could be rated (coverage). Lines whose conductor isn't recognised contribute 0 and are
 * counted as unrated.
 */
export function totalIndicativeCapacity(
  lines: Array<Pick<LineProps, "conductor" | "voltage" | "circuit">>,
): { totalMva: number; rated: number; total: number } {
  let totalMva = 0;
  let rated = 0;
  for (const line of lines) {
    const cap = lineCapacityFor(line);
    if (cap) {
      totalMva += cap.totalMva;
      rated++;
    }
  }
  return { totalMva, rated, total: lines.length };
}
