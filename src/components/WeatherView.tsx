// Full-screen weather-monitoring dashboard (same modal pattern as SummaryView). All readings
// are live, third-party and indicative — sources are credited inline and any per-source fetch
// failure degrades to a note instead of blanking the view.
import { useMemo } from "react";
import { graphAnalysis } from "../data/graph-data.ts";
import type { GridData } from "../data/types.ts";
import type { CircleWeather, CycloneEvent, WeatherData } from "../data/weather.ts";
import { downloadText, toCsv } from "../lib/export.ts";
import { compass8 } from "../lib/geo.ts";
import { riskTier, substationRisk, type RiskTier } from "../lib/risk.ts";
import { assetsInCone, wmoGroup, wmoLabel, type WmoGroup } from "../lib/weather.ts";
import { useAppStore } from "../state/store.ts";
import { WX_ALERT_COLOR } from "../theme/palette.ts";
import {
  CloudIcon,
  CloudRainIcon,
  CloseIcon,
  CycloneIcon,
  DownloadIcon,
  FogIcon,
  RefreshIcon,
  SnowIcon,
  StormIcon,
  SunIcon,
  WaveIcon,
  WindIcon,
} from "./icons.tsx";

const GROUP_ICON: Record<WmoGroup, (p: { width?: number; height?: number; className?: string }) => React.ReactNode> = {
  clear: SunIcon,
  cloud: CloudIcon,
  fog: FogIcon,
  rain: CloudRainIcon,
  snow: SnowIcon,
  storm: StormIcon,
};

function WxIcon({ code, size = 18, className }: { code: number; size?: number; className?: string }) {
  const Icon = GROUP_ICON[wmoGroup(code)];
  return <Icon width={size} height={size} className={className} />;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric" });
}

function fmtRange(from: string, to: string): string {
  const f = (s: string) => new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  return `${f(from)} – ${f(to)}`;
}

// Tier accent for the at-risk list — same token styles as DetailPanel's vulnerability read-out.
const TIER_CLASS: Record<RiskTier, string | undefined> = {
  low: undefined,
  moderate: "text-amber-600 dark:text-amber-300",
  elevated: "text-amber-600 dark:text-amber-300",
  high: "text-red-600 dark:text-red-400",
};

