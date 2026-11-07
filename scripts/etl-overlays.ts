// Generation + POWERGRID / railway / bulk-load overlays (Atlas 2.0 phase 4 split of build-data.mts).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { kmlWithFolders } from "@tmcw/togeojson";
import type { Feature, FeatureCollection, LineString, MultiLineString, Point, Position } from "geojson";
import { ALIASES, classifyEnergy, cleanPgName, ENERGY_TYPES, normalizeKv, parseDescriptionTable, parseMva, parseVoltage, pick, round5, type BulkLoadSubstation, type EnergyType, type GenerationPlant, type PowerGridLine, type PowerGridSubstation, type RailwaySubstation } from "./etl-lib.ts";
import { lineRouteKm, slug, uniqueId } from "./etl-core.ts";
import { LIVE_DIR, type RawFeat, layerSources, readLayer } from "./etl-sources.ts";

export interface TreeNode {
  type: string;
  meta?: { name?: string } & Record<string, unknown>;
  name?: string;
  children?: TreeNode[];
  geometry?: Point | LineString | null;
  properties?: Record<string, unknown> | null;
}

export function getDescriptionHtml(props: Record<string, unknown> | null | undefined): string {
  const d = props?.description;
  if (d == null) return "";
  if (typeof d === "string") return d;
  if (typeof d === "object" && "value" in (d as object)) {
    return String((d as { value?: unknown }).value ?? "");
  }
  return "";
}

/** Collect every Point Feature in a KML tree, ignoring folder structure. */
export function collectPoints(node: TreeNode, out: TreeNode[]): void {
  if (node.type === "Feature") {
    if (node.geometry?.type === "Point") out.push(node);
    return;
  }
  for (const child of node.children ?? []) collectPoints(child, out);
}

/**
 * Build the generation-plant overlay from data/raw/generation.kml.
 * Emitted as its own file (`generation.geojson`) so the app can LAZY-LOAD it — the layer is
 * never part of the initial transmission payload; it's fetched only when the user enables it.
 * Plants carry an energy-mix class (Solar / Wind / Thermal / Gas / Hydro / Other).
 */
export async function buildGeneration(outDir: string): Promise<void> {
  if (existsSync(resolve(LIVE_DIR, "generation-ss.geojson")) && process.env.ETL_SNAPSHOT_ONLY !== "1") {
    return buildGenerationLive(outDir, await readLayer("generation-ss"));
  }
  layerSources["generation-ss"] = "snapshot";
  const genPath = resolve("data/raw/generation.kml");
  console.log(`[etl] reading ${genPath}`);
  const xml = readFileSync(genPath, "utf-8");
  const doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  const tree = kmlWithFolders(doc) as unknown as TreeNode;

  const points: TreeNode[] = [];
  collectPoints(tree, points);
  console.log(`[etl] parsed ${points.length} generation plants`);

  const usedIds = new Set<string>();
  const plants: GenerationPlant[] = [];
  const byType: Record<string, number> = {};

  for (const feature of points) {
    const props = feature.properties ?? {};
    const table = parseDescriptionTable(getDescriptionHtml(props));
    const coords = (feature.geometry as Point).coordinates;
    const lng = round5(coords[0]);
    const lat = round5(coords[1]);
    const name = (props.name ? String(props.name) : pick(table, ALIASES.genName)) ?? "Unnamed plant";
    const cleanName = name.replace(/\s+/g, " ").trim();

    const energy = classifyEnergy(pick(table, ALIASES.energyType));
    // Source voltages are all 400/220/132; fall back to 132 kV if a future row is unparseable.
    const voltage = parseVoltage(pick(table, ALIASES.voltage)) ?? 132;
    const capRaw = pick(table, ALIASES.capacity);
    const capacityMw = capRaw != null && !Number.isNaN(Number(capRaw)) ? Number(capRaw) : null;

    const id = uniqueId(`g-${slug(cleanName)}`, usedIds);
    byType[energy] = (byType[energy] ?? 0) + 1;

    plants.push({
      id,
      kind: "generation",
      name: cleanName,
      descriptiveName: pick(table, ALIASES.genDescriptiveName),
      ssCode: pick(table, ALIASES.genCode),
      energy,
      voltage,
      circle: pick(table, ALIASES.circle),
      doc: pick(table, ALIASES.doc),
      capacityMw,
      lng,
      lat,
    });
  }

  writeGeneration(outDir, plants, byType);
}

/**
 * Generation plants from the live Gridmap `Generation_SS` layer — same plants as the KML, plus the
 * installed capacity (MW) and unit configuration the KML never carried.
 */
