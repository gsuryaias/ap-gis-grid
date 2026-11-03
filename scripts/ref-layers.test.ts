/**
 * Integrity checks for the committed RTGS reference layers (public/data/ref/*), emitted by
 * scripts/build-ref-layers.mts (a run-locally-then-commit build — CI only verifies the outputs).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FeatureCollection, Geometry, Position } from "geojson";
import { describe, expect, it } from "vitest";

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const CATALOG = join(DATA_DIR, "ref", "catalog.json");
const BBOX = { minLng: 76, maxLng: 85.5, minLat: 12, maxLat: 20 };
const MAX_BYTES = 5 * 1024 * 1024;
const GROUPS = ["Boundaries", "Transport", "Environment", "Water", "Hazards"];
const KIND_TYPES: Record<string, string[]> = {
  polygon: ["Polygon", "MultiPolygon"],
  line: ["LineString", "MultiLineString"],
  point: ["Point", "MultiPoint"],
};
const KEYS = [
  "id", "group", "label", "geometry", "file", "count", "bytes",
  "labelField", "fields", "source", "vintage", "note",
].sort();

interface CatalogEntry {
  id: string;
  group: string;
  label: string;
  geometry: string;
  file: string;
  count: number;
  bytes: number;
  labelField: string | null;
  fields: string[];
  source: string;
  vintage: string | null;
  note: string | null;
}

function positions(g: Geometry): Position[] {
  switch (g.type) {
    case "Point": return [g.coordinates];
    case "MultiPoint": case "LineString": return g.coordinates;
    case "MultiLineString": case "Polygon": return g.coordinates.flat();
    case "MultiPolygon": return g.coordinates.flat(2);
    case "GeometryCollection": return g.geometries.flatMap(positions);
  }
}

const catalog: CatalogEntry[] = JSON.parse(readFileSync(CATALOG, "utf8"));

describe("ref-layer catalog", () => {
  it("is a non-empty array of well-formed, unique entries", () => {
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.length).toBeGreaterThan(0);
    expect(new Set(catalog.map((c) => c.id)).size).toBe(catalog.length);
    for (const c of catalog) {
      expect(Object.keys(c).sort()).toEqual(KEYS);
      expect(GROUPS).toContain(c.group);
      expect(Object.keys(KIND_TYPES)).toContain(c.geometry);
      expect(c.file).toBe(`ref/${c.id}.geojson`);
      expect(c.labelField === null || c.labelField === "name").toBe(true);
      expect(c.fields).toContain("name");
      expect(c.source).toMatch(/^RTGS GIS library — /);
    }
  });
});

describe.each(catalog.map((c) => [c.id, c] as const))("ref layer %s", (_id, c) => {
  const path = join(DATA_DIR, c.file);

  it("exists, ≤ 5 MB, and matches the catalogued byte size", () => {
    expect(existsSync(path)).toBe(true);
    const size = statSync(path).size;
    expect(size).toBe(c.bytes);
    expect(size).toBeLessThanOrEqual(MAX_BYTES);
  });

  it("is a valid FeatureCollection matching count, kind, fields and the AP bbox", () => {
    const fc = JSON.parse(readFileSync(path, "utf8")) as FeatureCollection;
    expect(fc.type).toBe("FeatureCollection");
    expect(Array.isArray(fc.features)).toBe(true);
    expect(fc.features.length).toBe(c.count);
    expect(c.count).toBeGreaterThan(0);

    const allowed = KIND_TYPES[c.geometry];
    let named = 0;
    for (const f of fc.features) {
      expect(f.type).toBe("Feature");
      expect(f.geometry).toBeTruthy();
      expect(allowed).toContain(f.geometry.type);
      expect(Object.keys(f.properties ?? {})).toEqual(c.fields);
      if (f.properties?.name != null) named++;
      const pts = positions(f.geometry);
      expect(pts.length).toBeGreaterThan(0);
      for (const [x, y] of pts) {
        if (!(x >= BBOX.minLng && x <= BBOX.maxLng && y >= BBOX.minLat && y <= BBOX.maxLat)) {
          throw new Error(`${c.id}: coordinate [${x}, ${y}] outside AP bbox`);
        }
      }
    }
    expect(c.labelField === "name").toBe(named > 0);
  });
});
