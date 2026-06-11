// MIS Dashboards v1 — operational MIS from official daily publications (DSS revamp spec §4 / M3).
// DuckDB-WASM queries the data-branch parquet over HTTP (duck.ts) and ECharts renders lazily
// (Chart.tsx → echarts-lazy.ts); both runtimes live ONLY inside this workspace chunk. Each
// source degrades independently: a failed PSP or Vidyut fetch shows a "data unavailable" card,
// never a crash (per-source degradation, like the weather stack).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { FreshnessBadge } from "../../components/FreshnessBadge.tsx";
import { loadManifest, type DatasetManifest } from "../../data/manifests.ts";
import { useAppStore } from "../../state/store.ts";
import {
  anomalies,
  fmtNum,
  fmtSigned,
  indexTo100,
  kpiStat,
  rollingMean,
  type Anomaly,
  type KpiStat,
} from "./analytics.ts";
import { Chart } from "./Chart.tsx";
import {
  ENTITY_AI,
  ENTITY_AP,
  ENTITY_SR,
  loadPspData,
  loadVidyutData,
  type PspData,
  type VidyutData,
} from "./queries.ts";

type Loadable<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error" };

// ---------------------------------------------------------------------------
// Derived series (pure reshaping of the queried rows; all stats in analytics.ts)

interface Derived {
  dates: string[];
  apEnergy: Array<number | null>;
  apPeak: Array<number | null>;
  apEnergyRoll7: Array<number | null>;
  srEnergy: Array<number | null>;
  aiEnergy: Array<number | null>;
  energyKpi: KpiStat;
  peakKpi: KpiStat;
  shortageKpi: KpiStat;
  anoms: Anomaly[];
}

function derive(psp: PspData): Derived {
  const byEntity = new Map<string, Map<string, (typeof psp.rows)[number]>>();
  const dateSet = new Set<string>();
  for (const r of psp.rows) {
    dateSet.add(r.d);
    let m = byEntity.get(r.entity);
    if (!m) byEntity.set(r.entity, (m = new Map()));
    m.set(r.d, r);
  }
  const dates = [...dateSet].sort();
  const col = (entity: string, field: "energy_met_mu" | "max_demand_met_mw" | "energy_shortage_mu") =>
    dates.map((d) => byEntity.get(entity)?.get(d)?.[field] ?? null);

  const apEnergy = col(ENTITY_AP, "energy_met_mu");
  const apPeak = col(ENTITY_AP, "max_demand_met_mw");
  const apShortage = col(ENTITY_AP, "energy_shortage_mu");
  return {
    dates,
    apEnergy,
    apPeak,
    apEnergyRoll7: rollingMean(apEnergy, 7),
    srEnergy: col(ENTITY_SR, "energy_met_mu"),
    aiEnergy: col(ENTITY_AI, "energy_met_mu"),
    energyKpi: kpiStat(apEnergy),
    peakKpi: kpiStat(apPeak),
    shortageKpi: kpiStat(apShortage),
    anoms: anomalies(apEnergy, 14, 2, 7),
  };
}

// ---------------------------------------------------------------------------
// Chart options (theme tokens baked in per mode; rebuilt when dark flips)

interface ChartTheme {
  text: string;
  line: string;
  split: string;
}

function chartTheme(dark: boolean): ChartTheme {
  return dark
    ? { text: "#9bb0c4", line: "#294056", split: "#1d2c3d" }
    : { text: "#44566c", line: "#d6deea", split: "#e8ecf2" };
}

function baseOption(t: ChartTheme, dates: string[]): EChartsCoreOption {
  return {
    animationDuration: 300,
    grid: { left: 48, right: 16, top: 36, bottom: 28 },
    legend: { top: 4, textStyle: { color: t.text, fontSize: 11 }, itemWidth: 14, itemHeight: 9 },
    tooltip: { trigger: "axis", confine: true },
    xAxis: {
      type: "category",
      data: dates,
      axisLine: { lineStyle: { color: t.line } },
      axisLabel: { color: t.text, fontSize: 10, formatter: (d: string) => d.slice(5) },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      scale: true,
      axisLabel: { color: t.text, fontSize: 10 },
      splitLine: { lineStyle: { color: t.split } },
    },
  };
}

// Series hues: AP accent green, SR Okabe-Ito blue, All-India vermillion (CVD-safe trio).
const AP_COLOR = "#1a936f";
const SR_COLOR = "#0072b2";
const AI_COLOR = "#d55e00";

