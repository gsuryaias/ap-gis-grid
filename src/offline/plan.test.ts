// Field offline pack planning (Atlas 2.0 phase 4 PR 14).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FeatureCollection } from "geojson";
import { circleBBox, glyphUrls, intersect, packPlan, PACK_LAYERS, styleExtras, tileOf, tilesIn, type BBox } from "./plan.ts";
import { tileKey, type TileIndex, type TileList } from "../overlays/tiles-core.ts";
import { route } from "../sw/policy.ts";
import { DISCOM11_DEF, DISCOM_DEFS, TOWER_DEFS } from "../overlays/catalog.ts";

const read = <T,>(p: string) => JSON.parse(readFileSync(new URL(`../../public/${p}`, import.meta.url), "utf8")) as T;

describe("tile maths", () => {
  it("finds the slippy tile of a point", () => {
    expect(tileOf(0, 0, 1)).toEqual([1, 1]);
    expect(tileOf(-180, 85.05, 3)).toEqual([0, 0]);
    expect(tileOf(80.62, 16.51, 12)).toEqual([2965, 1857]); // Vijayawada
  });

  it("covers a bbox with every tile at a zoom", () => {
    const b: BBox = [80.5, 16.4, 80.7, 16.6];
    const t = tilesIn(b, 12);
    const [x0, y0] = tileOf(80.5, 16.6, 12);
    const [x1, y1] = tileOf(80.7, 16.4, 12);
    expect(t.length).toBe((x1 - x0 + 1) * (y1 - y0 + 1));
    expect(t).toContainEqual(tileOf(80.62, 16.51, 12));
    expect(tilesIn(b, 4)).toEqual([tileOf(80.6, 16.5, 4)]);
  });

  it("intersects boxes", () => {
    expect(intersect([0, 0, 2, 2], [1, 1, 3, 3])).toEqual([1, 1, 2, 2]);
    expect(intersect([0, 0, 1, 1], [2, 2, 3, 3])).toBeNull();
  });
});

describe("pack plan", () => {
  const index: TileIndex = {
    generatedAt: "",
    layers: {
      "discom-11kv-lines": { minzoom: 10, maxzoom: 11, bounds: [80, 16, 81, 17], count: 9, v: "a1", shards: 2 },
      "towers-132kv": { minzoom: 9, maxzoom: 9, bounds: [76, 12, 85, 20], count: 9, v: "t1", shards: 0 },
      mandals: { minzoom: 4, maxzoom: 4, bounds: [76, 12, 85, 20], count: 9, v: "m1", shards: 0 },
    },
  };
  const fileOf = (id: string) =>
    id === "towers-132kv" ? { file: "towers-132kv.json", towers: true } : id === "railways" ? { file: "ref/railways.geojson" } : id === "mandals" ? { file: "ref/mandals.geojson" } : undefined;
  const plan = packPlan({ bbox: [80.5, 16.4, 80.7, 16.6], index, layers: PACK_LAYERS, fileOf, versions: { "data/lines.geojson": "L1", "tiles/index.json": "I1" } });

  it("carries tiles at every zoom the layer has, inside the circle, plus every sidecar shard", () => {
    const l11 = plan.tiles.filter((t) => t.startsWith("tiles/discom-11kv-lines/"));
    expect(l11).toContain("tiles/discom-11kv-lines/rows/0.json?v=a1");
    expect(l11).toContain("tiles/discom-11kv-lines/rows/1.json?v=a1");
    expect(l11.filter((t) => t.includes("/10/"))).toHaveLength(tilesIn([80.5, 16.4, 80.7, 16.6], 10).length);
    expect(l11.some((t) => t.includes("/11/"))).toBe(true);
    expect(l11.some((t) => t.includes("/12/"))).toBe(false); // MapLibre over-zooms z11
    expect(plan.tiles).toContain(`tiles/towers-132kv/9/${tileOf(80.6, 16.5, 9).join("/")}.pbf?v=t1`);
  });

  it("carries the statewide files (versioned), tower files for the Inspector, untiled layers whole", () => {
    expect(plan.files).toContain("data/lines.geojson?v=L1");
    expect(plan.files).toContain("tiles/index.json?v=I1");
    expect(plan.files).toContain("data/live-status.json"); // never versioned
    expect(plan.files).toContain("data/towers-132kv.json");
    expect(plan.files).toContain("data/ref/railways.geojson"); // not tiled → its file
    expect(plan.files).not.toContain("data/ref/mandals.geojson"); // tiled → tiles only
  });

  it("carries the Field layers, 11 kV and offline context", () => {
    for (const id of ["discom-lines", "discom-ss", "towers-400kv", "discom-11kv-lines", "national-highways", "mandals"]) expect(PACK_LAYERS).toContain(id);
  });

  it("requests only the tiles that exist when the layer lists them", () => {
    const [x, y] = tileOf(80.6, 16.5, 9);
    const p = packPlan({ bbox: [80.5, 16.4, 80.7, 16.6], index, layers: ["towers-132kv"], fileOf, versions: {}, lists: { "towers-132kv": { 9: [] } } });
    expect(p.tiles).toEqual([]);
    const q = packPlan({ bbox: [80.5, 16.4, 80.7, 16.6], index, layers: ["towers-132kv"], fileOf, versions: {}, lists: { "towers-132kv": { 9: [tileKey(9, x, y)] } } });
    expect(q.tiles).toEqual([`tiles/towers-132kv/9/${x}/${y}.pbf?v=t1`]);
  });

  it("adds the basemap style, sprites and the label glyphs", () => {
    const x = styleExtras("https://b.example/style.json", { sprite: "https://b.example/sprite", glyphs: "https://b.example/fonts/{fontstack}/{range}.pbf" });
    expect(x).toContain("https://b.example/style.json");
    expect(x).toContain("https://b.example/sprite@2x.png");
    expect(x).toContain("https://b.example/fonts/Open%20Sans%20Bold/0-255.pbf");
    expect(glyphUrls("https://g/{fontstack}/{range}.pbf")).toHaveLength(3);
  });
});

