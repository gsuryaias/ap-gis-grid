import type { FeatureCollection } from "geojson";
import { describe, expect, it } from "vitest";
import {
  compositeRisk,
  criticalityScore,
  hazardScore,
  windZoneAt,
  type CriticalityInput,
  type HazardInput,
} from "./risk-engine.ts";

// Tiny synthetic zone map: three nested/overlapping rectangles sharing the SW corner, so a
// single point can sit inside one, two or all three zones. Deliberately listed lowest-vb
// first so the "highest wins" rule is exercised, not feature order.
const square = (maxLng: number): GeoJSON.Polygon => ({
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [maxLng, 0],
      [maxLng, 10],
      [0, 10],
      [0, 0],
    ],
  ],
});

const zones: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { vb: 39, label: "39 m/s" }, geometry: square(10) },
    { type: "Feature", properties: { vb: 44, label: "44 m/s" }, geometry: square(6) },
    { type: "Feature", properties: { vb: 50, label: "50 m/s" }, geometry: square(3) },
  ],
};

describe("windZoneAt", () => {
  it("returns the highest vb among overlapping zones", () => {
    expect(windZoneAt(1, 5, zones)).toBe(50); // inside all three
    expect(windZoneAt(4, 5, zones)).toBe(44); // inside 44 + 39 only
    expect(windZoneAt(8, 5, zones)).toBe(39); // inside 39 only
  });

  it("returns null outside every polygon", () => {
    expect(windZoneAt(20, 20, zones)).toBeNull();
    expect(windZoneAt(-1, 5, zones)).toBeNull();
  });

  it("ignores features without a valid vb", () => {
    const junk: FeatureCollection = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { vb: 99 }, geometry: square(10) }],
    };
    expect(windZoneAt(1, 1, junk)).toBeNull();
  });
});

// A floor hazard input: outside the wind zones, inland, no cyclone — only the wind fallback (8).
const hazardBase: HazardInput = { windVb: null, coastalBand: 3, inCycloneCone: false };

describe("hazardScore", () => {
  it("weights the wind zones 40 / 20 / 8 with a null fallback of 8", () => {
    expect(hazardScore({ ...hazardBase, windVb: 50 }).score).toBe(40);
    expect(hazardScore({ ...hazardBase, windVb: 44 }).score).toBe(20);
    expect(hazardScore({ ...hazardBase, windVb: 39 }).score).toBe(8);
    expect(hazardScore({ ...hazardBase, windVb: null }).score).toBe(8);
  });

  it("weights the coastal bands 30 / 18 / 8 / 0 (unknown = inland)", () => {
    expect(hazardScore({ ...hazardBase, coastalBand: 0 }).score).toBe(38);
    expect(hazardScore({ ...hazardBase, coastalBand: 1 }).score).toBe(26);
    expect(hazardScore({ ...hazardBase, coastalBand: 2 }).score).toBe(16);
    expect(hazardScore({ ...hazardBase, coastalBand: 3 }).score).toBe(8);
    expect(hazardScore({ ...hazardBase, coastalBand: undefined }).score).toBe(8);
  });

  it("adds 30 for an active cyclone cone", () => {
    expect(hazardScore({ ...hazardBase, inCycloneCone: true }).score).toBe(38);
  });

  it("maxes at 100 and lists every contributor", () => {
    const r = hazardScore({ windVb: 50, coastalBand: 0, inCycloneCone: true });
    expect(r.score).toBe(100);
    expect(r.factors).toEqual(["wind zone 50 m/s", "coastal band 0", "in active cyclone cone"]);
  });

  it("labels an unknown wind zone but omits zero contributors", () => {
    expect(hazardScore(hazardBase).factors).toEqual(["wind zone unknown"]);
  });
});

// A floor criticality input: small 132 kV asset, well-fed, few lines — voltage pts only (10).
const critBase: CriticalityInput = { feedDegree: 3, voltage: 132, connectedLineCount: 2 };

describe("criticalityScore", () => {
  it("weights voltage 40 / 25 / 10", () => {
    expect(criticalityScore({ ...critBase, voltage: 400 }).score).toBe(40);
    expect(criticalityScore({ ...critBase, voltage: 220 }).score).toBe(25);
    expect(criticalityScore({ ...critBase, voltage: 132 }).score).toBe(10);
  });

  it("weights hub size 30 / 20 / 10 / 0 at ≥8 / ≥5 / ≥3 lines", () => {
    expect(criticalityScore({ ...critBase, connectedLineCount: 8 }).score).toBe(40);
    expect(criticalityScore({ ...critBase, connectedLineCount: 5 }).score).toBe(30);
    expect(criticalityScore({ ...critBase, connectedLineCount: 3 }).score).toBe(20);
    expect(criticalityScore({ ...critBase, connectedLineCount: 2 }).score).toBe(10);
    expect(criticalityScore({ ...critBase, connectedLineCount: 0 }).score).toBe(10);
  });

  it("weights redundancy inverse 30 / 15 / 0 at feedDegree ≤1 / 2 / ≥3", () => {
    expect(criticalityScore({ ...critBase, feedDegree: 0 }).score).toBe(40);
    expect(criticalityScore({ ...critBase, feedDegree: 1 }).score).toBe(40);
    expect(criticalityScore({ ...critBase, feedDegree: 2 }).score).toBe(25);
    expect(criticalityScore({ ...critBase, feedDegree: 3 }).score).toBe(10);
  });

  it("maxes at 100 and lists every contributor", () => {
    const r = criticalityScore({ feedDegree: 1, voltage: 400, connectedLineCount: 9 });
    expect(r.score).toBe(100);
    expect(r.factors).toEqual(["400 kV", "9-line hub", "single-fed"]);
  });

  it("omits zero contributors (voltage is always listed)", () => {
    expect(criticalityScore(critBase).factors).toEqual(["132 kV"]);
  });
});

describe("compositeRisk", () => {
  it("returns 100 when every axis is 100", () => {
    expect(compositeRisk({ hazard: 100, vulnerability: 100, criticality: 100 })).toBe(100);
  });

  it("equals the common value when all axes agree (exponents sum to 1)", () => {
    expect(compositeRisk({ hazard: 50, vulnerability: 50, criticality: 50 })).toBe(50);
    expect(compositeRisk({ hazard: 80, vulnerability: 80, criticality: 80 })).toBe(80);
  });

  it("matches the documented formula on a mixed input", () => {
    // round(100 × 0.8^0.4 × 0.6^0.4 × 0.4^0.2) = round(62.07) = 62
    expect(compositeRisk({ hazard: 80, vulnerability: 60, criticality: 40 })).toBe(62);
  });

  it("clamps each axis to ≥5 so a zero never vetoes the blend", () => {
    // criticality 0 → 5: round(100 × 1 × 1 × 0.05^0.2) = 55, not 0
    expect(compositeRisk({ hazard: 100, vulnerability: 100, criticality: 0 })).toBe(55);
    // hazard 0 → 5: round(100 × 0.05^0.4) = 30
    expect(compositeRisk({ hazard: 0, vulnerability: 100, criticality: 100 })).toBe(30);
    // all-zero input floors to the geometric mean of the clamps: 5
    expect(compositeRisk({ hazard: 0, vulnerability: 0, criticality: 0 })).toBe(5);
  });
});
