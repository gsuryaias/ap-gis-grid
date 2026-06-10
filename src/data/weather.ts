// Live-weather fetch clients. All sources are free, keyless and CORS-enabled, so the static
// site talks to them directly — no backend, no proxy:
//   - Open-Meteo forecast + marine APIs (CC BY 4.0) — conditions/forecast/waves
//   - RainViewer public weather-maps API — composite rain-radar raster tiles
//   - GDACS (UN/EC JRC) — tropical-cyclone events + track/cone geometry (indicative)
// Everything degrades per-source: one failed API never blanks the others.
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { AP_COAST_POINTS, cycloneInBasin, type CirclePoint } from "../lib/weather.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CurrentWeather {
  time: string;
  tempC: number;
  humidityPct: number;
  precipMm: number;
  code: number;
  windKmh: number;
  gustKmh: number;
  windDirDeg: number;
}

export interface DailyOutlook {
  dates: string[];
  codes: number[];
  tMaxC: number[];
  precipSumMm: number[];
  gustMaxKmh: number[];
}

export interface CircleWeather {
  circle: string;
  lng: number;
  lat: number;
  current: CurrentWeather;
  daily: DailyOutlook;
}

export interface MarineConditions {
  name: string;
  lng: number;
  lat: number;
  waveM: number | null;
  windWaveM: number | null;
  swellM: number | null;
  time: string;
}

export type CycloneAlertLevel = "Green" | "Orange" | "Red";

export interface CycloneEvent {
  id: number;
  name: string;
  alertLevel: CycloneAlertLevel;
  severityText: string | null;
  country: string | null;
  fromDate: string;
  toDate: string;
  source: string | null;
  reportUrl: string | null;
  /** Track lines + forecast cone + alert swaths + current position, tagged for the map layers. */
  geometry: FeatureCollection;
  /** Forecast-cone / alert polygons only — input for the "grid assets in path" screen. */
  conePolygons: Array<Polygon | MultiPolygon>;
}

export interface RadarFrame {
  /** Full tile URL template ({z}/{x}/{y}) for the most recent radar frame. */
  tileUrl: string;
  /** Frame timestamp (unix seconds). */
  time: number;
}

export interface WeatherData {
  circles: CircleWeather[];
  marine: MarineConditions[];
  cyclones: CycloneEvent[];
  radar: RadarFrame | null;
  fetchedAt: number;
  /** Human-readable per-source failure notes (a partial load is still usable). */
  sourceErrors: string[];
}

// ---------------------------------------------------------------------------
// Open-Meteo: per-circle current conditions + 3-day outlook (one batched call)
// ---------------------------------------------------------------------------

const OM_CURRENT =
  "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m";
const OM_DAILY = "weather_code,temperature_2m_max,precipitation_sum,wind_gusts_10m_max";

