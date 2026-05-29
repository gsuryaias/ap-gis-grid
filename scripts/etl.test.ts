import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FeatureCollection } from "geojson";
import {
  classifyFolder,
  cleanValue,
  detectNameFlags,
  haversineMeters,
  normalizeKey,
  parseDescriptionTable,
  parseEndpointLabels,
  round5,
  snapEndpoint,
} from "./etl-lib.ts";

describe("etl-lib helpers", () => {
  it("rounds coordinates to 5 dp", () => {
    expect(round5(79.223333000008)).toBe(79.22333);
  });

  it("computes haversine distance", () => {
    expect(haversineMeters([0, 0], [0, 1])).toBeCloseTo(111195, -2);
    expect(haversineMeters([80, 15], [80, 15])).toBe(0);
  });

  it("normalises attribute keys", () => {
    expect(normalizeKey("SAP SS ID")).toBe("SAP SS ID");
    expect(normalizeKey("GP_LANG")).toBe("GP LANG");
    expect(normalizeKey(" Line_Length ")).toBe("LINE LENGTH");
  });

  it("cleans placeholder values to null", () => {
    expect(cleanValue("  Chittoor ")).toBe("Chittoor");
    expect(cleanValue("&lt;Null&gt;")).toBeNull();
    expect(cleanValue("N/A")).toBeNull();
    expect(cleanValue("")).toBeNull();
    expect(cleanValue("JAMMALAMADUGU &amp; CO")).toBe("JAMMALAMADUGU & CO");
  });

  it("classifies folders for voltage + circuit", () => {
    expect(classifyFolder("SS_400KV")).toEqual({ kind: "substation", voltage: 400, circuit: null });
    expect(classifyFolder("DC_220KV_Lines")).toEqual({ kind: "line", voltage: 220, circuit: "DC" });
    expect(classifyFolder("SC_132KV_Lines")).toEqual({ kind: "line", voltage: 132, circuit: "SC" });
    expect(classifyFolder("Existing")).toBeNull();
  });

  it("parses nested description tables, skipping title + wrapper rows", () => {
    const html =
      "<html><body><table>" +
      "<tr><td>Chittoor</td></tr>" +
      "<tr><td><table>" +
      "<tr><td>SS_CODE</td><td>SS-400KV-CTTR</td></tr>" +
      "<tr><td>VOLTAGE</td><td>400KV</td></tr>" +
      "<tr><td>DOC</td><td>&lt;Null&gt;</td></tr>" +
      "</table></td></tr>" +
      "</table></body></html>";
    const m = parseDescriptionTable(html);
    expect(m.get("SS CODE")).toBe("SS-400KV-CTTR");
    expect(m.get("VOLTAGE")).toBe("400KV");
    expect(m.get("DOC")).toBeNull(); // <Null> placeholder cleaned
    expect(m.has("CHITTOOR")).toBe(false); // title row skipped
  });

  it("flags ambiguous/mismatched circuit & voltage from line names", () => {
    expect(detectNameFlags("400KV Vemagiri- Nunna DC SC Line", 400, "SC").circuitAmbiguous).toBe(true);
    expect(detectNameFlags("400KV Nunna-Sattenapalli DC Line", 400, "SC").circuitAmbiguous).toBe(true);
    expect(detectNameFlags("220 KV CHITTOOR - TIRUVALAM SC LINE", 220, "SC").circuitAmbiguous).toBe(false);
    expect(detectNameFlags("Kandukur(220KV)- Kavali Line", 132, "SC").voltageMismatch).toBe(true);
  });

  it("parses endpoint labels from line names (best-effort)", () => {
    expect(parseEndpointLabels("400KV KALAPAKA-VEMAGIRI")).toEqual(["Kalapaka", "Vemagiri"]);
    expect(parseEndpointLabels("220 KV CHITTOOR - TIRUVALAM SC LINE")).toEqual(["Chittoor", "Tiruvalam"]);
  });

  it("snaps an endpoint to the nearest point within threshold", () => {
    const pts = [{ id: "a", lng: 80, lat: 15 }, { id: "b", lng: 81, lat: 16 }];
    const near = snapEndpoint([80.0009, 15.0], pts, 500);
    expect(near?.ssId).toBe("a");
    expect(near?.confidence).toBe("high");
    expect(snapEndpoint([82, 18], pts, 500)).toBeNull();
  });
});

describe("emitted data integrity (run `npm run build:data` first)", () => {
  const dir = resolve("public/data");
  const ready = existsSync(resolve(dir, "meta.json"));
  const read = <T>(f: string) => JSON.parse(readFileSync(resolve(dir, f), "utf-8")) as T;

  it.skipIf(!ready)("has the expected counts and consistent adjacency", () => {
    const ss = read<FeatureCollection>("substations.geojson");
    const lines = read<FeatureCollection>("lines.geojson");
    const ssIds = new Set(ss.features.map((f) => f.properties?.id as string));

    expect(ss.features.length).toBe(499); // 500 parsed − 1 exact-coord duplicate
    expect(lines.features.length).toBe(715);

    const allIds = [...ss.features, ...lines.features].map((f) => f.properties?.id as string);
    expect(new Set(allIds).size).toBe(allIds.length); // ids unique across both layers

    for (const f of ss.features) {
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
      expect(Number.isFinite(lng) && Number.isFinite(lat)).toBe(true);
      expect(lng).toBeGreaterThan(76);
      expect(lng).toBeLessThan(85);
      expect(lat).toBeGreaterThan(12);
      expect(lat).toBeLessThan(20);
      expect([400, 220, 132]).toContain(f.properties?.voltage);
    }

    for (const f of lines.features) {
      const conn = (f.properties?.connectsSS as string[]) ?? [];
      expect(conn.length).toBeLessThanOrEqual(2);
      for (const id of conn) expect(ssIds.has(id)).toBe(true); // every link resolves
      expect((f.geometry as GeoJSON.LineString).coordinates.length).toBeGreaterThanOrEqual(2);
    }
  });
});