describe("service worker and packs", () => {
  const SCOPE = "https://x.github.io/ap-gis-grid/";
  it("leaves pack downloads to the network (the page stores them)", () => {
    expect(route({ url: `${SCOPE}tiles/discom-ss/9/1/1.pbf?v=1`, method: "GET", pack: true }, SCOPE)).toBeNull();
  });
});

describe("on the real data", () => {
  const ss = read<FeatureCollection>("data/substations.geojson");
  const substations = ss.features.map((f) => f.properties as { circle: string; lng: number; lat: number });
  const circles = read<{ circles: string[] }>("data/meta.json").circles.filter((c) => substations.some((s) => s.circle === c));

  it("every circle with substations has a compact extent inside AP", () => {
    expect(circles.length).toBeGreaterThanOrEqual(13);
    for (const c of circles) {
      const b = circleBBox(substations, c)!;
      expect(b[0], c).toBeGreaterThan(76);
      expect(b[2], c).toBeLessThan(85.5);
      expect(b[2] - b[0], c).toBeLessThan(3);
    }
    expect(circleBBox(substations, "Nowhere")).toBeNull();
  });

  const TILES = new URL("../../public/tiles/index.json", import.meta.url);
  it.runIf(existsSync(TILES))("a circle pack is a couple of thousand existing tiles, every one on disk", () => {
    const index = read<TileIndex>("tiles/index.json");
    const defs = Object.fromEntries([...DISCOM_DEFS, DISCOM11_DEF, ...TOWER_DEFS].map((d) => [d.id, d]));
    const fileOf = (id: string) => (defs[id] ? { file: defs[id].file, towers: defs[id].format === "towers" } : { file: `ref/${id}.geojson` });
    const lists: Record<string, TileList | undefined> = {};
    for (const id of PACK_LAYERS) {
      const f = new URL(`../../public/tiles/${id}/tiles.json`, import.meta.url);
      if (index.layers[id] && existsSync(f)) lists[id] = JSON.parse(readFileSync(f, "utf8")) as TileList;
    }
    for (const c of circles) {
      const p = packPlan({ bbox: circleBBox(substations, c)!, index, layers: PACK_LAYERS, fileOf, versions: {}, lists });
      expect(p.tiles.length, c).toBeLessThan(4000);
      for (const t of p.tiles.slice(0, 200)) expect(existsSync(new URL(`../../public/${t.split("?")[0]}`, import.meta.url)), t).toBe(true);
    }
  });
});
