// Pure, side-effect-free helpers for the AP-TRANSCO ETL.
// Kept separate from build-data.mts so they can be unit-tested in isolation.
import { parse as parseHtml } from "node-html-parser";

export type Voltage = 400 | 220 | 132;
export type Circuit = "SC" | "DC";
export type Confidence = "high" | "medium" | "low";

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
  doc: string | null;
  lng: number;
  lat: number;
  connectedLineIds: string[];
}

export interface LineFeature {
  id: string;
  kind: "line";
  name: string;
  voltage: Voltage;
  circuit: Circuit;
  lengthKm: number | null;
  connectsSS: string[];
  endpointLabels: [string, string] | null;
  fromSS: { ssId: string; distM: number; confidence: Confidence } | null;
  toSS: { ssId: string; distM: number; confidence: Confidence } | null;
  circuitAmbiguous: boolean;
  voltageMismatch: boolean;
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
