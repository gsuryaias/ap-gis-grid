/**
 * DISCOM 33 kV sub-transmission ETL (pure — no I/O; unit-tested in etl-discom.test.ts).
 *
 * Input: the raw live pulls in data/raw/live/discom-*.geojson (APSPDCL + APEPDCL schemas differ).
 * Output: one normalised 33/11 kV substation point set + one 33 kV line set, tagged by DISCOM, for
 * the lazy "Distribution (33 kV)" overlay.
 *
 * - Substation polygons (compound outlines) → a marker at the ring-vertex centroid.
 * - APSPDCL lines arrive as ~12k individual pole-to-pole spans (half unnamed). Spans are grouped by
 *   (feeder name, division) and split into connected components by shared endpoints, so a feature
 *   is a feeder run, not a span. Unnamed spans are grouped the same way under a null name.
 * - Geometry is Douglas–Peucker simplified (~8 m) and rounded to 5 dp.
 */
import type { Position } from "geojson";

export type Discom = "APSPDCL" | "APEPDCL" | "APCPDCL";

export interface DiscomSubstation {
  id: string;
  kind: "discom-ss";
  discom: Discom;
  name: string;
  code: string | null;
  circle: string | null;
  division: string | null;
  subdivision: string | null;
  section: string | null;
  mandal: string | null;
  district: string | null;
  commissioned: string | null;
  feedersIn: number | null;
  feedersOut: number | null;
  capacity: string | null;
  ssType: string | null;
  urbanRural: string | null;
  lng: number;
  lat: number;
}

export interface DiscomLine {
  id: string;
  kind: "discom-line";
  discom: Discom;
  name: string | null;
  code: string | null;
  circle: string | null;
  division: string | null;
  section: string | null;
  sourceSs: string | null;
  lengthKm: number;
  spans: number;
}

type RawFeature = { geometry: GeoJSON.Geometry | null; properties: Record<string, unknown> };

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** Trim, collapse whitespace, null for empty / "<Null>" / placeholder tokens. */
export function cleanText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  if (!s || s === "<Null>" || s === "-" || s === "0" || /^null$/i.test(s) || /^none$/i.test(s)) return null;
  return s;
}

