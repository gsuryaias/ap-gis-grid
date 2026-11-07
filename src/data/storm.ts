// Glue between the live weather feed and the pure storm-situation engine (`lib/storm.ts`). It
// reduces the Open-Meteo outlook to per-circle maxima and memoises the situation per (grid, weather
// fetch, connectivity index), so the Storm panel and its printable briefing share ONE computation.
// Lazy-chunk only (it pulls in supply security); the map halo uses the light `storm-systems.ts`.
import {
  circleBoard,
  stormSituation,
  type CircleBoardRow,
  type CircleForecast,
  type EnvelopeLine,
  type AtRiskVia,
  type StormSituation,
  type StormSystem,
} from "../lib/storm.ts";
import { computeSupplySecurity, type SupplyClass, type SupplySecurity } from "../lib/supply-security.ts";
import type { ConnectivityIndex } from "./connectivity.ts";
import { stormSystems } from "./storm-systems.ts";
import type { GridData } from "./types.ts";
import type { WeatherData } from "./weather.ts";

export { stormSystem, stormSystems } from "./storm-systems.ts";

const secCache = new WeakMap<GridData, SupplySecurity>();

/** Corridor-level supply security (`lib/supply-security.ts`), computed once per GridData instance. */
export function supplySecurityOf(data: GridData): SupplySecurity {
  let s = secCache.get(data);
  if (!s) secCache.set(data, (s = computeSupplySecurity(data.substations, data.lines)));
  return s;
}


/** Did the cyclone feed answer? (an empty list from a working feed means "no active system"). */
export const cycloneFeedOk = (weather: WeatherData) => !weather.sourceErrors.some((e) => e.startsWith("Cyclones"));

export function circleForecasts(weather: WeatherData): CircleForecast[] {
  return weather.circles.map((c) => ({
    circle: c.circle,
    gustMaxKmh: Math.max(c.current.gustKmh, ...c.daily.gustMaxKmh),
    rainMaxMm: Math.max(0, ...c.daily.precipSumMm),
  }));
}

const linesCache = new WeakMap<GridData, EnvelopeLine[]>();
function envelopeLines(data: GridData): EnvelopeLine[] {
  let out = linesCache.get(data);
  if (out) return out;
  out = data.linesFc.features.map((f) => {
    const g = f.geometry;
    const coords = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    const p = f.properties as { id: string; coastalBand?: number };
    return { id: p.id, coastalBand: p.coastalBand, coords };
  });
  linesCache.set(data, out);
  return out;
}

export interface StormPicture {
  systems: StormSystem[];
  situation: StormSituation;
  board: CircleBoardRow[];
  cycloneFeedOk: boolean;
  /** The 33 kV downstream numbers wait for `transco-33kv.json`. */
  downstreamReady: boolean;
}

let last: { data: GridData; weather: WeatherData; conn: ConnectivityIndex | null; pic: StormPicture } | null = null;

export function stormPicture(data: GridData, weather: WeatherData, conn: ConnectivityIndex | null): StormPicture {
  if (last && last.data === data && last.weather === weather && last.conn === conn) return last.pic;
  const systems = stormSystems(weather);
  const situation = stormSituation({
    substations: data.substations,
    lines: envelopeLines(data),
    sec: supplySecurityOf(data),
    feeders: conn?.bySs ?? null,
    systems,
  });
  const ssCircle = new Map(data.substations.map((s) => [s.id, s.circle]));
  const ok = cycloneFeedOk(weather);
  const circles = data.meta.circles.filter((c) => c !== "Unassigned");
  const board = circleBoard(circles, (id) => ssCircle.get(id), situation, circleForecasts(weather), ok);
  const pic = { systems, situation, board, cycloneFeedOk: ok, downstreamReady: conn != null };
  last = { data, weather, conn, pic };
  return pic;
}

export interface AtRiskRow {
  id: string;
  name: string;
  voltage: number;
  circle: string | null;
  via: AtRiskVia;
  /** Plain-words reason ("in the cone", "coast · 85 km from track", "feed crosses exposure", …). */
  why: string;
  trackKm: number | null;
  coastalKm: number | null;
  supply: SupplyClass | null;
  /** 33 kV feeders it sources (null while the index loads). */
  feeders: number | null;
}

const VIA_RANK: Record<AtRiskVia, number> = { envelope: 0, feed: 1, cut: 2 };

/** Every at-risk TRANSCO SS as a flat row — the panel list, its CSV and the briefing share it. */
export function atRiskRows(pic: StormPicture, data: GridData, conn: ConnectivityIndex | null): AtRiskRow[] {
  const byId = new Map(data.substations.map((s) => [s.id, s]));
  const hit = new Map(pic.situation.envelope.map((h) => [h.id, h]));
  const sec = supplySecurityOf(data);
  const rows: AtRiskRow[] = [];
  for (const [id, via] of pic.situation.atRisk) {
    const s = byId.get(id);
    if (!s) continue;
    const h = hit.get(id);
    const why =
      via === "envelope"
        ? h?.reason === "cone"
          ? "in the cone"
          : `coast · ${Math.round(h?.trackKm ?? 0)} km from track`
        : via === "feed"
          ? "feed crosses exposure"
          : "islanded by a cut point";
    rows.push({
      id,
      name: s.name,
      voltage: s.voltage,
      circle: s.circle ?? null,
      via,
      why,
      trackKm: h?.trackKm ?? null,
      coastalKm: s.coastalKm ?? null,
      supply: sec.bySs.get(id)?.cls ?? null,
      feeders: conn ? (conn.bySs[id]?.length ?? 0) : null,
    });
  }
  return rows.sort(
    (a, b) =>
      VIA_RANK[a.via] - VIA_RANK[b.via] ||
      Number(hit.get(a.id)?.reason === "coast-track") - Number(hit.get(b.id)?.reason === "coast-track") ||
      b.voltage - a.voltage ||
      a.name.localeCompare(b.name),
  );
}

const n = (x: number) => x.toLocaleString("en-IN");
const plural = (x: number, one: string, many = one === "SS" ? one : `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;

/** One headline sentence for the status banner (and the briefing). */
export function stormHeadline(pic: StormPicture): string {
  const s = pic.situation;
  if (!pic.cycloneFeedOk) return "The cyclone feed (GDACS) did not answer — exposure can't be assessed; circles without a clear answer show grey.";
  if (!pic.systems.length) return "No active cyclone in the Bay of Bengal / Arabian Sea (GDACS).";
  const env = s.envelopeIds.size;
  const extra = s.atRisk.size - env;
  const parts = [`${plural(pic.systems.length, "active system")}`, `${plural(env, "substation")} in the warning envelope`];
  if (extra) parts.push(`${n(extra)} more fed through exposure`);
  if (pic.downstreamReady && s.downstream.discomSs) parts.push(`${n(s.downstream.discomSs)} 33/11 kV SS downstream`);
  return `${parts.join(" · ")}.`;
}
