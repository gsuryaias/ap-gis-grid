// Pure geodesic helpers for the on-map measurement tool. Kept dependency-free and
// side-effect-free so they can be unit-tested in the `node` test environment (same
// discipline as the ETL helpers). Inputs are GeoJSON [lng, lat] positions in degrees.
import type { MultiPolygon, Polygon, Position } from "geojson";

/** Mean Earth radius (IUGG), metres. Used for both length and area for consistency. */
const R = 6_371_008.8;
const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two [lng, lat] points, in metres (haversine). */
export function haversineMeters(a: Position, b: Position): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const lat1 = rad(a[1]);
  const lat2 = rad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total length of a poly-line of [lng, lat] points, in metres (0 for < 2 points). */
export function pathLengthMeters(points: Position[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += haversineMeters(points[i - 1], points[i]);
  return sum;
}

/**
 * Geodesic area of a polygon ring of [lng, lat] points, in square metres (always ≥ 0).
 * Spherical-excess formula (Chamberlain & Duquette / the one Turf and OpenLayers use).
 * The ring need not be explicitly closed; winding direction is ignored via Math.abs.
 */
export function ringAreaMeters(ring: Position[]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const lower = ring[i];
    const middle = ring[(i + 1) % n];
    const upper = ring[(i + 2) % n];
    total += (rad(upper[0]) - rad(lower[0])) * Math.sin(rad(middle[1]));
  }
  return Math.abs((total * R * R) / 2);
}

/** Initial great-circle bearing from `a` to `b`, in degrees clockwise from north (0–360). */
export function bearingDeg(a: Position, b: Position): number {
  const lat1 = rad(a[1]);
  const lat2 = rad(b[1]);
  const dLng = rad(b[0] - a[0]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/** 8-point compass abbreviation (N, NE, E, …) for a bearing in degrees. */
export function compass8(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** Component-wise mean of a set of positions — good enough to anchor a centroid label. */
export function centroid(points: Position[]): Position {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  const n = points.length || 1;
  return [x / n, y / n];
}

/**
 * Ray-casting point-in-ring test for [lng, lat] positions. Planar — fine at the scale of
 * cyclone cones / alert swaths (the same approach the ETL uses for SS compounds).
 */
export function pointInRing(pt: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Point-in-polygon for a GeoJSON Polygon/MultiPolygon geometry (outer ring minus holes). */
export function pointInPolygonGeom(pt: Position, geom: Polygon | MultiPolygon): boolean {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const rings of polys) {
    if (rings.length === 0) continue;
    if (!pointInRing(pt, rings[0])) continue;
    // Inside the outer ring — make sure the point isn't inside a hole.
    let inHole = false;
    for (let h = 1; h < rings.length; h++) {
      if (pointInRing(pt, rings[h])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/** Human-readable distance: metres under 1 km, otherwise km (en-IN grouping). */
export function formatLength(m: number): string {
  if (!Number.isFinite(m)) return "—";
  if (m < 1000) return `${m.toLocaleString("en-IN", { maximumFractionDigits: m < 10 ? 1 : 0 })} m`;
  return `${(m / 1000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} km`;
}

/** Human-readable area: m² → hectares (≥ 1 ha) → km² (≥ 1 km²). */
export function formatArea(m2: number): string {
  if (!Number.isFinite(m2)) return "—";
  if (m2 < 1e4) return `${m2.toLocaleString("en-IN", { maximumFractionDigits: 0 })} m²`;
  if (m2 < 1e6) return `${(m2 / 1e4).toLocaleString("en-IN", { maximumFractionDigits: 2 })} ha`;
  return `${(m2 / 1e6).toLocaleString("en-IN", { maximumFractionDigits: 2 })} km²`;
}