function energyOption(d: Derived, t: ChartTheme): EChartsCoreOption {
  return {
    ...baseOption(t, d.dates),
    series: [
      {
        name: "Energy met (MU)",
        type: "bar",
        data: d.apEnergy,
        itemStyle: { color: AP_COLOR, opacity: 0.45, borderRadius: [2, 2, 0, 0] },
        barMaxWidth: 14,
      },
      {
        name: "7-day mean",
        type: "line",
        data: d.apEnergyRoll7.map((v) => (v == null ? null : Math.round(v * 10) / 10)),
        smooth: true,
        showSymbol: false,
        lineStyle: { color: AP_COLOR, width: 2.5 },
        itemStyle: { color: AP_COLOR },
      },
    ],
  };
}

function indexedOption(d: Derived, t: ChartTheme): EChartsCoreOption {
  const [ap, sr, ai] = indexTo100([d.apEnergy, d.srEnergy, d.aiEnergy]).map((s) =>
    s.map((v) => (v == null ? null : Math.round(v * 10) / 10)),
  );
  const line = (name: string, data: Array<number | null>, color: string, width = 2) => ({
    name,
    type: "line",
    data,
    smooth: true,
    showSymbol: false,
    lineStyle: { color, width },
    itemStyle: { color },
  });
  return {
    ...baseOption(t, d.dates),
    yAxis: {
      type: "value",
      scale: true,
      name: "first common day = 100",
      nameTextStyle: { color: t.text, fontSize: 10 },
      axisLabel: { color: t.text, fontSize: 10 },
      splitLine: { lineStyle: { color: t.split } },
    },
    series: [
      line("Andhra Pradesh", ap, AP_COLOR, 2.5),
      line("Southern Region", sr, SR_COLOR),
      line("All India", ai, AI_COLOR),
    ],
  };
}

