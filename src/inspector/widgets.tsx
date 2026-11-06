// Live Inspector widgets (custom sections) that fetch on their own.
import { spotCell, spotWeather } from "../data/weather.ts";
import { useResource } from "../data/resources.ts";
import { compass8 } from "../lib/geo.ts";
import { wmoLabel } from "../lib/weather.ts";
import { useAppStore } from "../state/store.ts";
import { FieldView } from "./ui.tsx";

/**
 * Live spot conditions — only while the weather overlay is on (keeps the Inspector network-silent
 * otherwise). One fetch per ~1 km cell (the `spotWeather` resource).
 */
export function SpotConditions({ lng, lat }: { lng: number; lat: number }) {
  const showWeather = useAppStore((s) => s.filters.showWeather);
  const spot = useResource(spotWeather, showWeather ? spotCell(lng, lat) : null).data;
  if (!showWeather || !spot) return null;
  return (
    <FieldView
      row={{
        label: "Weather now",
        value: `${Math.round(spot.tempC)}°C · ${wmoLabel(spot.code)} · wind ${Math.round(spot.windKmh)} km/h ${compass8(spot.windDirDeg)}`,
        method: "weather",
      }}
    />
  );
}
