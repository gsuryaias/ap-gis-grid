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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
  coastalBand,
  distancePointToPolygons,
  distanceToPolylineKm,
  ENERGY_TYPES,
  formatMonthYear,
  haversineMeters,
  circuitTag,
  corridorKey,
  lineAccounting,
  mapLineCircuit,
  dedupePlaces,
  normalizeKv,
  normalizeSsVoltage,
  parseDescriptionTable,
  parseEndpointLabels,
  parseMva,
  parsePlacesTsv,
  parseVoltage,
  pick,
  placeType,
  round5,
  snapExternal,
  type BulkLoadSubstation,
  type Confidence,
  type EnergyType,
  type ExternalPoint,
  type GenerationPlant,
  type LineFeature,
  type PlaceTuple,
  type PowerGridLine,
  type PowerGridSubstation,
  type RailwaySubstation,
  type Substation,
  type Voltage,
} from "./etl-lib.ts";
import { buildWebTowers, normLineName, TOWER_LAYERS, type LineTowerStats, type TowersFile } from "./towers-lib.ts";
import {
  anchorOf,
  buildEpdclFeeders,
  buildSpdclFeeders,
  buildSpdclRoutes,
  coverageMask,
  dtrRows,
  epSsIdIndex,
  type Chain,
  type DtrRow,
  type F11,
  type SsRef,
} from "./etl-network.ts";
import type { GroupedFile } from "./net-lib.ts";
import { buildDiscomLines, buildDiscomSubstations, type Discom, type DiscomLineOut, type DiscomSubstation } from "./etl-discom.ts";
import { linkFeederSources, linkServedSubstations, NAME_MATCH_RADIUS_KM, PROXIMITY_KM, SERVES_M, type FeederIn } from "./etl-connectivity.ts";
import { toCsv } from "../src/lib/export.ts";

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

type RawFeat = { geometry: GeoJSON.Geometry | null; properties: Record<string, unknown> };

/** Where each layer was read from this run (reported in live-status.json + data-quality.json). */
const layerSources: Record<string, "live" | "snapshot"> = {};
const LIVE_DIR = resolve("data/raw/live");
const SNAPSHOT_DIR = resolve("data/raw/gridmap");

/**
 * Read a network layer: the live pull (data/raw/live/<name>.geojson, written by `npm run sync:live`
 * from the AP-TRANSCO enterprise GIS) when present, else the committed shapefile snapshot
 * (data/raw/gridmap/<name>.shp). Live attribute keys are pre-truncated to the shapefile's 10-char
 * dBASE names by the sync, so both paths feed the ETL identical property keys.
 */
