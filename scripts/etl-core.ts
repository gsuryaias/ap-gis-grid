// Core TRANSCO grid ETL (Atlas 2.0 phase 4 split of build-data.mts): the geometry helpers the domains share
// (ids, centroids, footprints, endpoint snapping, route length) and `buildCore` — substations + lines → the core grid files.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Feature, FeatureCollection, LineString, MultiLineString, MultiPolygon, Point, Polygon, Position } from "geojson";
import { canonicalizeCircle, cleanPgName, cleanSsName, coastalBand, distancePointToPolygons, distanceToPolylineKm, formatMonthYear, haversineMeters, circuitTag, corridorKey, lineAccounting, mapLineCircuit, normalizeSsVoltage, parseEndpointLabels, round5, snapExternal, type Confidence, type ExternalPoint, type LineFeature, type Substation, type Voltage } from "./etl-lib.ts";
import { SNAPSHOT_DIR, layerSources, readLayer, readShapefile } from "./etl-sources.ts";
import { buildTowers } from "./etl-towers.ts";

// Endpoints snap to the substation POLYGON (0 m if inside the compound; 80% of endpoints are).
// 1000 m also catches lines drawn slightly short of the compound; far-away (>1 km) endpoints are
// genuinely external (other-state / non-TRANSCO facilities) and stay unmatched (flagged low-conf).
export const SNAP_THRESHOLD_M = 1000;

export const AP_BBOX = { minLng: 76.3, maxLng: 84.9, minLat: 12.5, maxLat: 19.3 };

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function uniqueId(base: string, used: Set<string>): string {
  let id = base || "x";
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

/** Centroid of a (Multi)Polygon: unweighted mean of every ring vertex. */
export function polygonCentroid(geom: Polygon | MultiPolygon): [number, number] {
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
export function exteriorRings(geom: Polygon | MultiPolygon): Position[][] {
  const rings = geom.type === "Polygon" ? [geom.coordinates[0]] : geom.coordinates.map((poly) => poly[0]);
  return rings.filter((r) => r && r.length >= 3).map((ring) => ring.map((c): Position => [round5(c[0]), round5(c[1])]));
}

/** A substation footprint for polygon-based adjacency (rings + a bbox for quick rejection). */
export interface SsPoly {
  id: string;
  rings: Position[][];
  bbox: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
}

export function ringsBbox(rings: Position[][]): [number, number, number, number] {
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
export function snapToSs(
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

/** A small circular footprint (n-gon) around a point, for substations that have no surveyed polygon. */
export function syntheticFootprint(lng: number, lat: number, radiusM: number, n = 12): Position[][] {
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
export function endpointsOf(geom: LineString | MultiLineString): { first: [number, number]; last: [number, number]; rings: Position[][] } {
  const rings: Position[][] = geom.type === "MultiLineString" ? geom.coordinates : [geom.coordinates];
  // Use the longest ring for the canonical geometry + endpoints.
  let longest = rings[0];
  for (const ring of rings) if (ring.length > longest.length) longest = ring;
  const first = longest[0] as [number, number];
  const last = longest[longest.length - 1] as [number, number];
  return { first, last, rings: [longest] };
}

/** Flatten a (Multi)LineString into segment rings; sum geodesic length over all of them (km). */
export function lineRouteKm(geom: LineString | MultiLineString): { rings: Position[][]; km: number } {
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

export const r5n = (n: number) => Math.round(n * 1e5) / 1e5;

/**
 * The core TRANSCO grid: substations + lines from the Gridmap shapefiles / live pull → substations.geojson,
 * lines.geojson (with the per-line tower summary), search-index.json, meta.json and data-quality.json.
 */
export async function buildCore(outDir: string) {
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

  return { substations, footprintSource, towers: towers.summary };
}
