/**
 * Static vector-tile directories for the heavy display layers (Atlas 2.0 phase 4).
 *
 *   npm run build:tiles            # every tiled layer (skips layers whose input is unchanged)
 *   npm run build:tiles -- --force # rebuild everything
 *   npm run build:tiles -- --require   # CI: fail when tippecanoe is unavailable
 *   npx tsx scripts/build-tiles.mts discom-11kv-lines towers-132kv   # a subset
 *
 * Reads the GeoJSON / towers JSON that `build:data` (and `build:ref`) already emit in public/data and
 * writes `public/tiles/` (git-ignored): `<layer>/{z}/{x}/{y}.pbf` (uncompressed MVT — GitHub Pages
 * compresses on the wire; a gzip-inside-pbf tile would be double-encoded), attribute sidecars
 * `<layer>/rows/<shard>.json` for id-keyed layers, and `index.json` (the app's switch: a layer listed
 * there is drawn from tiles, anything else falls back to its GeoJSON — so dev without tiles works).
 *
 * tippecanoe runs natively when on PATH (CI installs it with apt), else inside a project-local Docker
 * image (`apgg-tippecanoe`, Ubuntu 24.04 + apt tippecanoe 2.49) — never installed globally.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { decodeTowers, type WebTowersFile } from "../src/overlays/towers.ts";
import { shardOf, type TileIndex, type TileInfo } from "../src/overlays/tiles-core.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "public/data");
const OUT = join(ROOT, "public/tiles");
const TMP = join(ROOT, "node_modules/.cache/apgg-tiles");
const IMAGE = "apgg-tippecanoe:2.49";

export interface TileLayer {
  id: string;
  /** Source file under public/data. */
  file: string;
  format?: "towers";
  /** Properties kept in the tiles (the cartography + tap pick); the rest stay in the sidecar / JSON. */
  keep: string[];
  minzoom: number;
  maxzoom: number;
  /** Attribute-sidecar shards (id-keyed layers); 0 = none (towers / RTGS read their own JSON). */
  shards: number;
  /** Feature id → MVT id: "index" for layers whose refs are feature indexes (towers, RTGS). */
  mvtId?: "index";
  extra?: string[];
}

const DISCOM_KEEP = ["id", "discom", "name"];

/** RTGS layers smaller than this stay GeoJSON. */
export const REF_TILE_MIN_BYTES = 300_000;

/**
 * Tiled layers, in build order (11 kV first — the biggest win). Max zooms stay low on purpose:
 * MapLibre over-zooms the last level, and z12 already resolves ≈ 2.4 m (4096 units / tile), z10 ≈ 10 m
 * — while every extra level roughly quadruples the file count GitHub Pages has to host.
 */
export function tileLayers(refCatalog: Array<{ id: string; file: string; geometry: string; labelField: string | null; bytes: number }>): TileLayer[] {
  return [
    { id: "discom-11kv-lines", file: "discom-11kv-lines.geojson", keep: DISCOM_KEEP, minzoom: 10, maxzoom: 12, shards: 128 },
    ...[400, 220, 132].map(
      (kv): TileLayer => ({
        id: `towers-${kv}kv`,
        file: `towers-${kv}kv.json`,
        format: "towers",
        keep: ["i", "no", "cp"],
        minzoom: kv === 400 ? 8 : 9,
        maxzoom: 12,
        shards: 0,
        mvtId: "index",
        // Every tower is drawn from its minzoom (the cartography thins nothing) — they're tiny points.
        extra: ["-r1", "--no-feature-limit"],
      }),
    ),
    { id: "discom-lines", file: "discom-lines.geojson", keep: DISCOM_KEEP, minzoom: 5, maxzoom: 11, shards: 16 },
    { id: "discom-ss", file: "discom-ss.geojson", keep: DISCOM_KEEP, minzoom: 5, maxzoom: 10, shards: 8, extra: ["-r1"] },
    // RTGS layers: only the heavy ones — a few-KB GeoJSON is cheaper than a tile pyramid.
    ...refCatalog
      .filter((e) => e.bytes >= REF_TILE_MIN_BYTES)
      .map(
      (e): TileLayer => ({
        id: e.id,
        file: e.file,
        keep: [...new Set(["name", ...(e.labelField ? [e.labelField] : [])])],
        minzoom: 4,
        maxzoom: 10,
        shards: 0,
        mvtId: "index",
        extra: e.geometry === "point" ? ["-r1"] : e.geometry === "polygon" ? ["--no-tiny-polygon-reduction"] : [],
      }),
    ),
  ];
}

