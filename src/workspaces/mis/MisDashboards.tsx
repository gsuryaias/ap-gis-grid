// MIS Dashboards v2 — operational MIS from official daily publications (Phase 2: drill-downs,
// vidyut history, DOY baselines). DuckDB-WASM queries parquet over HTTP (duck.ts); ECharts
// renders lazily (Chart.tsx → echarts-lazy.ts). Per-source degradation: failed fetches show
// unavailable cards, never a crash.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { ChevronDown, CloseIcon } from "../../components/icons.tsx";
import { FreshnessBadge } from "../../components/FreshnessBadge.tsx";
import { MethodCard } from "../../components/MethodCard.tsx";
import { loadManifest, type DatasetManifest } from "../../data/manifests.ts";
import { downloadText, toCsv } from "../../lib/export.ts";
import { useAppStore } from "../../state/store.ts";
import {
  anomalies,
  doyBaselineSeries,
  doyZScores,
  fmtNum,
  fmtSigned,
  indexTo100,
  kpiStat,
  rollingMean,
  spanYears,
  type Anomaly,
  type DateRange,
  type KpiStat,
} from "./analytics.ts";
import { Chart } from "./Chart.tsx";
import { ENERGY_TYPES, type EnergyType, type GenerationData } from "../../data/types.ts";
import { ENERGY_COLOR } from "../../theme/palette.ts";
import {
  ENTITY_AI,
  ENTITY_AP,
  ENTITY_SR,
  PEER_STATES,
  loadCeaData,
  loadPspData,
  loadPspDay,
  loadVidyutData,
  type CeaData,
  type CeaRow,
  type PspData,
  type PspRow,
  type VidyutData,
  type VidyutRow,
} from "./queries.ts";

type Loadable<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error" };

// ---------------------------------------------------------------------------
// Derived series

interface Derived {
  dates: string[];
  apEnergy: Array<number | null>;
  apPeak: Array<number | null>;
  apEveningPeak: Array<number | null>;
  apEnergyRoll7: Array<number | null>;
  srEnergy: Array<number | null>;
  aiEnergy: Array<number | null>;
  energyKpi: KpiStat;
  peakKpi: KpiStat;
  shortageKpi: KpiStat;
  anoms: Anomaly[];
  doyN: number;
  byEntity: Map<string, Map<string, PspRow>>;
}

function buildByEntity(rows: PspRow[]): Map<string, Map<string, PspRow>> {
  const byEntity = new Map<string, Map<string, PspRow>>();
  for (const r of rows) {
    let m = byEntity.get(r.entity);
    if (!m) byEntity.set(r.entity, (m = new Map()));
    m.set(r.d, r);
  }
  return byEntity;
}

function derive(psp: PspData): Derived {
  const dateSet = new Set<string>();
  for (const r of psp.rows) dateSet.add(r.d);
  const dates = [...dateSet].sort();
  const byEntity = buildByEntity(psp.rows);
  const col = (entity: string, field: keyof PspRow) =>
    dates.map((d) => {
      const v = byEntity.get(entity)?.get(d)?.[field];
      return typeof v === "number" ? v : null;
    });

  const apEnergy = col(ENTITY_AP, "energy_met_mu");
  const baselines = doyBaselineSeries(dates, apEnergy);
  const doyN = baselines.reduce((m, b) => (b.method === "doy" ? Math.max(m, b.n) : m), 0);

  return {
    dates,
    apEnergy,
    apPeak: col(ENTITY_AP, "max_demand_met_mw"),
    apEveningPeak: col(ENTITY_SR, "evening_peak_demand_mw"),
    srEnergy: col(ENTITY_SR, "energy_met_mu"),
    aiEnergy: col(ENTITY_AI, "energy_met_mu"),
    apEnergyRoll7: rollingMean(apEnergy, 7),
    energyKpi: kpiStat(apEnergy),
    peakKpi: kpiStat(col(ENTITY_AP, "max_demand_met_mw")),
    shortageKpi: kpiStat(col(ENTITY_AP, "energy_shortage_mu")),
    anoms: anomalies(apEnergy, 14, 2, 7),
    doyN,
    byEntity,
  };
}

function entitySeries(
  byEntity: Map<string, Map<string, PspRow>>,
  dates: string[],
  entity: string,
  field: keyof PspRow,
): Array<number | null> {
  return dates.map((d) => {
    const v = byEntity.get(entity)?.get(d)?.[field];
    return typeof v === "number" ? v : null;
  });
}

// ---------------------------------------------------------------------------
// Chart theme + options

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

function zoomBrush(t: ChartTheme): EChartsCoreOption {
  return {
    dataZoom: [
      {
        type: "inside",
        xAxisIndex: 0,
      },
      {
        type: "slider",
        xAxisIndex: 0,
        height: 18,
        bottom: 2,
        borderColor: t.line,
        fillerColor: darkFiller(t),
        handleStyle: { color: t.text },
        textStyle: { color: t.text, fontSize: 9 },
      },
    ],
    brush: {
      toolbox: ["lineX", "clear"],
      xAxisIndex: 0,
      brushStyle: { borderWidth: 1, color: "rgba(26,147,111,0.12)", borderColor: "#1a936f" },
    },
    toolbox: { show: false },
    grid: { left: 48, right: 16, top: 36, bottom: 48 },
  };
}

function darkFiller(t: ChartTheme): string {
  return t.line === "#294056" ? "rgba(41,64,86,0.35)" : "rgba(214,222,234,0.45)";
}

