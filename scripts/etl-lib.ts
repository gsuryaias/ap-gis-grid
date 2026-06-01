// Pure, side-effect-free helpers for the AP-TRANSCO ETL.
// Kept separate from build-data.mts so they can be unit-tested in isolation.
import { parse as parseHtml } from "node-html-parser";
import type { Position } from "geojson";

export type Voltage = 400 | 220 | 132;
export type Circuit = "SC" | "DC";
export type Confidence = "high" | "medium" | "low";

/** Energy-mix classes for generation plants (canonical; "Hydal" → "Hydro", null/unknown → "Other"). */
export type EnergyType = "Solar" | "Wind" | "Thermal" | "Gas" | "Hydro" | "Other";
export const ENERGY_TYPES: EnergyType[] = ["Thermal", "Gas", "Hydro", "Solar", "Wind", "Other"];

export interface GenerationPlant {
  id: string;
  kind: "generation";
  name: string;
  descriptiveName: string | null;
  ssCode: string | null;
  energy: EnergyType;
  voltage: Voltage;
  circle: string | null;
  doc: string | null;
  capacityMw: number | null;
  lng: number;
  lat: number;
}

/** Map a raw KML "SS Type" cell to a canonical energy class. */
export function classifyEnergy(raw: string | null | undefined): EnergyType {
  const t = (raw ?? "").toLowerCase().trim();
  if (t.includes("solar")) return "Solar";
  if (t.includes("wind")) return "Wind";
  if (t.includes("gas")) return "Gas";
  if (t.includes("hyd")) return "Hydro"; // source spells it "Hydal"
  if (t.includes("thermal") || t.includes("coal")) return "Thermal";
  return "Other";
}

/** Parse a voltage cell like "132KV" / "220 kV" → 400|220|132, or null if not recognised. */
export function parseVoltage(raw: string | null | undefined): Voltage | null {
  const m = (raw ?? "").match(/(\d{3})\s*KV/i);
  if (!m) return null;
  const v = Number(m[1]);
  return v === 400 || v === 220 || v === 132 ? (v as Voltage) : null;
}

/**
 * Normalise a Gridmap SS voltage cell (a bare string "132" / "200" / "400") to the canonical
 * 400|220|132 union. The source spells 220 kV as **"200"** (a known data quirk), so 200 → 220.
 * Returns null if unrecognised.
 */
export function normalizeSsVoltage(raw: unknown): Voltage | null {
  const m = String(raw ?? "").match(/(\d{3})/);
  if (!m) return null;
  let v = Number(m[1]);
  if (v === 200) v = 220; // source quirk: 220 kV is recorded as "200"
  return v === 400 || v === 220 || v === 132 ? (v as Voltage) : null;
}

/**
 * Map a Gridmap line `circuit_ty` cell to the canonical SC|DC circuit. The source has SC, DC,
 * "DC/SC" and MC (multi-circuit); anything with two-or-more circuits collapses to "DC", and a
 * missing/unknown value defaults to "SC" (single circuit).
 */
export function mapLineCircuit(raw: unknown): Circuit {
  const t = String(raw ?? "").toUpperCase().replace(/\s+/g, "");
  if (t === "SC") return "SC";
  if (t === "DC" || t === "DC/SC" || t === "SC/DC" || t === "MC") return "DC";
  return "SC"; // null / unknown → single circuit
}

/**
 * Circuit-km multiplier for a Gridmap line `circuit_ty`: SC=1, DC=2, "DC/SC"=2, MC=2, null=1.
 * (Per-circuit-aware; replaces the old route×circuits derivation.)
 */
export function lineCircuitMultiplier(raw: unknown): number {
  const t = String(raw ?? "").toUpperCase().replace(/\s+/g, "");
  if (t === "DC" || t === "DC/SC" || t === "SC/DC" || t === "MC") return 2;
  return 1; // SC / null / unknown
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Format a Gridmap `date_of_co` value (a Date, ISO string, or epoch number) as "Mon YYYY".
 * Sentinel/placeholder dates (year < 1950, e.g. the 1899 "no data" marker) → null.
 */
export function formatMonthYear(raw: unknown): string | null {
  if (raw == null) return null;
  const d = raw instanceof Date ? raw : new Date(raw as string | number);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 1950) return null; // 1899 sentinel / pre-1950 placeholders
  return `${MONTHS[d.getUTCMonth()]} ${y}`;
}

