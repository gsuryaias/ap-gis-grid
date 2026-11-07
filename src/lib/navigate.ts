// "Navigate here" for the field (Atlas 2.0 phase 5 PR 16). Pure: deep links into the phone's maps
// apps, and the point to send them to — a substation / transformer / tower is a point; for a line
// it's the vertex nearest the user's location (fault patrol: "take me to the nearest bit of this
// feeder"), or the middle of the line when we don't know where the user is.
import type { Geometry, Position } from "geojson";
import { haversineMeters } from "./geo.ts";

export interface NavLink {
  label: string;
  href: string;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** iOS has no `geo:` handler — Apple Maps' universal link instead. */
export const isIos = (ua: string) => /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile/i.test(ua));

/**
 * Directions (Google Maps, works on every platform and in the browser) + the phone's own maps app
 * (`geo:` on Android, Apple Maps on iOS). `from` = the user's fix, when known.
 */
export function navLinks(lng: number, lat: number, label: string, ua: string, from?: Position | null): NavLink[] {
  const dest = `${r6(lat)},${r6(lng)}`;
  const origin = from ? `&origin=${r6(from[1])},${r6(from[0])}` : "";
  const google = { label: "Google Maps", href: `https://www.google.com/maps/dir/?api=1${origin}&destination=${dest}&travelmode=driving` };
  const app = isIos(ua)
    ? { label: "Apple Maps", href: `https://maps.apple.com/?daddr=${dest}&q=${encodeURIComponent(label)}` }
    : { label: "Maps app", href: `geo:${dest}?q=${dest}(${encodeURIComponent(label)})` };
  return [google, app];
}

function vertices(g: Geometry): Position[] {
  switch (g.type) {
    case "Point":
      return [g.coordinates];
    case "MultiPoint":
    case "LineString":
      return g.coordinates;
    case "MultiLineString":
    case "Polygon":
      return g.coordinates.flat();
    case "MultiPolygon":
      return g.coordinates.flat(2);
    default:
      return [];
  }
}

export interface NavTarget {
  lng: number;
  lat: number;
  /** "nearest" = the closest vertex to `from`; "middle" = no fix, the line's middle vertex. */
  how: "point" | "nearest" | "middle";
  /** Straight-line metres from `from`, when known. */
  meters: number | null;
}

/** Where to navigate to for a feature geometry. */
export function navTarget(g: Geometry | null | undefined, from?: Position | null): NavTarget | null {
  if (!g) return null;
  const vs = vertices(g);
  if (!vs.length) return null;
  if (g.type === "Point") {
    const [lng, lat] = g.coordinates;
    return { lng, lat, how: "point", meters: from ? haversineMeters(from, [lng, lat]) : null };
  }
  if (!from) {
    const m = vs[Math.floor(vs.length / 2)];
    return { lng: m[0], lat: m[1], how: "middle", meters: null };
  }
  let best = vs[0];
  let bestM = Infinity;
  for (const v of vs) {
    const d = haversineMeters(from, v);
    if (d < bestM) [best, bestM] = [v, d];
  }
  return { lng: best[0], lat: best[1], how: "nearest", meters: bestM };
}
