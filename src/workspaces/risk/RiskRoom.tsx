// Risk Room workspace (M4 v1) — an ANALYSIS surface: scenario-ranked at-risk registers and
// briefing-pack exports over the hazard × vulnerability × criticality engine. No map of its
// own — every row syncs selection + fly-to on the persistent embedded map pane.
// All scores are INDICATIVE SCREENING VALUES per the repo's honesty convention.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { FeatureCollection } from "geojson";
import { FreshnessBadge } from "../../components/FreshnessBadge.tsx";
import { MethodCard } from "../../components/MethodCard.tsx";
import { CycloneIcon, DownloadIcon, RefreshIcon } from "../../components/icons.tsx";
import { VoltageBadge } from "../../components/VoltageBadge.tsx";
import type { DatasetManifest } from "../../data/manifests.ts";
import { downloadText } from "../../lib/export.ts";
import { COASTAL_BAND_LABEL, type RiskTier } from "../../lib/risk.ts";
import { useAppStore, type RiskSelectionContext } from "../../state/store.ts";
import { BriefingPack } from "./BriefingPack.tsx";
import {
  applyScenario,
  loadWindZones,
  registerToCsv,
  riskBaseRows,
  SCENARIOS,
  windLabel,
  type RiskRow,
  type ScenarioId,
} from "./model.ts";

// ---------------------------------------------------------------------------
// Presentation tokens
// ---------------------------------------------------------------------------

const TIER_CHIP: Record<RiskTier, string> = {
  low: "bg-surface-3 text-ink-2",
  moderate: "bg-amber-100/70 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200",
  elevated: "bg-orange-100/70 text-orange-900 dark:bg-orange-500/15 dark:text-orange-200",
  high: "bg-red-100/70 text-red-900 dark:bg-red-500/15 dark:text-red-200",
};

const TIER_ORDER: RiskTier[] = ["high", "elevated", "moderate", "low"];

function isScenarioId(s: string | undefined): s is ScenarioId {
  return s === "normal" || s === "watch" || s === "severe" || s === "active";
}

type SortKey =
  | "name" | "voltage" | "circle" | "coastal" | "wind"
  | "hazard" | "vulnerability" | "criticality" | "composite";

const SORT_VALUE: Record<SortKey, (r: RiskRow) => string | number> = {
  name: (r) => r.ss.name.toLowerCase(),
  voltage: (r) => r.ss.voltage,
  circle: (r) => r.ss.circle ?? "",
  coastal: (r) => r.ss.coastalKm ?? Number.POSITIVE_INFINITY,
  wind: (r) => r.windVb ?? 0,
  hazard: (r) => r.hazard,
  vulnerability: (r) => r.vulnerability,
  criticality: (r) => r.criticality,
  composite: (r) => r.composite,
};

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function SingleFedChip() {
  return (
    <span className="shrink-0 rounded-full bg-amber-100/70 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
      single-fed
    </span>
  );
}

function Th({
  label,
  k,
  sort,
  onSort,
  numeric,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: 1 | -1 };
  onSort: (k: SortKey) => void;
  numeric?: boolean;
}) {
  const active = sort.key === k;
  return (
    <th className={`px-2.5 py-2 ${numeric ? "text-right" : "text-left"}`}>
      <button
        onClick={() => onSort(k)}
        className={`text-[11px] font-semibold uppercase tracking-wide hover:text-ink ${active ? "text-ink" : "text-ink-2"}`}
      >
        {label}
        {active && <span className="ml-0.5">{sort.dir === -1 ? "↓" : "↑"}</span>}
      </button>
    </th>
  );
}