/**
 * Clean a Gridmap `ss_name` for display: strip the leading voltage prefix ("132KV ", "220KVSWS",
 * the "22OKV" letter-O typo, "400/220/11 KV …"), an "SS " token that some rows put before the
 * name, and a trailing " SS"/" SWS". Collapses whitespace. Returns null if nothing remains.
 */
export function cleanSsName(raw: string | null | undefined): string | null {
  let s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  // Leading voltage prefix: digits/slashes with an optional letter-O typo, then KV (+ optional SWS)
  s = s.replace(/^[\d/O]{2,}\s*K\s*V\s*(SWS)?\s*/i, "");
  // A leading "SS " / "SWS " token (some rows are "132KV SS NAME")
  s = s.replace(/^(SS|SWS)\s+/i, "");
  // Trailing " SS" / " SWS"
  s = s.replace(/\s+(SS|SWS)\s*$/i, "");
  s = s.replace(/\s+/g, " ").trim();
  return s || null;
}

// The AP-TRANSCO operating circles; the Gridmap source spells a few inconsistently and tags some
// with a second (often cross-state) token. We fold known spelling variants to a canonical name.
const CIRCLE_CANON: Record<string, string> = {
  anantapur: "Anantapur",
  ananthapur: "Anantapur",
  ananthapuram: "Anantapur",
  tirupati: "Tirupati",
  tirupathi: "Tirupati",
  thirupathi: "Tirupati",
  srikakulam: "Srikakulam",
  srikalulam: "Srikakulam",
};

/**
 * Canonicalise a Gridmap `circle` value to one of the ~13 AP-TRANSCO operating circles. The source
 * has composites ("Anantapur, Kadapa"), spelling variants ("Thirupathi"/"Tirupati") and cross-state
 * tags ("Kurnool, Telangana") — we keep the PRIMARY (first) token and fold known spellings. A bare
 * numeric code (the SS layer's opaque circle code) or an empty value → null.
 */
export function canonicalizeCircle(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const first = String(raw).split(/[,/]/)[0].trim();
  if (!first || /^\d+$/.test(first)) return null; // empty, or a bare numeric circle code
  const key = first.toLowerCase().replace(/[^a-z]/g, "");
  if (!key) return null;
  return CIRCLE_CANON[key] ?? titleCase(first);
}

export interface FolderClass {
  kind: "substation" | "line";
  voltage: Voltage;
  circuit: Circuit | null;
}

export interface Substation {
  id: string;
  kind: "substation";
  name: string;
  descriptiveName: string | null;
  ssCode: string | null;
  voltage: Voltage;
  circle: string | null;
  /** true when circle was spatially inferred. With the Gridmap source, circle is authoritative → always false. */
  circleInferred: boolean;
  doc: string | null;
  lng: number;
  lat: number;
  connectedLineIds: string[];
  // ---- New optional fields (Gridmap shapefile migration) ----
  /** Operating zone (authoritative, from the SS layer). */
  zone: string | null;
  /** Operating division (authoritative, from the SS layer). */
  division: string | null;
}

export interface LineFeature {
  id: string;
  kind: "line";
  name: string;
  voltage: Voltage;
  circuit: Circuit;
  lengthKm: number | null;
  /** Circuit-km = route length × a per-circuit-aware multiplier (SC ×1, DC/MC/DC-SC ×2). */
  ckm: number | null;
  /** Authoritative circle from the source line layer (may be inherited from a connected SS if null). */
  circle: string | null;
  connectsSS: string[];
  endpointLabels: [string, string] | null;
  fromSS: { ssId: string; distM: number; confidence: Confidence } | null;
  toSS: { ssId: string; distM: number; confidence: Confidence } | null;
  circuitAmbiguous: boolean;
  voltageMismatch: boolean;
  // ---- New optional fields (Gridmap shapefile migration) ----
  /** Raw source `circuit_ty` cell ("SC" | "DC" | "DC/SC" | "MC" | …), kept for transparency. */
  circuitType: string | null;
  /** Conductor type from `conductor_` (e.g. "Twin Moose"), or null. */
  conductor: string | null;
  /** Commissioning date as "Mon YYYY" from `date_of_co`; null when missing / a 1899 sentinel. */
  commissioned: string | null;
  /** Display-only non-TRANSCO endpoints (Generation/Railway/PowerGrid/HT consumer); not clickable. */
  externalEndpoints: { name: string; category: string }[];
}