// ---- pure helpers (unit-tested) ----------------------------------------------------------------

function eachPosition(g: Geometry, fn: (p: Position) => void): void {
  switch (g.type) {
    case "Point":
      return fn(g.coordinates);
    case "MultiPoint":
    case "LineString":
      return g.coordinates.forEach(fn);
    case "MultiLineString":
    case "Polygon":
      return g.coordinates.forEach((r) => r.forEach(fn));
    case "MultiPolygon":
      return g.coordinates.forEach((p) => p.forEach((r) => r.forEach(fn)));
    case "GeometryCollection":
      return g.geometries.forEach((x) => eachPosition(x, fn));
  }
}

/** [w, s, e, n] of a collection, padded a little so edge features aren't clipped by `bounds`. */
export function boundsOf(fc: FeatureCollection, pad = 0.01): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const f of fc.features) {
    if (!f.geometry) continue;
    eachPosition(f.geometry, ([x, y]) => {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    });
  }
  if (!Number.isFinite(w)) return [-180, -85, 180, 85];
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  return [r(w - pad), r(s - pad), r(e + pad), r(n + pad)];
}

/** The tile input: only the kept properties; MVT ids are integer feature indexes or dropped. */
export function tileInput(fc: FeatureCollection, layer: Pick<TileLayer, "keep" | "mvtId">): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: fc.features.map((f, i): Feature => {
      const p = f.properties ?? {};
      const props: Record<string, unknown> = {};
      for (const k of layer.keep) if (p[k] != null && p[k] !== "") props[k] = p[k];
      return { type: "Feature", ...(layer.mvtId === "index" ? { id: i } : {}), geometry: f.geometry, properties: props };
    }),
  };
}

/** Full features grouped into `shards` sidecar collections by `shardOf(properties.id)`. */
export function shardFeatures(fc: FeatureCollection, shards: number): FeatureCollection[] {
  const out: FeatureCollection[] = Array.from({ length: shards }, () => ({ type: "FeatureCollection", features: [] }));
  for (const f of fc.features) {
    const id = f.properties?.id;
    if (typeof id !== "string") continue;
    out[shardOf(id, shards)].features.push(f);
  }
  return out;
}

export function tippecanoeArgs(layer: TileLayer, input: string, outDir: string): string[] {
  return [
    "-e", outDir,
    "-l", layer.id,
    "-Z", String(layer.minzoom),
    "-z", String(layer.maxzoom),
    "--no-tile-compression",
    "--drop-densest-as-needed",
    "--force",
    "--quiet",
    ...(layer.extra ?? []),
    input,
  ];
}

// ---- runner ------------------------------------------------------------------------------------

type Runner = (args: string[]) => void;

function has(cmd: string, args: string[]): boolean {
  return spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
}

/** tippecanoe natively, else in Docker (image built once from Ubuntu's apt package), else null. */
function findRunner(): Runner | null {
  if (has("tippecanoe", ["--version"])) {
    return (args) => {
      const r = spawnSync("tippecanoe", args, { stdio: "inherit", cwd: ROOT });
      if (r.status !== 0) throw new Error(`tippecanoe exited ${r.status}`);
    };
  }
  if (!has("docker", ["info"])) return null;
  if (!has("docker", ["image", "inspect", IMAGE])) {
    console.log(`  building the ${IMAGE} Docker image (once)…`);
    const dockerfile = "FROM ubuntu:24.04\nRUN apt-get update && apt-get install -y --no-install-recommends tippecanoe && rm -rf /var/lib/apt/lists/*\n";
    const r = spawnSync("docker", ["build", "-t", IMAGE, "-"], { input: dockerfile, stdio: ["pipe", "inherit", "inherit"] });
    if (r.status !== 0) return null;
  }
  const user = typeof process.getuid === "function" ? ["--user", `${process.getuid()}:${process.getgid!()}`] : [];
  return (args) => {
    // Paths are passed relative to ROOT, which is mounted at /w.
    const r = spawnSync("docker", ["run", "--rm", ...user, "-v", `${ROOT}:/w`, "-w", "/w", IMAGE, "tippecanoe", ...args], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`tippecanoe (docker) exited ${r.status}`);
  };
}

