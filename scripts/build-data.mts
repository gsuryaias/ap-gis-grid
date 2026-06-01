/**
 * AP-TRANSCO ETL — Transco.kml → clean GeoJSON + meta + search index + data-quality report.
 *
 *   npm run build:data
 *
 * Design (see plan): folder path is authoritative for voltage/circuit; substation↔line
 * adjacency is derived GEOMETRICALLY (endpoint snapping), not from line names; IDs are
 * synthetic/stable (never bare name); coordinates are sourced from geometry and rounded to
 * 5 dp. Heterogeneous <description> HTML tables are normalised via a fixed alias map.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DOMParser } from "@xmldom/xmldom";
import { kmlWithFolders } from "@tmcw/togeojson";
import { open as openShapefile } from "shapefile";
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from "geojson";
import {
  ALIASES,
  canonicalizeCircle,
  classifyEnergy,
  cleanPgName,
  cleanSsName,
  distancePointToPolygons,
  ENERGY_TYPES,
  formatMonthYear,
  haversineMeters,
  lineCircuitMultiplier,
  mapLineCircuit,
  normalizeKv,
  normalizeSsVoltage,
  parseDescriptionTable,
  parseEndpointLabels,
  parseMva,
  parseVoltage,
  pick,
  round5,
  snapExternal,
  type BulkLoadSubstation,
  type Confidence,
  type EnergyType,
  type ExternalPoint,
  type GenerationPlant,
  type LineFeature,
  type PowerGridLine,
  type PowerGridSubstation,
  type RailwaySubstation,
  type Substation,
  type Voltage,
} from "./etl-lib.ts";

// Endpoints snap to the substation POLYGON (0 m if inside the compound; 80% of endpoints are).
// 1000 m also catches lines drawn slightly short of the compound; far-away (>1 km) endpoints are
// genuinely external (other-state / non-TRANSCO facilities) and stay unmatched (flagged low-conf).
const SNAP_THRESHOLD_M = 1000;
const AP_BBOX = { minLng: 76.3, maxLng: 84.9, minLat: 12.5, maxLat: 19.3 };

interface TreeNode {
  type: string;
  meta?: { name?: string } & Record<string, unknown>;
  name?: string;
  children?: TreeNode[];
  geometry?: Point | LineString | null;
  properties?: Record<string, unknown> | null;
}

function getDescriptionHtml(props: Record<string, unknown> | null | undefined): string {
  const d = props?.description;
  if (d == null) return "";
  if (typeof d === "string") return d;
  if (typeof d === "object" && "value" in (d as object)) {
    return String((d as { value?: unknown }).value ?? "");
  }
  return "";
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base || "x";
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

/** Centroid of a (Multi)Polygon: unweighted mean of every ring vertex. */
function polygonCentroid(geom: Polygon | MultiPolygon): [number, number] {
  const rings: Position[][] = geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const ring of rings) {
    for (const c of ring) {
      sx += c[0];
      sy += c[1];
      n++;
    }
  }
  return n > 0 ? [round5(sx / n), round5(sy / n)] : [NaN, NaN];
}

/** Exterior rings of a (Multi)Polygon (holes dropped — substation compounds rarely have any). */
function exteriorRings(geom: Polygon | MultiPolygon): Position[][] {
  const rings = geom.type === "Polygon" ? [geom.coordinates[0]] : geom.coordinates.map((poly) => poly[0]);
  return rings.filter((r) => r && r.length >= 3).map((ring) => ring.map((c): Position => [round5(c[0]), round5(c[1])]));
}

/** A substation footprint for polygon-based adjacency (rings + a bbox for quick rejection). */
interface SsPoly {
  id: string;
  rings: Position[][];
  bbox: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
}

function ringsBbox(rings: Position[][]): [number, number, number, number] {
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const ring of rings)
    for (const c of ring) {
      mnx = Math.min(mnx, c[0]); mxx = Math.max(mxx, c[0]);
      mny = Math.min(mny, c[1]); mxy = Math.max(mxy, c[1]);
    }
  return [mnx, mny, mxx, mxy];
}

/**
 * Snap a line endpoint to the substation whose compound it falls in / nearest (≤ thresholdM from the
 * polygon edge, 0 m if inside). Far more forgiving — and accurate — than centroid distance, since
 * lines terminate at the compound boundary. A degree-margin bbox check skips far-away footprints.
 */
