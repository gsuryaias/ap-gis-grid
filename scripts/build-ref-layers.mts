/**
 * Reference-layer ETL — RTGS (AP Real-Time Governance Society) shapefile library → curated,
 * web-ready GeoJSON in public/data/ref/ + public/data/ref/catalog.json.
 *
 *   RTGS_DIR="/path/to/RTGS data" npx tsx scripts/build-ref-layers.mts
 *
 * This is a RUN-LOCALLY-THEN-COMMIT build: the RTGS library lives on a private OneDrive, so CI
 * never runs this script — it consumes the committed outputs (integrity-checked by
 * scripts/ref-layers.test.ts).
 *
 * Per layer: read .shp/.shx/.dbf/.prj/.cpg into memory (source treated as untrusted data — only
 * parsed, never executed) → mapshaper: reproject to WGS84 (several layers are UTM 44N),
 * optional filter / dissolve / clip, topology-preserving Visvalingam-weighted simplification with
 * keep-shapes, 5-dp output → JS: whitelist + rename attributes to lowerCamel, trim strings and
 * null out empties/placeholders, guarantee a `name` key, de-duplicate points → validate
 * (non-empty, AP bbox, geometry kind, ≤ 5 MB) → write.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

const require = createRequire(import.meta.url);
// mapshaper ships no type declarations; its Node API is used via applyCommands only.
const mapshaper = require("mapshaper") as {
  applyCommands(cmd: string, input: Record<string, Buffer | string>): Promise<Record<string, string | Buffer>>;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "data", "ref");
const RTGS_DIR =
  process.env.RTGS_DIR ??
  "/Users/praveenchand/Library/CloudStorage/OneDrive-Personal/IAS/GIS/RTGS_Data/RTGS data";

/** AP bounding box with margin — every emitted coordinate must fall inside. */
export const AP_BBOX = { minLng: 76, maxLng: 85.5, minLat: 12, maxLat: 20 } as const;
const HARD_CAP_BYTES = 5 * 1024 * 1024;
const SOFT_CAP_BYTES = 2.5 * 1024 * 1024;

type Group = "Boundaries" | "Transport" | "Environment" | "Water" | "Hazards";
type Kind = "polygon" | "line" | "point";
type Raw = Record<string, unknown>;
type Props = Record<string, string | number | null>;

interface LayerSpec {
  id: string;
  group: Group;
  label: string;
  /** path relative to RTGS_DIR, without extension */
  src: string;
  geometry: Kind;
  department: string;
  /** mapshaper commands run after `-i … -proj wgs84`, before simplification */
  ms?: string;
  /** % of removable vertices retained (Visvalingam weighted, topology-preserving, keep-shapes) */
  simplify?: number;
  /** source record → kept properties (must include `name`) */
  props: (r: Raw) => Props;
  note: string | null;
  /** fixed vintage (event layers); otherwise derived from the ESRI metadata CreaDate year */
  vintage?: string | null;
}

export interface CatalogEntry {
  id: string;
  group: Group;
  label: string;
  geometry: Kind;
  file: string;
  count: number;
  bytes: number;
  labelField: "name" | null;
  fields: string[];
  source: string;
  vintage: string | null;
  note: string | null;
}

// ─── attribute cleaning ──────────────────────────────────────────────────────

const PLACEHOLDERS = new Set(["", "na", "n/a", "nil", "null", "<null>", "-", "--", "0"]);

/** Trim + collapse whitespace; empty / placeholder → null. */
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return PLACEHOLDERS.has(s.toLowerCase()) ? null : s;
}

