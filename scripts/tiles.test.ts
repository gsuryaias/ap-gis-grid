// Vector-tile build helpers (scripts/build-tiles.mts) + the shared tile contract (src/overlays/tiles-core.ts).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FeatureCollection } from "geojson";
import { boundsOf, REF_TILE_MIN_BYTES, shardFeatures, tileInput, tileLayers, tippecanoeArgs } from "./build-tiles.mts";
import { fnv1a, rowsPath, shardOf, tilePath, type TileIndex } from "../src/overlays/tiles-core.ts";
import { DISCOM11_DEF, DISCOM_DEFS, TOWER_DEFS } from "../src/overlays/catalog.ts";

const fc = (features: FeatureCollection["features"]): FeatureCollection => ({ type: "FeatureCollection", features });
const line = (id: string, coords: number[][], extra: Record<string, unknown> = {}) => ({
  type: "Feature" as const,
  geometry: { type: "LineString" as const, coordinates: coords },
  properties: { id, discom: "APEPDCL", name: `F ${id}`, lengthKm: 2, ...extra },
});

describe("tile contract", () => {
  it("shards are stable and spread", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(shardOf("f11-ep-01111101", 64)).toBe(shardOf("f11-ep-01111101", 64));
    expect(shardOf("x", 0)).toBe(0);
    const counts = new Array(16).fill(0);
    for (let i = 0; i < 4000; i++) counts[shardOf(`f11-ep-${i}`, 16)]++;
    expect(Math.min(...counts)).toBeGreaterThan(150); // ≈ 250 each
  });

  it("tile and sidecar paths carry the content version", () => {
    expect(tilePath("discom-ss", { v: "ab12" })).toBe("tiles/discom-ss/{z}/{x}/{y}.pbf?v=ab12");
    expect(rowsPath("discom-ss", 3, { v: "ab12" })).toBe("tiles/discom-ss/rows/3.json?v=ab12");
  });
});

describe("build-tiles helpers", () => {
  const src = fc([line("a", [[80, 15], [80.5, 15.2]], { poles: 9 }), line("b", [[81, 16], [81.2, 16.4]], { name: "" })]);

  it("tile input keeps only the cartography + pick fields (and index ids where refs are indexes)", () => {
    const t = tileInput(src, { keep: ["id", "discom", "name"] });
    expect(t.features[0]).toEqual({ type: "Feature", geometry: src.features[0].geometry, properties: { id: "a", discom: "APEPDCL", name: "F a" } });
    expect(t.features[1].properties).toEqual({ id: "b", discom: "APEPDCL" }); // empty strings dropped
    expect(t.features[1].id).toBeUndefined();
    expect(tileInput(src, { keep: ["name"], mvtId: "index" }).features.map((f) => f.id)).toEqual([0, 1]);
  });

  it("sidecar shards hold the full features, each in the shard its id hashes to", () => {
    const shards = shardFeatures(src, 4);
    expect(shards).toHaveLength(4);
    expect(shards.flatMap((s) => s.features)).toHaveLength(2);
    expect(shards[shardOf("a", 4)].features).toContainEqual(src.features[0]);
  });

  it("bounds are padded and rounded", () => {
    expect(boundsOf(src)).toEqual([79.99, 14.99, 81.21, 16.41]);
    expect(boundsOf(fc([]))).toEqual([-180, -85, 180, 85]);
  });

  it("tippecanoe runs uncompressed, densest-dropping, into the layer's own source-layer", () => {
    const [l11] = tileLayers([]);
    const args = tippecanoeArgs(l11, "in.geojson", "public/tiles/discom-11kv-lines");
    expect(args).toEqual(expect.arrayContaining(["--no-tile-compression", "--drop-densest-as-needed", "-l", "discom-11kv-lines"]));
    expect(args.at(-1)).toBe("in.geojson");
  });

  it("tiles every heavy overlay, with tiles from (at most) the style's own minzoom", () => {
    const ref = [
      { id: "mandals", file: "ref/mandals.geojson", geometry: "polygon", labelField: "name", bytes: 1_900_000 },
      { id: "airports", file: "ref/airports.geojson", geometry: "point", labelField: "name", bytes: 4_000 },
    ];
    const layers = tileLayers(ref);
    const ids = layers.map((l) => l.id);
    expect(ids[0]).toBe("discom-11kv-lines");
    for (const d of [DISCOM11_DEF, ...DISCOM_DEFS, ...TOWER_DEFS]) {
      const l = layers.find((x) => x.id === d.id)!;
      expect(l, d.id).toBeDefined();
      expect(l.minzoom, d.id).toBeLessThanOrEqual(d.style.minzoom ?? 0);
      // The tiles carry what the style filters / labels / picks on.
      if (d.style.color === "discom") expect(l.keep).toContain("discom");
      if (d.labelField && d.format !== "towers") expect(l.keep).toContain(d.labelField);
      expect(l.shards > 0 || l.mvtId === "index", d.id).toBe(true);
    }
    expect(layers.find((l) => l.id === "towers-132kv")!.keep).toEqual(["i", "no", "cp"]);
    expect(ids).toContain("mandals");
    expect(ids).not.toContain("airports"); // < REF_TILE_MIN_BYTES — its GeoJSON is cheaper
    expect(4_000).toBeLessThan(REF_TILE_MIN_BYTES);
  });
});

// When tiles have been built (CI / Docker), the index must agree with the data it was built from.
const INDEX = new URL("../public/tiles/index.json", import.meta.url);
describe.runIf(existsSync(INDEX))("built tiles", () => {
  const index = JSON.parse(readFileSync(INDEX, "utf8")) as TileIndex;
  it("every tiled DISCOM layer has its sidecar shards and the right count", () => {
    for (const id of ["discom-11kv-lines", "discom-lines", "discom-ss"]) {
      const info = index.layers[id];
      if (!info) continue;
      const data = JSON.parse(readFileSync(new URL(`../public/data/${id}.geojson`, import.meta.url), "utf8")) as FeatureCollection;
      expect(info.count, id).toBe(data.features.length);
      expect(info.shards, id).toBeGreaterThan(0);
      for (let k = 0; k < info.shards; k++) expect(existsSync(new URL(`../public/tiles/${id}/rows/${k}.json`, import.meta.url)), `${id} shard ${k}`).toBe(true);
    }
  });
});