function peakOption(d: Derived, t: ChartTheme): EChartsCoreOption {
  return {
    ...baseOption(t, d.dates),
    series: [
      {
        name: "AP peak demand met (MW)",
        type: "line",
        data: d.apPeak,
        smooth: true,
        showSymbol: false,
        lineStyle: { color: SR_COLOR, width: 2.5 },
        itemStyle: { color: SR_COLOR },
        areaStyle: { color: SR_COLOR, opacity: 0.08 },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Small presentational pieces

function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-[var(--radius-panel)] border border-line bg-surface p-4 shadow-[var(--shadow-panel)] ${className}`}
    >
      {children}
    </section>
  );
}

function DeltaRow({ label, delta, unit, digits }: { label: string; delta: number | null; unit: string; digits: number }) {
  const dir = delta == null || delta === 0 ? "" : delta > 0 ? "▲" : "▼";
  return (
    <p className="flex items-baseline justify-between text-[11px] text-ink-2">
      <span>{label}</span>
      <span className="font-medium tabular-nums">
        {dir && <span className="mr-0.5">{dir}</span>}
        {fmtSigned(delta, digits)} {unit}
      </span>
    </p>
  );
}

function KpiCard({
  label,
  stat,
  unit,
  digits,
  badge,
  highlightNonZero = false,
}: {
  label: string;
  stat: KpiStat;
  unit: string;
  digits: number;
  badge?: ReactNode;
  highlightNonZero?: boolean;
}) {
  const bad = highlightNonZero && stat.latest != null && stat.latest > 0;
  return (
    <Panel>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-xs font-medium text-ink-2">{label}</h3>
        {badge}
      </div>
      <p className={`mt-1.5 text-2xl font-bold tabular-nums ${bad ? "text-red-600 dark:text-red-400" : "text-ink"}`}>
        {fmtNum(stat.latest, digits)} <span className="text-sm font-medium text-ink-2">{unit}</span>
      </p>
      <div className="mt-2 space-y-0.5 border-t border-line pt-2">
        <DeltaRow label="vs previous day" delta={stat.dPrev} unit={unit} digits={digits} />
        <DeltaRow label="vs prior 7-day mean" delta={stat.dMean} unit={unit} digits={digits} />
      </div>
    </Panel>
  );
}

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-[var(--radius-panel)] border border-line bg-surface-3/60 ${className}`} />;
}

function Unavailable({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <Panel className="text-center">
      <p className="text-sm font-medium text-ink">{what} unavailable</p>
      <p className="mt-1 text-xs text-ink-2">
        Could not reach the data branch or start the in-browser SQL engine. The rest of the app is unaffected.
      </p>
      <button
        onClick={onRetry}
        className="mt-3 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
      >
        Retry
      </button>
    </Panel>
  );
}

/** The committed manifests carry `source` as `{name, url}`; the TS contract says string. Take either. */
function sourceName(m: DatasetManifest | null): string {
  if (!m) return "—";
  const s = m.source as unknown;
  if (typeof s === "string") return s;
  if (s && typeof s === "object" && "name" in s) return String((s as { name: unknown }).name);
  return "—";
}

function CoverageBlock({
  manifest,
  fallbackName,
  range,
}: {
  manifest: DatasetManifest | null;
  fallbackName: string;
  range: { min_d: string | null; max_d: string | null; n: number } | null;
}) {
  return (
    <div className="min-w-0 flex-1">
      <p className="text-xs font-semibold text-ink">{manifest ? sourceName(manifest) : fallbackName}</p>
      <p className="mt-0.5 text-[11px] text-ink-2">
        {range && range.min_d
          ? `${range.min_d} → ${range.max_d} · ${fmtNum(range.n)} rows`
          : "coverage unknown"}
        {manifest ? ` · ${manifest.attribution}` : ""}
      </p>
      {manifest && <p className="mt-0.5 text-[10px] leading-snug text-ink-2/80">{manifest.licence}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function MisDashboards() {
  const dark = useAppStore((s) => s.basemap !== "light");
  const [nonce, setNonce] = useState(0);
  const [pspManifest, setPspManifest] = useState<DatasetManifest | null>(null);
  const [vidyutManifest, setVidyutManifest] = useState<DatasetManifest | null>(null);
  const [psp, setPsp] = useState<Loadable<PspData>>({ status: "loading" });
  const [vidyut, setVidyut] = useState<Loadable<VidyutData>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setPsp({ status: "loading" });
    setVidyut({ status: "loading" });
    void loadManifest("psp-daily").then((m) => !cancelled && setPspManifest(m));
    void loadManifest("vidyut-daily").then((m) => !cancelled && setVidyutManifest(m));
    loadPspData()
      .then((data) => !cancelled && setPsp({ status: "ready", data }))
      .catch(() => !cancelled && setPsp({ status: "error" }));
    loadVidyutData()
      .then((data) => !cancelled && setVidyut({ status: "ready", data }))
      .catch(() => !cancelled && setVidyut({ status: "error" }));
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const derived = useMemo(() => (psp.status === "ready" ? derive(psp.data) : null), [psp]);
  const theme = useMemo(() => chartTheme(dark), [dark]);
  const energyOpt = useMemo(() => (derived ? energyOption(derived, theme) : null), [derived, theme]);
  const indexedOpt = useMemo(() => (derived ? indexedOption(derived, theme) : null), [derived, theme]);
  const peakOpt = useMemo(() => (derived ? peakOption(derived, theme) : null), [derived, theme]);

  const retry = () => setNonce((n) => n + 1);
  const pspBadge = <FreshnessBadge manifest={pspManifest} />;

  return (
    <div className="h-full w-full overflow-y-auto bg-surface-2">
      {/* pt clears the floating BrandHeader on narrow screens; on lg+ the dashboard sits to its right. */}
      <div className="w-full max-w-[1500px] px-4 pb-12 pt-40 sm:px-6 lg:pl-[300px] lg:pr-8 lg:pt-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-bold text-ink">MIS Dashboards</h1>
          <p className="text-sm text-ink-2">Daily power supply position — Andhra Pradesh in regional &amp; national context</p>
          <span className="flex items-center gap-1.5">
            {pspBadge}
            <FreshnessBadge manifest={vidyutManifest} />
          </span>
        </header>

        {/* KPI cards */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {psp.status === "loading" && (
            <>
              <Skeleton className="h-36" />
              <Skeleton className="h-36" />
              <Skeleton className="h-36" />
            </>
          )}
          {psp.status === "error" && (
            <div className="sm:col-span-2 xl:col-span-3">
              <Unavailable what="Grid-India PSP data" onRetry={retry} />
            </div>
          )}
          {derived && (
            <>
              <KpiCard label="AP energy met (latest day)" stat={derived.energyKpi} unit="MU" digits={1} badge={pspBadge} />
              <KpiCard label="AP peak demand met" stat={derived.peakKpi} unit="MW" digits={0} badge={pspBadge} />
              <KpiCard
                label="AP energy shortage"
                stat={derived.shortageKpi}
                unit="MU"
                digits={1}
                badge={pspBadge}
                highlightNonZero
              />
            </>
          )}

          {/* Vidyut Pravah snapshot — independent source, degrades on its own */}
          {vidyut.status === "loading" && <Skeleton className="h-36" />}
          {vidyut.status === "error" && <Unavailable what="Vidyut Pravah snapshot" onRetry={retry} />}
          {vidyut.status === "ready" && (
            <Panel>
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-xs font-medium text-ink-2">AP snapshot (Vidyut Pravah)</h3>
                <FreshnessBadge manifest={vidyutManifest} />
              </div>
              {vidyut.data.latest ? (
                <>
                  <p className="mt-1.5 text-2xl font-bold tabular-nums text-ink">
                    {fmtNum(vidyut.data.latest.demand_met_mw)}{" "}
                    <span className="text-sm font-medium text-ink-2">MW demand met</span>
                  </p>
                  <div className="mt-2 space-y-0.5 border-t border-line pt-2 text-[11px] text-ink-2">
                    <p className="flex justify-between">
                      <span>Exchange price</span>
                      <span className="font-medium tabular-nums">
                        {fmtNum(vidyut.data.latest.exchange_price_inr_kwh, 2)} ₹/kWh
                      </span>
                    </p>
                    <p className="flex justify-between">
                      <span>Peak shortage</span>
                      <span className="font-medium tabular-nums">{fmtNum(vidyut.data.latest.peak_shortage_mw)} MW</span>
                    </p>
                    <p className="flex justify-between">
                      <span>Snapshot date</span>
                      <span className="font-medium tabular-nums">{vidyut.data.latest.d}</span>
                    </p>
                  </div>
                </>
              ) : (
                <p className="mt-2 text-sm text-ink-2">No rows in the snapshot series yet.</p>
              )}
            </Panel>
          )}
        </div>

        {/* Charts */}
        <div className="mt-4 grid gap-3">
          {psp.status === "loading" && <Skeleton className="h-72" />}
          {energyOpt && (
            <Panel>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-ink">AP daily energy met · 7-day rolling mean</h2>
                {pspBadge}
              </div>
              <Chart option={energyOpt} className="mt-2 h-64 w-full" />
            </Panel>
          )}

          <div className="grid gap-3 xl:grid-cols-2">
            {psp.status === "loading" && (
              <>
                <Skeleton className="h-72" />
                <Skeleton className="h-72" />
              </>
            )}
            {indexedOpt && (
              <Panel>
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-ink">Energy met — AP vs Southern Region vs All India</h2>
                  {pspBadge}
                </div>
                <Chart option={indexedOpt} className="mt-2 h-64 w-full" />
              </Panel>
            )}
            {peakOpt && (
              <Panel>
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-ink">AP peak demand met trend</h2>
                  {pspBadge}
                </div>
                <Chart option={peakOpt} className="mt-2 h-64 w-full" />
              </Panel>
            )}
          </div>
        </div>

        {/* Anomaly flags */}
        {derived && (
          <Panel className="mt-4">
            <h2 className="text-sm font-semibold text-ink">
              Anomaly flags{" "}
              <span className="font-normal text-ink-2">— AP energy met &gt;2σ from the trailing 14-day window</span>
            </h2>
            {derived.anoms.length === 0 ? (
              <p className="mt-2 text-xs text-ink-2">No days deviate by more than 2σ in the loaded window.</p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {derived.anoms.map((a) => (
                  <span
                    key={a.i}
                    title={`Trailing 14-day mean ${fmtNum(a.mean, 1)} MU`}
                    className="inline-flex items-center gap-1.5 rounded-full bg-amber-100/70 px-2.5 py-1 text-[11px] font-medium text-amber-900 dark:bg-amber-500/15 dark:text-amber-200"
                  >
                    {derived.dates[a.i]} · {fmtNum(a.value, 1)} MU · z {fmtSigned(a.z, 1)}
                  </span>
                ))}
              </div>
            )}
            <p className="mt-2 text-[10px] text-ink-2/80">
              Indicative screening only — a statistical deviation from recent history, not an operational event flag.
            </p>
          </Panel>
        )}

        {/* Data coverage footer */}
        <footer className="mt-4 rounded-[var(--radius-panel)] border border-line bg-surface/70 p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-2">Data coverage</h2>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:gap-8">
            <CoverageBlock
              manifest={pspManifest}
              fallbackName="Grid-India daily PSP report"
              range={psp.status === "ready" ? psp.data.coverage : null}
            />
            <CoverageBlock
              manifest={vidyutManifest}
              fallbackName="Vidyut Pravah (Ministry of Power)"
              range={vidyut.status === "ready" ? vidyut.data.coverage : null}
            />
          </div>
          <p className="mt-3 text-[10px] text-ink-2/80">
            Values as published in the official reports; deltas, rolling means, indexing and anomaly z-scores are
            derived in-browser and indicative. Analytics: DuckDB-WASM over parquet, queried directly from the data
            branch.
          </p>
        </footer>
      </div>
    </div>
  );
}
