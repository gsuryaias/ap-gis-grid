// Small pure helpers shared by the adapters.
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { formatKm } from "../../lib/format.ts";
import { COASTAL_BAND_LABEL } from "../../lib/risk.ts";
import type { FieldRow, Locate } from "../types.ts";

/** Field rows with empty values dropped (null / undefined / ""). */
export function fields(...rows: Array<[string, string | number | null | undefined, Omit<FieldRow, "label" | "value">?]>): FieldRow[] {
  const out: FieldRow[] = [];
  for (const [label, v, extra] of rows) {
    if (v == null || v === "") continue;
    out.push({ label, value: typeof v === "number" ? v.toLocaleString("en-IN") : v, ...extra });
  }
  return out;
}

export const coords = (lng: number, lat: number) => `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

export function coast(km: number | null | undefined, band: number | null | undefined): string | null {
  if (km == null || band == null) return null;
  return `${formatKm(km)} (${COASTAL_BAND_LABEL[band as 0 | 1 | 2 | 3]} band)`;
}

export const pointAt = (lng: number, lat: number, zoom = 11.5): Locate => ({ center: [lng, lat], zoom });

function eachPosition(g: Geometry, fn: (p: Position) => void): void {
  switch (g.type) {
    case "Point":
      fn(g.coordinates);
      break;
    case "MultiPoint":
    case "LineString":
      g.coordinates.forEach(fn);
      break;
    case "MultiLineString":
    case "Polygon":
      g.coordinates.forEach((r) => r.forEach(fn));
      break;
    case "MultiPolygon":
      g.coordinates.forEach((p) => p.forEach((r) => r.forEach(fn)));
      break;
    case "GeometryCollection":
      g.geometries.forEach((x) => eachPosition(x, fn));
      break;
  }
}

/** [[w,s],[e,n]] of a geometry (null when empty). */
export function bboxOf(g: Geometry | null | undefined): [[number, number], [number, number]] | null {
  if (!g) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  eachPosition(g, ([x, y]) => {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  });
  return Number.isFinite(w) ? [[w, s], [e, n]] : null;
}

/** Camera target for a geometry: a point zooms in, anything else fits its bounds. */
export function locateGeometry(g: Geometry | null | undefined, pointZoom: number, maxZoom: number): Locate | null {
  if (!g) return null;
  if (g.type === "Point") return { center: [g.coordinates[0], g.coordinates[1]], zoom: pointZoom };
  const b = bboxOf(g);
  return b ? { bounds: b, maxZoom } : null;
}

export const oneFeature = (f: Feature | undefined): FeatureCollection | null => (f ? { type: "FeatureCollection", features: [f] } : null);

/** Display a raw property value (numbers in en-IN, arrays joined, ISO dates as IST calendar dates). */
export function display(k: string, v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    // Source dates are IST midnights stored as UTC (…T18:30Z) — show the IST calendar date.
    return new Date(new Date(v).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
  }
  if (typeof v === "number") {
    const lk = k.toLowerCase();
    return v.toLocaleString("en-IN", { maximumFractionDigits: lk.includes("km") || lk.includes("ha") ? 2 : 3 });
  }
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}