function readIndex(): TileIndex {
  try {
    return JSON.parse(readFileSync(join(OUT, "index.json"), "utf8")) as TileIndex;
  } catch {
    return { generatedAt: "", layers: {} };
  }
}

function dirBytes(dir: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const d = dirBytes(p);
      files += d.files;
      bytes += d.bytes;
    } else {
      files++;
      bytes += statSync(p).size;
    }
  }
  return { files, bytes };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const required = argv.includes("--require");
  const only = argv.filter((a) => !a.startsWith("--"));

  const run = findRunner();
  if (!run) {
    const msg = "tippecanoe not found (neither on PATH nor via Docker) — no tiles built; the app falls back to GeoJSON.";
    if (required) throw new Error(msg);
    console.warn(`build:tiles: ${msg}`);
    return;
  }

  const catalogPath = join(DATA, "ref/catalog.json");
  const catalog = existsSync(catalogPath) ? JSON.parse(readFileSync(catalogPath, "utf8")) : [];
  const layers = tileLayers(catalog).filter((l) => !only.length || only.includes(l.id));
  const index = readIndex();
  mkdirSync(OUT, { recursive: true });
  mkdirSync(TMP, { recursive: true });

  for (const layer of layers) {
    const src = join(DATA, layer.file);
    if (!existsSync(src)) {
      console.warn(`  ${layer.id}: ${layer.file} missing — skipped`);
      delete index.layers[layer.id];
      continue;
    }
    const raw = readFileSync(src);
    const v = createHash("sha1").update(raw).update(JSON.stringify(layer)).digest("hex").slice(0, 10);
    const dir = join(OUT, layer.id);
    if (!force && index.layers[layer.id]?.v === v && existsSync(dir)) {
      console.log(`  ${layer.id}: unchanged`);
      continue;
    }
    const t0 = Date.now();
    const json = JSON.parse(raw.toString("utf8"));
    const fc: FeatureCollection = layer.format === "towers" ? decodeTowers(layer.id, json as WebTowersFile) : (json as FeatureCollection);

    const input = join(TMP, `${layer.id}.geojson`);
    writeFileSync(input, JSON.stringify(tileInput(fc, layer)));
    rmSync(dir, { recursive: true, force: true });
    run(tippecanoeArgs(layer, relative(ROOT, input), relative(ROOT, dir)));
    rmSync(join(dir, "metadata.json"), { force: true });

    if (layer.shards > 0) {
      mkdirSync(join(dir, "rows"), { recursive: true });
      shardFeatures(fc, layer.shards).forEach((s, k) => writeFileSync(join(dir, "rows", `${k}.json`), JSON.stringify(s)));
    }
    const info: TileInfo = { minzoom: layer.minzoom, maxzoom: layer.maxzoom, bounds: boundsOf(fc), count: fc.features.length, v, shards: layer.shards };
    index.layers[layer.id] = info;
    const { files, bytes } = dirBytes(dir);
    console.log(`  ${layer.id}: ${fc.features.length.toLocaleString()} features → ${files.toLocaleString()} files, ${(bytes / 1e6).toFixed(1)} MB (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }

  // Drop index entries whose directory is gone (a layer removed from the catalogue).
  for (const id of Object.keys(index.layers)) if (!existsSync(join(OUT, id))) delete index.layers[id];
  index.generatedAt = new Date().toISOString();
  writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 1) + "\n");
  const total = dirBytes(OUT);
  console.log(`build:tiles: ${Object.keys(index.layers).length} layers, ${total.files.toLocaleString()} files, ${(total.bytes / 1e6).toFixed(1)} MB`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
