import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  abbrevMatch,
  linkFeederSources,
  linkServedSubstations,
  namesMatch,
  normSsName,
  pointSegmentM,
  skeleton,
  voltageHint,
  type FeederIn,
  type TranscoNode,
} from "./etl-connectivity.ts";

describe("source-SS name matching", () => {
  it("normalises recorded names", () => {
    expect(normSsName("132/33KV AMPOLU")).toBe("ampolu");
    expect(normSsName("132 KV  Chirala SS")).toBe("chirala");
    expect(normSsName("220/132/33 KV DAIRY FORM")).toBe("dairyform");
    expect(voltageHint("220/33 KV ONGOLE SS")).toBe(220);
    expect(voltageHint("Ongole")).toBeNull();
  });

  it("tolerates transliteration variants and typos", () => {
    expect(skeleton("narasapuram")).toBe(skeleton("narsapuram"));
    expect(namesMatch("rentachinthala", "rentachintala")).toBe(true);
    expect(namesMatch("dairyform", "dairyfarm")).toBe(true);
    expect(namesMatch("ongole", "nellore")).toBe(false);
    expect(namesMatch("kota", "kotha")).toBe(false); // too short for fuzzy rules
  });

  it("expands abbreviated names", () => {
    expect(abbrevMatch("132/33 KV K KOTA", "kamavarapukota")).toBe(true);
    expect(abbrevMatch("132/33 KV J R GUDEM", "jangareddygudem")).toBe(true);
    expect(abbrevMatch("132/33 KV R.C.PURAM", "ramachandrapuram")).toBe(true);
    expect(abbrevMatch("132/33 KV K KOTA", "ramakota")).toBe(false);
    expect(abbrevMatch("132/33 KV AMPOLU", "ampolu")).toBe(false); // not an abbreviation
  });
});

describe("feeder linking", () => {
  const T: TranscoNode[] = [
    { id: "s-a", name: "AMPOLU", descriptiveName: "132KV AMPOLU SS", voltage: 132, lng: 80, lat: 16 },
    { id: "s-b", name: "OTHER", descriptiveName: null, voltage: 132, lng: 80.3, lat: 16 },
  ];
  const f = (id: string, sourceSs: string | null, start: [number, number], name: string | null = null): FeederIn => ({
    id,
    discom: "APEPDCL",
    name,
    division: "d",
    sourceSs,
    parts: [[start, [start[0] + 0.05, start[1] + 0.05]]],
  });

  it("prefers the recorded source name, then proximity, then same-feeder inheritance", () => {
    const links = linkFeederSources(T, [
      f("f1", "132/33KV AMPOLU", [80.3, 16]), // starts at OTHER but records Ampolu → name wins
      f("f2", null, [80.301, 16.001]), // ~150 m from OTHER → proximity
      f("f3", null, [81, 17], "X"), // far away, named X
      f("f4", null, [80.0005, 16], "X"), // same feeder X, at AMPOLU
    ]);
    expect(links.get("f1")).toMatchObject({ transcoSsId: "s-a", method: "name" });
    expect(links.get("f2")).toMatchObject({ transcoSsId: "s-b", method: "proximity" });
    expect(links.get("f4")).toMatchObject({ transcoSsId: "s-a", method: "proximity" });
    expect(links.get("f3")).toMatchObject({ transcoSsId: "s-a", method: "feeder-group" });
  });

  it("finds 33/11 kV SS along a route (same DISCOM only)", () => {
    expect(pointSegmentM([80.5, 16.001], [80, 16], [81, 16])).toBeGreaterThan(90);
    expect(pointSegmentM([80.5, 16.001], [80, 16], [81, 16])).toBeLessThan(130);
    const served = linkServedSubstations(
      [f("f1", null, [80, 16])],
      [
        { id: "near", discom: "APEPDCL", lng: 80.025, lat: 16.0262 }, // ~100 m off the route
        { id: "far", discom: "APEPDCL", lng: 80.025, lat: 16.05 },
        { id: "other-discom", discom: "APCPDCL", lng: 80.025, lat: 16.025 },
      ],
    );
    expect(served.get("f1")).toEqual(["near"]);
  });
});

describe.skipIf(!existsSync("public/data/transco-33kv.json"))("emitted connectivity", () => {
  it("references only real feeders and 33/11 kV substations", () => {
    const idx = JSON.parse(readFileSync("public/data/transco-33kv.json", "utf-8"));
    const lines = new Set(
      JSON.parse(readFileSync("public/data/discom-lines.geojson", "utf-8")).features.map((x: { properties: { id: string } }) => x.properties.id),
    );
    const ssIds = new Set(Object.keys(idx.ss));
    const transco = new Set(
      JSON.parse(readFileSync("public/data/substations.geojson", "utf-8")).features.map((x: { properties: { id: string } }) => x.properties.id),
    );
    let n = 0;
    for (const [tid, feeders] of Object.entries(idx.bySs) as Array<[string, Array<[string, unknown, unknown, unknown, unknown, string[]]>]>) {
      expect(transco.has(tid), tid).toBe(true);
      for (const fd of feeders) {
        expect(lines.has(fd[0])).toBe(true);
        for (const s of fd[5]) expect(ssIds.has(s)).toBe(true);
        n++;
      }
    }
    expect(n).toBeGreaterThan(1000);
  });
});
