import { describe, expect, it } from "vitest";
import { anomalies, fmtNum, fmtSigned, indexTo100, kpiStat, mean, rollingMean, stddev } from "./analytics.ts";

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
    // 14 quiet days oscillating ±1 around 100, then a big spike.
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
