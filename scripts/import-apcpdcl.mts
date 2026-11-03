/**
 * One-off import of APCPDCL's 33 kV feeder network from its own GIS export (shapefile), which is NOT on
 * the open AP-TRANSCO GIS (APCPDCL's folder there is token-protected), so `npm run sync:live` can't
 * refresh it. Re-run when APCPDCL supplies a newer export:
 *
 *   npx tsx scripts/import-apcpdcl.mts [path/to/apcpdcl_gis]   (default: the arnab-cyclone-tracker copy)
 *   npm run build:data
 *
 * Publishes ONLY route geometry + feeder name, source EHT SS, circle/division/sub-division, conductor,
 * pole count and length. HT-consumer services, AB switches and individual poles are deliberately left out.
 */
import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { open as openShapefile } from "shapefile";

const dir = resolve(process.argv[2] ?? `${homedir()}/Documents/arnab-cyclone-tracker/data/raw/discom/apcpdcl_gis`);
const shp = `${dir}/33kV_Feeders_Merged.shp`;
if (!existsSync(shp)) {
  console.error(`[apcpdcl] not found: ${shp}`);
  process.exit(1);
}

const keep = ["FEEDER", "SUBSTN", "CIRCLE", "DIVISION", "SUBDIV", "COND_SIZE", "N_POLES", "TOTAL_KM"] as const;
const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
const round = (c: unknown): unknown => (Array.isArray(c) && typeof c[0] === "number" ? [r5(c[0] as number), r5(c[1] as number)] : (c as unknown[]).map(round));

const src = await openShapefile(shp, `${dir}/33kV_Feeders_Merged.dbf`);
const features: unknown[] = [];
for (let r = await src.read(); !r.done; r = await src.read()) {
  const g = r.value.geometry as GeoJSON.LineString | GeoJSON.MultiLineString | null;
  if (!g) continue;
  const p = r.value.properties as Record<string, unknown>;
  const props = Object.fromEntries(keep.map((k) => [k.toLowerCase(), p[k] ?? null]));
  features.push({ type: "Feature", geometry: { type: g.type, coordinates: round(g.coordinates) }, properties: props });
}

const out = resolve("data/raw/discom/apcpdcl-33kv-feeders.geojson");
mkdirSync(resolve("data/raw/discom"), { recursive: true });
const vintage = statSync(shp).mtime.toISOString().slice(0, 10);
writeFileSync(
  out,
  `{"type":"FeatureCollection","source":"APCPDCL 33 kV GIS export","vintage":"${vintage}","features":[\n${features.map((f) => JSON.stringify(f)).join(",\n")}\n]}\n`,
);
console.log(`[apcpdcl] wrote ${features.length} feeders → ${out} (export dated ${vintage})`);
