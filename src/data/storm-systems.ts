// GDACS events → `StormSystem`s (cones + track polylines) — the light half of the storm glue, kept
// apart from `data/storm.ts` so the map halo (`map/weather-layers.ts`, in the shell bundle) doesn't
// pull the supply-security engine out of the lazy Storm chunk.
import type { LineString, MultiLineString, Point, Position } from "geojson";
import type { StormSystem } from "../lib/storm-envelope.ts";
import type { CycloneEvent, WeatherData } from "./weather.ts";

const systemsCache = new WeakMap<WeatherData, StormSystem[]>();

/** One GDACS event → its cones and track polylines (reported positions become 1-point paths). */
export function stormSystem(ev: CycloneEvent): StormSystem {
  const track: Position[][] = [];
  for (const f of ev.geometry.features) {
    const kind = (f.properties as { wxKind?: string } | null)?.wxKind;
    const g = f.geometry;
    if (kind === "track" && g.type === "LineString") track.push((g as LineString).coordinates);
    else if (kind === "track" && g.type === "MultiLineString") track.push(...(g as MultiLineString).coordinates);
    else if (kind === "position" && g.type === "Point") track.push([(g as Point).coordinates]);
  }
  return { id: ev.id, name: ev.name, alertLevel: ev.alertLevel, cones: ev.conePolygons, track };
}

/** Every active system of a weather fetch (memoised per fetch). */
export function stormSystems(weather: WeatherData): StormSystem[] {
  let out = systemsCache.get(weather);
  if (!out) systemsCache.set(weather, (out = weather.cyclones.map(stormSystem)));
  return out;
}