async function readLayer(name: string): Promise<RawFeat[]> {
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

/** A small circular footprint (n-gon) around a point, for substations that have no surveyed polygon. */
function syntheticFootprint(lng: number, lat: number, radiusM: number, n = 12): Position[][] {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring: Position[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * (i % n)) / n;
    ring.push([round5(lng + dLng * Math.cos(a)), round5(lat + dLat * Math.sin(a))]);
  }
  return [ring];
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
async function buildGeneration(outDir: string): Promise<void> {
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
function buildGenerationLive(outDir: string, feats: RawFeat[]): void {
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

function writeGeneration(outDir: string, plants: GenerationPlant[], byType: Record<string, number>): void {
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
 * Build the place-search gazetteer from the committed GeoNames AP extract
 * (data/raw/geonames-ap.tsv, CC BY 4.0). Emitted as compact tuples — `places.json` is
 * LAZY-loaded by the search box on first use (never part of the initial payload) and is
 * search-only: places are not a map layer and are never selectable features.
 */
function buildPlaces(outDir: string): void {
  const tsvPath = resolve("data/raw/geonames-ap.tsv");
  console.log(`[etl] reading ${tsvPath}`);
  const rows = parsePlacesTsv(readFileSync(tsvPath, "utf-8"));

  // District names for disambiguation, from the extract's own ADM2 rows (covers both the
  // 13-district and 26-district vintages GeoNames mixes).
  const districts = new Map<string, string>();
  for (const r of rows) if (r.fcode === "ADM2") districts.set(r.admin2, r.name);

  const deduped = dedupePlaces(rows).sort(
    (a, b) => b.population - a.population || a.name.localeCompare(b.name),
  );
  const places: PlaceTuple[] = deduped.map((r) => {
    const type = placeType(r.fclass, r.fcode, r.population);
    // Districts / the state row need no district disambiguator of their own.
    const district = r.fclass === "A" && r.fcode !== "ADM3" ? "" : (districts.get(r.admin2) ?? "");
    return [r.name, type, district, round5(r.lng), round5(r.lat), r.population];
  });

  if (places.length < 25_000) {
    console.error(`[etl] VALIDATION FAILED: places gazetteer has ${places.length} rows (< 25000)`);
    process.exit(1);
  }
  writeFileSync(
    resolve(outDir, "places.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: "GeoNames gazetteer, Andhra Pradesh extract (CC BY 4.0)",
      count: places.length,
      places,
    }),
  );
  console.log(`[etl] wrote ${places.length} gazetteer places (dedup ${rows.length} → ${places.length})`);
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

/**
 * DISCOM 33 kV sub-transmission overlay (lazy-loaded) from the live pulls
 * data/raw/live/discom-{spdcl,epdcl,cpdcl}-{ss,lines}.geojson. Skipped (with empty outputs) when no
 * DISCOM layer has been synced yet — the app hides the toggle when the files are empty.
 */
type DiscomStats = Record<string, { substations: number; lines: number; lineKm: number; linesFrom?: string }>;

async function buildDiscom(outDir: string, transco: Substation[]): Promise<{ stats: DiscomStats; connectivity: unknown }> {
  const sources: Array<{ discom: Discom; stem: string }> = [
    { discom: "APSPDCL", stem: "discom-spdcl" },
    { discom: "APEPDCL", stem: "discom-epdcl" },
    { discom: "APCPDCL", stem: "discom-cpdcl" },
  ];
  const allSs: DiscomSubstation[] = [];
  const allLines: DiscomLineOut[] = [];
  const stats: DiscomStats = {};
  for (const { discom, stem } of sources) {
    const ssPath = resolve(LIVE_DIR, `${stem}-ss.geojson`);
    const lnPath = resolve(LIVE_DIR, `${stem}-lines.geojson`);
    // APCPDCL's feeders aren't on the open GIS — they come from a committed one-off export
    // (scripts/import-apcpdcl.mts) unless a live layer is ever configured.
    const staticLines = discom === "APCPDCL" ? resolve("data/raw/discom/apcpdcl-33kv-feeders.geojson") : null;
    const lineSrc = existsSync(lnPath) ? "live" : staticLines && existsSync(staticLines) ? "static" : null;
    if (!existsSync(ssPath) && !lineSrc) continue;
    const ss = existsSync(ssPath) ? buildDiscomSubstations(discom, await readLayer(`${stem}-ss`)) : [];
    const ln =
      lineSrc === "live"
        ? buildDiscomLines(discom, await readLayer(`${stem}-lines`))
        : lineSrc === "static"
          ? buildDiscomLines(discom, (JSON.parse(readFileSync(staticLines!, "utf-8")) as { features: RawFeat[] }).features)
          : [];
    if (lineSrc === "static") layerSources[`${stem}-lines`] = "snapshot";
    allSs.push(...ss);
    allLines.push(...ln);
    stats[discom] = {
      substations: ss.length,
      lines: ln.length,
      lineKm: Math.round(ln.reduce((a, l) => a + l.props.lengthKm, 0)),
      ...(lineSrc === "static"
        ? { linesFrom: `${discom} GIS export, ${(JSON.parse(readFileSync(staticLines!, "utf-8")) as { vintage?: string }).vintage ?? "undated"}` }
        : {}),
    };
    console.log(`[etl] DISCOM ${discom}: ${ss.length} 33/11 kV SS, ${ln.length} 33 kV line runs (${stats[discom].lineKm} km)`);
  }

  // ---- TRANSCO → 33 kV feeder → 33/11 kV SS connectivity (inferred; see etl-connectivity.ts) ----
  const feedersIn: FeederIn[] = allLines.map((l) => ({
    id: l.props.id,
    discom: l.props.discom,
    name: l.props.name,
    division: l.props.division,
    sourceSs: l.props.sourceSs,
    parts: l.parts,
  }));
  const tNodes = transco.map((t) => ({ id: t.id, name: t.name, descriptiveName: t.descriptiveName, voltage: t.voltage, lng: t.lng, lat: t.lat }));
  const src = linkFeederSources(tNodes, feedersIn);
  const serves = linkServedSubstations(feedersIn, allSs);
  const tById = new Map(transco.map((t) => [t.id, t]));
  const ssById = new Map(allSs.map((s) => [s.id, s]));
  const tLabel = (t: Substation) => `${t.voltage} kV ${t.name}`;

  // Inverse maps: 33/11 kV SS → feeders / TRANSCO sources; TRANSCO SS → feeders.
  const ssFeeders = new Map<string, string[]>();
  const ssSources = new Map<string, Set<string>>();
  const byTransco = new Map<string, string[]>();
  for (const l of allLines) {
    const id = l.props.id;
    const link = src.get(id);
    if (link) (byTransco.get(link.transcoSsId) ?? byTransco.set(link.transcoSsId, []).get(link.transcoSsId)!).push(id);
    for (const sid of serves.get(id) ?? []) {
      (ssFeeders.get(sid) ?? ssFeeders.set(sid, []).get(sid)!).push(id);
      if (link) (ssSources.get(sid) ?? ssSources.set(sid, new Set()).get(sid)!).add(link.transcoSsId);
    }
  }
  const lineById = new Map(allLines.map((l) => [l.props.id, l]));
  const feederLabel = (id: string) => lineById.get(id)?.props.name ?? "Unnamed 33 kV line";

  // Null attributes are dropped from the emitted overlay (the app reads every field as optional).
  const compact = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)));
  // Nearest TRANSCO SS for every 33/11 kV SS — a reference even where no feeder is mapped (APSPDCL).
  const nearestT = (lng: number, lat: number) => {
    let best: Substation | null = null;
    let bd = Infinity;
    for (const t of transco) {
      if (Math.abs(t.lng - lng) > 0.6 || Math.abs(t.lat - lat) > 0.6) continue;
      const d = haversineMeters([lng, lat], [t.lng, t.lat]);
      if (d < bd) { bd = d; best = t; }
    }
    return best ? { label: tLabel(best), km: Math.round(bd / 100) / 10 } : null;
  };
  const ssFeats: Feature[] = allSs.map((s) => ({
    type: "Feature",
    id: s.id,
    geometry: { type: "Point", coordinates: [s.lng, s.lat] },
    properties: compact({
      ...s,
      transcoSs: [...(ssSources.get(s.id) ?? [])].map((t) => tLabel(tById.get(t)!)).join("; ") || null,
      feeders: [...new Set((ssFeeders.get(s.id) ?? []).map(feederLabel))].slice(0, 8).join("; ") || null,
      nearestTranscoSs: ((n) => (n ? `${n.label} (${n.km} km)` : null))(nearestT(s.lng, s.lat)),
    }),
  }));
  const lineFeats: Feature[] = allLines.map((l) => {
    const link = src.get(l.props.id);
    const served = serves.get(l.props.id) ?? [];
    return {
      type: "Feature",
      id: l.props.id,
      geometry: l.parts.length === 1 ? { type: "LineString", coordinates: l.parts[0] } : { type: "MultiLineString", coordinates: l.parts },
      properties: compact({
        ...l.props,
        transcoSsId: link?.transcoSsId ?? null,
        transcoSs: link ? tLabel(tById.get(link.transcoSsId)!) : null,
        linkMethod: link?.method ?? null,
        servesSsCount: served.length || null,
        servesSs: served.slice(0, 12).map((id) => ssById.get(id)!.name).join("; ") || null,
      }),
    };
  });
  writeFileSync(resolve(outDir, "discom-ss.geojson"), JSON.stringify({ type: "FeatureCollection", features: ssFeats }));
  writeFileSync(resolve(outDir, "discom-lines.geojson"), JSON.stringify({ type: "FeatureCollection", features: lineFeats }));

  // Compact per-TRANSCO-SS index for the detail panel (lazy-loaded): feeders as tuples
  // [id, name, discom, km, method, servedSsIds[]] + a 33/11 kV SS lookup [name, discom, lng, lat].
  const bySs: Record<string, unknown[]> = {};
  for (const [tid, fids] of byTransco) {
    bySs[tid] = fids
      .map((id) => {
        const p = lineById.get(id)!.props;
        return [id, p.name, p.discom, p.lengthKm, src.get(id)!.method, serves.get(id) ?? []];
      })
      .sort((a, b) => String(a[1] ?? "~").localeCompare(String(b[1] ?? "~")));
  }
  const ssLookup = Object.fromEntries(allSs.map((s) => [s.id, [s.name, s.discom, s.lng, s.lat]]));
  const methods = { name: 0, proximity: 0, "feeder-group": 0 } as Record<string, number>;
  for (const l of src.values()) methods[l.method]++;
  const servedSsCount = ssFeeders.size;
  const ssWithSource = ssSources.size;
  const connectivity = {
    method:
      `Feeder→TRANSCO: recorded source-SS name matched within ${NAME_MATCH_RADIUS_KM} km, else a feeder end within ` +
      `${PROXIMITY_KM} km of a TRANSCO SS, else inherited from another run of the same feeder. Feeder→33/11 kV SS: ` +
      `same-DISCOM SS within ${SERVES_M} m of the route. Inferred — not a single-line diagram.`,
    feeders: allLines.length,
    feedersLinked: src.size,
    byMethod: methods,
    byDiscom: Object.fromEntries(
      Object.keys(stats).map((d) => {
        const ls = allLines.filter((l) => l.props.discom === d);
        const ssd = allSs.filter((s) => s.discom === d);
        return [d, {
          feeders: ls.length,
          feedersLinked: ls.filter((l) => src.has(l.props.id)).length,
          kmLinked: Math.round(ls.filter((l) => src.has(l.props.id)).reduce((a, l) => a + l.props.lengthKm, 0)),
          kmTotal: Math.round(ls.reduce((a, l) => a + l.props.lengthKm, 0)),
          substations: ssd.length,
          substationsOnFeeder: ssd.filter((s) => ssFeeders.has(s.id)).length,
          substationsTracedToTransco: ssd.filter((s) => ssSources.has(s.id)).length,
        }];
      }),
    ),
    transcoSsWithFeeders: byTransco.size,
    discomSsOnFeeder: servedSsCount,
    discomSsTracedToTransco: ssWithSource,
  };
  writeFileSync(
    resolve(outDir, "transco-33kv.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), method: connectivity.method, bySs, ss: ssLookup }),
  );

  // Statewide download: one row per 33 kV feeder run (linked first, by TRANSCO SS), unlinked at the end.
  const rows = allLines
    .map((l) => {
      const link = src.get(l.props.id);
      const t = link ? tById.get(link.transcoSsId)! : null;
      const served = (serves.get(l.props.id) ?? []).map((id) => ssById.get(id)!.name);
      return [
        t?.name ?? "", t?.ssCode ?? "", t?.voltage ?? "", t?.circle ?? "",
        l.props.discom, l.props.name ?? "Unnamed 33 kV line", l.props.id, l.props.division ?? "", l.props.lengthKm,
        link?.method ?? "unlinked", served.length, served.join("; "),
      ];
    })
    .sort((a, b) => (a[0] === "" ? 1 : 0) - (b[0] === "" ? 1 : 0) || String(a[0]).localeCompare(String(b[0])) || String(a[5]).localeCompare(String(b[5])));
  writeFileSync(
    resolve(outDir, "transco-33kv-connectivity.csv"),
    "\uFEFF" +
      toCsv(
        ["TRANSCO substation", "TRANSCO SS code", "TRANSCO kV", "TRANSCO circle", "DISCOM", "33 kV feeder", "Feeder id", "DISCOM division", "Feeder km", "Link method", "33/11 kV SS served", "33/11 kV substations"],
        rows,
      ),
  );
  console.log(
    `[etl] connectivity: ${src.size}/${allLines.length} feeder runs linked to ${byTransco.size} TRANSCO SS ` +
      `(name ${methods.name}, proximity ${methods.proximity}, group ${methods["feeder-group"]}); ` +
      `${servedSsCount}/${allSs.length} 33/11 kV SS on a feeder, ${ssWithSource} traced to TRANSCO`,
  );
  return { stats, connectivity };
}

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

/**
 * Transmission towers (data/raw/live/towers-<kv>.json from `npm run sync:towers`, grouped by line)
 * → public/data/towers-<kv>.json (dictionary-encoded, each line matched to its core line id by
 * normalised name) + a per-line summary (count, CP/SP, top tower types) folded into lines.geojson.
 */
function buildTowers(outDir: string, lines: Array<{ id: string; name: string }>) {
  const idsByName = new Map<string, string[]>();
  for (const l of lines) {
    const k = normLineName(l.name);
    const a = idsByName.get(k);
    if (a) a.push(l.id);
    else idsByName.set(k, [l.id]);
  }
  const manifestPath = resolve(LIVE_DIR, "towers-manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf-8")) : null;
  const stats = new Map<string, LineTowerStats>();
  const summary: Record<string, unknown> = { lastSuccess: manifest?.lastSuccess ?? null, layers: {} };
  for (const layer of TOWER_LAYERS) {
    const path = resolve(LIVE_DIR, `${layer.name}.json`);
    if (!existsSync(path)) {
      console.log(`[etl] ${layer.name}: not synced yet (npm run sync:towers) — skipped`);
      continue;
    }
    const raw = JSON.parse(readFileSync(path, "utf-8")) as TowersFile;
    const out = buildWebTowers(raw, idsByName, new Date().toISOString());
    for (const [id, st] of out.stats) stats.set(id, st);
    writeFileSync(resolve(outDir, `${layer.name}.json`), JSON.stringify(out.web));
    (summary.layers as Record<string, unknown>)[layer.name] = {
      voltage: layer.voltage,
      towers: raw.count,
      lines: raw.lines.length,
      matchedLines: out.matchedLines,
      matchedTowers: out.matchedTowers,
      fetchedAt: raw.fetchedAt,
      lastChangedAt: manifest?.layers?.[layer.name]?.lastChangedAt ?? null,
    };
    console.log(
      `[etl] ${layer.name}: ${raw.count} towers on ${raw.lines.length} lines → ${out.matchedLines} lines / ` +
        `${out.matchedTowers} towers matched to core lines`,
    );
  }
  return { stats, summary };
}

/**
 * DISCOM 11 kV network (scripts/sync-network.mts → data/raw/live/net-*) → the lazy 11 kV overlay,
 * DTR search shards and the network search tier with upstream trace chains. Reads the 33 kV
 * outputs buildDiscom just wrote (discom-ss / discom-lines / transco-33kv). See etl-network.ts.
 */
function buildNetwork(outDir: string, transco: Substation[]) {
  const live = (f: string) => resolve(LIVE_DIR, f);
  const readJson = <T,>(path: string): T | null => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as T) : null);
  type Fc = { features: Array<{ geometry: { type: string; coordinates: unknown } | null; properties: Record<string, unknown> }> };
  const epLines = readJson<Fc>(live("net-epdcl-11kv.geojson"));
  const spLines = readJson<Fc>(live("net-spdcl-11kv.geojson"));
  if (!epLines && !spLines) {
    console.log("[etl] network: not synced yet (npm run sync:network) — skipped");
    return null;
  }
  const ssFc = readJson<Fc>(resolve(outDir, "discom-ss.geojson"))!;
  const f33Fc = readJson<Fc>(resolve(outDir, "discom-lines.geojson"))!;
  const idx = readJson<{ bySs: Record<string, Array<[string, string | null, string, number, string, string[]]>> }>(resolve(outDir, "transco-33kv.json"))!;
  const ss: SsRef[] = ssFc.features.map((f) => {
    const p = f.properties;
    return { id: String(p.id), discom: String(p.discom), name: String(p.name), lng: Number(p.lng), lat: Number(p.lat) };
  });
  const ssById = new Map(ss.map((s) => [s.id, s]));
  const tLabel = new Map(transco.map((t) => [t.id, `${t.voltage} kV ${t.name}`]));
  const f33Name = new Map(f33Fc.features.map((f) => [String(f.properties.id), (f.properties.name as string | undefined) ?? "Unnamed 33 kV line"]));

  // 33/11 kV SS → (TRANSCO SS, 33 kV feeder) from the inferred 33 kV connectivity.
  const up = new Map<string, { tId: string; f33Id: string }>();
  for (const [tId, feeders] of Object.entries(idx.bySs)) for (const fd of feeders) for (const sid of fd[5]) if (!up.has(sid)) up.set(sid, { tId, f33Id: fd[0] });
  const chains: Chain[] = [];
  const chainIdx = new Map<string, number>();
  const chain = (c: Chain): number => {
    const k = JSON.stringify(c);
    let i = chainIdx.get(k);
    if (i == null) chainIdx.set(k, (i = chains.push(c) - 1));
    return i;
  };
  const ssChain = (ssId: string | null, fallbackName: string | null): number => {
    const s = ssId ? ssById.get(ssId) : null;
    const u = ssId ? up.get(ssId) : null;
    return chain([s?.id ?? null, s?.name ?? fallbackName, u?.f33Id ?? null, u ? (f33Name.get(u.f33Id) ?? null) : null, u?.tId ?? null, u ? (tLabel.get(u.tId) ?? null) : null]);
  };

  const TOL = 0.00015; // ≈ 15 m — 11 kV is only legible from ~z10, where this is sub-pixel
  const ep = epLines ? buildEpdclFeeders(epLines.features, epSsIdIndex(ss), TOL) : [];
  // APSPDCL: full pole-survey routes (scripts/import-spdcl-11kv.mts) where imported; the open-GIS spans
  // only where the import has no coverage (a skipped/truncated circle). IDs re-numbered over both.
  const spSs = ss.filter((s) => s.discom === "APSPDCL");
  const spImport = readSpdclImport();
  const spRoutes = spImport ? buildSpdclRoutes(spImport.features, spSs, TOL) : [];
  let spFallback: F11[] = [];
  let spSpansDropped = 0;
  if (spLines) {
    const covered = spRoutes.length ? coverageMask(spImport!.features.map((f) => partsOfGeom(f.geometry))) : () => false;
    const keep = spLines.features.filter((f) => {
      const parts = partsOfGeom(f.geometry);
      const p = parts[0];
      const hit = p?.length ? covered(p[Math.floor(p.length / 2)]) : false;
      if (hit) spSpansDropped++;
      return !hit;
    });
    spFallback = buildSpdclFeeders(keep, spSs, TOL);
  }
  const sp: F11[] = [...spRoutes, ...spFallback].map((f, i) => ({ ...f, id: `f11-sp-${String(i).padStart(5, "0")}` }));
  if (spImport) console.log(`[etl] network: APSPDCL import ${spRoutes.length} feeders (${Object.keys(spImport.index.circles).length} circles${Object.keys(spImport.index.skipped).length ? `, skipped ${Object.keys(spImport.index.skipped).join(",")}` : ""}); open-GIS spans kept ${spLines ? spLines.features.length - spSpansDropped : 0}, dropped ${spSpansDropped} as covered`);
  const feeders: F11[] = [...ep, ...sp];

  // ---- DTRs + AB switches → per-feeder counts, search shards ----
  const epByCode = new Map(ep.filter((f) => f.code).map((f) => [f.code!, f]));
  const spByName = new Map<string, F11[]>();
  for (const f of sp) {
    const k = f.name.toLowerCase();
    (spByName.get(k) ?? spByName.set(k, []).get(k)!).push(f);
  }
  const counts = new Map<string, { dtrs: number; kva: number; abs: number }>();
  const bump = (id: string, k: "dtrs" | "abs", kva = 0) => {
    const c = counts.get(id) ?? { dtrs: 0, kva: 0, abs: 0 };
    c[k]++;
    c.kva += kva;
    counts.set(id, c);
  };
  const epDtrFile = readJson<GroupedFile>(live("net-epdcl-dtr.json"));
  const spDtrFile = readJson<GroupedFile>(live("net-spdcl-dtr.json"));
  const abFile = readJson<GroupedFile>(live("net-epdcl-ab.json"));
  const epDtr = epDtrFile ? dtrRows(epDtrFile, "dtr_code") : [];
  const spDtr = spDtrFile ? dtrRows(spDtrFile, "serial_number") : [];
  const dtrFeeder = new Map<DtrRow, F11 | null>();
  for (const d of epDtr) dtrFeeder.set(d, epByCode.get(d.feederKey) ?? null);
  for (const d of spDtr) {
    const cands = spByName.get((feederLabelLc(d.feederKey)) ?? "") ?? [];
    let best: F11 | null = null;
    let bestD = Infinity;
    for (const f of cands) {
      const a = anchorOf(f.parts);
      const dd = (a[0] - d.lng) ** 2 + (a[1] - d.lat) ** 2;
      if (dd < bestD) [best, bestD] = [f, dd];
    }
    dtrFeeder.set(d, best);
  }
  for (const [d, f] of dtrFeeder) if (f) bump(f.id, "dtrs", d.kva ?? 0);
  if (abFile) for (const r of abFile.rows) {
    const f = epByCode.get(abFile.groups[r[0] as number].key);
    if (f) bump(f.id, "abs");
  }

  // ---- 11 kV overlay ----
  const lineFeats = feeders.map((f) => {
    const c = counts.get(f.id);
    const ch = chains[ssChain(f.ssId, f.ssName)];
    const props = Object.fromEntries(
      Object.entries({
        id: f.id, kind: "discom11-line", discom: f.discom, name: f.name, code: f.code,
        ss: f.ssId ? ch[1] : f.ssName, ssId: f.ssId, linkMethod: f.linkMethod,
        transcoSs: ch[5], transcoSsId: ch[4],
        section: f.section, subdivision: f.subdivision, division: f.division, circle: f.circle,
        lengthKm: f.lengthKm, poles: f.poles, dtrs: c?.dtrs || null, dtrKva: c?.kva ? Math.round(c.kva) : null, abSwitches: c?.abs || null,
      }).filter(([, v]) => v != null),
    );
    return { type: "Feature", id: f.id, geometry: f.parts.length === 1 ? { type: "LineString", coordinates: f.parts[0] } : { type: "MultiLineString", coordinates: f.parts }, properties: props };
  });
  writeFileSync(resolve(outDir, "discom-11kv-lines.geojson"), JSON.stringify({ type: "FeatureCollection", features: lineFeats }));

  // ---- DTR search shards ----
  const shardOut = new Map<string, { feeders: unknown[][]; fIdx: Map<string, number>; rows: unknown[][] }>();
  const DTR_COLS = ["dtr_capacity", "dtr_phase", "dtr_structure", "type_of_load", "pole_no", "dtr_make", "record_status", "phase", "make", "mounting_type", "no_of_lt_feeders"];
  const addDtr = (shard: string, d: DtrRow, discom: string) => {
    if (!d.code) return;
    let s = shardOut.get(shard);
    if (!s) shardOut.set(shard, (s = { feeders: [], fIdx: new Map(), rows: [] }));
    const f = dtrFeeder.get(d) ?? null;
    const fk = f?.id ?? `?${d.feederKey}`;
    let fi = s.fIdx.get(fk);
    if (fi == null) {
      fi = s.feeders.push([f?.id ?? null, f?.name ?? (d.feederKey || null), f ? ssChain(f.ssId, f.ssName) : -1, discom]) - 1;
      s.fIdx.set(fk, fi);
    }
    const row: unknown[] = [d.code, d.lng, d.lat, fi];
    for (const c of DTR_COLS) row.push(d.attrs[c] ?? null);
    while (row.length > 4 && row[row.length - 1] == null) row.pop();
    s.rows.push(row);
  };
  // Shard keys = the first 4 characters of the DTR code / serial (APEPDCL codes lead with circle +
  // division digits) — a typed code fetches exactly one small shard.
  const shardKey = (prefix: string, code: string) => `${prefix}-${code.slice(0, 4).toLowerCase().replace(/[^a-z0-9]/g, "_") || "xxxx"}`;
  for (const d of epDtr) addDtr(shardKey("ep", d.code), d, "APEPDCL");
  for (const d of spDtr) addDtr(`sp-${d.code.slice(0, 2).toLowerCase().replace(/[^a-z0-9]/g, "_") || "xx"}`, d, "APSPDCL");
  const shards: Record<string, number> = {};
  for (const [k, s] of shardOut) {
    // Dictionary-encode the repetitive attribute columns ("100 KVA", "POLE MOUNTED", "ACTIVE" …).
    const dicts = DTR_COLS.map((_, ci) => [...new Set(s.rows.map((r) => r[4 + ci]).filter((v) => v != null).map(String))].sort());
    const di = dicts.map((d) => new Map(d.map((v, j) => [v, j])));
    const rows = s.rows.map((r) => r.map((v, i) => (i >= 4 && v != null ? di[i - 4].get(String(v)) : v)));
    writeFileSync(resolve(outDir, `net-dtr-${k}.json`), JSON.stringify({ cols: DTR_COLS, dicts, feeders: s.feeders, rows }));
    shards[k] = s.rows.length;
  }

  // ---- Network search tier ----
  type Item = [string, string, string, number, number, string, number];
  const items: Item[] = [];
  for (const f of ss) {
    if (/^unnamed/i.test(f.name)) continue;
    items.push([f.name, "ss33", `${f.discom} · 33/11 kV substation`, f.lng, f.lat, f.id, ssChain(f.id, f.name)]);
  }
  for (const f of f33Fc.features) {
    const p = f.properties;
    if (!p.name) continue;
    const parts = (f.geometry?.type === "LineString" ? [f.geometry.coordinates] : (f.geometry?.coordinates as Position[][])) as Position[][];
    const [lng, lat] = anchorOf(parts);
    const tId = (p.transcoSsId as string | undefined) ?? null;
    items.push([String(p.name), "f33", `${p.discom} · 33 kV feeder${p.transcoSs ? ` from ${p.transcoSs}` : ""}`, lng, lat, String(p.id),
      chain([null, null, String(p.id), String(p.name), tId, tId ? (tLabel.get(tId) ?? null) : null])]);
  }
  const sections = new Map<string, { n: number; lng: number; lat: number; discom: string; label: string; sub: string }>();
  for (const f of feeders) {
    const [lng, lat] = anchorOf(f.parts);
    if (!/^unnamed/i.test(f.name))
      items.push([f.name, "f11", `${f.discom} · 11 kV${f.ssId || f.ssName ? ` from ${chains[ssChain(f.ssId, f.ssName)][1] ?? f.ssName} SS` : ""}${f.section ? ` · ${f.section}` : ""}`, lng, lat, f.id, ssChain(f.ssId, f.ssName)]);
    if (f.section) {
      const k = `${f.discom}|${f.section}|${f.division ?? ""}`;
      const s = sections.get(k) ?? { n: 0, lng: 0, lat: 0, discom: f.discom, label: `${f.section} section`, sub: `${f.discom} · ${[f.subdivision, f.division].filter(Boolean).join(", ")}` };
      s.n++;
      s.lng += lng;
      s.lat += lat;
      sections.set(k, s);
    }
  }
  for (const s of sections.values()) items.push([s.label, "sec", s.sub, r5n(s.lng / s.n), r5n(s.lat / s.n), "", -1]);
  writeFileSync(resolve(outDir, "search-network.json"), JSON.stringify({ generatedAt: new Date().toISOString(), shards, chains, items }));

  const summary: Record<string, unknown> = {};
  for (const discom of ["APEPDCL", "APSPDCL"]) {
    const fs = feeders.filter((f) => f.discom === discom);
    summary[discom] = {
      feeders: fs.length,
      km: Math.round(fs.reduce((a, f) => a + f.lengthKm, 0)),
      feedersLinkedToSs: fs.filter((f) => f.ssId).length,
      dtrs: discom === "APEPDCL" ? epDtr.length : spDtr.length,
      dtrsSearchable: discom === "APEPDCL" ? epDtr.filter((d) => d.code).length : spDtr.filter((d) => d.code).length,
      abSwitches: discom === "APEPDCL" ? (abFile?.count ?? 0) : 0,
      ...(discom === "APSPDCL" && spImport
        ? { routesFrom: spImport.index.vintage, routeCircles: Object.keys(spImport.index.circles).length, routeCirclesSkipped: Object.keys(spImport.index.skipped) }
        : {}),
    };
  }
  console.log(`[etl] network: ${ep.length} APEPDCL + ${sp.length} APSPDCL 11 kV runs; ${epDtr.length + spDtr.length} DTRs; ${items.length} search items; ${chains.length} chains; shards ${Object.keys(shards).join(",")}`);
  return { ...summary, searchItems: items.length };
}
const r5n = (n: number) => Math.round(n * 1e5) / 1e5;
const partsOfGeom = (g: { type: string; coordinates: unknown } | null): Position[][] =>
  !g ? [] : g.type === "LineString" ? [g.coordinates as Position[]] : g.type === "MultiLineString" ? (g.coordinates as Position[][]) : [];
