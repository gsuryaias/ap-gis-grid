import { describe, expect, it } from "vitest";
import { ageYears, commissionYear, formatAge, formatDist, formatKm } from "./format.ts";

describe("commissionYear", () => {
  it("extracts the year from a 'Mon YYYY' string", () => {
    expect(commissionYear("Oct 2017")).toBe(2017);
    expect(commissionYear("Jan 1958")).toBe(1958);
  });

  it("returns null for missing or implausible values", () => {
    expect(commissionYear(null)).toBeNull();
    expect(commissionYear("")).toBeNull();
    expect(commissionYear("no date")).toBeNull();
  });
});

describe("ageYears", () => {
  it("computes whole-year age relative to a reference year", () => {
    expect(ageYears("Oct 2017", 2026)).toBe(9);
    expect(ageYears("Jan 1958", 2026)).toBe(68);
  });

  it("clamps future commissioning to 0 and passes through unknowns", () => {
    expect(ageYears("Jan 2030", 2026)).toBe(0);
    expect(ageYears(null, 2026)).toBeNull();
  });
});

describe("formatAge", () => {
  it("singularises one year", () => {
    expect(formatAge(1)).toBe("1 yr");
    expect(formatAge(9)).toBe("9 yrs");
    expect(formatAge(null)).toBe("—");
  });
});

describe("formatKm / formatDist (regression)", () => {
  it("formats km and metres", () => {
    expect(formatKm(null)).toBe("—");
    expect(formatDist(500)).toBe("500 m");
    expect(formatDist(2000)).toBe("2.0 km");
  });
});
