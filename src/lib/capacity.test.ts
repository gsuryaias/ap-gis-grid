import { describe, expect, it } from "vitest";
import {
  circuitCount,
  conductorRating,
  CONDUCTOR_AMPACITY,
  formatMva,
  lineCapacity,
  totalIndicativeCapacity,
} from "./capacity.ts";

describe("conductorRating", () => {
  it("rates a plain conductor at its single-conductor ampacity", () => {
    expect(conductorRating("Moose")).toEqual({
      base: "moose",
      ampacityPerConductor: 800,
      bundle: 1,
      ampacity: 800,
    });
  });

  it("applies a bundle multiplier for Twin/Quad", () => {
    expect(conductorRating("Twin Moose")?.ampacity).toBe(1600);
    expect(conductorRating("Quad Moose")?.ampacity).toBe(3200);
    expect(conductorRating("Quad Moose")?.bundle).toBe(4);
  });

  it("is case-insensitive and tolerates the source's lowercase 'moose'", () => {
    expect(conductorRating("moose")?.ampacity).toBe(800);
  });

  it("picks the FIRST recognised base code in a mixed-route string", () => {
    // "Moose, Zebra" → dominant is Moose (appears first)
    expect(conductorRating("Moose, Zebra")?.base).toBe("moose");
    expect(conductorRating("Deer, Moose, Zebra")?.base).toBe("deer");
  });

  it("finds the base code behind an HTLS/alloy prefix", () => {
    expect(conductorRating("ACSS Zebra")?.base).toBe("zebra");
    expect(conductorRating("AL59 Moose")?.base).toBe("moose");
    expect(conductorRating("AAAC Panther")?.base).toBe("panther");
  });

  it("folds the source's conductor-name typos", () => {
    expect(conductorRating("Zeebra, UG Cable")?.base).toBe("zebra");
    expect(conductorRating("AAAC & ACSR Panter")?.base).toBe("panther");
  });

  it("returns null when no base code is recognised", () => {
    expect(conductorRating("UG Cable")).toBeNull();
    expect(conductorRating("AL59")).toBeNull();
    expect(conductorRating("")).toBeNull();
    expect(conductorRating(null)).toBeNull();
    expect(conductorRating(undefined)).toBeNull();
  });
});

describe("circuitCount", () => {
  it("counts DC as 2 circuits and SC as 1", () => {
    expect(circuitCount("DC")).toBe(2);
    expect(circuitCount("SC")).toBe(1);
  });
});

describe("lineCapacity", () => {
  it("computes per-circuit MVA as √3·kV·A/1000", () => {
    // Zebra (735 A) @ 220 kV → √3·220·735/1000 ≈ 280 MVA
    const cap = lineCapacity("Zebra", 220, "SC");
    expect(cap?.perCircuitMva).toBe(280);
    expect(cap?.totalMva).toBe(280); // SC → ×1
  });

  it("doubles total MVA for a double-circuit line", () => {
    const cap = lineCapacity("Zebra", 220, "DC");
    expect(cap?.perCircuitMva).toBe(280);
    expect(cap?.totalMva).toBe(560); // DC → ×2
  });

  it("matches the headline figures from CEA/utility tables", () => {
    // Panther (480 A) @ 132 kV ≈ 110 MVA; Moose (800 A) @ 400 kV ≈ 554 MVA
    expect(lineCapacity("Panther", 132, "SC")?.perCircuitMva).toBe(110);
    expect(lineCapacity("Moose", 400, "SC")?.perCircuitMva).toBe(554);
  });

  it("returns null for an unratable conductor", () => {
    expect(lineCapacity("UG Cable", 220, "SC")).toBeNull();
  });
});

describe("formatMva", () => {
  it("formats MVA, switching to GVA at >= 1000", () => {
    expect(formatMva(280)).toBe("≈ 280 MVA");
    expect(formatMva(1600)).toBe("≈ 1.6 GVA");
    expect(formatMva(null)).toBe("—");
    expect(formatMva(NaN)).toBe("—");
  });
});

describe("totalIndicativeCapacity", () => {
  it("sums rated lines and reports coverage", () => {
    const lines = [
      { conductor: "Zebra", voltage: 220 as const, circuit: "SC" as const }, // 280
      { conductor: "Zebra", voltage: 220 as const, circuit: "DC" as const }, // 560
      { conductor: "UG Cable", voltage: 132 as const, circuit: "SC" as const }, // unrated → 0
    ];
    const res = totalIndicativeCapacity(lines);
    expect(res.totalMva).toBe(840);
    expect(res.rated).toBe(2);
    expect(res.total).toBe(3);
  });
});

describe("CONDUCTOR_AMPACITY table", () => {
  it("covers the conductors that actually appear in the AP-TRANSCO data", () => {
    for (const code of ["moose", "zebra", "panther", "lynx", "deer", "dog", "bear"]) {
      expect(CONDUCTOR_AMPACITY[code]).toBeGreaterThan(0);
    }
  });
});