function snapToSs(
  coord: [number, number],
  ssPolys: SsPoly[],
  thresholdM: number,
): { ssId: string; distM: number; confidence: Confidence } | null {
  const margin = thresholdM / 100_000 + 0.005; // ~metres → degrees, plus slack
  let best: string | null = null;
  let bestDist = Infinity;
  for (const ss of ssPolys) {
    const [mnx, mny, mxx, mxy] = ss.bbox;
    if (coord[0] < mnx - margin || coord[0] > mxx + margin || coord[1] < mny - margin || coord[1] > mxy + margin)
      continue;
    const d = distancePointToPolygons(coord, ss.rings);
    if (d < bestDist) {
      bestDist = d;
      best = ss.id;
    }
  }
  if (best == null || bestDist > thresholdM) return null;
  const confidence: Confidence = bestDist <= 50 ? "high" : bestDist <= 250 ? "medium" : "low";
  return { ssId: best, distM: Math.round(bestDist), confidence };
}

/** Read every feature of a shapefile into memory (small layers — fine to buffer). */
async function readShapefile(
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

/** First/last vertex of a (Multi)LineString as [lng,lat] pairs (uses the longest part). */
function endpointsOf(geom: LineString | MultiLineString): { first: [number, number]; last: [number, number]; rings: Position[][] } {
  const rings: Position[][] = geom.type === "MultiLineString" ? geom.coordinates : [geom.coordinates];
  // Use the longest ring for the canonical geometry + endpoints.
  let longest = rings[0];
  for (const ring of rings) if (ring.length > longest.length) longest = ring;
  const first = longest[0] as [number, number];
  const last = longest[longest.length - 1] as [number, number];
  return { first, last, rings: [longest] };
}

/** Collect every Point Feature in a KML tree, ignoring folder structure. */
function collectPoints(node: TreeNode, out: TreeNode[]): void {
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
function buildGeneration(outDir: string): void {
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

  if (plants.length === 0) {
    console.error("[etl] VALIDATION FAILED: generation.kml produced 0 plants");
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

/** Flatten a (Multi)LineString into segment rings; sum geodesic length over all of them (km). */
function lineRouteKm(geom: LineString | MultiLineString): { rings: Position[][]; km: number } {
  const rings: Position[][] =
    geom.type === "MultiLineString" ? geom.coordinates : [geom.coordinates];
  let meters = 0;
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      meters += haversineMeters(
        [ring[i - 1][0], ring[i - 1][1]],
        [ring[i][0], ring[i][1]],
      );
    }
  }
  return { rings, km: meters / 1000 };
}

/**
 * Build the POWERGRID (PGCIL) national inter-state grid overlay from the ESRI shapefiles in
 * data/raw/gridmap/. Emitted as its own pair of files (`powergrid-lines.geojson` /
 * `powergrid-ss.geojson`) so the app can LAZY-LOAD it — never part of the initial payload.
 * Source is WGS84 (EPSG:4326); no reprojection. Connectivity to AP-TRANSCO is NOT modelled.
 */
async function buildPowerGrid(outDir: string): Promise<void> {
  const baseDir = resolve("data/raw/gridmap");
  const linesShp = `${baseDir}/powergrid-lines.shp`;
  const linesDbf = `${baseDir}/powergrid-lines.dbf`;
  const ssShp = `${baseDir}/powergrid-ss.shp`;
  const ssDbf = `${baseDir}/powergrid-ss.dbf`;
  console.log(`[etl] reading ${linesShp} + ${ssShp}`);

  // ---- Lines ---------------------------------------------------------------
  const usedLineIds = new Set<string>();
  const lines: PowerGridLine[] = [];
  const lineGeoms: Position[][][] = []; // parallel to `lines`: ring lists (handles MultiLineString)
  {
    const src = await openShapefile(linesShp, linesDbf);
    let seq = 0;
    for (let r = await src.read(); !r.done; r = await src.read()) {
      const feat = r.value;
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
    await src.cancel();
  }

  // ---- Substations ---------------------------------------------------------
  const usedSsIds = new Set<string>();
  const substations: PowerGridSubstation[] = [];
  {
    const src = await openShapefile(ssShp, ssDbf);
    for (let r = await src.read(); !r.done; r = await src.read()) {
      const feat = r.value;
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
    await src.cancel();
  }

  // ---- Railway-traction substations (RTSS) ---------------------------------
  const usedRailIds = new Set<string>();
  const railway: RailwaySubstation[] = [];
  {
    const railShp = `${baseDir}/railway-ss.shp`;
    const railDbf = `${baseDir}/railway-ss.dbf`;
    console.log(`[etl] reading ${railShp}`);
    const src = await openShapefile(railShp, railDbf);
    for (let r = await src.read(); !r.done; r = await src.read()) {
      const feat = r.value;
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
    await src.cancel();
  }

  // ---- Bulk-load / HT-consumer substations ---------------------------------
  const usedBulkIds = new Set<string>();
  const bulkload: BulkLoadSubstation[] = [];
  {
    const bulkShp = `${baseDir}/bulkload-ss.shp`;
    const bulkDbf = `${baseDir}/bulkload-ss.dbf`;
    console.log(`[etl] reading ${bulkShp}`);
    const src = await openShapefile(bulkShp, bulkDbf);
    for (let r = await src.read(); !r.done; r = await src.read()) {
      const feat = r.value;
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
    await src.cancel();
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

async function main(): Promise<void> {
  const outDir = resolve("public/data");
  const baseDir = resolve("data/raw/gridmap");
  mkdirSync(outDir, { recursive: true });

  // ==========================================================================
  // Substations — authoritative ESRI shapefile (APTransco SS, TRANSCO-only).
  // Polygon/MultiPolygon footprints → a marker POINT at the ring-vertex centroid.
  // ==========================================================================
  const ssShp = `${baseDir}/aptransco-ss.shp`;
  const ssDbf = `${baseDir}/aptransco-ss.dbf`;
  console.log(`[etl] reading ${ssShp}`);
  const rawSs = await readShapefile(ssShp, ssDbf);

  const usedIds = new Set<string>();
  const substations: Substation[] = [];
  const ssPolys: SsPoly[] = []; // parallel footprint set for polygon-based line adjacency
  let ssVoltageDropped = 0;
  const ssVoltageDroppedSamples: string[] = [];
  let ssIdSynthFromName = 0;

  for (const feat of rawSs) {
    const geom = feat.geometry;
    if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) continue;
    const props = feat.properties;
    const [lng, lat] = polygonCentroid(geom as Polygon | MultiPolygon);
    const descriptiveName = cleanPgName(props.ss_name as string);
    const cleanName = cleanSsName(props.ss_name as string) ?? descriptiveName ?? "Unnamed SS";

    const voltage = normalizeSsVoltage(props.voltage);
    if (voltage == null) {
      ssVoltageDropped++;
      if (ssVoltageDroppedSamples.length < 10) ssVoltageDroppedSamples.push(`${cleanName} (${String(props.voltage)})`);
      continue; // unrecognised voltage — cannot place in the 400/220/132 union
    }

    const ssCode = cleanPgName(props.sap_ss_id as string);
    // IDs: s-<slug(ssCode)>; for null/blank SAP id rows, synth s-<slug(name)>-<voltage>.
    let base: string;
    if (ssCode) base = `s-${slug(ssCode)}`;
    else {
      base = `s-${slug(cleanName)}-${voltage}`;
      ssIdSynthFromName++;
    }
    const id = uniqueId(base, usedIds);

    substations.push({
      id,
      kind: "substation",
      name: cleanName,
      descriptiveName,
      ssCode,
      voltage,
      // The SS layer's own `circle` is an opaque numeric code with no name map; we instead derive a
      // clean circle NAME below from the (canonicalised) circles of this SS's connected lines.
      circle: null,
      circleInferred: false, // authoritative — never inferred under the Gridmap source
      doc: null, // commissioning not present in this layer
      lng,
      lat,
      connectedLineIds: [],
      zone: cleanPgName(props.zone as string),
      division: cleanPgName(props.division as string),
    });
    const rings = exteriorRings(geom as Polygon | MultiPolygon);
    ssPolys.push({ id, rings, bbox: ringsBbox(rings) });
  }
  // Circle is authoritative now (no spatial inference under the Gridmap source).
  const inferredCircles = 0;

  // ==========================================================================
  // Lines — authoritative ESRI shapefiles (Lines 400KV / 220KV / 132KV).
  // Voltage = the layer. Adopt ALL features (per-circuit Ckt-1/Ckt-2 included);
  // drop only null / <2-vertex geometry. "(P)" is a naming token, NOT a flag.
  // ==========================================================================
  const lineLayers: Array<{ path: string; voltage: Voltage }> = [
    { path: `${baseDir}/lines-400kv`, voltage: 400 },
    { path: `${baseDir}/lines-220kv`, voltage: 220 },
    { path: `${baseDir}/lines-132kv`, voltage: 132 },
  ];

  // ---- Build the non-TRANSCO facility point set (display-only external endpoints) ----
  const externalPoints: ExternalPoint[] = [];
  const addExternalPoints = async (
    file: string,
    category: string,
    nameKeys: string[],
  ): Promise<void> => {
    const feats = await readShapefile(`${baseDir}/${file}.shp`, `${baseDir}/${file}.dbf`);
    for (const f of feats) {
      if (!f.geometry || f.geometry.type !== "Point") continue;
      const p = f.properties;
      let name: string | null = null;
      for (const k of nameKeys) {
        name = cleanPgName(p[k] as string);
        if (name) break;
      }
      const coords = (f.geometry as Point).coordinates;
      const lng = round5(Number(p.longitude ?? coords[0]));
      const lat = round5(Number(p.lattitude ?? coords[1]));
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      externalPoints.push({ name: name ?? `Unnamed ${category}`, category, lng, lat });
    }
  };
  await addExternalPoints("generation-ss", "Generation", ["name", "name_of_th"]);
  await addExternalPoints("railway-ss", "Railway", ["name_of_th", "name"]);
  await addExternalPoints("powergrid-ss", "PowerGrid", ["name", "name_of_ss"]);
  await addExternalPoints("bulkload-ss", "HT consumer", ["name", "name_of_th"]);

  const lines: LineFeature[] = [];
  const lineGeoms = new Map<string, Position[]>();
  let lineSeq = 0;
  let rawLineCount = 0;
  let droppedBadGeom = 0;

  for (const { path, voltage } of lineLayers) {
    console.log(`[etl] reading ${path}.shp`);
    const feats = await readShapefile(`${path}.shp`, `${path}.dbf`);
    for (const feat of feats) {
      rawLineCount++;
      const geom = feat.geometry;
      if (!geom || (geom.type !== "LineString" && geom.type !== "MultiLineString")) {
        droppedBadGeom++;
        continue;
      }
      const { first, last, rings } = endpointsOf(geom as LineString | MultiLineString);
      const positions: Position[] = rings[0].map((c) => [round5(c[0]), round5(c[1])]);
      if (positions.length < 2) {
        droppedBadGeom++;
        continue;
      }
      const props = feat.properties;
      const name = (cleanPgName(props.line_name as string) ?? "Unnamed line").replace(/\s+/g, " ").trim();
      const circuitType = cleanPgName(props.circuit_ty as string);
      const circuit = mapLineCircuit(props.circuit_ty);

      const lengthRaw = props.line_lengt;
      const lengthKm =
        lengthRaw != null && !Number.isNaN(Number(lengthRaw)) ? Math.round(Number(lengthRaw) * 1000) / 1000 : null;

      const id = uniqueId(`l-${String(lineSeq++).padStart(4, "0")}`, usedIds);
      const firstR: [number, number] = [round5(first[0]), round5(first[1])];
      const lastR: [number, number] = [round5(last[0]), round5(last[1])];
      const fromSS = snapToSs(firstR, ssPolys, SNAP_THRESHOLD_M);
      const toSS = snapToSs(lastR, ssPolys, SNAP_THRESHOLD_M);
      const connectsSS = [...new Set([fromSS?.ssId, toSS?.ssId].filter(Boolean) as string[])];

      // Canonical circle name from the line layer; SS circles are derived from their lines below,
      // after which any still-circle-less line inherits from a connected SS.
      const circle: string | null = canonicalizeCircle(props.circle as string);
      for (const ssId of connectsSS) {
        substations.find((s) => s.id === ssId)?.connectedLineIds.push(id);
      }

      // Display-only non-TRANSCO endpoints: only for endpoints that did NOT snap to a TRANSCO SS.
      const externalEndpoints: { name: string; category: string }[] = [];
      if (!fromSS) {
        const ext = snapExternal(firstR, externalPoints, SNAP_THRESHOLD_M);
        if (ext) externalEndpoints.push(ext);
      }
      if (!toSS) {
        const ext = snapExternal(lastR, externalPoints, SNAP_THRESHOLD_M);
        if (ext && !externalEndpoints.some((e) => e.name === ext.name && e.category === ext.category)) {
          externalEndpoints.push(ext);
        }
      }

      const ckm = lengthKm != null ? Math.round(lengthKm * lineCircuitMultiplier(props.circuit_ty) * 1000) / 1000 : null;

      lines.push({
        id,
        kind: "line",
        name,
        voltage,
        circuit,
        lengthKm,
        ckm,
        circle,
        connectsSS,
        endpointLabels: parseEndpointLabels(name),
        fromSS,
        toSS,
        // Shapefile circuit/voltage are authoritative — no folder-vs-name conflict to flag.
        circuitAmbiguous: false,
        voltageMismatch: false,
        circuitType,
        conductor: cleanPgName(props.conductor_ as string),
        commissioned: formatMonthYear(props.date_of_co),
        externalEndpoints,
      });
      lineGeoms.set(id, positions);
    }
  }

  console.log(
    `[etl] parsed ${substations.length} substations (dropped ${ssVoltageDropped} bad-voltage), ` +
      `${lines.length} lines (dropped ${droppedBadGeom} bad-geometry of ${rawLineCount})`,
  );

  // ---- Validation gate -----------------------------------------------------
  // Authoritative source = the Gridmap ESRI shapefiles. Sane lower-bound asserts (the exact
  // emitted counts are logged above); the build fails if the data drifts far below expectation.
  const errors: string[] = [];
  if (substations.length <= 300) errors.push(`expected > 300 substations, got ${substations.length}`);
  if (lines.length <= 1000) errors.push(`expected > 1000 lines, got ${lines.length}`);
  for (const s of substations) {
    if (!Number.isFinite(s.lng) || !Number.isFinite(s.lat)) errors.push(`bad coords: ${s.name}`);
    if (!s.name) errors.push(`substation missing name: ${s.id}`);
  }
  for (const [id, pos] of lineGeoms) if (pos.length < 2) errors.push(`line ${id} has <2 vertices`);
  if (errors.length) {
    console.error("[etl] VALIDATION FAILED:\n  - " + errors.join("\n  - "));
    process.exit(1);
  }
  console.log(`[etl] validation OK: ${substations.length} SS (> 300), ${lines.length} lines (> 1000)`);

  // ---- Warnings (non-fatal) ------------------------------------------------
  const coordWarnings = substations
    .filter(
      (s) =>
        s.lng < AP_BBOX.minLng ||
        s.lng > AP_BBOX.maxLng ||
        s.lat < AP_BBOX.minLat ||
        s.lat > AP_BBOX.maxLat,
    )
    .map((s) => ({ id: s.id, name: s.name, lng: s.lng, lat: s.lat }));

  // ---- Bounds & stats ------------------------------------------------------
  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;
  const acc = (lng: number, lat: number) => {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  };
  for (const s of substations) acc(s.lng, s.lat);
  for (const pos of lineGeoms.values()) for (const c of pos) acc(c[0], c[1]);

  // ---- Summary aggregation (by voltage, by circle, and the voltage×circle matrix) ----
  const UNASSIGNED = "Unassigned";
  const rnd1 = (n: number) => Math.round(n * 10) / 10;
  interface Agg {
    substations: number;
    lines: number;
    lengthKm: number;
    circuitKm: number;
  }
  const blank = (): Agg => ({ substations: 0, lines: 0, lengthKm: 0, circuitKm: 0 });
  const ensure = (m: Record<string, Agg>, k: string): Agg => (m[k] ??= blank());

  const byVoltage: Record<string, Agg> = { 400: blank(), 220: blank(), 132: blank() };
  const byCircle: Record<string, Agg> = {};
  const matrix: Record<string, Record<string, Agg>> = { 400: {}, 220: {}, 132: {} };

  // Derive each SS's circle NAME from the (canonical) circles of its connected lines (majority
  // vote) — the SS layer's own `circle` is an opaque code. Then any still-circle-less line inherits
  // from a connected SS, so substations + lines share ONE clean circle namespace.
  const lineById = new Map(lines.map((l) => [l.id, l]));
  for (const s of substations) {
    const tally = new Map<string, number>();
    for (const lid of s.connectedLineIds) {
      const c = lineById.get(lid)?.circle;
      if (c) tally.set(c, (tally.get(c) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestN = 0;
    for (const [c, n] of tally) if (n > bestN) { bestN = n; best = c; }
    s.circle = best;
  }
  const ssById = new Map(substations.map((s) => [s.id, s]));
  for (const l of lines) {
    if (l.circle) continue;
    for (const ssId of l.connectsSS) {
      const c = ssById.get(ssId)?.circle;
      if (c) { l.circle = c; break; }
    }
  }

  for (const s of substations) {
    const c = s.circle ?? UNASSIGNED;
    byVoltage[s.voltage].substations++;
    ensure(byCircle, c).substations++;
    ensure(matrix[s.voltage], c).substations++;
  }
  for (const l of lines) {
    const c = l.circle ?? UNASSIGNED;
    const route = l.lengthKm ?? 0;
    const ckm = l.ckm ?? 0;
    for (const a of [byVoltage[l.voltage], ensure(byCircle, c), ensure(matrix[l.voltage], c)]) {
      a.lines++;
      a.lengthKm += route;
      a.circuitKm += ckm;
    }
  }
  const roundAgg = (a: Agg): Agg => ({ ...a, lengthKm: rnd1(a.lengthKm), circuitKm: rnd1(a.circuitKm) });
  for (const v of Object.keys(byVoltage)) byVoltage[v] = roundAgg(byVoltage[v]);
  for (const c of Object.keys(byCircle)) byCircle[c] = roundAgg(byCircle[c]);
  for (const v of Object.keys(matrix)) for (const c of Object.keys(matrix[v])) matrix[v][c] = roundAgg(matrix[v][c]);

  const circles = Object.keys(byCircle).sort((a, b) =>
    a === UNASSIGNED ? 1 : b === UNASSIGNED ? -1 : a.localeCompare(b),
  );
  const totalLengthKm = rnd1(lines.reduce((a, l) => a + (l.lengthKm ?? 0), 0));
  const totalCircuitKm = rnd1(lines.reduce((a, l) => a + (l.ckm ?? 0), 0));

  // ---- Adjacency stats -----------------------------------------------------
  const both = lines.filter((l) => l.fromSS && l.toSS).length;
  const one = lines.filter((l) => (l.fromSS ? 1 : 0) + (l.toSS ? 1 : 0) === 1).length;
  const none = lines.length - both - one;
  const unmatchedSamples = lines
    .filter((l) => !l.fromSS || !l.toSS)
    .slice(0, 25)
    .map((l) => ({ id: l.id, name: l.name, endpoints: l.endpointLabels }));

  // ---- Emit ----------------------------------------------------------------
  const ssFc: FeatureCollection = {
    type: "FeatureCollection",
    features: substations.map(
      (s): Feature => ({
        type: "Feature",
        id: s.id,
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
        properties: {
          id: s.id,
          kind: "substation",
          name: s.name,
          descriptiveName: s.descriptiveName,
          ssCode: s.ssCode,
          voltage: s.voltage,
          circle: s.circle,
          circleInferred: s.circleInferred,
          doc: s.doc,
          lng: s.lng,
          lat: s.lat,
          connectedLineIds: s.connectedLineIds,
          connectedLineCount: s.connectedLineIds.length,
          // New optional fields (Gridmap migration)
          zone: s.zone,
          division: s.division,
        },
      }),
    ),
  };

  const lineFc: FeatureCollection = {
    type: "FeatureCollection",
    features: lines.map(
      (l): Feature => ({
        type: "Feature",
        id: l.id,
        geometry: { type: "LineString", coordinates: lineGeoms.get(l.id)! },
        properties: {
          id: l.id,
          kind: "line",
          name: l.name,
          voltage: l.voltage,
          circuit: l.circuit,
          lengthKm: l.lengthKm,
          ckm: l.ckm,
          circle: l.circle,
          connectsSS: l.connectsSS,
          endpointLabels: l.endpointLabels,
          fromSS: l.fromSS,
          toSS: l.toSS,
          circuitAmbiguous: l.circuitAmbiguous,
          voltageMismatch: l.voltageMismatch,
          // New optional fields (Gridmap migration)
          circuitType: l.circuitType,
          conductor: l.conductor,
          commissioned: l.commissioned,
          externalEndpoints: l.externalEndpoints,
        },
      }),
    ),
  };

  const searchIndex = [
    ...substations.map((s) => ({
      id: s.id,
      kind: "substation" as const,
      name: s.name,
      voltage: s.voltage,
      // Prefer the human-readable zone/division for the search subtitle (circle is a numeric code).
      sub: s.zone ?? s.division ?? s.ssCode ?? null,
    })),
    ...lines.map((l) => ({
      id: l.id,
      kind: "line" as const,
      name: l.name,
      voltage: l.voltage,
      sub: l.circuit,
    })),
  ];

  const meta = {
    generatedAt: new Date().toISOString(),
    source: "AP-TRANSCO Gridmap ESRI shapefiles (APTransco SS + Lines 400/220/132 kV)",
    counts: { substations: substations.length, lines: lines.length },
    byVoltage,
    byCircle,
    matrix,
    circles,
    totalLengthKm,
    totalCircuitKm,
    bounds: [
      [round5(minLng), round5(minLat)],
      [round5(maxLng), round5(maxLat)],
    ],
    snapThresholdM: SNAP_THRESHOLD_M,
  };

  const linesWithExternal = lines.filter((l) => l.externalEndpoints.length > 0).length;
  const dataQuality = {
    generatedAt: meta.generatedAt,
    notes: [
      "Source migrated from the Google-Earth KML to the authoritative AP-TRANSCO Gridmap ESRI shapefiles.",
      "Circle / voltage are now authoritative from the source layers, so inferredCircles = 0 and there are no circuit/voltage-mismatch flags.",
      'The "(P)" token in line names is a naming token, NOT a "proposed" flag (most such lines carry real past commissioning dates).',
      'Substation `circle` is the source numeric circle CODE (0 = unassigned → null); use `zone`/`division` for human-readable groupings. Line `circle` is a circle NAME.',
    ],
    substationSchemas: { aptranscoShapefile: substations.length },
    unknownSchemaSamples: ssVoltageDroppedSamples,
    idsSynthesizedFromName: ssIdSynthFromName,
    inferredCircles,
    adjacency: {
      method: `geometric endpoint-snapping to TRANSCO SS polygons (0 m if inside the compound; ≤ ${SNAP_THRESHOLD_M} m to the edge otherwise)`,
      linesBothEndpoints: both,
      linesOneEndpoint: one,
      linesNoEndpoint: none,
      pctBoth: Math.round((both / lines.length) * 1000) / 10,
      pctAtLeastOne: Math.round(((both + one) / lines.length) * 1000) / 10,
      linesWithExternalEndpoint: linesWithExternal,
      unmatchedSamples,
    },
    circuitAmbiguousLines: { count: 0, samples: [] as string[] },
    voltageMismatchLines: { count: 0, samples: [] as string[] },
    droppedDuplicates: [] as Array<{ name: string; lng: number; lat: number; keptId: string }>,
    coordWarnings,
  };

  writeFileSync(resolve(outDir, "substations.geojson"), JSON.stringify(ssFc));
  writeFileSync(resolve(outDir, "lines.geojson"), JSON.stringify(lineFc));
  writeFileSync(resolve(outDir, "search-index.json"), JSON.stringify(searchIndex));
  writeFileSync(resolve(outDir, "meta.json"), JSON.stringify(meta, null, 2));
  writeFileSync(resolve(outDir, "data-quality.json"), JSON.stringify(dataQuality, null, 2));

  console.log(`[etl] wrote ${substations.length} substations, ${lines.length} lines`);
  console.log(
    `[etl] adjacency: both=${both} (${dataQuality.adjacency.pctBoth}%), one=${one}, none=${none}` +
      ` | route ${totalLengthKm} km · circuit ${totalCircuitKm} km · ${circles.length} circles` +
      ` | linesWithExternalEndpoint=${linesWithExternal}` +
      (coordWarnings.length ? ` | ${coordWarnings.length} coord warning(s)` : ""),
  );

  // ---- Generation overlay (separate, lazy-loaded layer) --------------------
  buildGeneration(outDir);

  // ---- POWERGRID (PGCIL) national grid overlay (separate, lazy-loaded) -----
  await buildPowerGrid(outDir);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });

export { main };