/** Finite number (rounded to `dp`), or null for missing / non-positive placeholders. */
function num(v: unknown, dp = 2): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** ISO-ish date (mapshaper renders DBF dates as ISO strings) → YYYY-MM-DD. */
function isoDate(v: unknown): string | null {
  const s = str(v);
  const m = s?.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// ─── layer specs (catalog order) ─────────────────────────────────────────────

const SIMPLIFY = (pct: number) => `-simplify ${pct}% weighted keep-shapes`;

const LAYERS: LayerSpec[] = [
  // Boundaries
  {
    id: "districts", group: "Boundaries", label: "Districts", geometry: "polygon",
    src: "Administrative Boundaries/Andhra-District Bnd", department: "Administrative Boundaries",
    // no ESRI metadata beside this file; it ships with the mandal layer (CreaDate 2022-09-16, 26-district set)
    vintage: "2022",
    simplify: 20, note: "reprojected from UTM 44N",
    props: (r) => ({ name: str(r.District), code: str(r.DstCodeAP) }),
  },
  {
    id: "mandals", group: "Boundaries", label: "Mandals", geometry: "polygon",
    src: "Administrative Boundaries/Andhra-Mandal Bnd", department: "Administrative Boundaries",
    simplify: 15, note: "reprojected from UTM 44N",
    props: (r) => ({
      name: str(r.Mandal), district: str(r.District), revenueDivision: str(r.ReDivision),
      assembly: str(r.Assembly), parliament: str(r.Parliament),
    }),
  },
  {
    id: "revenue-divisions", group: "Boundaries", label: "Revenue divisions", geometry: "polygon",
    src: "Administrative Boundaries/Revenue_Division_Boundary", department: "Administrative Boundaries",
    simplify: 15, note: null,
    props: (r) => ({ name: str(r.revenue_di), district: str(r.district), areaSqKm: num(r.revenue__1) }),
  },
  {
    id: "assembly", group: "Boundaries", label: "Assembly constituencies", geometry: "polygon",
    src: "Electoral_Boundaries/Assembly_Boundary", department: "Electoral Boundaries",
    simplify: 12, note: null,
    props: (r) => ({
      name: str(r.assembly), code: str(r.assembly_c), reservation: str(r.assembly_t),
      parliament: str(r.parliament), district: str(r.district),
    }),
  },
  {
    id: "parliament", group: "Boundaries", label: "Parliamentary constituencies", geometry: "polygon",
    src: "Electoral_Boundaries/Parliament_Boundary", department: "Electoral Boundaries",
    simplify: 15, note: null,
    props: (r) => ({
      name: str(r.parliament), code: str(r.parliame_1), reservation: str(r.parliame_2),
      districts: str(r.district),
    }),
  },
  {
    id: "municipal", group: "Boundaries", label: "Urban local bodies", geometry: "polygon",
    src: "MAUD/Municipal_Boundary", department: "MA&UD",
    simplify: 12, note: null,
    props: (r) => ({ name: str(r.ulb_name), district: str(r.district), areaSqKm: num(r.ulb_area_s) }),
  },
  {
    id: "district-hq", group: "Boundaries", label: "District headquarters", geometry: "point",
    src: "Administrative Labels/District_Headquarters_26", department: "Administrative Labels",
    note: null,
    props: (r) => ({ name: str(r.district_h), district: str(r.district) }),
  },
  {
    id: "mandal-hq", group: "Boundaries", label: "Mandal headquarters", geometry: "point",
    src: "Administrative Labels/Mandal_Headquarters_679", department: "Administrative Labels",
    note: null,
    props: (r) => ({ name: str(r.mandal_hea), district: str(r.district), revenueDivision: str(r.revenue_di) }),
  },
  // Transport
  {
    id: "national-highways", group: "Transport", label: "National highways", geometry: "line",
    src: "Roads_Buildings/Roads/National_Highway", department: "Roads & Buildings",
    simplify: 8, note: null,
    props: (r) => ({
      name: str(r.nh_number), route: str(r.road_name), agency: str(r.category), lengthKm: num(r.length_km),
    }),
  },
  {
    id: "state-highways", group: "Transport", label: "State highways", geometry: "line",
    src: "Roads_Buildings/Roads/State_Highway", department: "Roads & Buildings",
    simplify: 2, note: "source is very densely digitised",
    props: (r) => ({
      name: str(r.sh_number), route: str(r.road_name), circle: str(r.circle), lengthKm: num(r.length_km),
    }),
  },
  {
    id: "railways", group: "Transport", label: "Railway lines", geometry: "line",
    src: "Physical_Infrastructure/Railway_Network", department: "Physical Infrastructure",
    simplify: 40, note: "source has no line names",
    props: (r) => ({
      name: null, gauge: str(r.type),
      zone: str(r.code)?.replace(/Easteran/g, "Eastern") ?? null, ownership: str(r.status),
    }),
  },
  {
    id: "railway-stations", group: "Transport", label: "Railway stations", geometry: "point",
    src: "Physical_Infrastructure/Railway_Stations_460", department: "Physical Infrastructure",
    note: null,
    props: (r) => ({
      name: str(r.station_na), code: str(r.code), category: str(r.type),
      mandal: str(r.mandal), district: str(r.district),
    }),
  },
  {
    id: "airports", group: "Transport", label: "Airports & airstrips", geometry: "point",
    src: "Physical_Infrastructure/Airport_Location_14", department: "Physical Infrastructure",
    note: null,
    props: (r) => ({
      name: str(r.airport_na), category: str(r.category), status: str(r.status), district: str(r.district),
    }),
  },
  {
    id: "seaports", group: "Transport", label: "Seaports & harbours", geometry: "point",
    src: "Physical_Infrastructure/Seaport_Location_19", department: "Physical Infrastructure",
    note: null,
    props: (r) => ({
      name: str(r.seaport_na), category: str(r.category), status: str(r.status), district: str(r.district),
    }),
  },
  // Environment
  {
    id: "reserve-forest", group: "Environment", label: "Reserve forests", geometry: "polygon",
    src: "Forest/Reserve_Forest", department: "Forest",
    // 10k forest compartments → dissolved to beat level (compartment numbers are not useful at
    // z6–12 and many are placeholders: 1000×601, 0×83).
    simplify: 8,
    ms: "-dissolve2 fields=division,range,beat copy-fields=section,district",
    note: "compartments dissolved to forest beats",
    props: (r) => ({
      name: str(r.beat), section: str(r.section), range: str(r.range),
      division: str(r.division), district: str(r.district),
    }),
  },
  {
    id: "forest", group: "Environment", label: "Forest blocks", geometry: "polygon",
    src: "Forest/Forest", department: "Forest",
    simplify: 12, note: null,
    props: (r) => ({ name: str(r.reserve_fo), areaSqKm: num(r.forest_are) }),
  },
  {
    id: "wildlife", group: "Environment", label: "Wildlife sanctuaries & national parks", geometry: "polygon",
    src: "Forest/Wildlife", department: "Forest",
    simplify: 30, note: null,
    props: (r) => ({ name: str(r.wildlife_n), type: str(r.type), areaSqKm: num(r.area_sqkm) }),
  },
  {
    id: "eco-sensitive", group: "Environment", label: "Eco-sensitive zones", geometry: "polygon",
    src: "Forest/Eco_Sensitive_Zones", department: "Forest",
    simplify: 40, note: "name is the protected area the ESZ surrounds",
    props: (r) => ({ name: str(r.eco_sensit), areaSqKm: num(r.area_sqkm) }),
  },
  {
    id: "crz-boundary", group: "Environment", label: "CRZ boundary", geometry: "line",
    src: "EnvironmentPCBDept/CRZ_Boundary", department: "Environment / APPCB",
    simplify: 10, note: "Coastal Regulation Zone limit line",
    props: () => ({ name: null }),
  },
  {
    id: "mining", group: "Environment", label: "Mining leases", geometry: "point",
    src: "MinesAndGeology/Mining_Locations_2124", department: "Mines & Geology",
    // Lease footprints are ~1–5 ha (invisible below z13) → represented by an interior point.
    ms: "-each '_bx = (this.bounds[0] + this.bounds[2]) / 2, _by = (this.bounds[1] + this.bounds[3]) / 2' -points inner",
    note: "lease polygons (mostly 1–5 ha) reduced to interior points",
    props: (r) => ({
      // The lessee (`lease_name`) is frequently a private individual — deliberately NOT published.
      name: str(r.mineral) ? `${str(r.mineral)} lease` : "Mining lease", mineral: str(r.mineral), status: str(r.status),
      extentHa: num(r.extent_in_), expiry: isoDate(r.expiry_dat), district: str(r.district),
    }),
  },
  // Water
  {
    id: "rivers", group: "Water", label: "Rivers", geometry: "polygon",
    src: "Water Resources/Rivers", department: "Water Resources",
    simplify: 6, note: "river-bed (spread area) polygons",
    props: (r) => ({ name: str(r.river_name), basin: str(r.major_basi) }),
  },
  {
    id: "reservoirs", group: "Water", label: "Reservoirs & barrages", geometry: "polygon",
    src: "Water Resources/Reservoirs", department: "Water Resources",
    simplify: 12, note: null,
    props: (r) => ({
      name: str(r.name), category: str(r.category), type: str(r.type),
      basin: str(r.basin), district: str(r.district),
    }),
  },
  {
    id: "canals", group: "Water", label: "Major canals", geometry: "line",
    src: "Water Resources/Canals", department: "Water Resources",
    simplify: 15,
    ms:
      `-filter "['Main Canal','Major Canal','Main Channel','Branch Canal','Lift Canal','Major Drain'].indexOf(canal_type) > -1" `,
    note: "main, major, branch & lift canals + major drains only (minor/sub channels, distributaries and minor drains dropped)",
    props: (r) => ({ name: str(r.canal_name), type: str(r.canal_type) }),
  },
  // Hazards
  {
    id: "seismic-zones", group: "Hazards", label: "Seismic zones", geometry: "polygon",
    src: "Disaster Management/Seismicity", department: "Disaster Management",
    simplify: 15, note: null,
    props: (r) => ({ name: str(r.zone), intensity: str(r.intensity) }),
  },
  {
    id: "cyclone-shelters", group: "Hazards", label: "Cyclone shelters", geometry: "point",
    src: "Disaster Management/Cyclone_Shelters_219", department: "Disaster Management",
    note: null,
    props: (r) => ({ name: str(r.location), mandal: str(r.mandal), district: str(r.district) }),
  },
  {
    id: "flood-2024-09-03", group: "Hazards", label: "Flood inundation, 3 Sep 2024", geometry: "polygon",
    src: "Disaster Management/Flood Layers/Flood_Sept_2024/Flood_Inundation_03_09_2024_Source_NRSC",
    department: "Disaster Management",
    // 38,605 raster-cell polygons (gridcode=1) → dissolved, split into patches, specks < 1 ha dropped.
    simplify: 8,
    ms:
      "-dissolve2 -explode -filter-islands min-area=10000 remove-empty " +
      "-each 'areaSqKm = Math.round(this.area / 1e3) / 1e3' -filter 'areaSqKm >= 0.01' ",
    vintage: "2024-09-03",
    note: "NRSC satellite-derived extent (Vijayawada/Budameru); raster cells dissolved into patches, < 1 ha dropped",
    props: (r) => ({ name: null, areaSqKm: num(r.areaSqKm, 3) }),
  },
  {
    id: "michaung-track", group: "Hazards", label: "Cyclone Michaung track", geometry: "line",
    src: "Disaster Management/Flood Layers/Michaung_cyclone_06-12-2023/Michaung_Cyclone_Track_Line",
    department: "Disaster Management",
    ms: `-clip bbox=${AP_BBOX.minLng},${AP_BBOX.minLat},${AP_BBOX.maxLng},${AP_BBOX.maxLat}`,
    vintage: "2023-12",
    note: "track clipped to the AP window (full track starts at 9.1°N, 86.4°E in the Bay of Bengal)",
    props: () => ({ name: null }),
  },
];

// ─── geometry helpers ────────────────────────────────────────────────────────

const KIND_TYPES: Record<Kind, string[]> = {
  polygon: ["Polygon", "MultiPolygon"],
  line: ["LineString", "MultiLineString"],
  point: ["Point", "MultiPoint"],
};

function eachPosition(g: Geometry, fn: (p: Position) => void): void {
  switch (g.type) {
    case "Point": fn(g.coordinates); break;
    case "MultiPoint": case "LineString": g.coordinates.forEach(fn); break;
    case "MultiLineString": case "Polygon": g.coordinates.forEach((l) => l.forEach(fn)); break;
    case "MultiPolygon": g.coordinates.forEach((p) => p.forEach((l) => l.forEach(fn))); break;
    case "GeometryCollection": g.geometries.forEach((x) => eachPosition(x, fn)); break;
  }
}

const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

// ─── build ───────────────────────────────────────────────────────────────────

/** Year of the ESRI metadata CreaDate (YYYYMMDD) beside the shapefile, if any. */
function metadataYear(base: string): string | null {
  for (const p of [`${base}.shp.xml`, `${base}.xml`]) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, "utf8").match(/<CreaDate>\s*(\d{4})\d{4}\s*</);
    if (m) return m[1];
  }
  return null;
}