export function buildGenerationLive(outDir: string, feats: RawFeat[]): void {
  const usedIds = new Set<string>();
  const plants: GenerationPlant[] = [];
  const byType: Record<string, number> = {};
  for (const f of feats) {
    if (!f.geometry || f.geometry.type !== "Point") continue;
    const p = f.properties;
    const name = (cleanPgName(p.name as string) ?? cleanPgName(p.name_of_th as string) ?? "Unnamed plant").replace(/\s+/g, " ");
    const energy = classifyEnergy(cleanPgName(p.ss_type as string));
    const voltage = parseVoltage(cleanPgName(p.voltage as string)) ?? 132;
    const cap = Number(p.total_capa);
    const coords = (f.geometry as Point).coordinates;
    byType[energy] = (byType[energy] ?? 0) + 1;
    plants.push({
      id: uniqueId(`g-${slug(name)}`, usedIds),
      kind: "generation",
      name,
      descriptiveName: cleanPgName(p.name_of_th as string),
      ssCode: cleanPgName(p.sap_ss_id as string),
      energy,
      voltage,
      circle: cleanPgName(p.circle as string),
      doc: cleanPgName(p.doc as string),
      capacityMw: p.total_capa != null && Number.isFinite(cap) && cap > 0 ? cap : null,
      units: cleanPgName(p.unit_wise_ as string)?.replace(/\s+/g, " ") ?? null,
      lng: round5(coords[0]),
      lat: round5(coords[1]),
    });
  }
  writeGeneration(outDir, plants, byType);
}

export function writeGeneration(outDir: string, plants: GenerationPlant[], byType: Record<string, number>): void {
  if (plants.length === 0) {
    console.error("[etl] VALIDATION FAILED: generation source produced 0 plants");
    process.exit(1);
  }

  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: plants.map(
      (p): Feature => ({
        type: "Feature",
        id: p.id,
        geometry: { type: "Point", coordinates: [p.lng, p.lat] },
        properties: { ...p },
      }),
    ),
  };

  writeFileSync(resolve(outDir, "generation.geojson"), JSON.stringify(fc));
  const mix = ENERGY_TYPES.filter((t) => byType[t]).map((t) => `${t} ${byType[t as EnergyType]}`).join(", ");
  console.log(`[etl] wrote ${plants.length} generation plants | mix: ${mix}`);
}

/**
 * Build the POWERGRID (PGCIL) national inter-state grid overlay from the ESRI shapefiles in
 * data/raw/gridmap/. Emitted as its own pair of files (`powergrid-lines.geojson` /
 * `powergrid-ss.geojson`) so the app can LAZY-LOAD it — never part of the initial payload.
 * Source is WGS84 (EPSG:4326); no reprojection. Connectivity to AP-TRANSCO is NOT modelled.
 */