function CycloneCard({ ev, data }: { ev: CycloneEvent; data: GridData }) {
  const select = useAppStore((s) => s.select);
  const toggleView = useAppStore((s) => s.toggleWeatherView);
  // Substations inside the forecast cone / alert swaths — the grid-relevance readout, ranked
  // by the indicative vulnerability screening score (storm mode).
  const atRisk = useMemo(() => {
    const ga = graphAnalysis(data);
    return assetsInCone(data.substations, ev.conePolygons)
      .map((ss) => {
        const feedDegree = ga.feedDegrees.get(ss.id) ?? 0;
        // Core SS carry no commissioning date (`doc` is null in this dataset) → unknown age.
        const { score } = substationRisk({
          coastalBand: ss.coastalBand,
          ageYears: null,
          feedDegree,
          voltage: ss.voltage,
        });
        return { ss, feedDegree, score, tier: riskTier(score) };
      })
      .sort((a, b) => b.score - a.score);
  }, [ev, data]);
  const exportCsv = () =>
    downloadText(
      `cyclone-${ev.id}-assets-at-risk.csv`,
      "text/csv",
      toCsv(
        ["name", "voltage_kv", "circle", "coastal_km", "feed_degree", "risk_score", "risk_tier", "longitude", "latitude"],
        atRisk.map(({ ss, feedDegree, score, tier }) => [
          ss.name, ss.voltage, ss.circle ?? "", ss.coastalKm ?? "", feedDegree, score, tier, ss.lng, ss.lat,
        ]),
      ),
    );
  const color = WX_ALERT_COLOR[ev.alertLevel];
  return (
    <div className="rounded-xl border px-3.5 py-3" style={{ borderColor: color, backgroundColor: `${color}14` }}>
      <div className="flex flex-wrap items-center gap-2">
        <CycloneIcon width={17} height={17} style={{ color }} className="shrink-0" />
        <span className="font-semibold text-ink">{ev.name}</span>
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white"
          style={{ backgroundColor: color }}
        >
          {ev.alertLevel} alert
        </span>
        <span className="text-xs text-ink-2">{fmtRange(ev.fromDate, ev.toDate)}</span>
        {ev.reportUrl && (
          <a
            href={ev.reportUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-xs font-medium text-accent hover:underline"
          >
            GDACS report
          </a>
        )}
      </div>
      <p className="mt-1 text-sm text-ink-2">
        {ev.severityText ?? "Tropical cyclone"}
        {ev.country ? ` · ${ev.country}` : ""}
      </p>
      <p className="mt-1 text-sm">
        {atRisk.length > 0 ? (
          <span className="font-medium text-ink">
            {atRisk.length} substation{atRisk.length === 1 ? "" : "s"} inside the forecast envelope
            <span className="font-normal text-ink-2"> (also haloed on the map · indicative)</span>
          </span>
        ) : (
          <span className="text-ink-2">No AP-TRANSCO substations inside the current forecast envelope.</span>
        )}
      </p>
      {atRisk.length > 0 && (
        <>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">
              Assets at risk (indicative)
            </span>
            <button
              onClick={exportCsv}
              title="Export all in-cone substations as CSV"
              className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <DownloadIcon width={14} height={14} /> CSV
            </button>
          </div>
          <div className="-mx-1 mt-1">
            {atRisk.slice(0, 10).map(({ ss, feedDegree, score, tier }) => (
              <button
                key={ss.id}
                onClick={() => {
                  select(ss.id, { fly: true });
                  toggleView(false);
                }}
                title="Screening score from coastal exposure, inferred redundancy and voltage — not a hazard model"
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1 truncate text-ink">{ss.name}</span>
                <span className="shrink-0 text-xs text-ink-2">{ss.voltage} kV</span>
                <span className={`shrink-0 text-xs font-semibold tabular-nums ${TIER_CLASS[tier] ?? "text-ink"}`}>
                  {score}
                </span>
                {feedDegree <= 1 && (
                  <span className="shrink-0 rounded-full bg-amber-100/70 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
                    single-fed
                  </span>
                )}
              </button>
            ))}
          </div>
          {atRisk.length > 10 && (
            <p className="px-1 text-xs text-ink-2">+{atRisk.length - 10} more — the CSV has the full list.</p>
          )}
        </>
      )}
    </div>
  );
}

function CircleCard({ cw }: { cw: CircleWeather }) {
  const c = cw.current;
  return (
    <div className="rounded-xl border border-line bg-surface-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[13px] font-semibold text-ink">{cw.circle}</span>
        <WxIcon code={c.code} className="shrink-0 text-ink-2" />
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-xl font-semibold tabular-nums text-ink">{Math.round(c.tempC)}°C</span>
        <span className="truncate text-xs text-ink-2">{wmoLabel(c.code)}</span>
      </div>
      <p className="mt-1 text-xs tabular-nums text-ink-2">
        Wind {Math.round(c.windKmh)} km/h {compass8(c.windDirDeg)} · gusts {Math.round(c.gustKmh)}
      </p>
      <p className="text-xs tabular-nums text-ink-2">
        RH {Math.round(c.humidityPct)}%{c.precipMm > 0 ? ` · rain ${c.precipMm.toLocaleString("en-IN")} mm` : ""}
      </p>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wide text-ink-2">{children}</h3>;
}

function Body({ weather, data }: { weather: WeatherData; data: GridData }) {
  return (
    <>
      {/* Active cyclones */}
      <SectionTitle>Tropical cyclones · Bay of Bengal / Arabian Sea</SectionTitle>
      {weather.cyclones.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-sm text-ink-2">
          No active cyclone systems in the basin (GDACS).
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {weather.cyclones.map((ev) => (
            <CycloneCard key={ev.id} ev={ev} data={data} />
          ))}
        </div>
      )}

      {/* Per-circle current conditions */}
      {weather.circles.length > 0 && (
        <>
          <SectionTitle>Current conditions by circle</SectionTitle>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {weather.circles.map((cw) => (
              <CircleCard key={cw.circle} cw={cw} />
            ))}
          </div>
        </>
      )}

      {/* Coastal / marine strip */}
      {weather.marine.length > 0 && (
        <>
          <SectionTitle>Coastal sea state</SectionTitle>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {weather.marine.map((m) => (
              <div key={m.name} className="rounded-xl border border-line bg-surface-2 px-3 py-2.5">
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate text-xs font-semibold text-ink">{m.name}</span>
                  <WaveIcon width={15} height={15} className="shrink-0 text-ink-2" />
                </div>
                <p className="mt-1 text-lg font-semibold tabular-nums text-ink">
                  {m.waveM != null ? `${m.waveM.toFixed(1)} m` : "—"}
                </p>
                <p className="text-[11px] tabular-nums text-ink-2">
                  swell {m.swellM != null ? `${m.swellM.toFixed(1)} m` : "—"}
                </p>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 3-day outlook */}
      {weather.circles.length > 0 && weather.circles[0].daily.dates.length > 0 && (
        <>
          <SectionTitle>3-day outlook · max temp / max gust / rain</SectionTitle>
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-2">
                  <th className="px-3 py-2">Circle</th>
                  {weather.circles[0].daily.dates.map((d) => (
                    <th key={d} className="px-3 py-2 text-right">{fmtDay(d)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weather.circles.map((cw) => (
                  <tr key={cw.circle} className="border-b border-line/60 last:border-0">
                    <td className="px-3 py-1.5 font-medium text-ink">{cw.circle}</td>
                    {cw.daily.dates.map((d, i) => (
                      <td key={d} className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-ink-2">
                        <span className="inline-flex items-center gap-1.5">
                          <WxIcon code={cw.daily.codes[i]} size={13} />
                          <span className="text-ink">{Math.round(cw.daily.tMaxC[i])}°</span>
                          <WindIcon width={12} height={12} />
                          {Math.round(cw.daily.gustMaxKmh[i])}
                          {cw.daily.precipSumMm[i] >= 1 && (
                            <span className="text-sky-600 dark:text-sky-400">
                              {Math.round(cw.daily.precipSumMm[i])} mm
                            </span>
                          )}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {weather.sourceErrors.length > 0 && (
        <p className="mt-3 rounded-lg bg-amber-100/70 px-2.5 py-2 text-xs text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
          Some sources didn’t respond: {weather.sourceErrors.join(" · ")}
        </p>
      )}

      <p className="mt-3 text-xs text-ink-2">
        Indicative, third-party data — not an operational forecast. Conditions &amp; marine:
        Open-Meteo · Radar: RainViewer · Cyclones: GDACS (UN/EC JRC). Gusts and cyclone envelopes
        are model outputs; verify against IMD advisories before acting.
      </p>
    </>
  );
}

export function WeatherView({ data }: { data: GridData }) {
  const open = useAppStore((s) => s.weatherOpen);
  const toggle = useAppStore((s) => s.toggleWeatherView);
  const weather = useAppStore((s) => s.weather);
  const wxStatus = useAppStore((s) => s.wxStatus);
  const wxError = useAppStore((s) => s.wxError);
  const refresh = useAppStore((s) => s.refreshWeather);
  if (!open) return null;

  return (
    <div
      className="absolute inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={() => toggle(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Weather monitor"
    >
      <div
        className="flex max-h-full w-[860px] max-w-full flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface shadow-[var(--shadow-panel)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div>
            <h2 className="text-lg font-semibold text-ink">Weather monitor</h2>
            <p className="text-sm text-ink-2">
              Live conditions, cyclone tracking and coastal sea state across the network
            </p>
          </div>
          <div className="flex items-center gap-2">
            {weather && (
              <span className="text-xs tabular-nums text-ink-2">updated {fmtTime(weather.fetchedAt)}</span>
            )}
            <button
              onClick={refresh}
              aria-label="Refresh weather"
              title="Refresh"
              className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <RefreshIcon width={16} height={16} />
            </button>
            <button
              onClick={() => toggle(false)}
              aria-label="Close"
              className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <CloseIcon />
            </button>
          </div>
        </header>

        <div className="overflow-auto px-5 pb-5">
          {weather ? (
            <Body weather={weather} data={data} />
          ) : wxStatus === "error" ? (
            <div className="py-10 text-center">
              <p className="text-sm text-ink-2">Couldn’t load weather data. {wxError}</p>
              <button
                onClick={refresh}
                className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-ink-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" />
              Fetching live weather…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