/** Round to 5 decimal places (~1 m) — survey-grade precision is not needed here. */
export function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

/** Great-circle distance in metres. */
export function haversineMeters(
  a: [number, number],
  b: [number, number],
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

const NULLISH = new Set(["", "null", "<null>", "na", "n/a", "-", "--", "nil"]);

/** Normalise a cell value; map placeholder/null tokens to `null`. */
export function cleanValue(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = decodeEntities(v).replace(/\s+/g, " ").trim();
  if (NULLISH.has(t.toLowerCase())) return null;
  return t;
}

/** Normalise an attribute key for alias matching: upper-case, underscores→spaces. */
export function normalizeKey(k: string): string {
  return decodeEntities(k).toUpperCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Parse a KML <description> HTML table into a map of normalised key → cleaned value.
 * Handles the nested-table layout (outer title table wraps an inner key/value table)
 * by keeping only <tr> rows with exactly two leaf <td> cells.
 */
export function parseDescriptionTable(html: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const root = parseHtml(html);
  for (const tr of root.querySelectorAll("tr")) {
    const tds = tr.childNodes.filter(
      (c): c is import("node-html-parser").HTMLElement =>
        c.nodeType === 1 && (c as import("node-html-parser").HTMLElement).tagName === "TD",
    );
    if (tds.length !== 2) continue; // title row (1 td) and wrapper row (nested table) are skipped
    if (tds[0].querySelector("table") || tds[1].querySelector("table")) continue;
    const key = normalizeKey(tds[0].text);
    if (!key) continue;
    out.set(key, cleanValue(tds[1].text));
  }
  return out;
}

/** First matching alias value (already cleaned), or null. */
export function pick(table: Map<string, string | null>, aliases: readonly string[]): string | null {
  for (const a of aliases) {
    const v = table.get(a);
    if (v != null) return v;
  }
  return null;
}

export const ALIASES = {
  descriptiveName: ["SUBSTATION NAME", "SUBSTATION", "NAME OF THE SS"],
  shortName: ["SS NAME", "NAME"],
  ssCode: ["SS CODE", "SAP SS ID"],
  circle: ["CIRCLE"],
  doc: ["DOC"],
  lat: ["GP LAT", "LATITUDE"],
  lng: ["GP LANG", "LONGITUDE"], // note: source mis-spells LONG as "LANG"
  lineLength: ["LINE LENGTH"],
  lineName: ["LINE NAME", "220KV LINE NAME", "LINE NAME "],
  // Generation-plant attributes
  genName: ["NAME", "SS NAME"],
  genDescriptiveName: ["NAME OF THE SS", "SUBSTATION NAME"],
  genCode: ["SAP SS ID", "SS CODE"],
  energyType: ["SS TYPE", "TYPE"],
  voltage: ["VOLTAGE"],
  capacity: ["CAPACITY", "CAPACITY (MW)", "MW"],
} as const;

/** Classify a folder name like "SS_400KV" / "DC_220KV_Lines". */
export function classifyFolder(folderName: string): FolderClass | null {
  const m = folderName.toUpperCase().match(/^(SS|SC|DC)_(\d{3})KV/);
  if (!m) return null;
  const voltage = Number(m[2]) as Voltage;
  if (![400, 220, 132].includes(voltage)) return null;
  if (m[1] === "SS") return { kind: "substation", voltage, circuit: null };
  return { kind: "line", voltage, circuit: m[1] as Circuit };
}

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

/** Best-effort endpoint labels parsed from a line name (display only, not authoritative). */
export function parseEndpointLabels(name: string): [string, string] | null {
  let s = ` ${name.toUpperCase()} `;
  s = s.replace(/\(.*?\)/g, " ");
  s = s.replace(/\[.*?\]/g, " ");
  s = s.replace(/\b\d{2,3}\s*KV\b/g, " ");
  s = s.replace(/&.*$/g, " "); // drop "& 02" style tails
  s = s.replace(/\bCKT[\s-]*\d+\b/g, " ");
  s = s.replace(/\b(DC\s*\/\s*SC|SC\s*\/\s*DC|DC\s+SC|SC\s+DC|DC|SC|CKT|LILO|TM|QM|FEEDER|LINE)\b/g, " ");
  const parts = s
    .split(/\s*-\s*/)
    .map((p) => p.replace(/[^A-Z0-9 .]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (parts.length >= 2) return [titleCase(parts[0]), titleCase(parts[parts.length - 1])];
  return null;
}

export interface NameFlags {
  circuitAmbiguous: boolean;
  voltageMismatch: boolean;
  nameVoltage: number | null;
  nameCircuit: Circuit | null;
}

/** Folder is authoritative; the name only sets review flags, never overrides. */
export function detectNameFlags(
  name: string,
  folderVoltage: Voltage,
  folderCircuit: Circuit,
): NameFlags {
  const u = ` ${name.toUpperCase()} `;
  const hasBoth = /\bDC\s*\/\s*SC\b|\bSC\s*\/\s*DC\b|\bDC\s+SC\b|\bSC\s+DC\b/.test(u);
  const hasDC = /\bDC\b/.test(u);
  const hasSC = /\bSC\b/.test(u);
  let nameCircuit: Circuit | null = null;
  if (!hasBoth) {
    if (hasDC && !hasSC) nameCircuit = "DC";
    else if (hasSC && !hasDC) nameCircuit = "SC";
  }
  const circuitMismatch = nameCircuit != null && nameCircuit !== folderCircuit;
  const vm = u.match(/\b(\d{2,3})\s*KV\b/);
  const nameVoltage = vm ? Number(vm[1]) : null;
  return {
    circuitAmbiguous: hasBoth || (hasDC && hasSC) || circuitMismatch,
    voltageMismatch: nameVoltage != null && nameVoltage !== folderVoltage,
    nameVoltage,
    nameCircuit,
  };
}

// ---- POWERGRID (PGCIL) national inter-state grid overlay -------------------
// Sourced from ESRI shapefiles (not the AP-TRANSCO KML). A separate, lazy-loaded overlay
// like generation. Voltages include 765 kV (and 400), so `voltage` is a plain number — NOT
// the AP-TRANSCO 400|220|132 union.

export interface PowerGridLine {
  id: string;
  kind: "pg-line";
  name: string;
  voltage: number;
  service: string | null;
  /** Route length in km, summed from the geometry (the source has no km field). */
  lengthKm: number | null;
}

export interface PowerGridSubstation {
  id: string;
  kind: "pg-substation";
  name: string;
  fullName: string | null;
  voltage: number;
  lng: number;
  lat: number;
}

/** Tidy a PowerGrid name (collapse whitespace, trim); null/placeholder → fallback handled by caller. */
export function cleanPgName(raw: string | null | undefined): string | null {
  const t = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!t || NULLISH.has(t.toLowerCase())) return null;
  return t;
}

/** Coerce a shapefile voltage cell (number or "765"/"765KV") to an integer kV, or null. */
export function normalizeKv(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw);
  const m = String(raw ?? "").match(/(\d{2,4})/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

// ---- Railway-traction (RTSS) & Bulk-load / HT-consumer substations ---------
// Two more point classes that ride inside the SAME lazy "Power grid" overlay group as the
// POWERGRID (PGCIL) lines/substations. Sourced from ESRI shapefiles (not the AP-TRANSCO KML).
// Both are loads off the AP-TRANSCO grid, not backbone, so they render as smaller markers.

export interface RailwaySubstation {
  id: string;
  kind: "rail-substation";
  name: string;
  /** Display label from the source `name_of_th` cell (e.g. "RTSS Gurazala"). */
  displayName: string | null;
  voltage: number;
  /** Grid substation this RTSS taps off (source `connected_`), e.g. "220KV RENTACHINTALA SS". */
  connectedSs: string | null;
  /** Contracted/connected capacity in MVA, or null. */
  mva: number | null;
  circle: string | null;
  district: string | null;
  lng: number;
  lat: number;
}

export interface BulkLoadSubstation {
  id: string;
  kind: "bulk-substation";
  name: string;
  voltage: number;
  /** Consumer type (source `ss_type`), e.g. "Private". */
  ssType: string | null;
  connectedSs: string | null;
  mva: number | null;
  circle: string | null;
  district: string | null;
  lng: number;
  lat: number;
}

/** Coerce a shapefile capacity cell (number or numeric string) to a finite number, or null. */
export function parseMva(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const t = (raw == null ? "" : String(raw)).trim();
  if (!t || NULLISH.has(t.toLowerCase())) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export interface SnapPoint {
  id: string;
  lng: number;
  lat: number;
}

/** Snap a line endpoint to the nearest substation within `thresholdM`. */
export function snapEndpoint(
  coord: [number, number],
  points: SnapPoint[],
  thresholdM: number,
): { ssId: string; distM: number; confidence: Confidence } | null {
  let best: SnapPoint | null = null;
  let bestDist = Infinity;
  for (const p of points) {
    const d = haversineMeters(coord, [p.lng, p.lat]);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  if (!best || bestDist > thresholdM) return null;
  const confidence: Confidence = bestDist <= 150 ? "high" : bestDist <= 350 ? "medium" : "low";
  return { ssId: best.id, distM: Math.round(bestDist), confidence };
}

/** A non-TRANSCO facility point used only for display-only line endpoint labelling. */
export interface ExternalPoint {
  name: string;
  category: string; // "Generation" | "Railway" | "PowerGrid" | "HT consumer"
  lng: number;
  lat: number;
}

/** Snap a line endpoint to the nearest non-TRANSCO facility within `thresholdM` (display only). */
export function snapExternal(
  coord: [number, number],
  points: ExternalPoint[],
  thresholdM: number,
): { name: string; category: string } | null {
  let best: ExternalPoint | null = null;
  let bestDist = Infinity;
  for (const p of points) {
    const d = haversineMeters(coord, [p.lng, p.lat]);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  if (!best || bestDist > thresholdM) return null;
  return { name: best.name, category: best.category };
}

// ---- Polygon adjacency (substations are compound footprints, not points) ----
// Lines terminate at the substation compound, often hundreds of metres from its centroid, so
// snapping endpoints to the polygon (0 m if inside, else distance to the nearest edge) recovers
// far more connections than centroid-distance. Planar maths is fine at compound scale.

/** Ray-casting point-in-ring test. */
function pointInRing(p: [number, number], ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True if the point lies inside any of a polygon's exterior rings (MultiPolygon parts don't overlap). */
export function pointInPolygons(p: [number, number], rings: Position[][]): boolean {
  return rings.some((ring) => pointInRing(p, ring));
}

/** Metres from a point to a segment, via a local equirectangular projection (small distances). */
function segmentMeters(p: [number, number], a: Position, b: Position): number {
  const mLat = 111_320;
  const mLng = 111_320 * Math.cos((p[1] * Math.PI) / 180);
  const ax = (a[0] - p[0]) * mLng, ay = (a[1] - p[1]) * mLat;
  const bx = (b[0] - p[0]) * mLng, by = (b[1] - p[1]) * mLat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Distance in metres from a point to a polygon — 0 if inside its exterior rings, else nearest edge. */
export function distancePointToPolygons(p: [number, number], rings: Position[][]): number {
  if (pointInPolygons(p, rings)) return 0;
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) best = Math.min(best, segmentMeters(p, ring[i - 1], ring[i]));
  }
  return best;
}
