import { describe, expect, it } from "vitest";
import { bearingDeg, compass8, formatArea, formatLength, haversineMeters, pathLengthMeters, ringAreaMeters } from "./geo.ts";

describe("haversineMeters", () => {
  it("measures one degree of latitude as ~111.2 km", () => {
    // 1° = R · π/180 along a meridian, independent of longitude.
    expect(haversineMeters([0, 0], [0, 1])).toBeCloseTo(111_195, -1);
  });

  it("is symmetric and zero for identical points", () => {
    expect(haversineMeters([80.4, 15.9], [80.4, 15.9])).toBe(0);
    expect(haversineMeters([80, 16], [81, 17])).toBeCloseTo(haversineMeters([81, 17], [80, 16]), 6);
  });

  it("shrinks a degree of longitude by cos(latitude)", () => {
    const atLat16 = haversineMeters([80, 16], [81, 16]);
    const atEquator = haversineMeters([80, 0], [81, 0]);
    expect(atLat16 / atEquator).toBeCloseTo(Math.cos((16 * Math.PI) / 180), 3);
  });
});

describe("pathLengthMeters", () => {
  it("returns 0 for fewer than two points", () => {
    expect(pathLengthMeters([])).toBe(0);
    expect(pathLengthMeters([[80, 16]])).toBe(0);
  });

  it("sums consecutive segments", () => {
    const a: [number, number] = [0, 0];
    const b: [number, number] = [0, 1];
    const c: [number, number] = [0, 2];
    expect(pathLengthMeters([a, b, c])).toBeCloseTo(haversineMeters(a, b) + haversineMeters(b, c), 3);
  });
});

describe("ringAreaMeters", () => {
  it("returns 0 for degenerate rings", () => {
    expect(ringAreaMeters([])).toBe(0);
    expect(ringAreaMeters([[0, 0], [1, 0]])).toBe(0);
  });

  it("matches the analytic lat/lon box area near the equator", () => {
    // Box [0,1]°×[0,1]°: A = R²·Δλ·(sinφ₂ − sinφ₁).
    const R = 6_371_008.8;
    const expected = R * R * (Math.PI / 180) * (Math.sin((1 * Math.PI) / 180) - 0);
    const ring = [[0, 0], [1, 0], [1, 1], [0, 1]] as [number, number][];
    expect(ringAreaMeters(ring)).toBeCloseTo(expected, -3); // within ~1 km²
  });

  it("ignores winding direction", () => {
    const cw = [[0, 0], [1, 0], [1, 1], [0, 1]] as [number, number][];
    const ccw = [...cw].reverse();
    expect(ringAreaMeters(cw)).toBeCloseTo(ringAreaMeters(ccw), 6);
  });
});

describe("bearingDeg / compass8", () => {
  it("points due north, east, south, and west", () => {
    expect(bearingDeg([80, 16], [80, 17])).toBeCloseTo(0, 1); // straight up a meridian
    expect(bearingDeg([80, 16], [81, 16])).toBeCloseTo(90, 0); // due east (small ≈90°)
    expect(bearingDeg([80, 16], [80, 15])).toBeCloseTo(180, 1); // due south
    expect(bearingDeg([80, 16], [79, 16])).toBeCloseTo(270, 0); // due west
  });

  it("maps bearings to 8-point compass labels", () => {
    expect(compass8(0)).toBe("N");
    expect(compass8(45)).toBe("NE");
    expect(compass8(90)).toBe("E");
    expect(compass8(225)).toBe("SW");
    expect(compass8(359)).toBe("N");
  });
});

describe("formatters", () => {
  it("formats lengths across the metre/kilometre boundary", () => {
    expect(formatLength(5.4)).toBe("5.4 m");
    expect(formatLength(420)).toBe("420 m");
    expect(formatLength(1500)).toBe("1.5 km");
    expect(formatLength(NaN)).toBe("—");
  });

  it("formats areas across m²/ha/km²", () => {
    expect(formatArea(800)).toBe("800 m²");
    expect(formatArea(50_000)).toBe("5 ha");
    expect(formatArea(2_500_000)).toBe("2.5 km²");
  });
});