function baseOption(t: ChartTheme, dates: string[]): EChartsCoreOption {
  return {
    animationDuration: 300,
    ...zoomBrush(t),
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

const AP_COLOR = "#1a936f";
const SR_COLOR = "#0072b2";
const EVENING_COLOR = "#cc79a7";
const PRICE_COLOR = "#e69f00";

const ENTITY_PALETTE = [
  "#1a936f", "#0072b2", "#d55e00", "#cc79a7", "#56b4e9", "#009e73", "#f0e442", "#e69f00",
];

function energyOption(d: Derived, t: ChartTheme): EChartsCoreOption {
  const baselines = doyBaselineSeries(d.dates, d.apEnergy);
  const upper = baselines.map((b) =>
    b?.mean != null && b?.sigma != null ? Math.round((b.mean + b.sigma) * 10) / 10 : null,
  );
  const lower = baselines.map((b) =>
    b?.mean != null && b?.sigma != null ? Math.round((b.mean - b.sigma) * 10) / 10 : null,
  );
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
      {
        name: "DOY baseline +σ",
        type: "line",
        data: upper,
        showSymbol: false,
        lineStyle: { color: AP_COLOR, width: 1, type: "dashed", opacity: 0.5 },
        itemStyle: { color: AP_COLOR },
      },
      {
        name: "DOY baseline −σ",
        type: "line",
        data: lower,
        showSymbol: false,
        lineStyle: { color: AP_COLOR, width: 1, type: "dashed", opacity: 0.5 },
        itemStyle: { color: AP_COLOR },
      },
    ],
  };
}

