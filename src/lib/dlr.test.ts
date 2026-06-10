import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAP_UPRATE,
  DEFAULT_MAX_CONDUCTOR_C,
  DEFAULT_REF_AMBIENT_C,
  deratedCapacityMva,
  deratingFactor,
  formatDerating,
} from "./dlr.ts";

describe("deratingFactor", () => {
  it("is exactly 1.0 at the reference ambient (40 °C)", () => {
    expect(deratingFactor(40)).toBe(1);
  });

  it("derates a hot day: 47 °C → sqrt(28/35) ≈ 0.894", () => {
    expect(deratingFactor(47)).toBeCloseTo(Math.sqrt(28 / 35), 5);
    expect(deratingFactor(47)).toBeCloseTo(0.894, 3);
  });

  it("clamps to 0 at and beyond the max conductor temperature", () => {
    expect(deratingFactor(75)).toBe(0);
    expect(deratingFactor(80)).toBe(0);
    expect(deratingFactor(120)).toBe(0);
  });

  it("uprates a cool day below the reference ambient", () => {
    // 30 °C → sqrt(45/35) ≈ 1.134 — under the cap, returned as-is.
    expect(deratingFactor(30)).toBeCloseTo(Math.sqrt(45 / 35), 5);
  });

  it("caps cool-weather uprating at 1.15 by default", () => {
    // 0 °C → sqrt(75/35) ≈ 1.464 uncapped.
    expect(deratingFactor(0)).toBe(1.15);
    expect(deratingFactor(-10)).toBe(1.15);
  });

  it("honours an overridden capUprate", () => {
    expect(deratingFactor(0, { capUprate: 1.3 })).toBe(1.3);
    expect(deratingFactor(30, { capUprate: 1.05 })).toBe(1.05);
  });

  it("honours overridden conductor / reference temperatures", () => {
    // HTLS-style 85 °C conductor, same 40 °C reference: 47 °C → sqrt(38/45).
    expect(deratingFactor(47, { maxConductorC: 85, refAmbientC: 40 })).toBeCloseTo(
      Math.sqrt(38 / 45),
      5,
    );
    expect(deratingFactor(85, { maxConductorC: 85 })).toBe(0);
  });

  it("returns null for non-finite input", () => {
    expect(deratingFactor(NaN)).toBeNull();
    expect(deratingFactor(Infinity)).toBeNull();
    expect(deratingFactor(-Infinity)).toBeNull();
  });

  it("returns null for a degenerate Tcond ≤ Tref configuration", () => {
    expect(deratingFactor(35, { maxConductorC: 40, refAmbientC: 40 })).toBeNull();
    expect(deratingFactor(35, { maxConductorC: 30, refAmbientC: 40 })).toBeNull();
  });
});

describe("deratedCapacityMva", () => {
  it("composes factor × base MVA (Zebra @ 220 kV ≈ 280 MVA, 47 °C → ≈ 250 MVA)", () => {
    const res = deratedCapacityMva(280, 47);
    expect(res).not.toBeNull();
    expect(res?.factor).toBeCloseTo(Math.sqrt(28 / 35), 5);
    expect(res?.mva).toBe(Math.round(280 * Math.sqrt(28 / 35))); // 250
  });

  it("is identity at the reference ambient", () => {
    expect(deratedCapacityMva(280, 40)).toEqual({ mva: 280, factor: 1 });
  });

  it("goes to 0 MVA when the ambient reaches the conductor limit", () => {
    expect(deratedCapacityMva(280, 75)).toEqual({ mva: 0, factor: 0 });
  });

  it("passes options through to the factor", () => {
    expect(deratedCapacityMva(100, 0, { capUprate: 1.1 })).toEqual({ mva: 110, factor: 1.1 });
  });

  it("returns null when the factor is null", () => {
    expect(deratedCapacityMva(280, NaN)).toBeNull();
  });

  it("returns null when baseMva isn't a positive finite number", () => {
    expect(deratedCapacityMva(0, 40)).toBeNull();
    expect(deratedCapacityMva(-5, 40)).toBeNull();
    expect(deratedCapacityMva(NaN, 40)).toBeNull();
    expect(deratedCapacityMva(Infinity, 40)).toBeNull();
  });
});

describe("formatDerating", () => {
  it("formats a derate with the typographic minus", () => {
    expect(formatDerating(0.894)).toBe("−11%");
    expect(formatDerating(0.5)).toBe("−50%");
    expect(formatDerating(0)).toBe("−100%");
  });

  it("formats an uprate with a plus sign", () => {
    expect(formatDerating(1.05)).toBe("+5%");
    expect(formatDerating(1.15)).toBe("+15%");
  });

  it("formats nominal (and rounds-to-zero values) as ±0%", () => {
    expect(formatDerating(1)).toBe("±0%");
    expect(formatDerating(0.999)).toBe("±0%"); // −0 after rounding must not show a sign
    expect(formatDerating(1.004)).toBe("±0%");
  });

  it("rounds to the nearest whole percent", () => {
    expect(formatDerating(0.886)).toBe("−11%"); // −11.4 → −11
    expect(formatDerating(1.134)).toBe("+13%");
  });
});

describe("default constants", () => {
  it("matches the nominal Indian ACSR rating assumptions", () => {
    expect(DEFAULT_MAX_CONDUCTOR_C).toBe(75);
    expect(DEFAULT_REF_AMBIENT_C).toBe(40);
    expect(DEFAULT_CAP_UPRATE).toBe(1.15);
  });
});
