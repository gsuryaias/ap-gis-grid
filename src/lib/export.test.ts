import { describe, expect, it } from "vitest";
import type { FeatureCollection } from "geojson";
import type { LineProps, SubstationProps } from "../data/types.ts";
import {
  csvCell,
  linesToCsv,
  subsetFeatures,
  substationsToCsv,
  substationsToGeoJSON,
  toCsv,
} from "./export.ts";

const ss = (over: Partial<SubstationProps>): SubstationProps => ({
  id: "s-1", kind: "substation", name: "ALPHA", descriptiveName: null, ssCode: null,
  voltage: 220, circle: "Guntur", circleInferred: false, doc: null, lng: 80.1, lat: 16.2,
  connectedLineIds: [], connectedLineCount: 3, zone: "Zone-1", division: "Guntur", ...over,
});

const line = (over: Partial<LineProps>): LineProps => ({
  id: "l-1", kind: "line", name: "ALPHA-BETA 220kV", voltage: 220, circuit: "DC",
  lengthKm: 12.5, ckm: 25, circle: "Guntur", connectsSS: ["s-1", "s-2"], endpointLabels: null,
  fromSS: null, toSS: null, circuitAmbiguous: false, voltageMismatch: false, ...over,
});

describe("csvCell", () => {
  it("passes through plain values and blanks null/undefined", () => {
    expect(csvCell("ALPHA")).toBe("ALPHA");
    expect(csvCell(220)).toBe("220");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("quotes and escapes cells containing commas, quotes, or newlines", () => {
    expect(csvCell("Anantapur, Kadapa")).toBe('"Anantapur, Kadapa"');
    expect(csvCell('a "b" c')).toBe('"a ""b"" c"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });
});

describe("toCsv", () => {
  it("joins headers + rows with CRLF and escapes each cell", () => {
    const csv = toCsv(["a", "b"], [[1, "x,y"], [2, "z"]]);
    expect(csv).toBe('a,b\r\n1,"x,y"\r\n2,z');
  });
});

describe("substationsToCsv", () => {
  it("emits the header row and one row per substation with the expected columns", () => {
    const csv = substationsToCsv([ss({ id: "s-1", name: "ALPHA" })]);
    const [header, row] = csv.split("\r\n");
    expect(header.split(",")).toEqual([
      "id", "name", "full_name", "ss_code", "voltage_kv", "circle", "zone", "division",
      "connected_lines", "longitude", "latitude",
    ]);
    expect(row.startsWith("s-1,ALPHA,")).toBe(true);
    expect(row.endsWith(",3,80.1,16.2")).toBe(true);
  });
});

describe("linesToCsv", () => {
  it("joins multi-valued fields with a pipe separator", () => {
    const csv = linesToCsv([line({ connectsSS: ["s-1", "s-2"], externalEndpoints: [{ name: "RTSS-X", category: "Railway" }] })]);
    const row = csv.split("\r\n")[1];
    expect(row).toContain("s-1 | s-2");
    expect(row).toContain("RTSS-X (Railway)");
  });

  it("renders null length/ckm as empty cells, not 'null'", () => {
    const row = linesToCsv([line({ lengthKm: null, ckm: null })]).split("\r\n")[1];
    expect(row).not.toContain("null");
  });
});

describe("substationsToGeoJSON", () => {
  it("builds Point features at [lng, lat] carrying the record in properties", () => {
    const fc = substationsToGeoJSON([ss({ id: "s-9", lng: 78.5, lat: 14.9 })]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);
    const f = fc.features[0];
    expect(f.geometry).toEqual({ type: "Point", coordinates: [78.5, 14.9] });
    expect(f.properties?.id).toBe("s-9");
  });
});

describe("subsetFeatures", () => {
  it("keeps only features whose properties.id is in the id set", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "LineString", coordinates: [] }, properties: { id: "l-1" } },
        { type: "Feature", geometry: { type: "LineString", coordinates: [] }, properties: { id: "l-2" } },
      ],
    };
    const out = subsetFeatures(fc, new Set(["l-2"]));
    expect(out.features).toHaveLength(1);
    expect(out.features[0].properties?.id).toBe("l-2");
  });
});
