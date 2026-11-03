import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { diffKeyed, featureKey, gatePull, LIVE_LAYERS, normalizeValue, truncateKeys } from "./live-sources.ts";
import { buildDiscomLines, buildDiscomSubstations, cleanSsLabel, cleanText, connectedParts, simplifyLine, titleCase } from "./etl-discom.ts";

describe("live-sources helpers", () => {
  it("truncates keys to the 10-char dBASE names the snapshot ETL expects", () => {
    expect(truncateKeys({ circuit_type: "DC", date_of_commissioning: 1, line_length: 3, name_of_the_ss: "x" })).toEqual({
      circuit_ty: "DC",
      date_of_co: 1,
      line_lengt: 3,
      name_of_th: "x",
    });
    // first key wins on collision
    expect(truncateKeys({ no_of_conductors: 1, no_of_conductor_x: 2 })).toEqual({ no_of_cond: 1 });
  });

  it("normalises values (trim, empty→null, epoch date→ISO)", () => {
    expect(normalizeValue("  a ", false)).toBe("a");
    expect(normalizeValue("   ", false)).toBeNull();
    expect(normalizeValue(1140028200000, true)).toBe("2006-02-15T18:30:00.000Z");
    expect(normalizeValue(5, false)).toBe(5);
  });

  it("keys features by the first meaningful key field, else geometry", () => {
    expect(featureKey({ sap_ss_id: "SS_1", ss_name: "A" }, ["sap_ss_id", "ss_name"], "g")).toBe("sap_ss_id:SS_1");
    expect(featureKey({ sap_ss_id: "<Null>", ss_name: "A" }, ["sap_ss_id", "ss_name"], "g")).toBe("ss_name:A");
    expect(featureKey({}, ["x"], "abc")).toBe("g:abc");
  });

  it("diffs keyed maps", () => {
    const d = diffKeyed(new Map([["a", "1"], ["b", "1"]]), new Map([["a", "2"], ["c", "1"]]));
    expect(d).toEqual({ added: ["c"], removed: ["b"], modified: ["a"] });
  });

  it("gates bad pulls (floor + max drop) but accepts growth", () => {
    expect(gatePull(0, 10, null)).toMatch(/floor/);
    expect(gatePull(80, 10, 100)).toMatch(/fell/);
    expect(gatePull(90, 10, 100)).toBeNull();
    expect(gatePull(500, 10, 100)).toBeNull();
  });

  it("has unique layer names", () => {
    const names = LIVE_LAYERS.map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("DISCOM ETL", () => {
  it("cleans text and title-cases", () => {
    expect(cleanText(" <Null> ")).toBeNull();
    expect(cleanText("  a  b ")).toBe("a b");
    expect(titleCase("SANTHOSH NAGAR 33KV SS")).toBe("Santhosh Nagar 33KV SS");
  });

  it("simplifies a straight run to its endpoints", () => {
    expect(simplifyLine([[0, 0], [1, 0.000001], [2, 0]], 0.0001)).toEqual([[0, 0], [2, 0]]);
    expect(simplifyLine([[0, 0], [1, 1], [2, 0]], 0.0001)).toHaveLength(3);
  });

  it("joins spans that share (near-)endpoints", () => {
    const comps = connectedParts([
      [[80, 16], [80.01, 16]],
      [[80.010001, 16], [80.02, 16]], // ~0.1 m gap → joined
      [[81, 17], [81.01, 17]],
    ]);
    expect(comps.map((c) => c.length).sort()).toEqual([1, 2]);
  });

  it("builds EPDCL substations from polygons with hierarchy", () => {
    const ss = buildDiscomSubstations("APEPDCL", [
      {
        geometry: { type: "Polygon", coordinates: [[[80, 16], [80.001, 16], [80.001, 16.001], [80, 16]]] },
        properties: { sub_station_name: "REVIDI", ssid: "1000-42-SS-1", circle_name: "VISAKHAPATNAM", stn_tr_cap: "13MVA" },
      },
    ]);
    expect(ss).toHaveLength(1);
    expect(ss[0]).toMatchObject({ discom: "APEPDCL", name: "Revidi", circle: "Visakhapatnam", capacity: "13MVA" });
    expect(ss[0].id).toBe("ds-ep-1000-42-ss-1");
  });

  it("cleans 33/11 kV substation labels", () => {
    expect(cleanSsLabel("33/11KV Vullipalem Sub-Station")).toBe("Vullipalem");
    expect(cleanSsLabel("33_11KV Z.P.INDOOR SS")).toBe("Z.P.INDOOR");
    expect(cleanSsLabel("REVIDI")).toBe("REVIDI");
  });

  it("builds APCPDCL substations (public hosted layer) and feeders (GIS export)", () => {
    const ss = buildDiscomSubstations("APCPDCL", [
      {
        geometry: { type: "Polygon", coordinates: [[[80, 16], [80.001, 16], [80.001, 16.001], [80, 16]]] },
        properties: { sub_station_name: "33/11KV Vullipalem Sub-Station", sub_station_id: "3027311402", circle_name: "BAPATLA", sub_station_type: "OUTDOOR" },
      },
    ]);
    expect(ss[0]).toMatchObject({ discom: "APCPDCL", name: "Vullipalem", code: "3027311402", circle: "Bapatla", ssType: "Outdoor" });
    const ln = buildDiscomLines("APCPDCL", [
      {
        geometry: { type: "MultiLineString", coordinates: [[[80, 16], [80.05, 16]]] },
        properties: { feeder: "33 KV  CHIRALA D1 FEEDER", substn: "132 KV  CHIRALA  SS", circle: "BAPATLA", n_poles: 207 },
      },
    ]);
    expect(ln[0].props).toMatchObject({ name: "33KV Chirala D1", sourceSs: "132 KV Chirala SS", spans: 207 });
  });

  it("groups SPDCL spans into feeder runs and drops 11 kV spans", () => {
    const span = (a: number, b: number) => ({ type: "LineString" as const, coordinates: [[a, 15], [b, 15]] });
    const lines = buildDiscomLines("APSPDCL", [
      { geometry: span(79, 79.01), properties: { feeder_name: "33KV X", division: "Nandyal", voltagelevel: 33 } },
      { geometry: span(79.01, 79.02), properties: { feeder_name: "33KV X", division: "Nandyal", voltagelevel: 33 } },
      { geometry: span(79.5, 79.6), properties: { feeder_name: "11KV Y", division: "Nandyal", voltagelevel: 11 } },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].props).toMatchObject({ name: "33KV X", spans: 2 });
    expect(lines[0].props.lengthKm).toBeGreaterThan(2);
  });
});

const live = "data/raw/live/manifest.json";
describe.skipIf(!existsSync(live))("committed live manifest", () => {
  it("records every configured (non-token) layer", () => {
    const m = JSON.parse(readFileSync(live, "utf-8"));
    for (const l of LIVE_LAYERS.filter((x) => !x.requiresToken)) {
      expect(m.layers[l.name], l.name).toBeTruthy();
      expect(m.layers[l.name].count, l.name).toBeGreaterThanOrEqual(l.minCount);
    }
  });
});
