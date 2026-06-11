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

/** Day-of-year (1–366) from an ISO date string. */
export function dayOfYear(iso: string): number {
  const d = new Date(`${iso}T00:00:00Z`);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((d.getTime() - start) / 86400000);
}

/** Month-day key (MM-DD) for same-calendar-day matching across leap years. */
export function monthDay(iso: string): string {
  return iso.slice(5, 10);
}

/** Calendar span of a sorted ISO date array, in fractional years. */
export function spanYears(dates: string[]): number {
  if (dates.length < 2) return 0;
  const t0 = Date.parse(`${dates[0]}T00:00:00Z`);
  const t1 = Date.parse(`${dates[dates.length - 1]}T00:00:00Z`);
  return (t1 - t0) / (365.25 * 86_400_000);
}

export type BaselineMethod = "doy" | "trailing14";

export interface DoyBaselinePoint {
  mean: number | null;
  sigma: number | null;
  method: BaselineMethod;
  /** Sample count used for the baseline at this index. */
  n: number;
}

/**
 * Per-day baseline: trailing 3-year same-DOY mean ± σ when ≥1 calendar year of history exists;
 * otherwise falls back to the trailing 14-day window (excluding the current day).
 */
export function doyBaselineSeries(
  dates: string[],
  values: Array<number | null>,
  trailingYears = 3,
  fallbackWindow = 14,
): DoyBaselinePoint[] {
  const enoughHistory = spanYears(dates) >= 1;
  return dates.map((d, i) => {
    const v = values[i];
    if (v == null) return { mean: null, sigma: null, method: "trailing14" as BaselineMethod, n: 0 };

    if (enoughHistory) {
      const md = monthDay(d);
      const year = Number(d.slice(0, 4));
      const sameDoy: number[] = [];
      for (let j = 0; j < i; j++) {
        if (monthDay(dates[j]!) !== md) continue;
        const yv = values[j];
        if (yv == null) continue;
        const y = Number(dates[j]!.slice(0, 4));
        if (y >= year - trailingYears && y < year) sameDoy.push(yv);
      }
      if (sameDoy.length >= 2) {
        return {
          mean: mean(sameDoy),
          sigma: stddev(sameDoy),
          method: "doy",
          n: sameDoy.length,
        };
      }
    }

    const prior = values.slice(Math.max(0, i - fallbackWindow), i);
    const n = prior.filter((p) => p != null).length;
    return {
      mean: mean(prior),
      sigma: stddev(prior),
      method: "trailing14",
      n,
    };
  });
}

/** Z-scores against the DOY / trailing-14 baseline at each index. */
export function doyZScores(dates: string[], values: Array<number | null>): Array<number | null> {
  const baselines = doyBaselineSeries(dates, values);
  return values.map((v, i) => {
    if (v == null) return null;
    const b = baselines[i]!;
    if (b.mean == null || b.sigma == null || b.sigma === 0) return null;
    return (v - b.mean) / b.sigma;
  });
}

export interface SeasonalDecomp {
  trend: Array<number | null>;
  seasonal: Array<number | null>;
  residual: Array<number | null>;
}

function tricube(x: number): number {
  const a = Math.abs(x);
  if (a >= 1) return 0;
  const t = 1 - a * a * a;
  return t * t * t;
}

/** Local LOESS smooth (pure TS, no deps). Nulls are skipped; bandwidth is a fraction of n. */
export function loessSmooth(values: Array<number | null>, bandwidth = 0.25): Array<number | null> {
  const n = values.length;
  if (n === 0) return [];
  const half = Math.max(1, Math.floor(bandwidth * n));
  return values.map((_, i) => {
    let sumW = 0;
    let sumWV = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      const v = values[j];
      if (v == null) continue;
      const w = tricube((j - i) / half);
      sumW += w;
      sumWV += w * v;
    }
    return sumW > 0 ? sumWV / sumW : null;
  });
}

/**
 * Simple seasonal decomposition: LOESS trend + DOY-averaged seasonal + residual.
 * Indicative — not a full STL; suitable for dashboard overlays.
 */
export function seasonalDecompose(dates: string[], values: Array<number | null>): SeasonalDecomp {
  const trend = loessSmooth(values, 0.2);
  const detrended = values.map((v, i) => (v != null && trend[i] != null ? v - trend[i]! : null));

  const doyBuckets = new Map<string, number[]>();
  for (let i = 0; i < dates.length; i++) {
    const d = detrended[i];
    if (d == null) continue;
    const md = monthDay(dates[i]!);
    const arr = doyBuckets.get(md) ?? [];
    arr.push(d);
    doyBuckets.set(md, arr);
  }
  const doyMean = new Map<string, number>();
  for (const [md, arr] of doyBuckets) {
    const m = mean(arr);
    if (m != null) doyMean.set(md, m);
  }

  const seasonal = dates.map((d, i) => {
    if (values[i] == null) return null;
    return doyMean.get(monthDay(d)) ?? null;
  });
  const residual = values.map((v, i) => {
    if (v == null || trend[i] == null) return null;
    const s = seasonal[i] ?? 0;
    return v - trend[i]! - s;
  });
  return { trend, seasonal, residual };
}

export type DateRange = { start: string; end: string };

/** Slice a sorted date axis and parallel series arrays to an inclusive ISO range. */
export function sliceByDateRange<T>(
  dates: string[],
  range: DateRange | null,
  ...series: Array<Array<T>>
): { dates: string[]; series: Array<Array<T>> } {
  if (!range) return { dates, series };
  const idx: number[] = [];
  const outDates: string[] = [];
  dates.forEach((d, i) => {
    if (d >= range.start && d <= range.end) {
      idx.push(i);
      outDates.push(d);
    }
  });
  return { dates: outDates, series: series.map((s) => idx.map((i) => s[i]!)) };
}

/** Map a date range to ECharts dataZoom start/end percentages (0–100). */
export function dateRangeToZoom(dates: string[], range: DateRange | null): { start: number; end: number } | null {
  if (!range || dates.length === 0) return null;
  let startIdx = -1;
  let endIdx = -1;
  dates.forEach((d, i) => {
    if (d >= range.start && d <= range.end) {
      if (startIdx < 0) startIdx = i;
      endIdx = i;
    }
  });
  if (startIdx < 0) return null;
  const n = dates.length;
  return {
    start: (startIdx / n) * 100,
    end: ((endIdx + 1) / n) * 100,
  };
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
