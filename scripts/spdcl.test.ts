import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chainTree, isTruncated } from "./spdcl-lib.ts";
import { buildSpdclRoutes, cleanSsName, coverageMask, type SsRef } from "./etl-network.ts";

const P = (x: number, y: number) => ({ x, y });

describe("chainTree", () => {
  it("walks a straight feeder as one line", () => {
    const [a, b, c, d] = [P(0, 0), P(1, 0), P(2, 0), P(3, 0)];
    expect(chainTree([[a, b], [b, c], [c, d]])).toEqual([[[0, 0], [1, 0], [2, 0], [3, 0]]]);
  });
  it("runs through a branch and starts the lateral at the branch pole (parts = leaves)", () => {
    const [a, b, c, d, e] = [P(0, 0), P(1, 0), P(2, 0), P(1, 1), P(1, 2)];
    const parts = chainTree([[a, b], [b, c], [b, d], [d, e]]);
    expect(parts).toHaveLength(2);
    expect(parts).toContainEqual([[0, 0], [1, 0], [2, 0]]);
    expect(parts).toContainEqual([[1, 0], [1, 1], [1, 2]]);
  });
  it("terminates on a back-link cycle", () => {
    const [a, b] = [P(0, 0), P(1, 0)];
    expect(chainTree([[a, b], [b, a]]).length).toBeGreaterThan(0);
  });
});

describe("isTruncated", () => {
  const dir = mkdtempSync(join(tmpdir(), "spdcl-"));
  it("accepts a complete KML and rejects a GeoServer-error tail", () => {
    writeFileSync(join(dir, "ok.kml"), "<kml><Document></Document></kml>\n");
    writeFileSync(join(dir, "bad.kml"), "<kml><Document><Placemark>…<ServiceExceptionReport><ServiceException>FATAL</ServiceException></ServiceExceptionReport>");
    expect(isTruncated(join(dir, "ok.kml"))).toBe(false);
    expect(isTruncated(join(dir, "bad.kml"))).toBe(true);
  });
});

describe("APSPDCL route ETL", () => {
  it("cleans the survey's SS names", () => {
    expect(cleanSsName("33/11KV Tekuripeta SubStation")).toBe("Tekuripeta");
    expect(cleanSsName("33/11 KV Salipet SS")).toBe("Salipet");
    expect(cleanSsName(null)).toBeNull();
  });
  it("builds a feeder, labels it, links its 33/11 kV SS by name", () => {
    const ss: SsRef[] = [{ id: "ds-sp-1", discom: "APSPDCL", name: "Tekuripeta", lng: 79.0, lat: 15.0 }];
    const [f] = buildSpdclRoutes(
      [{ geometry: { type: "LineString", coordinates: [[79.001, 15.0], [79.01, 15.0]] }, properties: { feeder: "11KV THOKALAPALLI", substation: "33/11KV Tekuripeta SubStation", circle: "KADAPA", poles: 20, km: 0.97 } }],
      ss,
      0.00015,
    );
    expect(f.name).toBe("11KV Thokalapalli");
    expect(f.ssId).toBe("ds-sp-1");
    expect(f.linkMethod).toBe("name");
    expect(f.poles).toBe(20);
    expect(f.lengthKm).toBe(0.97);
  });
  it("coverage mask marks cells along a long simplified segment, not far away", () => {
    const covered = coverageMask([[[[79.0, 15.0], [79.1, 15.0]]]]);
    expect(covered([79.05, 15.0])).toBe(true);
    expect(covered([79.05, 15.02])).toBe(false);
  });
});

// Integrity of the committed import (skipped when absent): routes only — no point-level fields leak.
const IDX = resolve("data/raw/discom/spdcl-11kv/index.json");
describe.skipIf(!existsSync(IDX))("committed APSPDCL import", () => {
  const index = JSON.parse(readFileSync(IDX, "utf-8")) as { circles: Record<string, { feeders: number }>; skipped: Record<string, string> };
  it("has circles and lists skipped ones", () => {
    expect(Object.keys(index.circles).length).toBeGreaterThan(0);
  });
  it("publishes only route properties", () => {
    const allowed = new Set(["feeder", "substation", "section", "subdivision", "division", "circle", "poles", "dtrPoles", "vcbs", "km"]);
    for (const c of Object.keys(index.circles)) {
      const fc = JSON.parse(readFileSync(resolve(`data/raw/discom/spdcl-11kv/${c}.geojson`), "utf-8"));
      expect(fc.features.length).toBe(index.circles[c].feeders);
      for (const f of fc.features) {
        for (const k of Object.keys(f.properties)) expect(allowed.has(k), `${c}: unexpected property ${k}`).toBe(true);
        expect(["LineString", "MultiLineString"]).toContain(f.geometry.type);
      }
    }
  });
});