async function runMapshaper(id: string, ms: string, input: Record<string, Buffer>): Promise<FeatureCollection> {
  const cmd = `-i src.shp -proj wgs84 ${ms} -o out.geojson format=geojson precision=0.00001`;
  const out = await mapshaper.applyCommands(cmd, input);
  const text = out["out.geojson"];
  if (text === undefined) throw new Error(`${id}: mapshaper produced no output`);
  return JSON.parse(String(text)) as FeatureCollection;
}

async function buildLayer(spec: LayerSpec): Promise<CatalogEntry | null> {
  const base = join(RTGS_DIR, spec.src);
  const input: Record<string, Buffer> = {};
  for (const ext of ["shp", "shx", "dbf", "prj", "cpg"]) {
    const p = `${base}.${ext}`;
    if (existsSync(p)) input[`src.${ext}`] = readFileSync(p);
  }
  if (!input["src.shp"] || !input["src.dbf"]) {
    console.warn(`⚠ ${spec.id}: missing ${spec.src}.shp/.dbf — skipped`);
    return null;
  }
  if (!input["src.prj"]) {
    console.warn(`⚠ ${spec.id}: no .prj — cannot verify CRS — skipped`);
    return null;
  }

  const pre = spec.ms ?? "";
  const fc = await runMapshaper(spec.id, spec.simplify ? `${pre} ${SIMPLIFY(spec.simplify)}` : pre, input);
  // Simplification can collapse tiny CLOSED polylines (e.g. CRZ loops round creeks) to a
  // degenerate segment that is dropped on output; keep-shapes only protects polygons. Back-fill
  // those features from an unsimplified run (same commands minus -simplify ⇒ same order).
  const collapsed = fc.features.filter((f) => !f.geometry).length;
  if (collapsed && spec.simplify) {
    const raw = await runMapshaper(spec.id, pre, input);
    if (raw.features.length === fc.features.length) {
      fc.features.forEach((f, i) => { if (!f.geometry) f.geometry = raw.features[i].geometry; });
      console.log(`  ${spec.id}: ${collapsed} features collapsed by simplification — kept unsimplified`);
    }
  }
  // Degenerate source polygons have no interior point; fall back to their bbox centre.
  for (const f of fc.features) {
    const p = f.properties ?? {};
    if (!f.geometry && typeof p._bx === "number" && typeof p._by === "number") {
      f.geometry = { type: "Point", coordinates: [p._bx, p._by] };
    }
  }

  const allowed = KIND_TYPES[spec.geometry];
  const seen = new Set<string>();
  let dropped = 0;
  let dupes = 0;
  const features: Feature[] = [];
  for (const f of fc.features) {
    if (!f.geometry || !allowed.includes(f.geometry.type)) { dropped++; continue; }
    eachPosition(f.geometry, (p) => { p[0] = r5(p[0]); p[1] = r5(p[1]); p.length = 2; });
    const properties = spec.props((f.properties ?? {}) as Raw);
    if (spec.geometry === "point") {
      const key = JSON.stringify([f.geometry, properties]);
      if (seen.has(key)) { dupes++; continue; }
      seen.add(key);
    }
    features.push({ type: "Feature", properties, geometry: f.geometry });
  }
  if (dropped) console.warn(`  ${spec.id}: dropped ${dropped} features with empty/unexpected geometry`);
  if (dupes) console.log(`  ${spec.id}: dropped ${dupes} exact duplicate points`);

  // validation
  if (features.length === 0) throw new Error(`${spec.id}: 0 features after processing`);
  for (const f of features) {
    eachPosition(f.geometry, ([x, y]) => {
      if (!(x >= AP_BBOX.minLng && x <= AP_BBOX.maxLng && y >= AP_BBOX.minLat && y <= AP_BBOX.maxLat)) {
        throw new Error(`${spec.id}: coordinate [${x}, ${y}] outside AP bbox`);
      }
    });
  }

  const json = JSON.stringify({ type: "FeatureCollection", features } satisfies FeatureCollection);
  const bytes = Buffer.byteLength(json);
  if (bytes > HARD_CAP_BYTES) throw new Error(`${spec.id}: ${bytes} bytes exceeds 5 MB hard cap`);
  if (bytes > SOFT_CAP_BYTES) console.warn(`  ${spec.id}: ${(bytes / 1048576).toFixed(2)} MB exceeds 2.5 MB target`);
  writeFileSync(join(OUT_DIR, `${spec.id}.geojson`), json);

  const fields = Object.keys(features[0].properties ?? {});
  const named = features.some((f) => f.properties?.name != null);
  console.log(`✓ ${spec.id.padEnd(18)} ${String(features.length).padStart(6)} feat  ${(bytes / 1024).toFixed(0).padStart(6)} KB`);
  return {
    id: spec.id,
    group: spec.group,
    label: spec.label,
    geometry: spec.geometry,
    file: `ref/${spec.id}.geojson`,
    count: features.length,
    bytes,
    labelField: named ? "name" : null,
    fields,
    source: `RTGS GIS library — ${spec.department}`,
    vintage: spec.vintage !== undefined ? spec.vintage : metadataYear(base),
    note: [spec.simplify ? `simplified ${spec.simplify}%` : null, spec.note].filter(Boolean).join("; ") || null,
  };
}

async function main(): Promise<void> {
  if (!existsSync(RTGS_DIR) || !statSync(RTGS_DIR).isDirectory()) {
    console.error(
      `RTGS_DIR not found: ${RTGS_DIR}\n` +
        `This build needs the RTGS shapefile library (local-only; not available in CI). ` +
        `Set RTGS_DIR to the "RTGS data" folder and re-run; commit public/data/ref/*.`,
    );
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const only = process.argv.slice(2);
  const catalog: CatalogEntry[] = [];
  const skipped: string[] = [];
  for (const spec of LAYERS) {
    if (only.length && !only.includes(spec.id)) continue;
    const entry = await buildLayer(spec);
    if (entry) catalog.push(entry);
    else skipped.push(spec.id);
  }
  if (only.length) {
    console.log("(partial run — catalog.json not rewritten)");
    return;
  }
  writeFileSync(join(OUT_DIR, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
  const total = catalog.reduce((s, c) => s + c.bytes, 0);
  console.log(`\n${catalog.length} layers, ${(total / 1048576).toFixed(2)} MB total → public/data/ref/`);
  if (skipped.length) console.warn(`skipped: ${skipped.join(", ")}`);
}

await main();