function MiniRegister({
  title,
  note,
  rows,
  empty,
  value,
  onPick,
}: {
  title: string;
  note: string;
  rows: RiskRow[];
  empty: string;
  value: (r: RiskRow) => ReactNode;
  onPick: (row: RiskRow) => void;
}) {
  return (
    <section className="rounded-[var(--radius-panel)] border border-line bg-surface px-3.5 py-3 shadow-[var(--shadow-panel)]">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">{title}</h3>
      <p className="mt-0.5 text-[11px] text-ink-2/80">{note}</p>
      {rows.length === 0 ? (
        <p className="mt-2 rounded-lg bg-surface-2 px-2.5 py-2 text-xs text-ink-2">{empty}</p>
      ) : (
        <div className="-mx-1 mt-1.5">
          {rows.map((r) => (
            <button
              key={r.ss.id}
              onClick={() => onPick(r)}
              title="Fly to asset on map and show factor breakdown"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm hover:bg-surface-2"
            >
              <span className="min-w-0 flex-1 truncate text-ink">{r.ss.name}</span>
              <span className="shrink-0 text-xs text-ink-2">{r.ss.voltage} kV</span>
              <span className="shrink-0 text-xs font-medium tabular-nums text-ink">{value(r)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function FactorBreakdown({
  selection,
  name,
  onClose,
}: {
  selection: RiskSelectionContext;
  name: string;
  onClose: () => void;
}) {
  return (
    <section className="mt-3 rounded-[var(--radius-panel)] border border-line bg-surface px-4 py-3 shadow-[var(--shadow-panel)]">
      <div className="flex items-start gap-3">
        <div className="mr-auto min-w-0">
          <h3 className="truncate text-sm font-semibold text-ink">{name}</h3>
          <p className="text-[11px] text-ink-2">
            Indicative factor breakdown · composite{" "}
            <span className={`rounded-full px-1.5 py-0.5 font-semibold tabular-nums ${TIER_CHIP[selection.tier as RiskTier]}`}>
              {selection.composite}
            </span>{" "}
            ({selection.tier})
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink"
        >
          Clear
        </button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg bg-surface-2 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-2">Hazard · {selection.hazard}</p>
          <p className="mt-1 text-xs text-ink">{selection.hazardFactors.join(" · ") || "—"}</p>
        </div>
        <div className="rounded-lg bg-surface-2 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-2">
            Vulnerability · {selection.vulnerability}
          </p>
          <p className="mt-1 text-xs text-ink">{selection.vulnFactors.join(" · ") || "—"}</p>
        </div>
        <div className="rounded-lg bg-surface-2 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-2">
            Criticality · {selection.criticality}
          </p>
          <p className="mt-1 text-xs text-ink">{selection.critFactors.join(" · ") || "—"}</p>
        </div>
      </div>
      <p className="mt-2 text-[10px] text-ink-2/80">
        Screening proxy only — not a hazard model, reliability study or load-flow result.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export default function RiskRoom() {
  const data = useAppStore((s) => s.data);
  const weather = useAppStore((s) => s.weather);
  const wxStatus = useAppStore((s) => s.wxStatus);
  const refreshWeather = useAppStore((s) => s.refreshWeather);
  const select = useAppStore((s) => s.select);
  const selectedId = useAppStore((s) => s.selectedId);
  const setWorkspaceContext = useAppStore((s) => s.setWorkspaceContext);
  const workspaceContext = useAppStore((s) => s.workspaceContext);
  const regionCircle = useAppStore((s) => s.filters.circle);
  const setRegionCircle = useAppStore((s) => s.setRegionCircle);

  // Wind zones (static asset) — fetched once on first entry, module-cached thereafter.
  const [zones, setZones] = useState<FeatureCollection | null>(null);
  const [zonesError, setZonesError] = useState<string | null>(null);
  const [zonesNonce, setZonesNonce] = useState(0);
  useEffect(() => {
    let on = true;
    setZonesError(null);
    loadWindZones()
      .then((z) => on && setZones(z))
      .catch((e) => on && setZonesError(e instanceof Error ? e.message : String(e)));
    return () => {
      on = false;
    };
  }, [zonesNonce]);

  // Workspace state synced to URL hash via workspaceContext + filters.circle.
  const [scenarioId, setScenarioId] = useState<ScenarioId>(() => {
    const s = workspaceContext.scenario ?? workspaceContext.hazard;
    return isScenarioId(s) ? s : "normal";
  });
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>(() => {
    const k = workspaceContext.sort as SortKey | undefined;
    return { key: k && k in SORT_VALUE ? k : "composite", dir: -1 };
  });
  const [briefingOpen, setBriefingOpen] = useState(false);

  const circle = regionCircle ?? "";

  useEffect(() => {
    if (workspaceContext.scenario === scenarioId && workspaceContext.hazard === scenarioId) return;
    setWorkspaceContext({ scenario: scenarioId, hazard: scenarioId });
  }, [scenarioId, setWorkspaceContext, workspaceContext.scenario, workspaceContext.hazard]);

  useEffect(() => {
    if (workspaceContext.sort === sort.key) return;
    setWorkspaceContext({ sort: sort.key });
  }, [sort.key, setWorkspaceContext, workspaceContext.sort]);

  useEffect(() => {
    const s = workspaceContext.scenario ?? workspaceContext.hazard;
    if (isScenarioId(s) && s !== scenarioId) setScenarioId(s);
  }, [workspaceContext.scenario, workspaceContext.hazard, scenarioId]);

  useEffect(() => {
    const k = workspaceContext.sort as SortKey | undefined;
    if (k && k in SORT_VALUE && k !== sort.key) setSort((prev) => ({ ...prev, key: k }));
  }, [workspaceContext.sort, sort.key]);

  const liveEvents = useMemo(
    () => (weather?.cyclones ?? []).filter((c) => c.conePolygons.length > 0),
    [weather],
  );
  const hasLiveEvent = liveEvents.length > 0;

  // The "Active event" scenario exists only while a real GDACS cyclone is live.
  useEffect(() => {
    if (scenarioId === "active" && !hasLiveEvent) setScenarioId("normal");
  }, [scenarioId, hasLiveEvent]);

  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const scenarios = SCENARIOS.filter((s) => s.id !== "active" || hasLiveEvent);

  // Full register under the active scenario (sorted by composite desc by applyScenario).
  const rows = useMemo(
    () => (data && zones ? applyScenario(riskBaseRows(data, weather, zones), scenario) : null),
    [data, weather, zones, scenario],
  );

  // Push composite scores + scenario to the embedded map (transient — not in hash).
  useEffect(() => {
    if (!rows) return;
    const prev = useAppStore.getState().workspaceContext.riskScores;
    if (prev && Object.keys(prev).length === rows.length) {
      let same = true;
      for (const r of rows) {
        if (prev[r.ss.id] !== r.composite) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    const riskScores = Object.fromEntries(rows.map((r) => [r.ss.id, r.composite]));
    setWorkspaceContext({ riskScores });
  }, [rows, setWorkspaceContext]);

  const riskSelection = workspaceContext.riskSelection;

  const tierCounts = useMemo(() => {
    const c: Record<RiskTier, number> = { low: 0, moderate: 0, elevated: 0, high: 0 };
    for (const r of rows ?? []) c[r.tier]++;
    return c;
  }, [rows]);

  // Text + circle filters, then the active column sort, then the top-50 cut.
  const shown = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    const filtered = rows.filter(
      (r) => (!q || r.ss.name.toLowerCase().includes(q)) && (!circle || r.ss.circle === circle),
    );
    const v = SORT_VALUE[sort.key];
    return filtered
      .sort((a, b) => {
        const av = v(a);
        const bv = v(b);
        const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
        return cmp !== 0 ? sort.dir * cmp : b.composite - a.composite;
      })
      .slice(0, 50);
  }, [rows, query, circle, sort]);

  const filteredTotal = useMemo(() => {
    if (!rows) return 0;
    const q = query.trim().toLowerCase();
    return rows.filter((r) => (!q || r.ss.name.toLowerCase().includes(q)) && (!circle || r.ss.circle === circle)).length;
  }, [rows, query, circle]);

  // Per-hazard mini-registers (top-10 by each hazard sub-axis, under the active scenario).
  const topWind = useMemo(
    () => (rows ? [...rows].sort((a, b) => (b.windVb ?? 0) - (a.windVb ?? 0) || b.hazard - a.hazard).slice(0, 10) : []),
    [rows],
  );
  const topCoastal = useMemo(
    () =>
      rows
        ? rows.filter((r) => r.ss.coastalKm != null).sort((a, b) => a.ss.coastalKm! - b.ss.coastalKm!).slice(0, 10)
        : [],
    [rows],
  );
  const topCyclone = useMemo(() => (rows ? rows.filter((r) => r.inCone).slice(0, 10) : []), [rows]);

  // Freshness badges — synthetic manifests so the shared FreshnessBadge renders both vintages.
  const staticManifest = useMemo<DatasetManifest | null>(
    () =>
      data
        ? {
            id: "core-network",
            schema: {},
            source: {
              name: "AP-TRANSCO Gridmap ETL + indicative IS 875 wind zones",
              url: "https://github.com/gsuryaias/ap-gis-grid",
            },
            licence: "—",
            attribution: "AP-TRANSCO",
            cadence: "static",
            vintage: data.meta.generatedAt.slice(0, 10),
            lastSuccess: data.meta.generatedAt,
            paths: [],
          }
        : null,
    [data],
  );
  const wxManifest = useMemo<DatasetManifest | null>(
    () =>
      weather
        ? {
            id: "live-weather",
            schema: {},
            source: {
              name: "Open-Meteo · GDACS · RainViewer",
              url: "https://open-meteo.com",
            },
            licence: "open / keyless",
            attribution: "Open-Meteo · GDACS",
            cadence: "daily",
            vintage: `live · ${fmtTime(weather.fetchedAt)}`,
            lastSuccess: new Date(weather.fetchedAt).toISOString(),
            paths: [],
          }
        : null,
    [weather],
  );

  if (!data) return null; // App mounts workspaces only after the grid data is ready

  const focusOnMap = (row: RiskRow) => {
    const selection: RiskSelectionContext = {
      id: row.ss.id,
      hazard: row.hazard,
      vulnerability: row.vulnerability,
      criticality: row.criticality,
      composite: row.composite,
      tier: row.tier,
      hazardFactors: row.hazardFactors,
      vulnFactors: row.vulnFactors,
      critFactors: row.critFactors,
    };
    setWorkspaceContext({
      scenario: scenario.id,
      hazard: scenario.id,
      circle: row.ss.circle ?? undefined,
      highlightIds: [row.ss.id],
      riskSelection: selection,
    });
    if (row.ss.circle) setRegionCircle(row.ss.circle);
    select(row.ss.id, { fly: true });
  };

  const clearSelection = () => {
    setWorkspaceContext({ highlightIds: [], riskSelection: null });
    select(null);
  };

  const onSort = (k: SortKey) =>
    setSort((s) => ({ key: k, dir: s.key === k ? ((-s.dir) as 1 | -1) : k === "name" || k === "circle" ? 1 : -1 }));

  const exportCsv = () => {
    if (!rows) return;
    downloadText(`risk-register-${scenario.id}.csv`, "text/csv", registerToCsv(rows));
  };

  return (
    <div className="h-full w-full overflow-y-auto bg-surface-2">
      <div className="mx-auto max-w-[1180px] px-4 pb-12 pt-4">
        {/* ---- Header strip: scenario, live event, tiers, freshness, exports ---- */}
        <section className="rounded-[var(--radius-panel)] border border-line bg-surface px-5 py-4 shadow-[var(--shadow-panel)]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="mr-auto">
              <p className="text-xs font-medium text-ink-2">
                Scenario-ranked register · hazard × vulnerability × criticality (indicative)
              </p>
            </div>
            {hasLiveEvent && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100/70 px-2.5 py-1 text-xs font-semibold text-red-900 dark:bg-red-500/15 dark:text-red-200">
                <CycloneIcon width={14} height={14} />
                {liveEvents.map((e) => `${e.name} (${e.alertLevel})`).join(" · ")}
              </span>
            )}
            <span className="inline-flex items-center gap-1 text-[10px] text-ink-2">
              network <FreshnessBadge manifest={staticManifest} />
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] text-ink-2">
              weather <FreshnessBadge manifest={wxManifest} />
            </span>
            {weather ? (
              <button
                onClick={refreshWeather}
                title="Refresh live weather"
                aria-label="Refresh live weather"
                className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink"
              >
                <RefreshIcon width={14} height={14} />
              </button>
            ) : wxStatus === "loading" ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-accent" />
                fetching weather…
              </span>
            ) : (
              <button
                onClick={refreshWeather}
                className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
              >
                Load live weather
              </button>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line bg-surface-2/70 p-0.5">
              {scenarios.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setScenarioId(s.id)}
                  title={s.assumption}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    scenarioId === s.id ? "bg-accent text-white" : "text-ink-2 hover:bg-surface-3 hover:text-ink"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {TIER_ORDER.map((t) => (
                <span key={t} className={`rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${TIER_CHIP[t]}`}>
                  {t} {tierCounts[t]}
                </span>
              ))}
            </div>
            <div className="flex gap-1.5">
              <button
                onClick={exportCsv}
                disabled={!rows}
                title="Full register under the active scenario, as CSV"
                className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-50"
              >
                <DownloadIcon width={14} height={14} /> CSV
              </button>
              <button
                onClick={() => setBriefingOpen(true)}
                disabled={!rows}
                title="Print-styled briefing pack (scenario, vintages, ranked assets)"
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                Briefing
              </button>
            </div>
          </div>

          <p className="mt-2.5 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">{scenario.assumption}</p>
        </section>

        {/* ---- Loading / error states for the wind-zone fetch ---- */}
        {!rows && (
          <div className="mt-3 rounded-[var(--radius-panel)] border border-line bg-surface px-5 py-8 text-center shadow-[var(--shadow-panel)]">
            {zonesError ? (
              <>
                <p className="text-sm text-ink-2">Couldn't load the wind-zone layer. {zonesError}</p>
                <button
                  onClick={() => setZonesNonce((n) => n + 1)}
                  className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
                >
                  Retry
                </button>
              </>
            ) : (
              <span className="inline-flex items-center gap-2 text-sm text-ink-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" />
                Assembling the risk register…
              </span>
            )}
          </div>
        )}

        {rows && (
          <>
            {/* ---- Per-hazard mini-registers ---- */}
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <MiniRegister
                title="Wind exposure · top 10"
                note="Highest IS 875 zone first (indicative digitisation)"
                rows={topWind}
                empty="No assets."
                value={(r) => `${windLabel(r.windVb)} · h ${r.hazard}`}
                onPick={focusOnMap}
              />
              <MiniRegister
                title="Coastal proximity · top 10"
                note="Closest to the coastline first (straight-line)"
                rows={topCoastal}
                empty="No coastal-distance data."
                value={(r) => `${r.ss.coastalKm!.toLocaleString("en-IN")} km`}
                onPick={focusOnMap}
              />
              <MiniRegister
                title="Cyclone cone · top 10"
                note={
                  scenarioId === "active"
                    ? "Inside the live GDACS forecast envelope"
                    : scenario.forceConeBandMax != null
                      ? "Treated as in-cone by this scenario preset"
                      : "No cone assumed under this scenario"
                }
                rows={topCyclone}
                empty="No substations in a cone under this scenario."
                value={(r) => `composite ${r.composite}`}
                onPick={focusOnMap}
              />
            </div>

            {riskSelection && (
              <FactorBreakdown
                selection={riskSelection}
                name={data.byId.get(riskSelection.id)?.name ?? riskSelection.id}
                onClose={clearSelection}
              />
            )}

            {/* ---- Ranked register ---- */}
            <section className="mt-3 rounded-[var(--radius-panel)] border border-line bg-surface shadow-[var(--shadow-panel)]">
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
                <h2 className="mr-auto text-sm font-semibold text-ink">
                  At-risk register
                  <span className="ml-2 text-xs font-normal text-ink-2">
                    top {Math.min(50, filteredTotal)} of {filteredTotal} · {scenario.label}
                  </span>
                </h2>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter by name…"
                  className="w-44 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-2/70 focus:outline-none"
                />
                <select
                  value={circle}
                  onChange={(e) => {
                    const next = e.target.value || null;
                    setRegionCircle(next);
                    if (next) setWorkspaceContext({ circle: next });
                  }}
                  className="rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink focus:outline-none"
                >
                  <option value="">All circles</option>
                  {data.meta.circles.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line bg-surface-2">
                      <Th label="Substation" k="name" sort={sort} onSort={onSort} />
                      <Th label="kV" k="voltage" sort={sort} onSort={onSort} />
                      <Th label="Circle" k="circle" sort={sort} onSort={onSort} />
                      <Th label="Coast" k="coastal" sort={sort} onSort={onSort} />
                      <Th label="Wind" k="wind" sort={sort} onSort={onSort} />
                      <Th label="Hazard" k="hazard" sort={sort} onSort={onSort} numeric />
                      <Th label="Vuln" k="vulnerability" sort={sort} onSort={onSort} numeric />
                      <Th label="Crit" k="criticality" sort={sort} onSort={onSort} numeric />
                      <Th label="Composite" k="composite" sort={sort} onSort={onSort} numeric />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr
                        key={r.ss.id}
                        onClick={() => focusOnMap(r)}
                        title={`Show on map — hazard: ${r.hazardFactors.join(", ")} · criticality: ${r.critFactors.join(", ")}`}
                        className={`cursor-pointer border-b border-line/60 last:border-0 hover:bg-surface-2 ${
                          selectedId === r.ss.id ? "bg-accent/5" : ""
                        }`}
                      >
                        <td className="px-2.5 py-1.5">
                          <span className="flex items-center gap-1.5">
                            <span className="min-w-0 truncate font-medium text-ink">{r.ss.name}</span>
                            {r.feedDegree <= 1 && <SingleFedChip />}
                            {r.inCone && (
                              <span className="shrink-0 rounded-full bg-red-100/70 px-1.5 py-0.5 text-[10px] font-medium text-red-900 dark:bg-red-500/15 dark:text-red-200">
                                in cone
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-2.5 py-1.5">
                          <VoltageBadge voltage={r.ss.voltage} small />
                        </td>
                        <td className="whitespace-nowrap px-2.5 py-1.5 text-xs text-ink-2">{r.ss.circle ?? "—"}</td>
                        <td className="whitespace-nowrap px-2.5 py-1.5 text-xs tabular-nums text-ink-2">
                          {r.coastalBand != null ? COASTAL_BAND_LABEL[r.coastalBand] : "—"}
                        </td>
                        <td className="whitespace-nowrap px-2.5 py-1.5 text-xs tabular-nums text-ink-2">
                          {windLabel(r.windVb)}
                        </td>
                        <td className="whitespace-nowrap px-2.5 py-1.5 text-right text-xs tabular-nums text-ink">
                          {r.hazard}
                        </td>
                        <td className="whitespace-nowrap px-2.5 py-1.5 text-right text-xs tabular-nums text-ink">
                          {r.vulnerability}
                        </td>
                        <td className="whitespace-nowrap px-2.5 py-1.5 text-right text-xs tabular-nums text-ink">
                          {r.criticality}
                        </td>
                        <td className="whitespace-nowrap px-2.5 py-1.5 text-right">
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${TIER_CHIP[r.tier]}`}>
                            {r.composite}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filteredTotal > 50 && (
                <p className="border-t border-line px-4 py-2 text-xs text-ink-2">
                  +{filteredTotal - 50} more — the CSV export carries the full register.
                </p>
              )}
              <p className="border-t border-line px-4 py-2.5 text-[11px] leading-relaxed text-ink-2">
                Indicative screening values only — not a hazard model, reliability study or load-flow
                result. Wind zones are an approximate digitisation of IS 875 (Part 3); connectivity
                (feed degree, line counts) is inferred from geometric snapping; scenario presets are
                screening assumptions; cyclone envelopes are GDACS model output, not IMD advisories.
              </p>
            </section>

            <MethodCard
              metric="Composite risk score (hazard × vulnerability × criticality)"
              source="AP-TRANSCO Gridmap ETL + indicative IS 875 wind zones + GDACS (live weather optional)"
              vintage={data.meta.generatedAt.slice(0, 10)}
              method="Per-substation screening index ranked under the active scenario preset"
              limitation="Indicative screening only — not a hazard model, reliability study or load-flow result"
            />
          </>
        )}
      </div>

      {briefingOpen && rows && (
        <BriefingPack
          scenario={scenario}
          rows={rows}
          networkVintage={data.meta.generatedAt.slice(0, 10)}
          weatherFetchedAt={weather?.fetchedAt ?? null}
          liveEventNames={liveEvents.map((e) => e.name)}
          onClose={() => setBriefingOpen(false)}
        />
      )}
    </div>
  );
}
