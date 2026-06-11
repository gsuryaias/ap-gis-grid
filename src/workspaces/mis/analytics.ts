// Pure time-series helpers for the MIS dashboards (no DOM, no fetch — unit-tested in
// analytics.test.ts, mirroring the etl-lib/geo regime). All windows are trailing windows over
// values that may contain nulls (a missing publication day); nulls are skipped, never zero-filled.

/** Mean of the non-null values; null when none. */
export function mean(values: Array<number | null>): number | null {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v != null && Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

/** Population standard deviation of the non-null values; null when fewer than 2. */
export function stddev(values: Array<number | null>): number | null {
  const m = mean(values);
  if (m == null) return null;
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v != null && Number.isFinite(v)) {
      sum += (v - m) * (v - m);
      n++;
    }
  }
  return n >= 2 ? Math.sqrt(sum / n) : null;
}

/**
 * Trailing rolling mean: out[i] = mean of values[i-window+1 … i] (nulls skipped). The first
 * `window − 1` slots still produce a partial-window mean so the chart line starts at day one.
 */
export function rollingMean(values: Array<number | null>, window: number): Array<number | null> {
  return values.map((_, i) => mean(values.slice(Math.max(0, i - window + 1), i + 1)));
}

export interface KpiStat {
  /** Latest non-null value (and the index it came from), or null when the series is empty. */
  latest: number | null;
  /** Absolute change vs the previous day's value (null when either side is missing). */
  dPrev: number | null;
  /** Mean of the up-to-`window` days immediately BEFORE the latest value. */
  meanPrior: number | null;
  /** Absolute change of latest vs that prior-window mean. */
  dMean: number | null;
}

/** KPI deltas for the last point of a daily series: vs the previous day and vs the prior-`window` mean. */
export function kpiStat(values: Array<number | null>, window = 7): KpiStat {
  let i = values.length - 1;
  while (i >= 0 && values[i] == null) i--;
  if (i < 0) return { latest: null, dPrev: null, meanPrior: null, dMean: null };
  const latest = values[i]!;
  const prev = i >= 1 ? values[i - 1] : null;
  const meanPrior = i >= 1 ? mean(values.slice(Math.max(0, i - window), i)) : null;
  return {
    latest,
    dPrev: prev != null ? latest - prev : null,
    meanPrior,
    dMean: meanPrior != null ? latest - meanPrior : null,
  };
}

/** Rebase a series to 100 at the first index where EVERY series has a value; null until then. */
export function indexTo100(series: Array<Array<number | null>>): Array<Array<number | null>> {
  const len = series[0]?.length ?? 0;
  let base = -1;
  for (let i = 0; i < len; i++) {
    if (series.every((s) => s[i] != null && s[i]! > 0)) {
      base = i;
      break;
    }
  }
  if (base < 0) return series.map((s) => s.map(() => null));
  return series.map((s) => {
    const b = s[base]!;
    return s.map((v, i) => (i >= base && v != null ? (v / b) * 100 : null));
  });
}

export interface Anomaly {
  /** Index into the input series. */
  i: number;
  value: number;
  /** Trailing-window mean / z-score at that day. */
  mean: number;
  z: number;
}

/**
 * Days whose value deviates more than `sigma` standard deviations from the TRAILING `window`-day
 * mean (the day itself excluded). Needs at least `minPrior` non-null prior days in the window —
 * early days with too little history are never flagged.
 */
export function anomalies(
  values: Array<number | null>,
  window = 14,
  sigma = 2,
  minPrior = 7,
): Anomaly[] {
  const out: Anomaly[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    const prior = values.slice(Math.max(0, i - window), i);
    const nPrior = prior.filter((p) => p != null).length;
    if (nPrior < minPrior) continue;
    const m = mean(prior);
    const sd = stddev(prior);
    if (m == null || sd == null || sd === 0) continue;
    const z = (v - m) / sd;
    if (Math.abs(z) > sigma) out.push({ i, value: v, mean: m, z });
  }
  return out;
}

/** "+3.2" / "−1.4" / "0.0" with a true minus sign; null-safe. */
export function fmtSigned(v: number | null, digits = 1): string {
  if (v == null) return "—";
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s.replace("-", "−");
}

/** Thousands-grouped fixed-digit number; null-safe ("—"). */
export function fmtNum(v: number | null, digits = 0): string {
  if (v == null) return "—";
  return v.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
