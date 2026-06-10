import { describe, expect, it } from "vitest";
import { riskTier, substationRisk, type RiskInput } from "./risk.ts";

// A floor input: inland, young, well-fed, 132 kV — only the always-on voltage component (3 pts).
const base: RiskInput = { coastalBand: 3, ageYears: 5, feedDegree: 3, voltage: 132 };

describe("substationRisk — coastal exposure (up to 40 pts)", () => {
  it("weights the bands 40 / 25 / 12 / 0", () => {
    expect(substationRisk({ ...base, coastalBand: 0 }).score).toBe(43);
    expect(substationRisk({ ...base, coastalBand: 1 }).score).toBe(28);
    expect(substationRisk({ ...base, coastalBand: 2 }).score).toBe(15);
    expect(substationRisk({ ...base, coastalBand: 3 }).score).toBe(3);
  });

  it("treats a missing band as inland (0 pts, no coastal factor)", () => {
    const r = substationRisk({ ...base, coastalBand: undefined });
    expect(r.score).toBe(3);
    expect(r.factors.some((f) => f.startsWith("coastal"))).toBe(false);
  });
});

describe("substationRisk — redundancy (up to 30 pts)", () => {
  it("scores feedDegree ≤1 → 30, =2 → 15, ≥3 → 0", () => {
    expect(substationRisk({ ...base, feedDegree: 0 }).score).toBe(33);
    expect(substationRisk({ ...base, feedDegree: 1 }).score).toBe(33);
    expect(substationRisk({ ...base, feedDegree: 2 }).score).toBe(18);
    expect(substationRisk({ ...base, feedDegree: 3 }).score).toBe(3);
    expect(substationRisk({ ...base, feedDegree: 5 }).score).toBe(3);
  });

  it("labels the contributing degrees", () => {
    expect(substationRisk({ ...base, feedDegree: 1 }).factors).toContain("single-fed");
    expect(substationRisk({ ...base, feedDegree: 2 }).factors).toContain("double-fed");
    expect(substationRisk({ ...base, feedDegree: 3 }).factors).not.toContain("double-fed");
  });
});

describe("substationRisk — age (up to 20 pts)", () => {
  it("ramps linearly from 0 pts at ≤10 yrs to 20 pts at ≥40 yrs", () => {
    expect(substationRisk({ ...base, ageYears: 0 }).score).toBe(3);
    expect(substationRisk({ ...base, ageYears: 10 }).score).toBe(3);
    expect(substationRisk({ ...base, ageYears: 25 }).score).toBe(13); // midpoint → 10 pts
    expect(substationRisk({ ...base, ageYears: 38 }).score).toBe(22); // 18.67 pts, sum rounded
    expect(substationRisk({ ...base, ageYears: 40 }).score).toBe(23);
    expect(substationRisk({ ...base, ageYears: 60 }).score).toBe(23); // capped at 20 pts
  });

  it("treats unknown age as mild risk (10 pts) with its own factor", () => {
    const r = substationRisk({ ...base, ageYears: null });
    expect(r.score).toBe(13);
    expect(r.factors).toContain("age unknown");
  });
});

describe("substationRisk — criticality by voltage (up to 10 pts)", () => {
  it("scores 400 → 10, 220 → 6, 132 → 3", () => {
    expect(substationRisk({ ...base, voltage: 400 }).score).toBe(10);
    expect(substationRisk({ ...base, voltage: 220 }).score).toBe(6);
    expect(substationRisk({ ...base, voltage: 132 }).score).toBe(3);
  });
});

describe("substationRisk — factors", () => {
  it("lists every non-zero contributor for a worst-case substation", () => {
    const r = substationRisk({ coastalBand: 0, ageYears: 40, feedDegree: 1, voltage: 400 });
    expect(r.score).toBe(100);
    expect(r.factors).toEqual(["coastal <10 km", "single-fed", "40 yrs old", "400 kV"]);
  });

  it("omits zero contributors (inland, young, well-fed)", () => {
    expect(substationRisk(base).factors).toEqual(["132 kV"]);
  });
});

describe("riskTier", () => {
  it("cuts at <25 / 25–49 / 50–69 / ≥70", () => {
    expect(riskTier(0)).toBe("low");
    expect(riskTier(24)).toBe("low");
    expect(riskTier(25)).toBe("moderate");
    expect(riskTier(49)).toBe("moderate");
    expect(riskTier(50)).toBe("elevated");
    expect(riskTier(69)).toBe("elevated");
    expect(riskTier(70)).toBe("high");
    expect(riskTier(100)).toBe("high");
  });
});