/** "SANTHOSH NAGAR" / "sangala palli" → "Santhosh Nagar" / "Sangala Palli" (keeps short codes upper). */
export function titleCase(s: string | null): string | null {
  if (!s) return s;
  return s
    .toLowerCase()
    .replace(/(^|[\s\-/(.])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())
    .replace(/\b(Kv|Ss|Mva|Kva|Ehv|Eht|Lis|Ii|Iii|Iv)\b/g, (w) => w.toUpperCase())
    .replace(/(\d)(kv|mva|kva|mw)\b/gi, (_m, d: string, u: string) => d + u.toUpperCase());
}

/** "33/11KV Vullipalem Sub-Station" / "33_11KV Z.P.INDOOR SS" → "Vullipalem" / "Z.P.INDOOR". */
export function cleanSsLabel(s: string | null): string | null {
  if (!s) return s;
  const t = s
    .replace(/^\s*33\s*[/_\\-]?\s*11\s*k\.?v\.?\s*/i, "")
    .replace(/\s*(sub[\s-]*station|s\.?s\.?)\s*$/i, "")
    .trim();
  return t || s;
}

const toInt = (v: unknown): number | null => {
  const n = Number(String(v ?? "").trim());
  return v == null || String(v).trim() === "" || !Number.isFinite(n) ? null : Math.round(n);
};

function monthYear(v: unknown): string | null {
  if (v == null) return null;
  const d = new Date(v as string);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1950) return null;
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function centroid(g: GeoJSON.Geometry | null): [number, number] | null {
  if (!g) return null;
  if (g.type === "Point") return [round5(g.coordinates[0]), round5(g.coordinates[1])];
  const rings: Position[][] =
    g.type === "Polygon" ? [g.coordinates[0]] : g.type === "MultiPolygon" ? g.coordinates.map((p) => p[0]) : [];
  let sx = 0, sy = 0, n = 0;
  for (const r of rings) for (const c of r) { sx += c[0]; sy += c[1]; n++; }
  return n ? [round5(sx / n), round5(sy / n)] : null;
}

// ---- geometry helpers --------------------------------------------------------------------------

function perpDist(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas–Peucker in degree space (tolerance in degrees; 0.00008° ≈ 8 m at AP latitudes). */
export function simplifyLine(coords: Position[], tol: number): Position[] {
  if (coords.length <= 2) return coords;
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, coords.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(coords[i], coords[s], coords[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return coords.filter((_c, i) => keep[i]);
}

function haversineKm(a: Position, b: Position): number {
  const R = 6371.0088;
  const toR = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toR;
  const dLng = (b[0] - a[0]) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function pathKm(parts: Position[][]): number {
  let km = 0;
  for (const p of parts) for (let i = 1; i < p.length; i++) km += haversineKm(p[i - 1], p[i]);
  return km;
}

function partsOf(g: GeoJSON.Geometry | null): Position[][] {
  if (!g) return [];
  if (g.type === "LineString") return [g.coordinates];
  if (g.type === "MultiLineString") return g.coordinates;
  return [];
}

/**
 * Split a bag of line parts into connected components (parts sharing an endpoint, snapped to a
 * ~11 m grid — digitised spans often stop a few metres short of each other). Union–find over
 * endpoint keys.
 */
export function connectedParts(parts: Position[][], snapDeg = 0.0001): Position[][][] {
  const parent = parts.map((_p, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byEnd = new Map<string, number>();
  const key = (c: Position) => `${Math.round(c[0] / snapDeg)},${Math.round(c[1] / snapDeg)}`;
  parts.forEach((p, i) => {
    for (const c of [p[0], p[p.length - 1]]) {
      const k = key(c);
      const j = byEnd.get(k);
      if (j == null) byEnd.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, Position[][]>();
  parts.forEach((p, i) => {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(p);
  });
  return [...groups.values()];
}

// ---- builders ----------------------------------------------------------------------------------

export function buildDiscomSubstations(discom: Discom, feats: RawFeature[]): DiscomSubstation[] {
  const out: DiscomSubstation[] = [];
  const used = new Set<string>();
  const prefix = discom === "APSPDCL" ? "ds-sp" : discom === "APEPDCL" ? "ds-ep" : "ds-cp";
  feats.forEach((f, i) => {
    const c = centroid(f.geometry);
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return;
    const p = f.properties;
    let s: Omit<DiscomSubstation, "id" | "lng" | "lat">;
    if (discom === "APCPDCL") {
      s = {
        kind: "discom-ss",
        discom,
        name: titleCase(cleanSsLabel(cleanText(p.sub_station_name))) ?? "Unnamed 33/11 kV SS",
        code: cleanText(p.sub_station_id),
        circle: titleCase(cleanText(p.circle_name)),
        division: titleCase(cleanText(p.division_name)),
        subdivision: titleCase(cleanText(p.sub_division_name)),
        section: titleCase(cleanText(p.section_name)),
        mandal: null,
        district: null,
        commissioned: null,
        feedersIn: null,
        feedersOut: null,
        capacity: null,
        ssType: titleCase(cleanText(p.sub_station_type)),
        urbanRural: null,
      };
    } else if (discom === "APEPDCL") {
      s = {
        kind: "discom-ss",
        discom,
        name: titleCase(cleanText(p.sub_station_name)) ?? "Unnamed 33/11 kV SS",
        code: cleanText(p.ssid) ?? cleanText(p.sub_station_id),
        circle: titleCase(cleanText(p.circle_name)),
        division: titleCase(cleanText(p.division_name)),
        subdivision: titleCase(cleanText(p.sub_division_name)),
        section: titleCase(cleanText(p.section_name)),
        mandal: null,
        district: null,
        commissioned: null,
        feedersIn: toInt(p.no_of_hv_f),
        feedersOut: toInt(p.no_of_lv_f),
        capacity: cleanText(p.stn_tr_cap),
        ssType: titleCase(cleanText(p.sstype)),
        urbanRural: titleCase(cleanText(p.urbanrural)),
      };
    } else {
      const code = toInt(p.ss_sap_code);
      s = {
        kind: "discom-ss",
        discom,
        name: titleCase(cleanSsLabel(cleanText(p.ss_name))) ?? "Unnamed 33/11 kV SS",
        code: code ? String(code) : null,
        circle: null,
        division: titleCase(cleanText(p.division)),
        subdivision: titleCase(cleanText(p.subdivision)),
        section: titleCase(cleanText(p.section_)),
        mandal: titleCase(cleanText(p.mandal)),
        district: titleCase(cleanText(p.district)),
        commissioned: monthYear(p.date_of_commissioning),
        feedersIn: toInt(p.no_of_incomingfeeders),
        feedersOut: null,
        capacity: null,
        ssType: null,
        urbanRural: null,
      };
    }
    let id = `${prefix}-${String(i).padStart(4, "0")}`;
    if (s.code) {
      const base = `${prefix}-${s.code.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    }
    used.add(id);
    out.push({ id, ...s, lng: c[0], lat: c[1] });
  });
  return out;
}

export interface DiscomLineOut {
  props: DiscomLine;
  parts: Position[][];
}

export function buildDiscomLines(discom: Discom, feats: RawFeature[], tolDeg = 0.00008): DiscomLineOut[] {
  const prefix = discom === "APSPDCL" ? "dl-sp" : discom === "APEPDCL" ? "dl-ep" : "dl-cp";
  const out: DiscomLineOut[] = [];
  const finish = (props: Omit<DiscomLine, "id" | "lengthKm">, rawParts: Position[][]) => {
    const lengthKm = Math.round(pathKm(rawParts) * 100) / 100;
    const parts = rawParts
      .map((p) => simplifyLine(p, tolDeg).map((c): Position => [round5(c[0]), round5(c[1])]))
      .filter((p) => p.length >= 2 && !(p.length === 2 && p[0][0] === p[1][0] && p[0][1] === p[1][1]));
    if (!parts.length || lengthKm <= 0) return;
    out.push({ props: { id: `${prefix}-${String(out.length).padStart(5, "0")}`, ...props, lengthKm }, parts });
  };

  if (discom === "APCPDCL") {
    // APCPDCL GIS export (scripts/import-apcpdcl.mts): one feature per feeder (main line + spurs merged).
    for (const f of feats) {
      const parts = partsOf(f.geometry).filter((p) => p.length >= 2);
      if (!parts.length) continue;
      const p = f.properties;
      const raw = cleanText(p.feeder);
      const name = raw ? raw.replace(/^33\s*k\.?v\.?\s*/i, "").replace(/\s+feeder$/i, "").trim() : null;
      finish(
        {
          kind: "discom-line",
          discom,
          name: titleCase(name ? `33KV ${name}` : null),
          code: null,
          circle: titleCase(cleanText(p.circle)),
          division: titleCase(cleanText(p.division)),
          section: titleCase(cleanText(p.subdiv)),
          sourceSs: titleCase(cleanText(p.substn)),
          spans: toInt(p.n_poles) ?? parts.length,
        },
        parts,
      );
    }
    return out;
  }

  if (discom === "APEPDCL") {
    // Already one feature per 33 kV feeder, with an authoritative length.
    for (const f of feats) {
      const parts = partsOf(f.geometry).filter((p) => p.length >= 2);
      if (!parts.length) continue;
      const p = f.properties;
      const code = cleanText(p.feeder_code_33kv);
      finish(
        {
          kind: "discom-line",
          discom,
          name: titleCase(cleanText(p.feeder_name_33kv)),
          code: code ? String(Math.round(Number(code)) || code) : null,
          circle: titleCase(cleanText(p.circle_name)),
          division: titleCase(cleanText(p.division_name)),
          section: titleCase(cleanText(p.section_name)),
          sourceSs: cleanText(p.eht_ss_name),
          spans: toInt(p.pole_count) ?? parts.length,
        },
        parts,
      );
    }
    return out;
  }

  // APSPDCL (and the APCPDCL default): span segments → feeder runs.
  const groups = new Map<string, { name: string | null; division: string | null; section: string | null; code: string | null; parts: Position[][] }>();
  for (const f of feats) {
    const p = f.properties;
    const kv = Number(p.voltagelevel);
    // The layer is the 33 kV network, but a few spans are tagged 11 kV — keep them out.
    if (Number.isFinite(kv) && (kv === 11 || kv === 11000 || kv === 440)) continue;
    const parts = partsOf(f.geometry).filter((x) => x.length >= 2);
    if (!parts.length) continue;
    const name = titleCase(cleanText(p.feeder_name));
    const division = titleCase(cleanText(p.division));
    const k = `${(name ?? "").toLowerCase()}|${(division ?? "").toLowerCase()}`;
    const g = groups.get(k) ?? { name, division, section: titleCase(cleanText(p.section_)), code: cleanText(p.feeder_code), parts: [] };
    g.parts.push(...parts);
    groups.set(k, g);
  }
  for (const g of [...groups.values()].sort((a, b) => (a.name ?? "~").localeCompare(b.name ?? "~"))) {
    for (const comp of connectedParts(g.parts)) {
      finish(
        { kind: "discom-line", discom, name: g.name, code: g.code, circle: null, division: g.division, section: g.section, sourceSs: null, spans: comp.length },
        comp,
      );
    }
  }
  return out;
}
