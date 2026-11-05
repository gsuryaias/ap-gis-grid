// v1 deep-link contract. These fixtures are real link shapes that may already be shared in emails /
// WhatsApp; Atlas 2.0's URL v2 must keep decoding every one of them (decodeV1 → v2), so this file is
// the compatibility gate for that migration — extend it, never loosen it.
import { describe, expect, it } from "vitest";
import { defaultHashState, parseHash, serializeHash, type HashState } from "./hash.ts";

const FIXTURES: { name: string; hash: string; expect: Partial<HashState> }[] = [
  { name: "empty hash", hash: "", expect: {} },
  { name: "bare version → atlas", hash: "#v=1", expect: { workspace: "atlas" } },
  {
    name: "selected substation",
    hash: "#v=1&sel=s-1234",
    expect: { workspace: "atlas", selectedId: "s-1234" },
  },
  {
    name: "atlas filters + overlays",
    hash: "#v=1&base=dark&volt=400%2C220&circ=DC&show=ln&gen=1&pg=1&wx=1&tbl=1&circle=Kadapa&coast=0",
    expect: {
      basemap: "dark",
      voltages: [400, 220],
      circuits: ["DC"],
      showSubstations: false,
      showLines: true,
      showGeneration: true,
      showPowerGrid: true,
      showWeather: true,
      tableOpen: true,
      circle: "Kadapa",
      coastalBand: 0,
    },
  },
  {
    name: "MIS drill with multi-value voltage slicer",
    hash: "#v=1&w=mis&by=division&mf=voltage%3A400%2C220~circle%3AKadapa&tab=age&theme=age&map=collapsed",
    expect: {
      workspace: "mis",
      misBy: "division",
      misFilters: "voltage:400,220~circle:Kadapa",
      misTab: "age",
      misTheme: "age",
      mapLayout: "collapsed",
    },
  },
  {
    name: "removed workspace (risk room / planning) falls back to atlas",
    hash: "#v=1&w=risk&sel=l-17",
    expect: { workspace: "atlas", selectedId: "l-17" },
  },
];

describe("URL hash v1 — decode fixtures", () => {
  for (const f of FIXTURES) {
    it(f.name, () => {
      const out = parseHash(f.hash);
      expect(out).toMatchObject(f.expect);
    });
  }

  it("ignores links from an unknown schema version", () => {
    expect(parseHash("#v=9&sel=s-1")).toEqual({});
    expect(parseHash("#sel=s-1")).toEqual({});
  });

  it("drops invalid values instead of failing", () => {
    const out = parseHash("#v=1&volt=999&circ=XX&coast=7&base=neon&w=mis&by=Bad%20Dim&tab=" + "x".repeat(40));
    expect(out.voltages).toEqual(defaultHashState.voltages);
    expect(out.circuits).toEqual(defaultHashState.circuits);
    expect(out.coastalBand).toBeUndefined();
    expect(out.basemap).toBeUndefined();
    expect(out.misBy).toBeNull();
    expect(out.misTab).toBeNull();
  });

  it("MIS keys are ignored outside the MIS workspace", () => {
    const out = parseHash("#v=1&by=division&tab=age");
    expect(out.misBy).toBeUndefined();
    expect(out.misTab).toBeUndefined();
  });
});

describe("URL hash v1 — round trip", () => {
  it("default state serialises to just the version", () => {
    expect(serializeHash(defaultHashState)).toBe("#v=1");
  });

  it("non-default atlas + MIS state survives serialise → parse", () => {
    const atlas: HashState = {
      ...defaultHashState,
      selectedId: "l-42",
      basemap: "satellite",
      voltages: [132],
      showGeneration: true,
      circle: "Vijayawada",
      coastalBand: 2,
    };
    expect(parseHash(serializeHash(atlas))).toMatchObject({
      selectedId: "l-42",
      basemap: "satellite",
      voltages: [132],
      showGeneration: true,
      circle: "Vijayawada",
      coastalBand: 2,
    });

    const mis: HashState = { ...defaultHashState, workspace: "mis", misBy: "zone", misFilters: "circle:Kadapa", misTab: "n1" };
    expect(parseHash(serializeHash(mis))).toMatchObject({ workspace: "mis", misBy: "zone", misFilters: "circle:Kadapa", misTab: "n1" });
  });
});