function indexedOption(
  dates: string[],
  entities: string[],
  byEntity: Map<string, Map<string, PspRow>>,
  t: ChartTheme,
): EChartsCoreOption {
  const raw = entities.map((e) => entitySeries(byEntity, dates, e, "energy_met_mu"));
  const indexed = indexTo100(raw).map((s) => s.map((v) => (v == null ? null : Math.round(v * 10) / 10)));
  return {
    ...baseOption(t, dates),
    yAxis: {
      type: "value",
      scale: true,
      name: "first common day = 100",
      nameTextStyle: { color: t.text, fontSize: 10 },
      axisLabel: { color: t.text, fontSize: 10 },
      splitLine: { lineStyle: { color: t.split } },
    },
    series: entities.map((name, i) => ({
      name,
      type: "line",
      data: indexed[i],
      smooth: true,
      showSymbol: false,
      lineStyle: { color: ENTITY_PALETTE[i % ENTITY_PALETTE.length], width: i === 0 ? 2.5 : 2 },
      itemStyle: { color: ENTITY_PALETTE[i % ENTITY_PALETTE.length] },
    })),
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

function peakVsEveningOption(d: Derived, t: ChartTheme): EChartsCoreOption {
  const srEvening = d.apEveningPeak;
  const line = (name: string, data: Array<number | null>, color: string) => ({
    name,
    type: "line",
    data,
    smooth: true,
    showSymbol: false,
    lineStyle: { color, width: 2 },
    itemStyle: { color },
  });
  return {
    ...baseOption(t, d.dates),
    yAxis: {
      type: "value",
      scale: true,
      name: "MW",
      nameTextStyle: { color: t.text, fontSize: 10 },
      axisLabel: { color: t.text, fontSize: 10 },
      splitLine: { lineStyle: { color: t.split } },
    },
    series: [
      line("AP max demand met", d.apPeak, AP_COLOR),
      line("SR evening peak demand", srEvening, EVENING_COLOR),
    ],
  };
}

function vidyutTsOption(rows: VidyutRow[], t: ChartTheme): EChartsCoreOption {
  const dates = rows.map((r) => r.d);
  const demand = rows.map((r) => r.demand_met_mw);
  const price = rows.map((r) => r.exchange_price_inr_kwh);
  return {
    ...baseOption(t, dates),
    yAxis: [
      {
        type: "value",
        name: "MW",
        scale: true,
        axisLabel: { color: t.text, fontSize: 10 },
        splitLine: { lineStyle: { color: t.split } },
        nameTextStyle: { color: t.text, fontSize: 10 },
      },
      {
        type: "value",
        name: "₹/kWh",
        scale: true,
        axisLabel: { color: t.text, fontSize: 10 },
        splitLine: { show: false },
        nameTextStyle: { color: t.text, fontSize: 10 },
      },
    ],
    series: [
      {
        name: "Demand met",
        type: "line",
        data: demand,
        yAxisIndex: 0,
        smooth: true,
        showSymbol: true,
        symbolSize: 5,
        lineStyle: { color: AP_COLOR, width: 2.5 },
        itemStyle: { color: AP_COLOR },
      },
      {
        name: "Exchange price",
        type: "line",
        data: price,
        yAxisIndex: 1,
        smooth: true,
        showSymbol: false,
        lineStyle: { color: PRICE_COLOR, width: 2, type: "dashed" },
        itemStyle: { color: PRICE_COLOR },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Presentational

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

function sourceName(m: DatasetManifest | null): string {
  if (!m) return "—";
  const s = m.source as unknown;
  if (typeof s === "string") return s;
  if (s && typeof s === "object" && "name" in s) return String((s as { name: unknown }).name);
  return "—";
}

function exportDailyOpsBrief(opts: {
  derived: Derived;
  pspManifest: DatasetManifest | null;
  vidyutManifest: DatasetManifest | null;
  focusEntity: string;
  latestDate: string | null;
}) {
  const { derived, pspManifest, vidyutManifest, focusEntity, latestDate } = opts;
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const anomRows = derived.anoms
    .map(
      (a) =>
        `<tr><td>${esc(derived.dates[a.i]!)}</td><td>${fmtNum(a.value, 1)} MU</td><td>${fmtSigned(a.z, 1)}</td></tr>`,
    )
    .join("");
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>AP daily ops brief · ${esc(latestDate ?? "—")}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#1e293b}
h1{font-size:1.25rem}table{width:100%;border-collapse:collapse;font-size:0.85rem;margin-top:0.5rem}
th,td{border:1px solid #cbd5e1;padding:0.35rem 0.5rem;text-align:left}
th{background:#f1f5f9}.kpi{display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin:1rem 0}
.kpi div{border:1px solid #e2e8f0;border-radius:8px;padding:0.75rem}
.meta{font-size:0.75rem;color:#64748b;margin-top:1.5rem}
</style></head><body>
<h1>AP daily ops brief (indicative)</h1>
<p>Entity focus: <strong>${esc(focusEntity)}</strong> · latest PSP day: ${esc(latestDate ?? "—")}</p>
<div class="kpi">
<div><strong>Energy met</strong><br>${fmtNum(derived.energyKpi.latest, 1)} MU</div>
<div><strong>Peak demand met</strong><br>${fmtNum(derived.peakKpi.latest, 0)} MW</div>
<div><strong>Energy shortage</strong><br>${fmtNum(derived.shortageKpi.latest, 2)} MU</div>
<div><strong>Anomaly flags</strong><br>${derived.anoms.length} day(s) &gt;2σ</div>
</div>
<h2>Anomalies (AP energy met)</h2>
${derived.anoms.length ? `<table><thead><tr><th>Date</th><th>Value</th><th>z-score</th></tr></thead><tbody>${anomRows}</tbody></table>` : "<p>None in the loaded window.</p>"}
<h2>Data vintages</h2>
<ul>
<li>PSP: ${esc(pspManifest ? `${sourceName(pspManifest)} · ${pspManifest.vintage}` : "unavailable")}</li>
<li>Vidyut Pravah: ${esc(vidyutManifest ? `${sourceName(vidyutManifest)} · ${vidyutManifest.vintage}` : "unavailable")}</li>
</ul>
<p class="meta">Indicative MIS screening from official daily publications — not real-time SCADA. Generated ${esc(new Date().toLocaleString("en-IN"))} · AP-TRANSCO Grid Atlas</p>
</body></html>`;
  downloadText(`mis-daily-ops-${latestDate ?? "brief"}.html`, "text/html", html);
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

type DrillGroupBy = "entity_type" | "shortage";

function DayDrillPanel({
  date,
  rows,
  onClose,
}: {
  date: string;
  rows: PspRow[] | null;
  onClose: () => void;
}) {
  const [groupBy, setGroupBy] = useState<DrillGroupBy>("entity_type");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    if (!rows) return [];
    if (groupBy === "entity_type") {
      const order = ["all-india", "region", "state"];
      const byType = new Map<string, PspRow[]>();
      for (const r of rows) {
        const arr = byType.get(r.entity_type) ?? [];
        arr.push(r);
        byType.set(r.entity_type, arr);
      }
      return order
        .filter((t) => byType.has(t))
        .map((t) => ({
          key: t,
          title: t === "all-india" ? "All India" : t === "region" ? "Regions" : "States",
          rows: (byType.get(t) ?? []).sort((a, b) => (b.energy_met_mu ?? 0) - (a.energy_met_mu ?? 0)),
        }));
    }
    const withShort = rows.filter((r) => (r.energy_shortage_mu ?? 0) > 0 || (r.peak_shortage_mw ?? 0) > 0);
    const clean = rows.filter((r) => !withShort.includes(r));
    const out: { key: string; title: string; rows: PspRow[] }[] = [];
    if (withShort.length) out.push({ key: "short", title: "With shortage", rows: withShort });
    if (clean.length) out.push({ key: "ok", title: "No shortage reported", rows: clean });
    return out;
  }, [rows, groupBy]);

  const exportCsv = () => {
    if (!rows?.length) return;
    const csv = toCsv(
      ["date", "entity", "entity_type", "energy_met_mu", "energy_shortage_mu", "max_demand_met_mw", "peak_shortage_mw", "evening_peak_demand_mw"],
      rows.map((r) => [
        r.d, r.entity, r.entity_type, r.energy_met_mu, r.energy_shortage_mu,
        r.max_demand_met_mw, r.peak_shortage_mw, r.evening_peak_demand_mw,
      ]),
    );
    downloadText(`psp-drill-${date}.csv`, "text/csv", csv);
  };

  const toggle = (k: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`PSP drill-down for ${date}`}
    >
      <div
        className="flex max-h-[90vh] w-[720px] max-w-full flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface shadow-[var(--shadow-panel)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div>
            <h2 className="text-lg font-semibold text-ink">Day drill-down · {date}</h2>
            <p className="text-sm text-ink-2">All PSP entities · shortage breakdown</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={exportCsv}
              disabled={!rows?.length}
              className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-2 disabled:opacity-40"
            >
              CSV
            </button>
            <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink">
              <CloseIcon />
            </button>
          </div>
        </header>

        <div className="flex items-center justify-between px-5 py-2">
          <div className="flex rounded-lg bg-surface-2 p-0.5 text-sm">
            {(["entity_type", "shortage"] as DrillGroupBy[]).map((g) => (
              <button
                key={g}
                onClick={() => setGroupBy(g)}
                className={`rounded-md px-3 py-1 font-medium ${
                  groupBy === g ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"
                }`}
              >
                {g === "entity_type" ? "By entity type" : "By shortage"}
              </button>
            ))}
          </div>
          <span className="text-xs text-ink-2">{rows ? `${rows.length} entities` : "Loading…"}</span>
        </div>

        <div className="flex-1 overflow-auto px-3 pb-4">
          {!rows && <Skeleton className="mx-2 h-40" />}
          {rows?.length === 0 && <p className="px-3 text-sm text-ink-2">No rows for this date.</p>}
          {groups.map((g) => {
            const open = expanded.has(g.key);
            return (
              <div key={g.key} className="border-b border-line/60 last:border-0">
                <button
                  onClick={() => toggle(g.key)}
                  className="flex w-full items-center gap-2 py-2 pl-2 pr-1 text-left"
                  aria-expanded={open}
                >
                  <ChevronDown width={15} height={15} className={`shrink-0 text-ink-2 transition-transform ${open ? "" : "-rotate-90"}`} />
                  <span className="font-semibold text-ink">{g.title}</span>
                  <span className="text-xs text-ink-2">({g.rows.length})</span>
                </button>
                {open && (
                  <div className="mb-2 overflow-hidden rounded-lg border border-line">
                    <table className="w-full text-xs tabular-nums">
                      <thead>
                        <tr className="bg-surface-2 text-[10px] font-semibold uppercase tracking-wide text-ink-2">
                          <th className="px-2 py-1.5 text-left">Entity</th>
                          <th className="px-2 py-1.5 text-right">Energy met</th>
                          <th className="px-2 py-1.5 text-right">Energy shortage</th>
                          <th className="px-2 py-1.5 text-right">Peak met</th>
                          <th className="px-2 py-1.5 text-right">Peak shortage</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.rows.map((r) => (
                          <tr key={r.entity} className="border-t border-line/60">
                            <td className="px-2 py-1.5 text-ink">{r.entity}</td>
                            <td className="px-2 py-1.5 text-right">{fmtNum(r.energy_met_mu, 1)} MU</td>
                            <td className={`px-2 py-1.5 text-right ${(r.energy_shortage_mu ?? 0) > 0 ? "font-semibold text-red-600 dark:text-red-400" : ""}`}>
                              {fmtNum(r.energy_shortage_mu, 2)}
                            </td>
                            <td className="px-2 py-1.5 text-right">{fmtNum(r.max_demand_met_mw)} MW</td>
                            <td className={`px-2 py-1.5 text-right ${(r.peak_shortage_mw ?? 0) > 0 ? "font-semibold text-red-600 dark:text-red-400" : ""}`}>
                              {fmtNum(r.peak_shortage_mw)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

type SortKey = "d" | "peak_shortage_mw" | "energy_shortage_mu";

function ShortageRegister({
  rows,
  onDayClick,
}: {
  rows: VidyutRow[];
  onDayClick: (d: string) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("d");
  const [sortAsc, setSortAsc] = useState(false);

  const shortageAnoms = useMemo(() => {
    const peak = rows.map((r) => r.peak_shortage_mw);
    const energy = rows.map((r) => r.energy_shortage_mu);
    const peakFlags = new Set(anomalies(peak, 14, 2, 3).map((a) => a.i));
    const energyFlags = new Set(anomalies(energy, 14, 2, 3).map((a) => a.i));
    return { peakFlags, energyFlags };
  }, [rows]);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = sortKey === "d" ? a.d : a[sortKey];
      const bv = sortKey === "d" ? b.d : b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = sortKey === "d" ? String(av).localeCompare(String(bv)) : Number(av) - Number(bv);
      return sortAsc ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortAsc]);

  const th = (key: SortKey, label: string) => (
    <th className="px-2 py-1.5 text-right font-semibold">
      <button
        onClick={() => {
          if (sortKey === key) setSortAsc((a) => !a);
          else { setSortKey(key); setSortAsc(false); }
        }}
        className="uppercase tracking-wide hover:text-ink"
      >
        {label}{sortKey === key ? (sortAsc ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );

  return (
    <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-line">
      <table className="w-full text-xs tabular-nums">
        <thead className="sticky top-0 bg-surface-2 text-[10px] text-ink-2">
          <tr>
            <th className="px-2 py-1.5 text-left font-semibold uppercase tracking-wide">
              <button onClick={() => { setSortKey("d"); setSortAsc((a) => sortKey === "d" ? !a : false); }} className="hover:text-ink">
                Date{sortKey === "d" ? (sortAsc ? " ↑" : " ↓") : ""}
              </button>
            </th>
            {th("peak_shortage_mw", "Peak shortage MW")}
            {th("energy_shortage_mu", "Energy shortage MU")}
            <th className="px-2 py-1.5 text-center font-semibold uppercase tracking-wide">Flag</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const origIdx = rows.findIndex((x) => x.d === r.d);
            const flagged =
              shortageAnoms.peakFlags.has(origIdx) || shortageAnoms.energyFlags.has(origIdx) ||
              (r.peak_shortage_mw ?? 0) > 0 || (r.energy_shortage_mu ?? 0) > 0;
            return (
              <tr
                key={r.d}
                onClick={() => onDayClick(r.d)}
                className="cursor-pointer border-t border-line/60 hover:bg-surface-2"
              >
                <td className="px-2 py-1.5 text-ink">{r.d}</td>
                <td className={`px-2 py-1.5 text-right ${(r.peak_shortage_mw ?? 0) > 0 ? "text-red-600 dark:text-red-400" : ""}`}>
                  {fmtNum(r.peak_shortage_mw)}
                </td>
                <td className={`px-2 py-1.5 text-right ${(r.energy_shortage_mu ?? 0) > 0 ? "text-red-600 dark:text-red-400" : ""}`}>
                  {fmtNum(r.energy_shortage_mu, 2)}
                </td>
                <td className="px-2 py-1.5 text-center">
                  {flagged && (
                    <span className="rounded-full bg-amber-100/70 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
                      {shortageAnoms.peakFlags.has(origIdx) || shortageAnoms.energyFlags.has(origIdx) ? "anomaly" : "shortage"}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EntityPicker({
  states,
  selected,
  onChange,
  max = 6,
}: {
  states: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  max?: number;
}) {
  const toggle = (e: string) => {
    if (selected.includes(e)) onChange(selected.filter((x) => x !== e));
    else if (selected.length < max) onChange([...selected, e]);
  };
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {states.map((s) => {
        const on = selected.includes(s);
        const disabled = !on && selected.length >= max;
        return (
          <button
            key={s}
            onClick={() => toggle(s)}
            disabled={disabled}
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
              on
                ? "bg-[#1a936f]/15 text-[#1a936f] ring-1 ring-[#1a936f]/40"
                : disabled
                  ? "cursor-not-allowed bg-surface-2 text-ink-2/50"
                  : "bg-surface-2 text-ink-2 hover:text-ink"
            }`}
          >
            {s}
          </button>
        );
      })}
    </div>
  );
}

function BenchmarkTable({
  dates,
  byEntity,
  entities,
  onExport,
}: {
  dates: string[];
  byEntity: Map<string, Map<string, PspRow>>;
  entities: string[];
  onExport: () => void;
}) {
  const latest = dates[dates.length - 1];
  const prev7 = dates.slice(Math.max(0, dates.length - 8), dates.length - 1);

  const rows = entities.map((entity) => {
    const today = byEntity.get(entity)?.get(latest ?? "");
    const energy7 = prev7.map((d) => byEntity.get(entity)?.get(d)?.energy_met_mu ?? null);
    const peak7 = prev7.map((d) => byEntity.get(entity)?.get(d)?.energy_shortage_mu ?? null);
    return {
      entity,
      energy: today?.energy_met_mu ?? null,
      peak: today?.max_demand_met_mw ?? null,
      shortage: today?.energy_shortage_mu ?? null,
      energy7mean: mean7(energy7),
      shortage7mean: mean7(peak7),
    };
  });

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">Benchmark · latest day vs 7-day mean</h2>
        <button
          onClick={onExport}
          className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-2"
        >
          CSV
        </button>
      </div>
      <div className="mt-2 overflow-auto rounded-lg border border-line">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="bg-surface-2 text-[10px] font-semibold uppercase tracking-wide text-ink-2">
              <th className="px-2 py-1.5 text-left">Entity</th>
              <th className="px-2 py-1.5 text-right">Energy met</th>
              <th className="px-2 py-1.5 text-right">7d mean</th>
              <th className="px-2 py-1.5 text-right">Peak met</th>
              <th className="px-2 py-1.5 text-right">Shortage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.entity} className="border-t border-line/60">
                <td className="px-2 py-1.5 font-medium text-ink">{r.entity}</td>
                <td className="px-2 py-1.5 text-right">{fmtNum(r.energy, 1)} MU</td>
                <td className="px-2 py-1.5 text-right text-ink-2">{fmtNum(r.energy7mean, 1)}</td>
                <td className="px-2 py-1.5 text-right">{fmtNum(r.peak)} MW</td>
                <td className={`px-2 py-1.5 text-right ${(r.shortage ?? 0) > 0 ? "text-red-600 dark:text-red-400" : ""}`}>
                  {fmtNum(r.shortage, 2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[10px] text-ink-2/80">Latest day: {latest ?? "—"} · indicative screening</p>
    </div>
  );
}

function mean7(vals: Array<number | null>): number | null {
  const v = vals.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

const CEA_SOURCE_LABEL: Record<string, string> = {
  thermal: "Thermal",
  hydro: "Hydro",
  nuclear: "Nuclear",
  solar: "Solar",
  wind: "Wind",
  gas: "Gas",
  other: "Other",
};

const CEA_TO_OVERLAY: Record<string, EnergyType> = {
  thermal: "Thermal",
  hydro: "Hydro",
  nuclear: "Other",
  solar: "Solar",
  wind: "Wind",
  gas: "Gas",
  other: "Other",
};

function ceaApEvolutionOption(rows: CeaRow[], t: ChartTheme): EChartsCoreOption | null {
  const ap = rows.filter((r) => r.region_state === ENTITY_AP);
  if (ap.length === 0) return null;
  const months = [...new Set(ap.map((r) => r.month))].sort();
  const sources = ["solar", "wind", "thermal", "hydro"] as const;
  const byMonth = new Map<string, Map<string, number>>();
  for (const r of ap) {
    let m = byMonth.get(r.month);
    if (!m) byMonth.set(r.month, (m = new Map()));
    m.set(r.source, r.share_pct ?? 0);
  }
  return {
    animationDuration: 300,
    legend: { top: 4, textStyle: { color: t.text, fontSize: 11 } },
    tooltip: { trigger: "axis", confine: true, valueFormatter: (v: number) => `${v}%` },
    grid: { left: 44, right: 16, top: 36, bottom: 28 },
    xAxis: {
      type: "category",
      data: months.map((m) => m.slice(0, 7)),
      axisLine: { lineStyle: { color: t.line } },
      axisLabel: { color: t.text, fontSize: 10 },
    },
    yAxis: {
      type: "value",
      max: 100,
      axisLabel: { color: t.text, fontSize: 10, formatter: "{value}%" },
      splitLine: { lineStyle: { color: t.split } },
    },
    series: sources.map((src) => ({
      name: CEA_SOURCE_LABEL[src] ?? src,
      type: "line",
      smooth: true,
      symbol: "circle",
      symbolSize: 5,
      lineStyle: { width: 2 },
      itemStyle: { color: ENERGY_COLOR[CEA_TO_OVERLAY[src]!] },
      data: months.map((m) => byMonth.get(m)?.get(src) ?? null),
    })),
  };
}

function overlayPlantShares(generation: GenerationData | null): Map<EnergyType, number> {
  const counts = Object.fromEntries(ENERGY_TYPES.map((t) => [t, 0])) as Record<EnergyType, number>;
  if (!generation) return new Map(ENERGY_TYPES.map((t) => [t, 0]));
  for (const f of generation.fc.features) {
    const props = f.properties as { energy?: EnergyType } | null;
    const e = props?.energy;
    if (e && e in counts) counts[e as EnergyType]++;
  }
  const total = ENERGY_TYPES.reduce((s, t) => s + counts[t], 0);
  return new Map(
    ENERGY_TYPES.map((t) => [t, total > 0 ? Math.round((counts[t] / total) * 10_000) / 100 : 0]),
  );
}

function EnergyMixPanel({
  cea,
  ceaManifest,
  overlayShares,
  overlayReady,
}: {
  cea: CeaData;
  ceaManifest: DatasetManifest | null;
  overlayShares: Map<EnergyType, number>;
  overlayReady: boolean;
}) {
  const latestMonth = cea.latestApMonth;
  const latestRows = cea.rows.filter((r) => r.region_state === ENTITY_AP && r.month === latestMonth);
  const sorted = [...latestRows].sort((a, b) => (b.share_pct ?? 0) - (a.share_pct ?? 0));

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[28rem] text-left text-[11px]">
          <thead>
            <tr className="bg-surface-2 text-[10px] font-semibold uppercase tracking-wide text-ink-2">
              <th className="px-2 py-1.5">Source</th>
              <th className="px-2 py-1.5 text-right">CEA gen (MU)</th>
              <th className="px-2 py-1.5 text-right">CEA share</th>
              <th className="px-2 py-1.5 text-right">Overlay plants</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const overlayType = CEA_TO_OVERLAY[r.source] ?? "Other";
              const plantPct = overlayShares.get(overlayType) ?? 0;
              return (
                <tr key={r.source} className="border-t border-line/60">
                  <td className="px-2 py-1.5 font-medium text-ink">
                    <span
                      className="mr-1.5 inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: ENERGY_COLOR[overlayType] }}
                    />
                    {CEA_SOURCE_LABEL[r.source] ?? r.source}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(r.generation_mu, 1)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(r.share_pct, 1)}%</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink-2">
                    {overlayReady ? `${fmtNum(plantPct, 1)}%` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] leading-relaxed text-ink-2/80">
        CEA monthly generation mix for Andhra Pradesh ({latestMonth?.slice(0, 7) ?? "—"}) vs static generation-overlay
        plant counts by energy class. Overlay shares are indicative — plant count ≠ MWh; toggle Generation plants in Map layers.
      </p>
      <p className="text-[10px] text-ink-2/70">Source: {sourceName(ceaManifest)}</p>
    </div>
  );
}

function VidyutDayDetail({ row }: { row: VidyutRow | null }) {
  if (!row) return <p className="mt-2 text-xs text-ink-2">Click a day on the chart or shortage register.</p>;
  return (
    <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-ink-2 sm:grid-cols-4">
      <div className="rounded-lg border border-line bg-surface-2 px-2.5 py-2">
        <p className="text-[10px] uppercase tracking-wide">Demand met</p>
        <p className="text-sm font-semibold tabular-nums text-ink">{fmtNum(row.demand_met_mw)} MW</p>
      </div>
      <div className="rounded-lg border border-line bg-surface-2 px-2.5 py-2">
        <p className="text-[10px] uppercase tracking-wide">Exchange price</p>
        <p className="text-sm font-semibold tabular-nums text-ink">{fmtNum(row.exchange_price_inr_kwh, 2)} ₹/kWh</p>
      </div>
      <div className="rounded-lg border border-line bg-surface-2 px-2.5 py-2">
        <p className="text-[10px] uppercase tracking-wide">Peak shortage</p>
        <p className="text-sm font-semibold tabular-nums text-ink">{fmtNum(row.peak_shortage_mw)} MW</p>
      </div>
      <div className="rounded-lg border border-line bg-surface-2 px-2.5 py-2">
        <p className="text-[10px] uppercase tracking-wide">Energy shortage</p>
        <p className="text-sm font-semibold tabular-nums text-ink">{fmtNum(row.energy_shortage_mu, 2)} MU</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function MisDashboards() {
  const dark = useAppStore((s) => s.basemap !== "light");
  const workspaceContext = useAppStore((s) => s.workspaceContext);
  const setWorkspaceContext = useAppStore((s) => s.setWorkspaceContext);
  const [nonce, setNonce] = useState(0);
  const [pspManifest, setPspManifest] = useState<DatasetManifest | null>(null);
  const [vidyutManifest, setVidyutManifest] = useState<DatasetManifest | null>(null);
  const [ceaManifest, setCeaManifest] = useState<DatasetManifest | null>(null);
  const [psp, setPsp] = useState<Loadable<PspData>>({ status: "loading" });
  const [vidyut, setVidyut] = useState<Loadable<VidyutData>>({ status: "loading" });
  const [cea, setCea] = useState<Loadable<CeaData>>({ status: "loading" });
  const generation = useAppStore((s) => s.generation);
  const genStatus = useAppStore((s) => s.genStatus);
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const drillDate = workspaceContext.date ?? null;
  const [drillRows, setDrillRows] = useState<PspRow[] | null>(null);
  const [vidyutDay, setVidyutDay] = useState<string | null>(null);
  const [compareEntities, setCompareEntities] = useState<string[]>(() => {
    const e = useAppStore.getState().workspaceContext.entity;
    return e ? [e, ENTITY_SR, ENTITY_AI].filter((x, i, a) => a.indexOf(x) === i) : [ENTITY_AP, ENTITY_SR, ENTITY_AI];
  });
  const [overlayEntities, setOverlayEntities] = useState<string[]>([ENTITY_AP, ...PEER_STATES.slice(0, 2)]);

  const focusEntity = workspaceContext.entity ?? ENTITY_AP;

  useEffect(() => {
    if (workspaceContext.entity && workspaceContext.entity !== focusEntity) {
      setCompareEntities((prev) =>
        prev.includes(workspaceContext.entity!)
          ? prev
          : [workspaceContext.entity!, ...prev.filter((x) => x !== workspaceContext.entity)],
      );
    }
  }, [workspaceContext.entity, focusEntity]);

  useEffect(() => {
    let cancelled = false;
    setPsp({ status: "loading" });
    setVidyut({ status: "loading" });
    setCea({ status: "loading" });
    void loadManifest("psp-daily").then((m) => !cancelled && setPspManifest(m));
    void loadManifest("vidyut-daily").then((m) => !cancelled && setVidyutManifest(m));
    void loadManifest("cea-monthly").then((m) => !cancelled && setCeaManifest(m));
    loadPspData()
      .then((data) => !cancelled && setPsp({ status: "ready", data }))
      .catch(() => !cancelled && setPsp({ status: "error" }));
    loadVidyutData()
      .then((data) => !cancelled && setVidyut({ status: "ready", data }))
      .catch(() => !cancelled && setVidyut({ status: "error" }));
    loadCeaData()
      .then((data) => !cancelled && setCea({ status: "ready", data }))
      .catch(() => !cancelled && setCea({ status: "error" }));
    return () => { cancelled = true; };
  }, [nonce]);

  useEffect(() => {
    if (!drillDate) { setDrillRows(null); return; }
    let cancelled = false;
    setDrillRows(null);
    loadPspDay(drillDate)
      .then((rows) => !cancelled && setDrillRows(rows))
      .catch(() => !cancelled && setDrillRows([]));
    return () => { cancelled = true; };
  }, [drillDate]);

  const derived = useMemo(() => (psp.status === "ready" ? derive(psp.data) : null), [psp]);
  const theme = useMemo(() => chartTheme(dark), [dark]);

  const stateEntities = useMemo(() => {
    if (psp.status !== "ready") return [];
    return psp.data.entities
      .filter((e) => e.entity_type === "state")
      .map((e) => e.entity)
      .sort((a, b) => a.localeCompare(b));
  }, [psp]);

  const regionEntities = useMemo(() => {
    if (psp.status !== "ready") return [ENTITY_SR, ENTITY_AI];
    return psp.data.entities
      .filter((e) => e.entity_type === "region" || e.entity_type === "all-india")
      .map((e) => e.entity);
  }, [psp]);

  const benchmarkEntities = useMemo(
    () => [ENTITY_AP, ENTITY_SR, ENTITY_AI, ...PEER_STATES.filter((s) => stateEntities.includes(s))],
    [stateEntities],
  );

  const energyOpt = useMemo(
    () => (derived ? energyOption(derived, theme) : null),
    [derived, theme],
  );
  const indexedOpt = useMemo(
    () =>
      derived
        ? indexedOption(derived.dates, compareEntities, derived.byEntity, theme)
        : null,
    [derived, compareEntities, theme],
  );
  const peakOpt = useMemo(
    () => (derived ? peakOption(derived, theme) : null),
    [derived, theme],
  );
  const peakEveningOpt = useMemo(
    () => (derived ? peakVsEveningOption(derived, theme) : null),
    [derived, theme],
  );
  const overlayOpt = useMemo(
    () =>
      derived
        ? indexedOption(derived.dates, overlayEntities, derived.byEntity, theme)
        : null,
    [derived, overlayEntities, theme],
  );
  const overlayShares = useMemo(() => overlayPlantShares(generation), [generation]);
  const ceaMixOpt = useMemo(
    () => (cea.status === "ready" ? ceaApEvolutionOption(cea.data.rows, theme) : null),
    [cea, theme],
  );

  const vidyutOpt = useMemo(
    () => (vidyut.status === "ready" ? vidyutTsOption(vidyut.data.rows, theme) : null),
    [vidyut, theme],
  );

  const vidyutSelected = useMemo(() => {
    if (vidyut.status !== "ready" || !vidyutDay) return null;
    return vidyut.data.rows.find((r) => r.d === vidyutDay) ?? null;
  }, [vidyut, vidyutDay]);

  const doyYears = derived ? Math.round(spanYears(derived.dates)) : 0;
  const doyN = derived?.doyN ?? 0;

  const handleDateClick = useCallback((d: string) => setWorkspaceContext({ date: d }), [setWorkspaceContext]);
  const handleRangeChange = useCallback((r: DateRange | null) => {
    setDateRange((prev) => {
      if (!prev && !r) return prev;
      if (prev && r && prev.start === r.start && prev.end === r.end) return prev;
      return r;
    });
  }, []);

  const handleCompareEntities = useCallback(
    (next: string[]) => {
      setCompareEntities(next);
      if (next[0]) setWorkspaceContext({ entity: next[0] });
    },
    [setWorkspaceContext],
  );

  const exportBenchmark = () => {
    if (!derived) return;
    const latest = derived.dates[derived.dates.length - 1];
    const csv = toCsv(
      ["entity", "date", "energy_met_mu", "max_demand_met_mw", "energy_shortage_mu"],
      benchmarkEntities.map((entity) => {
        const r = derived.byEntity.get(entity)?.get(latest ?? "");
        return [entity, latest, r?.energy_met_mu, r?.max_demand_met_mw, r?.energy_shortage_mu];
      }),
    );
    downloadText(`psp-benchmark-${latest}.csv`, "text/csv", csv);
  };

  const retry = () => setNonce((n) => n + 1);
  const pspBadge = <FreshnessBadge manifest={pspManifest} />;

  return (
    <div className="h-full w-full overflow-y-auto bg-surface-2">
      <div className="mx-auto w-full max-w-[1500px] px-4 pb-12 pt-4 sm:px-6">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-sm text-ink-2">Daily power supply position — Andhra Pradesh in regional &amp; national context</p>
          <span className="flex items-center gap-1.5">
            {pspBadge}
            <FreshnessBadge manifest={vidyutManifest} />
          </span>
          {derived && (
            <button
              onClick={() =>
                exportDailyOpsBrief({
                  derived,
                  pspManifest,
                  vidyutManifest,
                  focusEntity,
                  latestDate: derived.dates[derived.dates.length - 1] ?? null,
                })
              }
              className="rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-2"
            >
              Daily ops brief
            </button>
          )}
          {dateRange && (
            <button
              onClick={() => setDateRange(null)}
              className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-2 ring-1 ring-line hover:text-ink"
            >
              Range {dateRange.start.slice(5)} → {dateRange.end.slice(5)} · clear
            </button>
          )}
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
              <KpiCard label="AP energy shortage" stat={derived.shortageKpi} unit="MU" digits={1} badge={pspBadge} highlightNonZero />
            </>
          )}

          {vidyut.status === "loading" && <Skeleton className="h-36" />}
          {vidyut.status === "error" && <Unavailable what="Vidyut Pravah" onRetry={retry} />}
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
                      <span className="font-medium tabular-nums">{fmtNum(vidyut.data.latest.exchange_price_inr_kwh, 2)} ₹/kWh</span>
                    </p>
                    <p className="flex justify-between">
                      <span>Peak shortage</span>
                      <span className="font-medium tabular-nums">{fmtNum(vidyut.data.latest.peak_shortage_mw)} MW</span>
                    </p>
                    <p className="flex justify-between">
                      <span>Series length</span>
                      <span className="font-medium tabular-nums">{fmtNum(vidyut.data.rows.length)} days</span>
                    </p>
                  </div>
                </>
              ) : (
                <p className="mt-2 text-sm text-ink-2">No rows in the snapshot series yet.</p>
              )}
            </Panel>
          )}
        </div>

        {/* PSP charts */}
        <div className="mt-4 grid gap-3">
          {psp.status === "loading" && <Skeleton className="h-72" />}
          {energyOpt && derived && (
            <Panel>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-ink">AP daily energy met · 7-day mean · DOY baseline</h2>
                {pspBadge}
              </div>
              <p className="mt-0.5 text-[10px] text-ink-2">Click a bar to drill down · brush or slider to set shared date range</p>
              <Chart
                option={energyOpt}
                className="mt-2 h-72 w-full"
                dates={derived.dates}
                dateRange={dateRange}
                onDateClick={handleDateClick}
                onDateRangeChange={handleRangeChange}
              />
            </Panel>
          )}

          <div className="grid gap-3 xl:grid-cols-2">
            {indexedOpt && derived && (
              <Panel>
                <h2 className="text-sm font-semibold text-ink">Energy met — indexed comparison</h2>
                <EntityPicker
                  states={[...regionEntities, ...stateEntities]}
                  selected={compareEntities}
                  onChange={handleCompareEntities}
                />
                <Chart
                  option={indexedOpt}
                  className="mt-2 h-64 w-full"
                  dates={derived.dates}
                  dateRange={dateRange}
                  onDateClick={handleDateClick}
                  onDateRangeChange={handleRangeChange}
                />
              </Panel>
            )}
            {peakOpt && derived && (
              <Panel>
                <h2 className="text-sm font-semibold text-ink">AP peak demand met trend</h2>
                <Chart
                  option={peakOpt}
                  className="mt-2 h-64 w-full"
                  dates={derived.dates}
                  dateRange={dateRange}
                  onDateClick={handleDateClick}
                  onDateRangeChange={handleRangeChange}
                />
              </Panel>
            )}
          </div>

          {peakEveningOpt && derived && (
            <Panel>
              <h2 className="text-sm font-semibold text-ink">Peak vs evening peak (PSP)</h2>
              <p className="mt-0.5 text-[10px] text-ink-2">
                AP max demand met vs SR evening-peak demand (evening peak is regional-only in the PSP report)
              </p>
              <Chart
                option={peakEveningOpt}
                className="mt-2 h-64 w-full"
                dates={derived.dates}
                dateRange={dateRange}
                onDateClick={handleDateClick}
                onDateRangeChange={handleRangeChange}
              />
            </Panel>
          )}

          {derived && (
            <Panel>
              <BenchmarkTable
                dates={derived.dates}
                byEntity={derived.byEntity}
                entities={benchmarkEntities}
                onExport={exportBenchmark}
              />
            </Panel>
          )}
        </div>

        {/* CEA energy-mix */}
        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          {cea.status === "loading" && <Skeleton className="h-72 xl:col-span-2" />}
          {ceaMixOpt && cea.status === "ready" && (
            <Panel className="xl:col-span-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-ink">CEA monthly energy mix · AP evolution</h2>
                <FreshnessBadge manifest={ceaManifest} />
              </div>
              <Chart option={ceaMixOpt} className="mt-2 h-56 w-full" />
            </Panel>
          )}
          {cea.status === "ready" && cea.data.rows.length > 0 && (
            <Panel className="xl:col-span-2">
              <h2 className="text-sm font-semibold text-ink">Energy mix vs generation overlay</h2>
              <EnergyMixPanel
                cea={cea.data}
                ceaManifest={ceaManifest}
                overlayShares={overlayShares}
                overlayReady={genStatus === "ready"}
              />
            </Panel>
          )}
        </div>

        {/* Vidyut history */}
        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          {vidyut.status === "loading" && (
            <>
              <Skeleton className="h-72" />
              <Skeleton className="h-72" />
            </>
          )}
          {vidyutOpt && vidyut.status === "ready" && (
            <Panel className="xl:col-span-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-ink">Vidyut Pravah · demand &amp; price trend</h2>
                <FreshnessBadge manifest={vidyutManifest} />
              </div>
              <Chart
                option={vidyutOpt}
                className="mt-2 h-64 w-full"
                dates={vidyut.data.rows.map((r) => r.d)}
                dateRange={dateRange}
                onDateClick={setVidyutDay}
                onDateRangeChange={handleRangeChange}
              />
              <VidyutDayDetail row={vidyutSelected} />
            </Panel>
          )}
          {vidyut.status === "ready" && vidyut.data.rows.length > 0 && (
            <Panel className="xl:col-span-2">
              <h2 className="text-sm font-semibold text-ink">Shortage register (Vidyut Pravah)</h2>
              <p className="mt-0.5 text-[10px] text-ink-2">Sortable · anomaly days flagged · click a row for detail</p>
              <ShortageRegister rows={vidyut.data.rows} onDayClick={setVidyutDay} />
            </Panel>
          )}
        </div>

        {/* State overlay comparison */}
        {overlayOpt && derived && stateEntities.length > 0 && (
          <Panel className="mt-4">
            <h2 className="text-sm font-semibold text-ink">State comparison · energy met overlay</h2>
            <EntityPicker states={stateEntities} selected={overlayEntities} onChange={setOverlayEntities} max={8} />
            <Chart
              option={overlayOpt}
              className="mt-2 h-72 w-full"
              dates={derived.dates}
              dateRange={dateRange}
              onDateClick={handleDateClick}
              onDateRangeChange={handleRangeChange}
            />
          </Panel>
        )}

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
                  <button
                    key={a.i}
                    onClick={() => setWorkspaceContext({ date: derived.dates[a.i]! })}
                    title={`Trailing 14-day mean ${fmtNum(a.mean, 1)} MU`}
                    className="inline-flex items-center gap-1.5 rounded-full bg-amber-100/70 px-2.5 py-1 text-[11px] font-medium text-amber-900 dark:bg-amber-500/15 dark:text-amber-200"
                  >
                    {derived.dates[a.i]} · {fmtNum(a.value, 1)} MU · z {fmtSigned(a.z, 1)}
                  </button>
                ))}
              </div>
            )}
            {derived.dates.length > 0 && (
              <p className="mt-2 text-[10px] text-ink-2/80">
                DOY z-scores (latest): {fmtSigned(doyZScores(derived.dates, derived.apEnergy).at(-1) ?? null, 2)}
              </p>
            )}
          </Panel>
        )}

        {/* Method + coverage footer */}
        <footer className="mt-4 space-y-3">
          <MethodCard
            metric="AP peak demand met"
            source="Grid-India PSP (MOP_E), manifest psp-daily"
            manifest={pspManifest}
            method="Daily regional maximum from official publication"
            limitation="Not real-time SCADA; 1-day publication lag"
          />
          <Panel className="bg-surface-2/80">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-2">Anomaly method</h2>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-2">
              14-day z-score on AP energy met; DOY baseline uses {doyN > 0 ? `${doyN} same-day samples` : `${doyYears} yr history`} (falls back to 14-day window when &lt;1 year).
              Seasonal decomposition is LOESS trend + DOY seasonal (indicative, not dispatch-grade).
              Missing MW values are never zero-filled.
            </p>
          </Panel>

          <div className="rounded-[var(--radius-panel)] border border-line bg-surface/70 p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-2">Data coverage</h2>
            <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:gap-8">
              <CoverageBlock manifest={pspManifest} fallbackName="Grid-India daily PSP report" range={psp.status === "ready" ? psp.data.coverage : null} />
              <CoverageBlock manifest={vidyutManifest} fallbackName="Vidyut Pravah (Ministry of Power)" range={vidyut.status === "ready" ? vidyut.data.coverage : null} />
              <CoverageBlock manifest={ceaManifest} fallbackName="CEA monthly generation reports" range={cea.status === "ready" ? cea.data.coverage : null} />
            </div>
          </div>
        </footer>
      </div>

      {drillDate && (
        <DayDrillPanel
          date={drillDate}
          rows={drillRows}
          onClose={() => setWorkspaceContext({ date: undefined })}
        />
      )}
    </div>
  );
}
