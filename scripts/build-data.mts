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
import type { Feature, FeatureCollection, LineString, Point, Position } from "geojson";
import {
  ALIASES,
  classifyFolder,
  detectNameFlags,
  haversineMeters,
  parseDescriptionTable,
  parseEndpointLabels,
  pick,
  round5,
  snapEndpoint,
  type Circuit,
  type LineFeature,
  type SnapPoint,
  type Substation,
} from "./etl-lib.ts";

const SNAP_THRESHOLD_M = 500;
const AP_BBOX = { minLng: 76.3, maxLng: 84.9, minLat: 12.5, maxLat: 19.3 };

interface TreeNode {
  type: string;
  meta?: { name?: string } & Record<string, unknown>;
  name?: string;
  children?: TreeNode[];
  geometry?: Point | LineString | null;
  properties?: Record<string, unknown> | null;
}

function folderName(n: TreeNode): string {
  return (n.meta?.name ?? n.name ?? "") as string;
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

interface RawFeature {
  cls: NonNullable<ReturnType<typeof classifyFolder>>;
  feature: TreeNode;
}

function walk(node: TreeNode, cls: ReturnType<typeof classifyFolder>, out: RawFeature[]): void {
  if (node.type === "Feature") {
    if (cls) out.push({ cls, feature: node });
    return;
  }
  const here = classifyFolder(folderName(node)) ?? cls;
  for (const child of node.children ?? []) walk(child, here, out);
}

function main(): void {
  const kmlPath = resolve("data/raw/Transco.kml");
  const outDir = resolve("public/data");
  mkdirSync(outDir, { recursive: true });

  console.log(`[etl] reading ${kmlPath}`);
  const xml = readFileSync(kmlPath, "utf-8");
  const doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  const tree = kmlWithFolders(doc) as unknown as TreeNode;

  const raw: RawFeature[] = [];
  walk(tree, null, raw);

  const rawPoints = raw.filter((r) => r.feature.geometry?.type === "Point");
  const rawLines = raw.filter((r) => r.feature.geometry?.type === "LineString");
  console.log(`[etl] parsed ${rawPoints.length} points, ${rawLines.length} lines`);

  // ---- Substations ---------------------------------------------------------
  const usedIds = new Set<string>();
  const substations: Substation[] = [];
  const droppedDuplicates: Array<{ name: string; lng: number; lat: number; keptId: string }> = [];
  const coordKeyToId = new Map<string, string>();
  const schemaCounts = { sap: 0, sscode: 0, legacy400: 0, unknown: 0 };
  const unknownSchemaSamples: string[] = [];

  for (const { cls, feature } of rawPoints) {
    const props = feature.properties ?? {};
    const table = parseDescriptionTable(getDescriptionHtml(props));
    const coords = (feature.geometry as Point).coordinates;
    const lng = round5(coords[0]);
    const lat = round5(coords[1]);
    const name = (props.name ? String(props.name) : pick(table, ALIASES.shortName)) ?? "Unnamed";
    const cleanName = name.replace(/\s+/g, " ").trim();

    // schema variant (for the quality report)
    if (table.has("SAP SS ID")) schemaCounts.sap++;
    else if (table.has("SUBSTATION NAME")) schemaCounts.legacy400++;
    else if (table.has("SUBSTATION")) schemaCounts.sscode++;
    else {
      schemaCounts.unknown++;
      if (unknownSchemaSamples.length < 10) unknownSchemaSamples.push(cleanName);
    }

    const coordKey = `${lng},${lat}`;
    if (coordKeyToId.has(coordKey)) {
      droppedDuplicates.push({ name: cleanName, lng, lat, keptId: coordKeyToId.get(coordKey)! });
      continue; // exact-coordinate coincident duplicate (only "Tadimarri" in current data)
    }

    const ssCode = pick(table, ALIASES.ssCode);
    const id = uniqueId(`s-${slug(ssCode ?? `${cls.voltage}-${substations.length}`)}`, usedIds);
    coordKeyToId.set(coordKey, id);

    substations.push({
      id,
      kind: "substation",
      name: cleanName,
      descriptiveName: pick(table, ALIASES.descriptiveName),
      ssCode,
      voltage: cls.voltage,
      circle: pick(table, ALIASES.circle),
      circleInferred: false,
      doc: pick(table, ALIASES.doc),
      lng,
      lat,
      connectedLineIds: [],
    });
  }

  // Circle inference: the source records 'Circle' only for 132 kV substations, so 400/220 kV
  // (and any circle-less) substations are assigned the circle of the nearest circle-bearing
  // substation. Circles are contiguous regions, so this is a sound spatial inference (flagged).
  const circleBearers = substations.filter((s) => s.circle);
  let inferredCircles = 0;
  for (const s of substations) {
    if (s.circle) continue;
    let best: (typeof circleBearers)[number] | null = null;
    let bestDist = Infinity;
    for (const t of circleBearers) {
      const d = haversineMeters([s.lng, s.lat], [t.lng, t.lat]);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    if (best) {
      s.circle = best.circle;
      s.circleInferred = true;
      inferredCircles++;
    }
  }

  // ---- Lines ---------------------------------------------------------------
  const snapPoints: SnapPoint[] = substations.map((s) => ({ id: s.id, lng: s.lng, lat: s.lat }));
  const lines: LineFeature[] = [];
  const lineGeoms = new Map<string, Position[]>();
  let lineSeq = 0;

  for (const { cls, feature } of rawLines) {
    const props = feature.properties ?? {};
    const table = parseDescriptionTable(getDescriptionHtml(props));
    const geom = feature.geometry as LineString;
    const positions: Position[] = geom.coordinates.map((c) => [round5(c[0]), round5(c[1])]);
    const name = (props.name ? String(props.name) : pick(table, ALIASES.lineName)) ?? "Unnamed line";
    const cleanName = name.replace(/\s+/g, " ").trim();
    const circuit = cls.circuit as Circuit;
    const voltage = cls.voltage;

    const lengthRaw = pick(table, ALIASES.lineLength);
    const lengthKm = lengthRaw != null && !Number.isNaN(Number(lengthRaw)) ? Number(lengthRaw) : null;
    const flags = detectNameFlags(cleanName, voltage, circuit);

    const id = uniqueId(`l-${String(lineSeq++).padStart(3, "0")}`, usedIds);
    const first = positions[0] as [number, number];
    const last = positions[positions.length - 1] as [number, number];
    const fromSS = snapEndpoint(first, snapPoints, SNAP_THRESHOLD_M);
    const toSS = snapEndpoint(last, snapPoints, SNAP_THRESHOLD_M);
    const connectsSS = [...new Set([fromSS?.ssId, toSS?.ssId].filter(Boolean) as string[])];

    let circle: string | null = null;
    for (const ssId of connectsSS) {
      const ss = substations.find((s) => s.id === ssId);
      ss?.connectedLineIds.push(id);
      if (!circle && ss?.circle) circle = ss.circle; // inherit circle from a connected SS
    }

    const ckm = lengthKm != null ? Math.round(lengthKm * (circuit === "DC" ? 2 : 1) * 1000) / 1000 : null;

    lines.push({
      id,
      kind: "line",
      name: cleanName,
      voltage,
      circuit,
      lengthKm,
      ckm,
      circle,
      connectsSS,
      endpointLabels: parseEndpointLabels(cleanName),
      fromSS,
      toSS,
      circuitAmbiguous: flags.circuitAmbiguous,
      voltageMismatch: flags.voltageMismatch,
    });
    lineGeoms.set(id, positions);
  }

  // ---- Validation gate -----------------------------------------------------
  const errors: string[] = [];
  if (rawPoints.length !== 500) errors.push(`expected 500 substations, got ${rawPoints.length}`);
  if (rawLines.length !== 715) errors.push(`expected 715 lines, got ${rawLines.length}`);
  for (const s of substations) {
    if (!Number.isFinite(s.lng) || !Number.isFinite(s.lat)) errors.push(`bad coords: ${s.name}`);
    if (!s.name) errors.push(`substation missing name: ${s.id}`);
  }
  for (const [id, pos] of lineGeoms) if (pos.length < 2) errors.push(`line ${id} has <2 vertices`);
  if (errors.length) {
    console.error("[etl] VALIDATION FAILED:\n  - " + errors.join("\n  - "));
    process.exit(1);
  }

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
      sub: s.circle ?? s.ssCode ?? null,
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
    source: "Transco.kml (AP-TRANSCO, Google Earth export)",
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

  const dataQuality = {
    generatedAt: meta.generatedAt,
    substationSchemas: schemaCounts,
    unknownSchemaSamples,
    inferredCircles,
    adjacency: {
      method: `geometric endpoint-snapping ≤ ${SNAP_THRESHOLD_M} m`,
      linesBothEndpoints: both,
      linesOneEndpoint: one,
      linesNoEndpoint: none,
      pctBoth: Math.round((both / lines.length) * 1000) / 10,
      pctAtLeastOne: Math.round(((both + one) / lines.length) * 1000) / 10,
      unmatchedSamples,
    },
    circuitAmbiguousLines: {
      count: lines.filter((l) => l.circuitAmbiguous).length,
      samples: lines.filter((l) => l.circuitAmbiguous).slice(0, 15).map((l) => l.name),
    },
    voltageMismatchLines: {
      count: lines.filter((l) => l.voltageMismatch).length,
      samples: lines.filter((l) => l.voltageMismatch).slice(0, 15).map((l) => l.name),
    },
    droppedDuplicates,
    coordWarnings,
  };

  writeFileSync(resolve(outDir, "substations.geojson"), JSON.stringify(ssFc));
  writeFileSync(resolve(outDir, "lines.geojson"), JSON.stringify(lineFc));
  writeFileSync(resolve(outDir, "search-index.json"), JSON.stringify(searchIndex));
  writeFileSync(resolve(outDir, "meta.json"), JSON.stringify(meta, null, 2));
  writeFileSync(resolve(outDir, "data-quality.json"), JSON.stringify(dataQuality, null, 2));

  console.log(
    `[etl] wrote ${substations.length} substations, ${lines.length} lines` +
      (droppedDuplicates.length ? ` (dropped ${droppedDuplicates.length} coincident dup)` : ""),
  );
  console.log(
    `[etl] adjacency: both=${both} (${dataQuality.adjacency.pctBoth}%), one=${one}, none=${none}` +
      ` | route ${totalLengthKm} km · circuit ${totalCircuitKm} km · ${circles.length} circles` +
      ` | circuitAmbiguous=${dataQuality.circuitAmbiguousLines.count}` +
      ` voltageMismatch=${dataQuality.voltageMismatchLines.count}` +
      (coordWarnings.length ? ` | ${coordWarnings.length} coord warning(s)` : ""),
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

export { main };
