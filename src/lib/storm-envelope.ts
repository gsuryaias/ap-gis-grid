// The storm WARNING ENVELOPE (Atlas 2.0 phase 5, PR 15): substations and lines inside a forecast
// cone / alert swath, plus coastal ones near the forecast track. Split from `storm.ts` because the
// map halo (shell bundle) needs only this; the situation analysis stays in the lazy Storm chunk.
// Pure, dependency-free; tested through `storm.test.ts`.
import type { MultiPolygon, Polygon, Position } from "geojson";
import { pointInPolygonGeom } from "./geo.ts";

/** One active system, reduced to what the screen needs. */
export interface StormSystem {
  id: number;
  name: string;
  alertLevel: "Green" | "Orange" | "Red";
  /** Forecast cone + alert swaths. */
  cones: Array<Polygon | MultiPolygon>;
  /** Past + forecast track polylines, plus single-point paths for reported positions. */
  track: Position[][];
}

/** Coastal band at or below which an SS near the track is in the envelope (≤ 1 → < 25 km from the coast). */
export const STORM_COAST_BAND = 1;
/** Distance from the track that pulls a coastal substation into the envelope. */
export const STORM_TRACK_KM = 150;

// ---- geometry ---------------------------------------------------------------------------------

const KM_PER_DEG = 111.32;

/** Equirectangular point → segment distance in km. Accurate to well under 1 % at storm scales. */
function segKm(p: Position, a: Position, b: Position): number {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const ax = (a[0] - p[0]) * k, ay = a[1] - p[1];
  const bx = (b[0] - p[0]) * k, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const x = ax + t * dx, y = ay + t * dy;
  return Math.hypot(x, y) * KM_PER_DEG;
}

/** Shortest distance (km) from a point to any of the paths (a 1-point path is a position). */
export function distanceToPathsKm(p: Position, paths: readonly Position[][]): number {
  let best = Infinity;
  for (const path of paths) {
    if (path.length === 1) best = Math.min(best, segKm(p, path[0], path[0]));
    for (let i = 1; i < path.length; i++) best = Math.min(best, segKm(p, path[i - 1], path[i]));
  }
  return best;
}

type BBox = [number, number, number, number];
function bboxOf(geom: Polygon | MultiPolygon): BBox {
  const b: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  const rings = geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
  for (const ring of rings)
    for (const [x, y] of ring) {
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x;
      if (y > b[3]) b[3] = y;
    }
  return b;
}
const inBox = (p: Position, b: BBox) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

/** A cone set with bounding boxes, so most vertices skip the point-in-polygon test. */
function coneTester(systems: readonly StormSystem[]) {
  const cones = systems.flatMap((s) => s.cones.map((g) => ({ g, b: bboxOf(g), sys: s })));
  return (p: Position) => cones.filter((c) => inBox(p, c.b) && pointInPolygonGeom(p, c.g)).map((c) => c.sys);
}

// ---- 1. warning envelope ----------------------------------------------------------------------

export type EnvelopeReason = "cone" | "coast-track";

export interface EnvelopeHit {
  id: string;
  reason: EnvelopeReason;
  /** Systems responsible (cone hits: those whose cone holds it; coast-track hits: the nearest). */
  systemIds: number[];
  /** Worst alert level among those systems. */
  alertLevel: StormSystem["alertLevel"];
  /** Distance to the nearest track (km), null with no track. */
  trackKm: number | null;
}

export interface EnvelopeSs {
  id: string;
  lng: number;
  lat: number;
  coastalBand?: number;
}

const LEVEL_RANK = { Green: 0, Orange: 1, Red: 2 } as const;
const worst = (ls: StormSystem["alertLevel"][]) =>
  ls.reduce<StormSystem["alertLevel"]>((w, l) => (LEVEL_RANK[l] > LEVEL_RANK[w] ? l : w), "Green");

export interface EnvelopeOpts {
  trackKm?: number;
  coastBand?: number;
}

/** Substations in the warning envelope: cone ∪ (coastal band ≤ 1 ∧ within `trackKm` of a track). */
export function warningEnvelope(
  substations: readonly EnvelopeSs[],
  systems: readonly StormSystem[],
  opts: EnvelopeOpts = {},
): EnvelopeHit[] {
  if (systems.length === 0) return [];
  const maxKm = opts.trackKm ?? STORM_TRACK_KM;
  const band = opts.coastBand ?? STORM_COAST_BAND;
  const inCones = coneTester(systems);
  const out: EnvelopeHit[] = [];
  for (const s of substations) {
    const p: Position = [s.lng, s.lat];
    let nearest: { sys: StormSystem; km: number } | null = null;
    for (const sys of systems) {
      if (!sys.track.length) continue;
      const km = distanceToPathsKm(p, sys.track);
      if (!nearest || km < nearest.km) nearest = { sys, km };
    }
    const trackKm = nearest ? Math.round(nearest.km * 10) / 10 : null;
    const hits = inCones(p);
    if (hits.length) {
      const sys = [...new Set(hits)];
      out.push({ id: s.id, reason: "cone", systemIds: sys.map((x) => x.id), alertLevel: worst(sys.map((x) => x.alertLevel)), trackKm });
    } else if (nearest && nearest.km <= maxKm && s.coastalBand != null && s.coastalBand <= band) {
      out.push({ id: s.id, reason: "coast-track", systemIds: [nearest.sys.id], alertLevel: nearest.sys.alertLevel, trackKm });
    }
  }
  return out;
}

export interface EnvelopeLine {
  id: string;
  coastalBand?: number;
  coords: Position[][];
}

/** Lines with a vertex inside the envelope (same rule as substations: cone, or coastal and near a track). */
export function exposedLines(lines: readonly EnvelopeLine[], systems: readonly StormSystem[], opts: EnvelopeOpts = {}): Set<string> {
  const out = new Set<string>();
  if (systems.length === 0) return out;
  const maxKm = opts.trackKm ?? STORM_TRACK_KM;
  const band = opts.coastBand ?? STORM_COAST_BAND;
  const inCones = coneTester(systems);
  const tracks = systems.flatMap((s) => s.track);
  for (const l of lines) {
    const coastal = l.coastalBand != null && l.coastalBand <= band && tracks.length > 0;
    const hit = l.coords.some((part) =>
      part.some((p) => inCones(p).length > 0 || (coastal && distanceToPathsKm(p, tracks) <= maxKm)),
    );
    if (hit) out.add(l.id);
  }
  return out;
}
