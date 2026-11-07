/**
 * AP-TRANSCO ETL — raw sources → public/data/* (core grid, overlays, distribution network, search tiers,
 * live-status). `npm run build:data`.
 *
 * Orchestration only (Atlas 2.0 phase 4 split): the domains live in
 *   etl-core.ts          shared readers / geometry helpers + the core grid (substations, lines, meta, quality)
 *   etl-towers.ts        transmission towers (+ the per-line summary folded into lines.geojson)
 *   etl-overlays.ts      generation + POWERGRID / railway / bulk-load overlays
 *   etl-distribution.ts  DISCOM 33 kV overlay + connectivity, DISCOM 11 kV network + DTR search tier
 *   etl-places.ts        the GeoNames place gazetteer
 * with pure, unit-tested helpers in etl-lib / etl-discom / etl-connectivity / etl-network / towers-lib.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCore } from "./etl-core.ts";
import { buildDiscom, buildNetwork } from "./etl-distribution.ts";
import { buildGeneration, buildPowerGrid } from "./etl-overlays.ts";
import { buildPlaces } from "./etl-places.ts";
import { LIVE_DIR, layerSources } from "./etl-sources.ts";

/**
 * public/data/live-status.json — what the app shows in the "Live network" badge / change log:
 * the sync manifest (per-layer status, counts, last fetch/change) + the most recent change entries.
 */
function writeLiveStatus(outDir: string, extra: Record<string, unknown>): void {
  const manifestPath = resolve(LIVE_DIR, "manifest.json");
  const changelogPath = resolve(LIVE_DIR, "changelog.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf-8")) : null;
  const changelog = existsSync(changelogPath) ? (JSON.parse(readFileSync(changelogPath, "utf-8")) as unknown[]) : [];
  const status = {
    generatedAt: new Date().toISOString(),
    source: manifest?.source ?? null,
    lastRun: manifest?.lastRun ?? null,
    lastSuccess: manifest?.lastSuccess ?? null,
    layers: manifest?.layers ?? {},
    layerSources,
    changes: changelog.slice(0, 40),
    ...extra,
  };
  writeFileSync(resolve(outDir, "live-status.json"), JSON.stringify(status, null, 2));
}

async function main(): Promise<void> {
  const outDir = resolve("public/data");
  mkdirSync(outDir, { recursive: true });

  // ---- Core TRANSCO grid (substations, lines, search index, meta, data quality, towers) ----
  const { substations, footprintSource, towers } = await buildCore(outDir);

  // ---- Generation overlay (separate, lazy-loaded layer) --------------------
  await buildGeneration(outDir);

  // ---- POWERGRID (PGCIL) national grid overlay (separate, lazy-loaded) -----
  await buildPowerGrid(outDir);

  // ---- DISCOM 33 kV sub-transmission overlay (separate, lazy-loaded) -------
  const { stats: discom, connectivity } = await buildDiscom(outDir, substations);

  // ---- DISCOM 11 kV network + network search tier (separate, lazy-loaded) --
  const network = buildNetwork(outDir, substations);

  // ---- Place-search gazetteer (separate, lazy-loaded by the search box) ----
  buildPlaces(outDir);

  writeLiveStatus(outDir, { discom, footprintSource, connectivity, towers, network });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });

export { main };
