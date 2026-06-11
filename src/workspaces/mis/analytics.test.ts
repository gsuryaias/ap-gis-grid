import { describe, expect, it } from "vitest";
import {
  anomalies,
  dateRangeToZoom,
  dayOfYear,
  doyBaselineSeries,
  doyZScores,
  fmtNum,
  fmtSigned,
  indexTo100,
  kpiStat,
  loessSmooth,
  mean,
  rollingMean,
  seasonalDecompose,
  sliceByDateRange,
  spanYears,
  stddev,
} from "./analytics.ts";

describe("mean / stddev", () => {
  it("skips nulls and handles empties", () => {
    expect(mean([1, null, 3])).toBe(2);
    expect(mean([null, null])).toBeNull();
    expect(mean([])).toBeNull();
  });
  it("population stddev; null under 2 samples", () => {
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 10);
    expect(stddev([5])).toBeNull();
  });
});

describe("rollingMean", () => {
  it("trailing window with partial start", () => {
    expect(rollingMean([1, 2, 3, 4], 3)).toEqual([1, 1.5, 2, 3]);
  });
  it("skips nulls inside the window", () => {
    expect(rollingMean([2, null, 4], 3)).toEqual([2, 2, 3]);
  });
});

describe("kpiStat", () => {
  it("deltas vs previous day and prior-window mean", () => {
    const s = kpiStat([10, 10, 10, 10, 10, 10, 10, 17], 7);
    expect(s.latest).toBe(17);
    expect(s.dPrev).toBe(7);
    expect(s.meanPrior).toBe(10);
    expect(s.dMean).toBe(7);
  });
  it("walks back over a trailing null and degrades on short series", () => {
    expect(kpiStat([5, 8, null]).latest).toBe(8);
    expect(kpiStat([5, 8, null]).dPrev).toBe(3);
    expect(kpiStat([]).latest).toBeNull();
    expect(kpiStat([4]).dPrev).toBeNull();
  });
});

describe("indexTo100", () => {
  it("rebases every series at the first fully-populated index", () => {
    const [a, b] = indexTo100([
      [null, 50, 100],
      [200, 200, 300],
    ]);
    expect(a).toEqual([null, 100, 200]);
    expect(b).toEqual([null, 100, 150]);
  });
  it("all-null when there is no common base", () => {
    expect(indexTo100([[null, 1], [2, null]])).toEqual([
      [null, null],
      [null, null],
    ]);
  });
});

describe("anomalies", () => {
  it("flags a >2σ spike against the trailing window only once history exists", () => {
    const quiet = Array.from({ length: 14 }, (_, i) => (i % 2 === 0 ? 99 : 101));
    const found = anomalies([...quiet, 130], 14, 2, 7);
    expect(found).toHaveLength(1);
    expect(found[0].i).toBe(14);
    expect(found[0].value).toBe(130);
    expect(found[0].z).toBeGreaterThan(2);
  });
  it("never flags early days with insufficient prior history", () => {
    expect(anomalies([1, 100, 1, 100], 14, 2, 7)).toEqual([]);
  });
  it("ignores zero-variance windows instead of dividing by zero", () => {
    const flat = Array.from({ length: 10 }, () => 100);
    expect(anomalies([...flat, 100], 14, 2, 7)).toEqual([]);
  });
});

describe("dayOfYear / spanYears", () => {
  it("computes DOY and span", () => {
    expect(dayOfYear("2024-01-01")).toBe(1);
    expect(dayOfYear("2024-12-31")).toBe(366);
    expect(spanYears(["2024-01-01", "2024-06-01"])).toBeGreaterThan(0.3);
    expect(spanYears(["2024-06-01"])).toBe(0);
  });
});

describe("doyBaselineSeries", () => {
  it("falls back to trailing-14 when history is under one year", () => {
    const dates = Array.from({ length: 20 }, (_, i) => `2024-06-${String(i + 1).padStart(2, "0")}`);
    const values = dates.map((_, i) => 100 + (i % 3));
    const baselines = doyBaselineSeries(dates, values);
    expect(baselines[15]!.method).toBe("trailing14");
    expect(baselines[15]!.mean).not.toBeNull();
  });

  it("uses same-DOY history when multiple years exist", () => {
    const dates = ["2022-06-15", "2023-06-15", "2024-06-15"];
    const values = [90, 100, 130];
    const baselines = doyBaselineSeries(dates, values);
    expect(baselines[2]!.method).toBe("doy");
    expect(baselines[2]!.mean).toBe(95);
    expect(baselines[2]!.n).toBe(2);
  });
});

describe("doyZScores", () => {
  it("produces a z-score against the DOY baseline", () => {
    const dates = ["2022-06-15", "2023-06-15", "2024-06-15"];
    const values = [90, 100, 130];
    const z = doyZScores(dates, values);
    expect(z[2]).not.toBeNull();
    expect(z[2]!).toBeGreaterThan(1);
  });
});

describe("loessSmooth / seasonalDecompose", () => {
  it("smooths a noisy ramp", () => {
    const values = Array.from({ length: 30 }, (_, i) => i + (i % 2 === 0 ? 0.5 : -0.5));
    const smoothed = loessSmooth(values, 0.3);
    expect(smoothed[15]).toBeGreaterThan(14);
    expect(smoothed[15]).toBeLessThan(16);
  });

  it("decomposes into trend + seasonal + residual", () => {
    const dates = Array.from({ length: 40 }, (_, i) => {
      const d = new Date(Date.UTC(2024, 0, 1 + i));
      return d.toISOString().slice(0, 10);
    });
    const values = dates.map((_, i) => 100 + Math.sin((i / 40) * Math.PI * 2) * 5 + i * 0.1);
    const { trend, seasonal, residual } = seasonalDecompose(dates, values);
    expect(trend.filter((v) => v != null).length).toBeGreaterThan(10);
    expect(seasonal.some((v) => v != null)).toBe(true);
    expect(residual.some((v) => v != null)).toBe(true);
  });
});

describe("sliceByDateRange / dateRangeToZoom", () => {
  it("slices parallel series", () => {
    const dates = ["2024-01-01", "2024-01-02", "2024-01-03"];
    const { dates: d2, series } = sliceByDateRange(dates, { start: "2024-01-02", end: "2024-01-03" }, [10, 20, 30]);
    expect(d2).toEqual(["2024-01-02", "2024-01-03"]);
    expect(series[0]).toEqual([20, 30]);
  });

  it("maps a range to zoom percentages", () => {
    const dates = ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"];
    const z = dateRangeToZoom(dates, { start: "2024-01-02", end: "2024-01-03" });
    expect(z!.start).toBeCloseTo(25);
    expect(z!.end).toBeCloseTo(75);
  });
});

describe("formatters", () => {
  it("fmtSigned uses an explicit sign and a true minus", () => {
    expect(fmtSigned(3.21)).toBe("+3.2");
    expect(fmtSigned(-1.46)).toBe("−1.5");
    expect(fmtSigned(null)).toBe("—");
  });
  it("fmtNum groups thousands and is null-safe", () => {
    expect(fmtNum(13535)).toBe("13,535");
    expect(fmtNum(null)).toBe("—");
  });
});
