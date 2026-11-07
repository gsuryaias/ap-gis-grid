// Where the raw layers come from (Atlas 2.0 phase 4 split of build-data.mts): the live REST pulls in
// data/raw/live/ when present, else the committed Gridmap shapefile snapshots (ETL_SNAPSHOT_ONLY=1 forces them).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { open as openShapefile } from "shapefile";

/** Read every feature of a shapefile into memory (small layers — fine to buffer). */
export async function readShapefile(
  shp: string,
  dbf: string,
): Promise<Array<{ geometry: GeoJSON.Geometry | null; properties: Record<string, unknown> }>> {
  const src = await openShapefile(shp, dbf);
  const out: Array<{ geometry: GeoJSON.Geometry | null; properties: Record<string, unknown> }> = [];
  for (let r = await src.read(); !r.done; r = await src.read()) {
    out.push({
      geometry: r.value.geometry as GeoJSON.Geometry | null,
      properties: (r.value.properties ?? {}) as Record<string, unknown>,
    });
  }
  await src.cancel();
  return out;
}

export type RawFeat = { geometry: GeoJSON.Geometry | null; properties: Record<string, unknown> };

/** Where each layer was read from this run (reported in live-status.json + data-quality.json). */
export const layerSources: Record<string, "live" | "snapshot"> = {};

export const LIVE_DIR = resolve("data/raw/live");

export const SNAPSHOT_DIR = resolve("data/raw/gridmap");

/**
 * Read a network layer: the live pull (data/raw/live/<name>.geojson, written by `npm run sync:live`
 * from the AP-TRANSCO enterprise GIS) when present, else the committed shapefile snapshot
 * (data/raw/gridmap/<name>.shp). Live attribute keys are pre-truncated to the shapefile's 10-char
 * dBASE names by the sync, so both paths feed the ETL identical property keys.
 */
export async function readLayer(name: string): Promise<RawFeat[]> {
  const live = resolve(LIVE_DIR, `${name}.geojson`);
  if (existsSync(live) && process.env.ETL_SNAPSHOT_ONLY !== "1") {
    const fc = JSON.parse(readFileSync(live, "utf-8")) as { features: RawFeat[] };
    layerSources[name] = "live";
    console.log(`[etl] reading ${name} (live: ${fc.features.length} features)`);
    return fc.features.map((f) => ({ geometry: f.geometry, properties: f.properties ?? {} }));
  }
  layerSources[name] = "snapshot";
  console.log(`[etl] reading ${name} (snapshot shapefile)`);
  return readShapefile(`${SNAPSHOT_DIR}/${name}.shp`, `${SNAPSHOT_DIR}/${name}.dbf`);
}
