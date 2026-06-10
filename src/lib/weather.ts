// Pure helpers for the real-time weather overlay/dashboard. Dependency- and side-effect-free
// (same discipline as geo.ts / etl-lib) so they unit-test in the `node` environment. All
// network I/O lives in src/data/weather.ts.
import type { MultiPolygon, Polygon, Position } from "geojson";
import type { SubstationProps } from "../data/types.ts";
import { centroid, pointInPolygonGeom } from "./geo.ts";

/** Coarse rendering family for a WMO weather code (drives the dashboard icon). */
export type WmoGroup = "clear" | "cloud" | "fog" | "rain" | "snow" | "storm";

/** Human label for a WMO 4677-style weather code (the codes Open-Meteo emits). */
export function wmoLabel(code: number): string {
  const table: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Rime fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Dense drizzle",
    56: "Freezing drizzle",
    57: "Freezing drizzle",
    61: "Light rain",
    63: "Rain",
    65: "Heavy rain",
    66: "Freezing rain",
    67: "Freezing rain",
    71: "Light snow",
    73: "Snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Light showers",
    81: "Showers",
    82: "Violent showers",
    85: "Snow showers",
    86: "Snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm, hail",
    99: "Thunderstorm, heavy hail",
  };
  return table[code] ?? "—";
}

/** Icon family for a WMO weather code. */
export function wmoGroup(code: number): WmoGroup {
  if (code <= 1) return "clear";
  if (code <= 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  return "rain"; // drizzle / rain / showers
}

export interface CirclePoint {
  circle: string;
  lng: number;
  lat: number;
}

/**
 * One representative query point per canonical AP-TRANSCO circle: the centroid of that circle's
 * substations. Computed at runtime from data already loaded — no ETL change, no hardcoded HQs.
 */
export function circlePoints(substations: SubstationProps[]): CirclePoint[] {
  const byCircle = new Map<string, Position[]>();
  for (const s of substations) {
    if (!s.circle) continue;
    const arr = byCircle.get(s.circle) ?? [];
    arr.push([s.lng, s.lat]);
    byCircle.set(s.circle, arr);
  }
  return [...byCircle.entries()]
    .map(([circle, pts]) => {
      const [lng, lat] = centroid(pts);
      return { circle, lng, lat };
    })
    .sort((a, b) => a.circle.localeCompare(b.circle));
}

/**
 * North Indian Ocean basin gate for GDACS cyclone events (Bay of Bengal + Arabian Sea).
 * GDACS lists storms worldwide; only systems that can matter to the AP grid pass.
 */
export function cycloneInBasin(lng: number, lat: number): boolean {
  return lng >= 55 && lng <= 105 && lat >= -5 && lat <= 30;
}

/** Fixed offshore sample points for the Open-Meteo marine API along the AP coastline (N → S). */
export const AP_COAST_POINTS: ReadonlyArray<{ name: string; lng: number; lat: number }> = [
  { name: "Srikakulam coast", lng: 84.25, lat: 18.2 },
  { name: "Visakhapatnam", lng: 83.45, lat: 17.6 },
  { name: "Kakinada", lng: 82.4, lat: 16.9 },
  { name: "Machilipatnam", lng: 81.3, lat: 16.1 },
  { name: "Ongole coast", lng: 80.35, lat: 15.45 },
  { name: "Nellore coast", lng: 80.3, lat: 14.4 },
];

/**
 * Substations inside any of the given forecast-cone / alert-swath polygons. Indicative only —
 * the cone is a path-uncertainty envelope, not a damage prediction.
 */
export function assetsInCone(
  substations: SubstationProps[],
  polygons: Array<Polygon | MultiPolygon>,
): SubstationProps[] {
  if (polygons.length === 0) return [];
  return substations.filter((s) => polygons.some((p) => pointInPolygonGeom([s.lng, s.lat], p)));
}
