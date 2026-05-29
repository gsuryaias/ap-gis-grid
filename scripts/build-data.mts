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
  parseDescriptionTable,
  parseEndpointLabels,
  pick,
  round5,
  snapEndpoint,
  type Circuit,
  type LineFeature,
  type SnapPoint,
  type Substation,
  type Voltage,
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
      doc: pick(table, ALIASES.doc),
      lng,
      lat,
      connectedLineIds: [],
    });
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

    for (const ssId of connectsSS) {
      substations.find((s) => s.id === ssId)?.connectedLineIds.push(id);
    }

    lines.push({
      id,
      kind: "line",
      name: cleanName,
      voltage,
      circuit,
      lengthKm,
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

  const byVoltage: Record<string, { substations: number; lines: number; lengthKm: number }> = {};
  for (const v of [400, 220, 132] as Voltage[]) {
    byVoltage[v] = {
      substations: substations.filter((s) => s.voltage === v).length,
      lines: lines.filter((l) => l.voltage === v).length,
      lengthKm: Math.round(lines.filter((l) => l.voltage === v).reduce((a, l) => a + (l.lengthKm ?? 0), 0) * 10) / 10,
    };
  }
  const totalLengthKm = Math.round(lines.reduce((a, l) => a + (l.lengthKm ?? 0), 0) * 10) / 10;

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
    totalLengthKm,
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
      ` | total ${totalLengthKm} km` +
      ` | circuitAmbiguous=${dataQuality.circuitAmbiguousLines.count}` +
      ` voltageMismatch=${dataQuality.voltageMismatchLines.count}` +
      (coordWarnings.length ? ` | ${coordWarnings.length} coord warning(s)` : ""),
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

export { main };