interface OmForecastRow {
  current: {
    time: string;
    temperature_2m: number;
    relative_humidity_2m: number;
    precipitation: number;
    weather_code: number;
    wind_speed_10m: number;
    wind_gusts_10m: number;
    wind_direction_10m: number;
  };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    precipitation_sum: number[];
    wind_gusts_10m_max: number[];
  };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export async function loadCircleWeather(points: CirclePoint[]): Promise<CircleWeather[]> {
  if (points.length === 0) return [];
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${points.map((p) => p.lat.toFixed(3)).join(",")}` +
    `&longitude=${points.map((p) => p.lng.toFixed(3)).join(",")}` +
    `&current=${OM_CURRENT}&daily=${OM_DAILY}&forecast_days=3&timezone=Asia%2FKolkata`;
  const body = await getJson<OmForecastRow | OmForecastRow[]>(url);
  const rows = Array.isArray(body) ? body : [body]; // single-location requests return a bare object
  return points.map((p, i) => {
    const r = rows[i];
    return {
      circle: p.circle,
      lng: p.lng,
      lat: p.lat,
      current: {
        time: r.current.time,
        tempC: r.current.temperature_2m,
        humidityPct: r.current.relative_humidity_2m,
        precipMm: r.current.precipitation,
        code: r.current.weather_code,
        windKmh: r.current.wind_speed_10m,
        gustKmh: r.current.wind_gusts_10m,
        windDirDeg: r.current.wind_direction_10m,
      },
      daily: {
        dates: r.daily.time,
        codes: r.daily.weather_code,
        tMaxC: r.daily.temperature_2m_max,
        precipSumMm: r.daily.precipitation_sum,
        gustMaxKmh: r.daily.wind_gusts_10m_max,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Open-Meteo marine: wave/swell at fixed AP-coast offshore points (one batched call)
// ---------------------------------------------------------------------------

interface OmMarineRow {
  current: {
    time: string;
    wave_height: number | null;
    wind_wave_height: number | null;
    swell_wave_height: number | null;
  };
}

export async function loadMarine(): Promise<MarineConditions[]> {
  const pts = AP_COAST_POINTS;
  const url =
    "https://marine-api.open-meteo.com/v1/marine" +
    `?latitude=${pts.map((p) => p.lat.toFixed(3)).join(",")}` +
    `&longitude=${pts.map((p) => p.lng.toFixed(3)).join(",")}` +
    "&current=wave_height,wind_wave_height,swell_wave_height&timezone=Asia%2FKolkata";
  const body = await getJson<OmMarineRow | OmMarineRow[]>(url);
  const rows = Array.isArray(body) ? body : [body];
  return pts.map((p, i) => ({
    name: p.name,
    lng: p.lng,
    lat: p.lat,
    waveM: rows[i]?.current.wave_height ?? null,
    windWaveM: rows[i]?.current.wind_wave_height ?? null,
    swellM: rows[i]?.current.swell_wave_height ?? null,
    time: rows[i]?.current.time ?? "",
  }));
}

// ---------------------------------------------------------------------------
// GDACS: active tropical cyclones in the North Indian Ocean + their geometry
// ---------------------------------------------------------------------------

interface GdacsEventProps {
  eventid: number;
  eventname: string;
  name: string;
  alertlevel: string;
  iscurrent: string; // "true" | "false" (strings in the source)
  country: string;
  fromdate: string;
  todate: string;
  source: string;
  severitydata?: { severitytext?: string };
  url?: { geometry?: string; report?: string };
}

/** GDACS geometry classes we keep: track lines, forecast cone, alert swaths, current position. */
function classifyGdacsFeature(cls: string): { kind: string; level?: CycloneAlertLevel } | null {
  if (cls.startsWith("Line_")) return { kind: "track" };
  if (cls === "Poly_Cones") return { kind: "cone" };
  if (cls === "Poly_Green") return { kind: "alert", level: "Green" };
  if (cls === "Poly_Orange") return { kind: "alert", level: "Orange" };
  if (cls === "Poly_Red") return { kind: "alert", level: "Red" };
  if (cls === "Point_Centroid") return { kind: "position" };
  return null; // per-advisory position polygons etc. — clutter, dropped
}

function parseAlertLevel(s: string): CycloneAlertLevel {
  return s === "Red" || s === "Orange" ? s : "Green";
}

export async function loadCyclones(): Promise<CycloneEvent[]> {
  const list = await getJson<FeatureCollection>(
    "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC",
  );
  const active = (list.features ?? []).filter((f) => {
    const p = f.properties as unknown as GdacsEventProps;
    if (p.iscurrent !== "true") return false;
    if (f.geometry?.type !== "Point") return false;
    const [lng, lat] = f.geometry.coordinates;
    return cycloneInBasin(lng, lat);
  });

  const events = await Promise.all(
    active.map(async (f): Promise<CycloneEvent | null> => {
      const p = f.properties as unknown as GdacsEventProps;
      if (!p.url?.geometry) return null;
      try {
        const geom = await getJson<FeatureCollection>(p.url.geometry);
        const kept: Feature[] = [];
        const conePolygons: Array<Polygon | MultiPolygon> = [];
        for (const feat of geom.features ?? []) {
          const cls = String((feat.properties as Record<string, unknown> | null)?.Class ?? "");
          const tag = classifyGdacsFeature(cls);
          if (!tag) continue;
          kept.push({
            ...feat,
            properties: { wxKind: tag.kind, wxLevel: tag.level ?? null, eventId: p.eventid, eventName: p.name },
          });
          if (
            (tag.kind === "cone" || tag.kind === "alert") &&
            (feat.geometry.type === "Polygon" || feat.geometry.type === "MultiPolygon")
          ) {
            conePolygons.push(feat.geometry);
          }
        }
        return {
          id: p.eventid,
          name: p.name || p.eventname,
          alertLevel: parseAlertLevel(p.alertlevel),
          severityText: p.severitydata?.severitytext ?? null,
          country: p.country || null,
          fromDate: p.fromdate,
          toDate: p.todate,
          source: p.source || null,
          reportUrl: p.url?.report ?? null,
          geometry: { type: "FeatureCollection", features: kept },
          conePolygons,
        };
      } catch {
        return null; // one event's geometry failing shouldn't hide the others
      }
    }),
  );
  return events.filter((ev): ev is CycloneEvent => ev !== null);
}

// ---------------------------------------------------------------------------
// RainViewer: latest composite radar frame (free tier: past data, zoom ≤ 7)
// ---------------------------------------------------------------------------

interface RainViewerIndex {
  host: string;
  radar?: { past?: Array<{ time: number; path: string }> };
}

export async function loadRadarFrame(): Promise<RadarFrame | null> {
  const idx = await getJson<RainViewerIndex>("https://api.rainviewer.com/public/weather-maps.json");
  const past = idx.radar?.past ?? [];
  if (past.length === 0) return null;
  const latest = past[past.length - 1];
  // 256px tiles, colour scheme 2 (universal blue — the free-tier scheme), smoothing + snow mask.
  return { tileUrl: `${idx.host}${latest.path}/256/{z}/{x}/{y}/2/1_1.png`, time: latest.time };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Fetch all weather sources in parallel; partial failures land in `sourceErrors`. */
export async function loadWeather(points: CirclePoint[]): Promise<WeatherData> {
  const [circles, marine, cyclones, radar] = await Promise.allSettled([
    loadCircleWeather(points),
    loadMarine(),
    loadCyclones(),
    loadRadarFrame(),
  ]);
  const sourceErrors: string[] = [];
  const note = (label: string, r: PromiseSettledResult<unknown>) => {
    if (r.status === "rejected") sourceErrors.push(`${label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  };
  note("Conditions (Open-Meteo)", circles);
  note("Marine (Open-Meteo)", marine);
  note("Cyclones (GDACS)", cyclones);
  note("Radar (RainViewer)", radar);
  // All four down → surface a real error instead of an empty-but-"ready" state.
  if (sourceErrors.length === 4) throw new Error(sourceErrors.join(" · "));
  return {
    circles: circles.status === "fulfilled" ? circles.value : [],
    marine: marine.status === "fulfilled" ? marine.value : [],
    cyclones: cyclones.status === "fulfilled" ? cyclones.value : [],
    radar: radar.status === "fulfilled" ? radar.value : null,
    fetchedAt: Date.now(),
    sourceErrors,
  };
}

// ---------------------------------------------------------------------------
// Spot conditions for a selected feature (DetailPanel) — tiny, cached per location
// ---------------------------------------------------------------------------

export interface SpotWeather {
  tempC: number;
  code: number;
  windKmh: number;
  windDirDeg: number;
}

const spotCache = new Map<string, Promise<SpotWeather>>();

/** Current conditions at one point, deduped per ~1 km cell so repeat selections don't refetch. */
export function loadSpotWeather(lng: number, lat: number): Promise<SpotWeather> {
  const key = `${lng.toFixed(2)},${lat.toFixed(2)}`;
  let p = spotCache.get(key);
  if (!p) {
    const url =
      "https://api.open-meteo.com/v1/forecast" +
      `?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
      "&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m&timezone=Asia%2FKolkata";
    p = getJson<OmForecastRow>(url).then((r) => ({
      tempC: r.current.temperature_2m,
      code: r.current.weather_code,
      windKmh: r.current.wind_speed_10m,
      windDirDeg: r.current.wind_direction_10m,
    }));
    p.catch(() => spotCache.delete(key)); // failed fetches retry on the next selection
    spotCache.set(key, p);
  }
  return p;
}
