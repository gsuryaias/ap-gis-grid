import { describe, expect, it } from "vitest";
import { freshFilters } from "../state/slices/filters.ts";
import { passesFilter, passesSlice, sliceActive } from "./selectors.ts";
import type { LineProps, SubstationProps } from "./types.ts";

const ss = (p: Partial<SubstationProps>) => ({ kind: "substation", voltage: 220, circle: "Kadapa", coastalBand: 3, ...p }) as SubstationProps;
const line = (p: Partial<LineProps>) => ({ kind: "line", voltage: 220, circle: "Kadapa", coastalBand: 3, circuit: "DC", ...p }) as LineProps;

describe("shared filter predicates", () => {
  it("passes everything with fresh filters", () => {
    const f = freshFilters();
    expect(sliceActive(f)).toBe(false);
    expect(passesSlice(ss({}), f)).toBe(true);
    expect(passesSlice(line({}), f)).toBe(true);
  });

  it("slices by voltage, circle, coastal band (cumulative ≤) and — for lines — circuit", () => {
    const f = { ...freshFilters(), voltages: { 400: true, 220: false, 132: true } };
    expect(sliceActive(f)).toBe(true);
    expect(passesSlice(ss({}), f)).toBe(false);
    expect(passesSlice(ss({ voltage: 400 }), f)).toBe(true);

    const c = { ...freshFilters(), circle: "Kadapa" };
    expect(passesSlice(ss({}), c)).toBe(true);
    expect(passesSlice(line({ circle: "Nellore" }), c)).toBe(false);

    const coast = { ...freshFilters(), coastalBand: 1 as const };
    expect(passesSlice(ss({ coastalBand: 0 }), coast)).toBe(true);
    expect(passesSlice(ss({ coastalBand: 1 }), coast)).toBe(true);
    expect(passesSlice(ss({ coastalBand: 2 }), coast)).toBe(false);
    expect(passesSlice(ss({ coastalBand: undefined }), coast)).toBe(false);

    const dcOff = { ...freshFilters(), circuits: { SC: true, DC: false } };
    expect(passesSlice(line({}), dcOff)).toBe(false);
    expect(passesSlice(line({ circuit: "SC" }), dcOff)).toBe(true);
    expect(passesSlice(ss({}), dcOff)).toBe(true); // substations have no circuit
  });

  it("passesFilter = slice + layer visibility", () => {
    const f = { ...freshFilters(), showLines: false };
    expect(passesFilter(line({}), f)).toBe(false);
    expect(passesFilter(ss({}), f)).toBe(true);
  });
});