type SpdclIndex = { source: string; vintage: string; circles: Record<string, { feeders: number; km: number; points: number }>; skipped: Record<string, string> };
/** Committed APSPDCL pole-survey routes (data/raw/discom/spdcl-11kv/<circle>.geojson + index.json), or null. */
function readSpdclImport(): { index: SpdclIndex; features: Array<{ geometry: { type: string; coordinates: unknown } | null; properties: Record<string, unknown> }> } | null {
  const dir = resolve("data/raw/discom/spdcl-11kv");
  if (!existsSync(resolve(dir, "index.json"))) return null;
  const index = JSON.parse(readFileSync(resolve(dir, "index.json"), "utf-8")) as SpdclIndex;
  const features = Object.keys(index.circles).sort().flatMap((c) => JSON.parse(readFileSync(resolve(dir, `${c}.geojson`), "utf-8")).features);
  return { index, features };
}
/** APSPDCL DTR feeder names are raw ("WW FEEDER"); compare like the 11 kV run labels. */
function feederLabelLc(raw: string): string | null {
  const s = raw.replace(/^(11\s*k\.?\s*v\.?\s*)+/i, "").replace(/\s+/g, " ").trim();
  return s ? `11kv ${s.toLowerCase()}` : null;
}

async function main(): Promise<void> {
  const outDir = resolve("public/data");
  mkdirSync(outDir, { recursive: true });

  // ==========================================================================
  // Substations — authoritative ESRI shapefile (APTransco SS, TRANSCO-only).
  // Polygon/MultiPolygon footprints → a marker POINT at the ring-vertex centroid.
  // ==========================================================================
  const rawSs = await readLayer("aptransco-ss");

  // The live TRANSCO SS layer is POINTS; the committed snapshot has surveyed compound POLYGONS, which
  // make line-endpoint adjacency far more accurate (80% of endpoints fall inside a compound). So each
  // live point borrows its polygon from the snapshot by SAP id (else the nearest same-voltage
  // polygon within 300 m); a genuinely new SS with no surveyed outline gets a 150 m-radius footprint.
  const snapshotPolys: Array<{ code: string | null; voltage: Voltage | null; rings: Position[][]; c: [number, number] }> = [];
  for (const f of await readShapefile(`${SNAPSHOT_DIR}/aptransco-ss.shp`, `${SNAPSHOT_DIR}/aptransco-ss.dbf`)) {
    const g = f.geometry;
    if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
    snapshotPolys.push({
      code: cleanPgName(f.properties.sap_ss_id as string),
      voltage: normalizeSsVoltage(f.properties.voltage),
      rings: exteriorRings(g as Polygon | MultiPolygon),
      c: polygonCentroid(g as Polygon | MultiPolygon),
    });
  }
  const polyByCode = new Map<string, Position[][]>();
  for (const sp of snapshotPolys) if (sp.code && !polyByCode.has(sp.code)) polyByCode.set(sp.code, sp.rings);
  const footprintSource = { surveyedPolygon: 0, snapshotByCode: 0, snapshotNearest: 0, synthetic: 0 };

  const usedIds = new Set<string>();
  const substations: Substation[] = [];
  const ssPolys: SsPoly[] = []; // parallel footprint set for polygon-based line adjacency
  let ssVoltageDropped = 0;
  const ssVoltageDroppedSamples: string[] = [];
  let ssIdSynthFromName = 0;

  for (const feat of rawSs) {
    const geom = feat.geometry;
    if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon" && geom.type !== "Point")) continue;
    const props = feat.properties;
    const [lng, lat] =
      geom.type === "Point"
        ? [round5((geom as Point).coordinates[0]), round5((geom as Point).coordinates[1])]
        : polygonCentroid(geom as Polygon | MultiPolygon);
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
    let rings: Position[][];
    if (geom.type !== "Point") {
      rings = exteriorRings(geom as Polygon | MultiPolygon);
      footprintSource.surveyedPolygon++;
    } else if (ssCode && polyByCode.has(ssCode)) {
      rings = polyByCode.get(ssCode)!;
      footprintSource.snapshotByCode++;
    } else {
      let best: Position[][] | null = null;
      let bestD = 300;
      for (const sp of snapshotPolys) {
        if (sp.voltage !== voltage) continue;
        const d = haversineMeters([lng, lat], sp.c);
        if (d < bestD) { bestD = d; best = sp.rings; }
      }
      if (best) footprintSource.snapshotNearest++;
      else footprintSource.synthetic++;
      rings = best ?? syntheticFootprint(lng, lat, 150);
    }
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
    { path: "lines-400kv", voltage: 400 },
    { path: "lines-220kv", voltage: 220 },
    { path: "lines-132kv", voltage: 132 },
  ];

  // ---- Build the non-TRANSCO facility point set (display-only external endpoints) ----
  const externalPoints: ExternalPoint[] = [];
  const addExternalPoints = async (
    file: string,
    category: string,
    nameKeys: string[],
  ): Promise<void> => {
    const feats = await readLayer(file);
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
  const adjEnds: Array<["T" | "E" | "N", "T" | "E" | "N"]> = []; // per-line endpoint resolution
  const extCategory: Record<string, number> = {}; // external endpoints by facility category

  for (const { path, voltage } of lineLayers) {
    const feats = await readLayer(path);
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

      // Non-TRANSCO endpoints: for any end that did NOT snap to a TRANSCO SS, try the facility set
      // (Generation / Railway / PowerGrid / HT). These ARE real connections — they're what most of
      // the "unmatched" ends actually terminate at — so we count them toward connectivity below.
      const fromExt = fromSS ? null : snapExternal(firstR, externalPoints, SNAP_THRESHOLD_M);
      const toExt = toSS ? null : snapExternal(lastR, externalPoints, SNAP_THRESHOLD_M);
      const externalEndpoints: { name: string; category: string }[] = [];
      if (fromExt) externalEndpoints.push(fromExt);
      if (toExt && !externalEndpoints.some((e) => e.name === toExt.name && e.category === toExt.category)) {
        externalEndpoints.push(toExt);
      }
      // Per-end connectivity: T = TRANSCO SS, E = external facility, N = nothing within threshold.
      const endKind = (ss: unknown, ext: unknown) => (ss ? "T" : ext ? "E" : "N");
      adjEnds.push([endKind(fromSS, fromExt), endKind(toSS, toExt)]);
      for (const e of [fromExt, toExt]) if (e) extCategory[e.category] = (extCategory[e.category] ?? 0) + 1;

      lines.push({
        id,
        kind: "line",
        name,
        voltage,
        circuit,
        lengthKm,
        ckm: null, // circuit/route accounting needs the whole corridor — filled in below
        circuits: 1,
        routeKm: null,
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

  // ---- Circuit / route accounting ------------------------------------------
  // Each circuit of a DC tower line is usually its own row ("…, Ckt-1" / "…, Ckt-2"). Group those
  // siblings into corridors so route-km is counted once per tower line and circuit-km once per
  // circuit (see `lineAccounting`).
  const corridorSize = new Map<string, number>();
  for (const l of lines) {
    if (circuitTag(l.name) == null) continue;
    const k = corridorKey(l.name, l.voltage);
    corridorSize.set(k, (corridorSize.get(k) ?? 0) + 1);
  }
  for (const l of lines) {
    const size = corridorSize.get(corridorKey(l.name, l.voltage)) ?? 1;
    Object.assign(l, lineAccounting(l.name, l.circuitType, l.lengthKm, size));
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
    const route = l.routeKm ?? 0;
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
  const totalLengthKm = rnd1(lines.reduce((a, l) => a + (l.routeKm ?? 0), 0));
  const totalCircuitKm = rnd1(lines.reduce((a, l) => a + (l.ckm ?? 0), 0));

  // ---- Adjacency stats -----------------------------------------------------
  // TRANSCO-only view (both endpoints land at a TRANSCO substation):
  const both = lines.filter((l) => l.fromSS && l.toSS).length;
  const one = lines.filter((l) => (l.fromSS ? 1 : 0) + (l.toSS ? 1 : 0) === 1).length;
  const none = lines.length - both - one;
  // Connectivity-resolved view: count an endpoint as connected if it lands at a TRANSCO SS OR at a
  // non-TRANSCO facility (Generation / Railway / PowerGrid / HT). Most "missing" TRANSCO ends are
  // really these — so this is the honest connectivity picture.
  const isConn = (k: "T" | "E" | "N") => k !== "N";
  const bothResolved = adjEnds.filter(([a, b]) => isConn(a) && isConn(b)).length;
  const transcoPlusExternal = adjEnds.filter(([a, b]) => (a === "T" && b === "E") || (a === "E" && b === "T")).length;
  const bothExternal = adjEnds.filter(([a, b]) => a === "E" && b === "E").length;
  const unresolvedEither = adjEnds.filter(([a, b]) => a === "N" || b === "N").length; // ≥1 end connects to nothing
  const unmatchedSamples = lines
    .filter((_l, i) => adjEnds[i][0] === "N" || adjEnds[i][1] === "N")
    .slice(0, 25)
    .map((l) => ({ id: l.id, name: l.name, endpoints: l.endpointLabels }));

  // ---- Coastal exposure (distance to the Bay-of-Bengal coastline) ----------
  // Straight-line distance to the committed Natural Earth coastline extract — the canonical
  // cyclone-exposure proxy (AP's coast is the most cyclone-struck in India). Indicative only.
  const coastPath = resolve("data/raw/coastline-ap.geojson");
  console.log(`[etl] reading ${coastPath}`);
  const coastFc = JSON.parse(readFileSync(coastPath, "utf-8")) as FeatureCollection;
  const coast: [number, number][][] = [];
  for (const f of coastFc.features) {
    const g = f.geometry;
    if (g?.type === "LineString") coast.push(g.coordinates as [number, number][]);
    else if (g?.type === "MultiLineString") coast.push(...(g.coordinates as [number, number][][]));
  }
  if (coast.length === 0) {
    console.error("[etl] VALIDATION FAILED: coastline-ap.geojson has no LineString geometry");
    process.exit(1);
  }
  const rnd1km = (km: number) => Math.round(km * 10) / 10;
  const ssCoast = new Map<string, { km: number; band: 0 | 1 | 2 | 3 }>();
  const coastBandCounts: Record<0 | 1 | 2 | 3, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const s of substations) {
    const km = rnd1km(distanceToPolylineKm(s.lng, s.lat, coast));
    const band = coastalBand(km);
    ssCoast.set(s.id, { km, band });
    coastBandCounts[band]++;
  }
  // Lines: minimum distance over the line's geometry vertices.
  const lineCoast = new Map<string, { km: number; band: 0 | 1 | 2 | 3 }>();
  for (const [id, pos] of lineGeoms) {
    let min = Infinity;
    for (const c of pos) min = Math.min(min, distanceToPolylineKm(c[0], c[1], coast));
    const km = rnd1km(min);
    lineCoast.set(id, { km, band: coastalBand(km) });
  }
  console.log(
    `[etl] coastal exposure (${coast.reduce((n, l) => n + l.length, 0)} coastline vertices): ` +
      `SS bands <10km=${coastBandCounts[0]} / 10–25=${coastBandCounts[1]} / 25–50=${coastBandCounts[2]} / inland=${coastBandCounts[3]}`,
  );

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
          // Coastal exposure (indicative straight-line distance to the Natural Earth coastline)
          coastalKm: ssCoast.get(s.id)!.km,
          coastalBand: ssCoast.get(s.id)!.band,
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
          circuits: l.circuits,
          routeKm: l.routeKm,
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
          // Coastal exposure (min over the line's vertices; indicative straight-line distance)
          coastalKm: lineCoast.get(l.id)!.km,
          coastalBand: lineCoast.get(l.id)!.band,
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
    source:
      layerSources["aptransco-ss"] === "live"
        ? "AP-TRANSCO enterprise GIS (gis.aptransco.gov.in, live REST pull) — Transco SS + Lines 400/220/132 kV"
        : "AP-TRANSCO Gridmap ESRI shapefiles (APTransco SS + Lines 400/220/132 kV)",
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
    substationSchemas: { [layerSources["aptransco-ss"] === "live" ? "aptranscoLive" : "aptranscoShapefile"]: substations.length },
    layerSources,
    substationFootprints: footprintSource,
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
      // Connectivity-resolved view (TRANSCO SS or non-TRANSCO facility counts as a connection):
      linesBothEndsResolved: bothResolved,
      pctBothEndsResolved: Math.round((bothResolved / lines.length) * 1000) / 10,
      linesTranscoPlusExternal: transcoPlusExternal,
      linesBothExternal: bothExternal,
      linesUnresolvedEnd: unresolvedEither,
      externalEndpointsByCategory: extCategory,
      unmatchedSamples,
    },
    circuitAmbiguousLines: { count: 0, samples: [] as string[] },
    voltageMismatchLines: { count: 0, samples: [] as string[] },
    droppedDuplicates: [] as Array<{ name: string; lng: number; lat: number; keptId: string }>,
    coordWarnings,
    coastalExposure: {
      source: "Natural Earth 10m coastline, AP Bay-of-Bengal extract (indicative straight-line distance)",
      substationBands: {
        "<10km": coastBandCounts[0],
        "10-25km": coastBandCounts[1],
        "25-50km": coastBandCounts[2],
        ">=50km": coastBandCounts[3],
      },
    },
  };

  // ---- Transmission towers (lazy overlay) + per-line tower summary ----------
  const towers = buildTowers(outDir, lines);
  for (const f of lineFc.features) {
    const st = towers.stats.get(String(f.properties!.id));
    if (st) f.properties!.towers = st;
  }

  writeFileSync(resolve(outDir, "substations.geojson"), JSON.stringify(ssFc));
  writeFileSync(resolve(outDir, "lines.geojson"), JSON.stringify(lineFc));
  writeFileSync(resolve(outDir, "search-index.json"), JSON.stringify(searchIndex));
  writeFileSync(resolve(outDir, "meta.json"), JSON.stringify(meta, null, 2));
  writeFileSync(resolve(outDir, "data-quality.json"), JSON.stringify(dataQuality, null, 2));

  console.log(`[etl] wrote ${substations.length} substations, ${lines.length} lines`);
  const extMix = Object.entries(extCategory).map(([k, v]) => `${k} ${v}`).join(", ");
  console.log(
    `[etl] adjacency: both-TRANSCO=${both} (${dataQuality.adjacency.pctBoth}%)` +
      ` | both-ends-resolved=${bothResolved} (${dataQuality.adjacency.pctBothEndsResolved}%)` +
      ` [+${transcoPlusExternal} TRANSCO+external, ${bothExternal} both-external] | unresolved=${unresolvedEither}` +
      ` | route ${totalLengthKm} km · circuit ${totalCircuitKm} km · ${circles.length} circles` +
      ` | external ends: ${extMix}` +
      (coordWarnings.length ? ` | ${coordWarnings.length} coord warning(s)` : ""),
  );

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

  writeLiveStatus(outDir, { discom, footprintSource, connectivity, towers: towers.summary, network });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });

export { main };
