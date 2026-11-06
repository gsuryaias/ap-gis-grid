// Storm lens panel (lazy chunk): live cyclones + the substations inside each forecast envelope,
// circle conditions, sea state and the 3-day outlook — the Weather monitor laid out for a column.
// The full situation panel (warning envelope beyond the cone, exposed radial pockets, downstream
// 33/11 kV at risk, printable briefing) is phase 5.
import { useResource } from "../data/resources.ts";
import type { GridData } from "../data/types.ts";
import { weatherRes } from "../data/weather.ts";
import { RefreshIcon } from "../components/icons.tsx";
import { fmtTime, WeatherBody } from "../components/WeatherView.tsx";
import { useAppStore } from "../state/store.ts";
import { LayersBlock } from "./ExplorePanel.tsx";
import { PanelSection, StartHere } from "./StartHere.tsx";

export default function StormPanel({ data }: { data: GridData }) {
  // An active consumer: keeps the 10-min re-poll alive while the Storm lens is open.
  const { data: weather, status, error } = useResource(weatherRes, "");
  const toggleWeatherView = useAppStore((s) => s.toggleWeatherView);
  const refresh = () => void weatherRes.refresh().catch(() => undefined);
  return (
    <div className="flex flex-col gap-3">
      <StartHere lens="storm" />
      <PanelSection
        title="Situation"
        action={
          <span className="flex items-center gap-1.5">
            {weather && <span className="text-[10.5px] tabular-nums text-ink-2">updated {fmtTime(weather.fetchedAt)}</span>}
            <button type="button" onClick={refresh} aria-label="Refresh weather" title="Refresh" className="rounded-md p-0.5 text-ink-2 hover:bg-surface-2 hover:text-ink">
              <RefreshIcon width={14} height={14} />
            </button>
          </span>
        }
      >
        {weather ? (
          <div className="-mt-3">
            <WeatherBody weather={weather} data={data} compact />
          </div>
        ) : status === "error" ? (
          <div className="rounded-lg bg-surface-2 px-3 py-2.5 text-sm text-ink-2">
            Couldn’t load weather data. {error}{" "}
            <button type="button" onClick={refresh} className="font-medium text-accent hover:underline">
              Retry
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 py-4 text-sm text-ink-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" aria-hidden />
            Fetching live weather…
          </div>
        )}
        <button type="button" onClick={() => toggleWeatherView(true)} className="mt-2 text-[11px] font-medium text-accent hover:underline">
          Open the full weather monitor
        </button>
      </PanelSection>
      <LayersBlock data={data} lens="storm" />
    </div>
  );
}
