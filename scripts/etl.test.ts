import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FeatureCollection } from "geojson";
import {
  canonicalizeCircle,
  classifyEnergy,
  classifyFolder,
  cleanPgName,
  cleanSsName,
  cleanValue,
  dedupePlaces,
  detectNameFlags,
  distancePointToPolygons,
  formatMonthYear,
  haversineMeters,
  lineCircuitMultiplier,
  mapLineCircuit,
  normalizeKey,
  normalizeKv,
  normalizeSsVoltage,
  parseDescriptionTable,
  parseEndpointLabels,
  parseMva,
  parsePlacesTsv,
  parseVoltage,
  placeType,
  pointInPolygons,
  round5,
  snapEndpoint,
  type PlaceRow,
} from "./etl-lib.ts";

describe("etl-lib helpers", () => {
  it("rounds coordinates to 5 dp", () => {
    expect(round5(79.223333000008)).toBe(79.22333);
  });

  it("computes haversine distance", () => {
    expect(haversineMeters([0, 0], [0, 1])).toBeCloseTo(111195, -2);
    expect(haversineMeters([80, 15], [80, 15])).toBe(0);
  });

  it("canonicalises circle names (primary token + spelling folding; codes → null)", () => {
    expect(canonicalizeCircle("Anantapur, Kadapa")).toBe("Anantapur"); // composite → primary
    expect(canonicalizeCircle("Kadapa/Ananthapur")).toBe("Kadapa");
    expect(canonicalizeCircle("Ananthapuram")).toBe("Anantapur"); // spelling variant
    expect(canonicalizeCircle("Thirupathi")).toBe("Tirupati");
    expect(canonicalizeCircle("Tirupathi, Tamilnadu")).toBe("Tirupati");
    expect(canonicalizeCircle("Srikalulam")).toBe("Srikakulam");
    expect(canonicalizeCircle("Guntur")).toBe("Guntur");
    expect(canonicalizeCircle("6")).toBeNull(); // bare numeric SS circle code
    expect(canonicalizeCircle(null)).toBeNull();
  });

  it("tests point-in-polygon and point-to-polygon distance (adjacency)", () => {
    const square: [number, number][][] = [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]];
    expect(pointInPolygons([0.5, 0.5], square)).toBe(true);
    expect(pointInPolygons([2, 2], square)).toBe(false);
    expect(distancePointToPolygons([0.5, 0.5], square)).toBe(0); // inside → 0 m
    // ~0.01° east of the edge at the equator ≈ ~1.1 km
    expect(distancePointToPolygons([1.01, 0.5], square)).toBeGreaterThan(900);
    expect(distancePointToPolygons([1.01, 0.5], square)).toBeLessThan(1300);
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

  it("classifies generation energy mix (canonical, case-insensitive)", () => {
    expect(classifyEnergy("Solar")).toBe("Solar");
    expect(classifyEnergy("Hydal")).toBe("Hydro"); // source mis-spelling
    expect(classifyEnergy("Gas")).toBe("Gas");
    expect(classifyEnergy("THERMAL")).toBe("Thermal");
    expect(classifyEnergy("Wind")).toBe("Wind");
    expect(classifyEnergy("<Null>")).toBe("Other");
    expect(classifyEnergy(null)).toBe("Other");
  });

  it("parses plant voltage to the canonical set", () => {
    expect(parseVoltage("132KV")).toBe(132);
    expect(parseVoltage("220 kV")).toBe(220);
    expect(parseVoltage("400KV")).toBe(400);
    expect(parseVoltage("66KV")).toBeNull();
    expect(parseVoltage(null)).toBeNull();
  });

  it("normalises a Gridmap SS voltage string to the canonical set (200 → 220)", () => {
    expect(normalizeSsVoltage("132")).toBe(132);
    expect(normalizeSsVoltage("200")).toBe(220); // source quirk: 220 kV recorded as "200"
    expect(normalizeSsVoltage(200)).toBe(220);
    expect(normalizeSsVoltage("400")).toBe(400);
    expect(normalizeSsVoltage("220")).toBe(220);
    expect(normalizeSsVoltage("66")).toBeNull();
    expect(normalizeSsVoltage(null)).toBeNull();
    expect(normalizeSsVoltage("")).toBeNull();
  });

  it("maps a Gridmap line circuit_ty to the canonical SC|DC", () => {
    expect(mapLineCircuit("SC")).toBe("SC");
    expect(mapLineCircuit("DC")).toBe("DC");
    expect(mapLineCircuit("DC/SC")).toBe("DC");
    expect(mapLineCircuit("MC")).toBe("DC");
    expect(mapLineCircuit(null)).toBe("SC"); // null → single circuit
    expect(mapLineCircuit("")).toBe("SC");
    expect(mapLineCircuit("weird")).toBe("SC");
  });

  it("computes the per-circuit-aware circuit-km multiplier", () => {
    expect(lineCircuitMultiplier("SC")).toBe(1);
    expect(lineCircuitMultiplier("DC")).toBe(2);
    expect(lineCircuitMultiplier("DC/SC")).toBe(2);
    expect(lineCircuitMultiplier("MC")).toBe(2);
    expect(lineCircuitMultiplier(null)).toBe(1);
    expect(lineCircuitMultiplier("")).toBe(1);
  });

  it("formats a commissioning date as Mon YYYY (1899/pre-1950 sentinel → null)", () => {
    expect(formatMonthYear(new Date("2006-02-15T18:30:00.000Z"))).toBe("Feb 2006");
    expect(formatMonthYear("2016-07-14T18:30:00.000Z")).toBe("Jul 2016");
    expect(formatMonthYear("1899-11-29T18:38:50.000Z")).toBeNull(); // sentinel
    expect(formatMonthYear(null)).toBeNull();
    expect(formatMonthYear("not-a-date")).toBeNull();
  });

  it("cleans a Gridmap SS name (strips voltage prefix, SS/SWS tokens)", () => {
    expect(cleanSsName("132KV CHIGURUKOTA SS")).toBe("CHIGURUKOTA");
    expect(cleanSsName("220KV MARKAPUR SS")).toBe("MARKAPUR");
    expect(cleanSsName("400/220/11 KV Guddigudem SS")).toBe("Guddigudem");
    expect(cleanSsName("22OKV SIMHACHALAM  SS")).toBe("SIMHACHALAM"); // letter-O typo prefix
    expect(cleanSsName("132KV SS KORTURU")).toBe("KORTURU"); // SS before the name
    expect(cleanSsName("220KV Inaparajupalli SWS")).toBe("Inaparajupalli");
    expect(cleanSsName("132KVSWS GUDIPADU")).toBe("GUDIPADU");
    expect(cleanSsName(null)).toBeNull();
  });

  it("snaps an endpoint to the nearest point within threshold", () => {
    const pts = [{ id: "a", lng: 80, lat: 15 }, { id: "b", lng: 81, lat: 16 }];
    const near = snapEndpoint([80.0009, 15.0], pts, 500);
    expect(near?.ssId).toBe("a");
    expect(near?.confidence).toBe("high");
    expect(snapEndpoint([82, 18], pts, 500)).toBeNull();
  });

  it("cleans PowerGrid names (collapse whitespace; placeholder/null → null)", () => {
    expect(cleanPgName("  Palasa   765KV  SS ")).toBe("Palasa 765KV SS");
    expect(cleanPgName("<Null>")).toBeNull();
    expect(cleanPgName("")).toBeNull();
    expect(cleanPgName(null)).toBeNull();
  });

  it("normalises a PowerGrid voltage cell (number or string) to integer kV", () => {
    expect(normalizeKv(765)).toBe(765);
    expect(normalizeKv(400)).toBe(400);
    expect(normalizeKv("765KV")).toBe(765);
    expect(normalizeKv("400 kV")).toBe(400);
    expect(normalizeKv(220.0)).toBe(220);
    expect(normalizeKv("")).toBeNull();
    expect(normalizeKv(null)).toBeNull();
  });

  it("parses a capacity (MVA) cell to a finite number, placeholder/null → null", () => {
    expect(parseMva(6)).toBe(6);
    expect(parseMva(38)).toBe(38);
    expect(parseMva("12.5")).toBe(12.5);
    expect(parseMva("<Null>")).toBeNull();
    expect(parseMva("")).toBeNull();
    expect(parseMva(null)).toBeNull();
    expect(parseMva(NaN)).toBeNull();
  });

  it("parses the GeoNames TSV (header + blank/short rows skipped)", () => {
    const tsv = [
      "geonameid\tname\tlat\tlng\tfclass\tfcode\tadmin2\tpopulation",
      "1253102\tVijayawada\t16.50745\t80.6466\tP\tPPL\t749\t1143232",
      "9999999\tNo Coords\tx\ty\tP\tPPL\t749\t0",
      "",
      "1253184\tVetapalem\t15.78042\t80.30905\tP\tPPL\t750\t0",
    ].join("\n");
    const rows = parsePlacesTsv(tsv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: 1253102,
      name: "Vijayawada",
      lat: 16.50745,
      lng: 80.6466,
      fclass: "P",
      fcode: "PPL",
      admin2: "749",
      population: 1143232,
    });
  });

  it("classifies place types (population splits city/town/village)", () => {
    expect(placeType("P", "PPL", 1143232)).toBe("city");
    expect(placeType("P", "PPLA2", 0)).toBe("city"); // district seat
    expect(placeType("P", "PPL", 45000)).toBe("town");
    expect(placeType("P", "PPL", 0)).toBe("village");
    expect(placeType("A", "ADM2", 0)).toBe("district");
    expect(placeType("A", "ADM3", 0)).toBe("mandal");
    expect(placeType("S", "RSTN", 0)).toBe("railway station");
    expect(placeType("S", "TMPL", 0)).toBe("temple");
    expect(placeType("L", "RESF", 0)).toBe("forest");
    expect(placeType("H", "RSV", 0)).toBe("water");
    expect(placeType("T", "MT", 0)).toBe("hill");
  });

  it("dedupes same-name rows within 10 km (keep most populous); far homonyms survive", () => {
    const row = (id: number, name: string, lat: number, lng: number, population: number): PlaceRow => ({
      id, name, lat, lng, fclass: "P", fcode: "PPL", admin2: "749", population,
    });
    const out = dedupePlaces([
      row(1, "Tirupati", 13.6355, 79.4199, 295323),
      row(2, "Tirupati", 13.65, 79.42, 0), // ~1.6 km from the city → collapsed
      row(3, "Tirupati", 17.15, 82.152, 0), // ~480 km away → a real homonym, kept
      row(4, "Other", 15.0, 80.0, 0),
    ]);
    expect(out.map((r) => r.id).sort()).toEqual([1, 3, 4]);
    expect(out.find((r) => r.id === 1)?.population).toBe(295323); // populous row won
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

    expect(ss.features.length).toBe(376); // APTransco SS shapefile (TRANSCO-only)
    expect(lines.features.length).toBe(1190); // Lines 400+220+132 kV shapefiles

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

  const genReady = existsSync(resolve(dir, "generation.geojson"));
  it.skipIf(!genReady)("emits a well-formed generation overlay", () => {
    const gen = read<FeatureCollection>("generation.geojson");
    expect(gen.features.length).toBe(57);

    const ids = gen.features.map((f) => f.properties?.id as string);
    expect(new Set(ids).size).toBe(ids.length); // unique
    for (const id of ids) expect(id.startsWith("g-")).toBe(true); // never bare names

    const ENERGY = ["Solar", "Wind", "Thermal", "Gas", "Hydro", "Other"];
    for (const f of gen.features) {
      expect(f.properties?.kind).toBe("generation");
      expect(ENERGY).toContain(f.properties?.energy);
      expect([400, 220, 132]).toContain(f.properties?.voltage);
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
      expect(lng).toBeGreaterThan(76);
      expect(lng).toBeLessThan(85);
      expect(lat).toBeGreaterThan(12);
      expect(lat).toBeLessThan(20);
    }
  });

  const pgReady =
    existsSync(resolve(dir, "powergrid-lines.geojson")) && existsSync(resolve(dir, "powergrid-ss.geojson"));
  it.skipIf(!pgReady)("emits a well-formed POWERGRID overlay", () => {
    const lines = read<FeatureCollection>("powergrid-lines.geojson");
    const ss = read<FeatureCollection>("powergrid-ss.geojson");

    expect(lines.features.length).toBe(54);
    expect(ss.features.length).toBe(28);

    const lineIds = lines.features.map((f) => f.properties?.id as string);
    const ssIds = ss.features.map((f) => f.properties?.id as string);
    expect(new Set(lineIds).size).toBe(lineIds.length); // unique
    expect(new Set(ssIds).size).toBe(ssIds.length);
    for (const id of lineIds) expect(id.startsWith("pl-")).toBe(true);
    for (const id of ssIds) expect(id.startsWith("ps-")).toBe(true);

    // POWERGRID is the national inter-state grid: lines reach into neighbouring states
    // (e.g. Angul, Odisha at ~lat 20.74 / lng 85.15), so the envelope is slightly wider
    // than the AP-TRANSCO bbox while still being a sane sanity guard.
    const inBox = (lng: number, lat: number) => {
      expect(lng).toBeGreaterThan(76);
      expect(lng).toBeLessThan(86);
      expect(lat).toBeGreaterThan(12);
      expect(lat).toBeLessThan(21);
    };

    for (const f of lines.features) {
      expect(f.properties?.kind).toBe("pg-line");
      expect(typeof f.properties?.voltage).toBe("number");
      const g = f.geometry as GeoJSON.LineString | GeoJSON.MultiLineString;
      const rings = g.type === "MultiLineString" ? g.coordinates : [g.coordinates];
      const verts = rings.reduce((n, r) => n + r.length, 0);
      expect(verts).toBeGreaterThanOrEqual(2);
      for (const ring of rings) for (const [lng, lat] of ring) inBox(lng, lat);
    }

    for (const f of ss.features) {
      expect(f.properties?.kind).toBe("pg-substation");
      expect(typeof f.properties?.voltage).toBe("number");
      expect((f.geometry as GeoJSON.Point).type).toBe("Point");
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
      inBox(lng, lat);
    }
  });

  const railReady = existsSync(resolve(dir, "railway-ss.geojson"));
  it.skipIf(!railReady)("emits a well-formed railway-traction (RTSS) overlay", () => {
    const rs = read<FeatureCollection>("railway-ss.geojson");
    expect(rs.features.length).toBe(62);

    const ids = rs.features.map((f) => f.properties?.id as string);
    expect(new Set(ids).size).toBe(ids.length); // unique
    for (const id of ids) expect(id.startsWith("rs-")).toBe(true);

    for (const f of rs.features) {
      expect(f.properties?.kind).toBe("rail-substation");
      expect(typeof f.properties?.voltage).toBe("number");
      expect((f.geometry as GeoJSON.Point).type).toBe("Point");
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
      expect(lng).toBeGreaterThan(76);
      expect(lng).toBeLessThan(86);
      expect(lat).toBeGreaterThan(12);
      expect(lat).toBeLessThan(21);
    }
  });

  const bulkReady = existsSync(resolve(dir, "bulkload-ss.geojson"));
  it.skipIf(!bulkReady)("emits a well-formed bulk-load / HT-consumer overlay", () => {
    const bs = read<FeatureCollection>("bulkload-ss.geojson");
    expect(bs.features.length).toBe(139);

    const ids = bs.features.map((f) => f.properties?.id as string);
    expect(new Set(ids).size).toBe(ids.length); // unique
    for (const id of ids) expect(id.startsWith("bs-")).toBe(true);

    for (const f of bs.features) {
      expect(f.properties?.kind).toBe("bulk-substation");
      expect(typeof f.properties?.voltage).toBe("number");
      expect((f.geometry as GeoJSON.Point).type).toBe("Point");
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
      expect(lng).toBeGreaterThan(76);
      expect(lng).toBeLessThan(86);
      expect(lat).toBeGreaterThan(12);
      expect(lat).toBeLessThan(21);
    }
  });

  const placesReady = existsSync(resolve(dir, "places.json"));
  it.skipIf(!placesReady)("emits a well-formed place gazetteer", () => {
    type PlacesFile = {
      count: number;
      source: string;
      places: [string, string, string, number, number, number][];
    };
    const f = read<PlacesFile>("places.json");
    expect(f.count).toBeGreaterThan(25_000); // lower-bound gate (33,497 in current data)
    expect(f.count).toBe(f.places.length);
    expect(f.source).toContain("GeoNames");

    for (const [name, type, district, lng, lat, pop] of f.places) {
      expect(name.length).toBeGreaterThan(0);
      expect(typeof type).toBe("string");
      expect(typeof district).toBe("string");
      // AP proper — slightly wider than the grid bbox (GeoNames border villages overhang a bit).
      expect(lng).toBeGreaterThan(76);
      expect(lng).toBeLessThan(85.5);
      expect(lat).toBeGreaterThan(12);
      expect(lat).toBeLessThan(20);
      expect(pop).toBeGreaterThanOrEqual(0);
    }

    // Known anchors: the biggest city and a district must both resolve.
    const vij = f.places.find((p) => p[0] === "Vijayawada");
    expect(vij?.[1]).toBe("city");
    expect(f.places.some((p) => p[0] === "Kurnool" && p[1] === "district")).toBe(true);
  });
});
