// Pure, side-effect-free helpers for an *indicative* ambient-temperature dynamic line rating
// (DLR): derating of the nominal conductor ampacity/capacity inferred in capacity.ts.
//
// THIS IS INDICATIVE ONLY — a screening number layered on an already-indicative ampacity. Real
// dynamic line rating (e.g. IEEE 738) depends on wind speed/direction, solar radiation, conductor
// condition and sag clearances; none of that is modelled here. The model is the bare steady-state
// conductor heat balance: heat dissipation ∝ (Tcond − Tambient), and I²R heating ∝ I², so
//
//   I(Ta) / I(Tref) = sqrt((Tcond − Ta) / (Tcond − Tref))
//
// The Indian ACSR nominal ratings in CONDUCTOR_AMPACITY assume roughly 40 °C ambient with a 75 °C
// maximum conductor temperature, so Tref = 40 and Tcond = 75 by default.
// Examples: Ta = 47 °C → sqrt(28/35) ≈ 0.894 (≈ −11 %); Ta = 30 °C → sqrt(45/35) ≈ 1.134.

/** Default maximum conductor temperature (°C) assumed by the nominal ACSR ratings. */
export const DEFAULT_MAX_CONDUCTOR_C = 75;
/** Default reference ambient temperature (°C) assumed by the nominal ACSR ratings. */
export const DEFAULT_REF_AMBIENT_C = 40;
/**
 * Default cap on cool-weather uprating (×1.15). Cold air does raise real ampacity, but without
 * wind/solar/sag data an uncapped sqrt would look wildly optimistic, so the indicative factor
 * never exceeds this.
 */
export const DEFAULT_CAP_UPRATE = 1.15;

export interface DlrOptions {
  /** Maximum conductor temperature (°C). Default 75. */
  maxConductorC?: number;
  /** Reference ambient (°C) the nominal rating assumes. Default 40. */
  refAmbientC?: number;
  /** Upper bound on the cool-weather uprating factor. Default 1.15. */
  capUprate?: number;
}

/**
 * Indicative ambient-temperature derating factor for a nominal conductor rating:
 * factor = sqrt((Tcond − Ta) / (Tcond − Tref)), clamped to 0 when the ambient reaches/exceeds the
 * max conductor temperature and capped at `capUprate` in cool weather. At Ta = Tref the factor is
 * exactly 1. Returns null for non-finite input (or a degenerate Tcond ≤ Tref configuration).
 *
 * INDICATIVE ONLY — real DLR depends on wind speed/direction, solar radiation, conductor
 * condition and sag clearances.
 */
export function deratingFactor(ambientC: number, opts?: DlrOptions): number | null {
  if (!Number.isFinite(ambientC)) return null;
  const maxConductorC = opts?.maxConductorC ?? DEFAULT_MAX_CONDUCTOR_C;
  const refAmbientC = opts?.refAmbientC ?? DEFAULT_REF_AMBIENT_C;
  const capUprate = opts?.capUprate ?? DEFAULT_CAP_UPRATE;
  const denom = maxConductorC - refAmbientC;
  if (!(denom > 0)) return null;
  if (ambientC >= maxConductorC) return 0;
  const factor = Math.sqrt((maxConductorC - ambientC) / denom);
  return Math.min(factor, capUprate);
}

/**
 * Apply the indicative ambient derating to a base (nominal) MVA figure from capacity.ts.
 * Returns the derated MVA (rounded, like capacity.ts) plus the factor used, or null when the
 * factor is null or `baseMva` isn't a positive finite number.
 *
 * INDICATIVE ONLY — this stacks an indicative weather factor on an already-indicative
 * conductor-table capacity; it is a screening number, not an operating limit.
 */
export function deratedCapacityMva(
  baseMva: number,
  ambientC: number,
  opts?: DlrOptions,
): { mva: number; factor: number } | null {
  if (!Number.isFinite(baseMva) || baseMva <= 0) return null;
  const factor = deratingFactor(ambientC, opts);
  if (factor == null) return null;
  return { mva: Math.round(baseMva * factor), factor };
}

/**
 * Format a derating factor as a signed whole-percent delta vs. nominal, e.g. 0.894 → "−11%",
 * 1.05 → "+5%", 1.0 → "±0%". Uses the typographic minus (U+2212) to match the codebase style.
 */
export function formatDerating(factor: number): string {
  const pct = Math.round((factor - 1) * 100);
  if (pct === 0) return "±0%";
  return pct > 0 ? `+${pct}%` : `−${-pct}%`;
}