export async function buildPowerGrid(outDir: string): Promise<void> {

  // ---- Lines ---------------------------------------------------------------
  const usedLineIds = new Set<string>();
  const lines: PowerGridLine[] = [];
  const lineGeoms: Position[][][] = []; // parallel to `lines`: ring lists (handles MultiLineString)
  {
    let seq = 0;
    for (const feat of await readLayer("powergrid-lines")) {
      const geom = feat.geometry;
      if (!geom || (geom.type !== "LineString" && geom.type !== "MultiLineString")) continue;
      const props = (feat.properties ?? {}) as Record<string, unknown>;
      const name = cleanPgName(props.name_of_th as string) ?? "Unnamed PowerGrid line";
      const voltage = normalizeKv(props.voltagelev) ?? 0;
      const service = cleanPgName(props.serviceoru as string);

      const { rings, km } = lineRouteKm(geom as LineString | MultiLineString);
      const roundedRings = rings.map((ring) => ring.map((c): Position => [round5(c[0]), round5(c[1])]));
      const lengthKm = Math.round(km * 1000) / 1000;

      const id = uniqueId(`pl-${String(seq++).padStart(3, "0")}`, usedLineIds);
      lines.push({ id, kind: "pg-line", name, voltage, service, lengthKm });
      lineGeoms.push(roundedRings);
    }
  }

  // ---- Substations ---------------------------------------------------------
  const usedSsIds = new Set<string>();
  const substations: PowerGridSubstation[] = [];
  {
    for (const feat of await readLayer("powergrid-ss")) {
      const geom = feat.geometry;
      if (!geom || geom.type !== "Point") continue;
      const props = (feat.properties ?? {}) as Record<string, unknown>;
      const name = cleanPgName(props.name as string) ?? cleanPgName(props.name_of_ss as string) ?? "Unnamed PowerGrid SS";
      const fullName = cleanPgName(props.name_of_ss as string);
      const voltage = normalizeKv(props.voltage) ?? 0;
      const coords = (geom as Point).coordinates;
      const lng = round5(coords[0]);
      const lat = round5(coords[1]);

      const id = uniqueId(`ps-${slug(name)}`, usedSsIds);
      substations.push({ id, kind: "pg-substation", name, fullName, voltage, lng, lat });
    }
  }

  // ---- Railway-traction substations (RTSS) ---------------------------------
  const usedRailIds = new Set<string>();
  const railway: RailwaySubstation[] = [];
  {
    for (const feat of await readLayer("railway-ss")) {
      const geom = feat.geometry;
      if (!geom || geom.type !== "Point") continue;
      const props = (feat.properties ?? {}) as Record<string, unknown>;
      const name = cleanPgName(props.name as string) ?? cleanPgName(props.name_of_th as string) ?? "Unnamed RTSS";
      const displayName = cleanPgName(props.name_of_th as string);
      const voltage = parseVoltage(props.voltage as string) ?? 0;
      const lng = round5(Number(props.longitude ?? (geom as Point).coordinates[0]));
      const lat = round5(Number(props.lattitude ?? (geom as Point).coordinates[1]));
      const id = uniqueId(`rs-${slug(name)}`, usedRailIds);
      railway.push({
        id,
        kind: "rail-substation",
        name,
        displayName,
        voltage,
        connectedSs: cleanPgName(props.connected_ as string),
        mva: parseMva(props.cmd_in_mva),
        circle: cleanPgName(props.circle as string),
        district: cleanPgName(props.district as string),
        lng,
        lat,
      });
    }
  }

  // ---- Bulk-load / HT-consumer substations ---------------------------------
  const usedBulkIds = new Set<string>();
  const bulkload: BulkLoadSubstation[] = [];
  {
    for (const feat of await readLayer("bulkload-ss")) {
      const geom = feat.geometry;
      if (!geom || geom.type !== "Point") continue;
      const props = (feat.properties ?? {}) as Record<string, unknown>;
      const name = cleanPgName(props.name as string) ?? cleanPgName(props.name_of_th as string) ?? "Unnamed bulk-load SS";
      const voltage = parseVoltage(props.voltage as string) ?? 0;
      const lng = round5(Number(props.longitude ?? (geom as Point).coordinates[0]));
      const lat = round5(Number(props.lattitude ?? (geom as Point).coordinates[1]));
      const id = uniqueId(`bs-${slug(name)}`, usedBulkIds);
      bulkload.push({
        id,
        kind: "bulk-substation",
        name,
        voltage,
        ssType: cleanPgName(props.ss_type as string),
        connectedSs: cleanPgName(props.connected_ as string),
        mva: parseMva(props.cmd_in_mva),
        circle: cleanPgName(props.circle as string),
        district: cleanPgName(props.district as string),
        lng,
        lat,
      });
    }
  }

  if (
    lines.length === 0 ||
    substations.length === 0 ||
    railway.length === 0 ||
    bulkload.length === 0
  ) {
    console.error(
      `[etl] VALIDATION FAILED: power-grid shapefiles produced ${lines.length} lines / ` +
        `${substations.length} substations / ${railway.length} railway SS / ${bulkload.length} bulk-load SS`,
    );
    process.exit(1);
  }

  const linesFc: FeatureCollection = {
    type: "FeatureCollection",
    features: lines.map((l, i): Feature => {
      const rings = lineGeoms[i];
      return {
        type: "Feature",
        id: l.id,
        geometry:
          rings.length === 1
            ? { type: "LineString", coordinates: rings[0] }
            : { type: "MultiLineString", coordinates: rings },
        properties: { ...l },
      };
    }),
  };

  const ssFc: FeatureCollection = {
    type: "FeatureCollection",
    features: substations.map(
      (s): Feature => ({
        type: "Feature",
        id: s.id,
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
        properties: { ...s },
      }),
    ),
  };

  const railwayFc: FeatureCollection = {
    type: "FeatureCollection",
    features: railway.map(
      (s): Feature => ({
        type: "Feature",
        id: s.id,
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
        properties: { ...s },
      }),
    ),
  };

  const bulkloadFc: FeatureCollection = {
    type: "FeatureCollection",
    features: bulkload.map(
      (s): Feature => ({
        type: "Feature",
        id: s.id,
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
        properties: { ...s },
      }),
    ),
  };

  writeFileSync(resolve(outDir, "powergrid-lines.geojson"), JSON.stringify(linesFc));
  writeFileSync(resolve(outDir, "powergrid-ss.geojson"), JSON.stringify(ssFc));
  writeFileSync(resolve(outDir, "railway-ss.geojson"), JSON.stringify(railwayFc));
  writeFileSync(resolve(outDir, "bulkload-ss.geojson"), JSON.stringify(bulkloadFc));
  console.log(
    `[etl] wrote ${lines.length} power-grid lines / ${substations.length} substations` +
      ` / ${railway.length} railway SS / ${bulkload.length} bulk-load SS`,
  );
}
