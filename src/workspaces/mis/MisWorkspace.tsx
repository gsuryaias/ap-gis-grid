// Network MIS workspace — an analyst's view of the AP-TRANSCO network built on the live GIS data.
//
// Drill model: a breadcrumb of (dimension = value) filters defines the SCOPE; every panel on the
// page (KPIs, breakdown, thematic tabs, register) and the embedded map (dimming + fit + thematic
// layer) follows it. Clicking a breakdown row adds a filter and regroups by the next sensible
// dimension; clicking an asset opens its dossier. The drill state lives in the URL hash
// (`by`, `mf`, `tab`, `theme`), so any view is shareable.
import { useCallback, useEffect, useMemo, useState } from "react";
import { graphAnalysis } from "../../data/graph-data.ts";
import { loadConnectivity, type ConnectivityIndex } from "../../data/connectivity.ts";
import { timeAgo, useLiveStatus } from "../../data/live-status.ts";
import { isMisTheme, MIS_THEME_LABEL, MIS_THEMES, themeLegend, type MisMapState, type MisTheme } from "../../map/mis-layers.ts";
import { useAppStore } from "../../state/store.ts";
import { LineDossier, SsDossier } from "./Dossier.tsx";
import {
  applyScope,
  bboxOf,
  buildModel,
  decodeFilters,
  DIMENSIONS,
  encodeFilters,
  groupBy,
  isDimId,
  LINE_USEFUL_LIFE_YRS,
  metrics,
  type DimId,
  type ScopeFilter,
} from "./model.ts";
import { Breakdown, nextDim, Register } from "./tables.tsx";
import { AgeTab, ConductorTab, DownstreamTab, InterfacesTab, isThemeTab, N1Tab, THEME_TABS, type ThemeTab } from "./themes.tsx";
import { gva, nf0, pct, Segmented, StatTile, Tabs, VoltageSegBar, VoltageLegend } from "./ui.tsx";

export default function MisWorkspace() {
  const data = useAppStore((s) => s.data)!;
  const ctx = useAppStore((s) => s.workspaceContext);
  const setCtx = useAppStore((s) => s.setWorkspaceContext);
  const selectedId = useAppStore((s) => s.selectedId);
  const select = useAppStore((s) => s.select);
  const basemap = useAppStore((s) => s.basemap);
  const live = useLiveStatus();

  const [conn, setConn] = useState<ConnectivityIndex | null>(null);
  const [connError, setConnError] = useState(false);
  useEffect(() => {
    let on = true;
    loadConnectivity()
      .then((c) => on && setConn(c))
      .catch(() => on && setConnError(true));
    return () => {
      on = false;
    };
  }, []);

  const model = useMemo(
    () => buildModel(data, graphAnalysis(data), conn, new Date().getFullYear()),
    [data, conn],
  );

  // ---- Drill state (hash-synced) --------------------------------------------------------------
  const filters = useMemo(() => decodeFilters(ctx.misFilters), [ctx.misFilters]);
  const usedDims = useMemo(() => new Set(filters.map((f) => f.dim)), [filters]);
  const byRaw: DimId = isDimId(ctx.misBy) ? ctx.misBy : "circle";
  const by = usedDims.has(byRaw) ? nextDim(byRaw, usedDims) : byRaw;
  const tab: ThemeTab = isThemeTab(ctx.misTab) ? ctx.misTab : "age";
  const theme: MisTheme = isMisTheme(ctx.misTheme) ? ctx.misTheme : "voltage";

  const setFilters = useCallback(
    (f: ScopeFilter[], nextBy?: DimId) =>
      setCtx({ misFilters: f.length ? encodeFilters(f) : undefined, ...(nextBy ? { misBy: nextBy } : {}) }),
    [setCtx],
  );
  const drill = useCallback(
    (dim: DimId, value: string) => {
      const next = [...filters.filter((f) => f.dim !== dim), { dim, value }];
      setFilters(next, nextDim(dim, new Set(next.map((f) => f.dim))));
    },
    [filters, setFilters],
  );

  const scope = useMemo(() => applyScope(model, filters), [model, filters]);
  const total = useMemo(() => metrics(scope.ss, scope.lines), [scope]);
  const groups = useMemo(() => groupBy(scope, by), [scope, by]);
  const scopeLabel = filters.length
    ? filters.map((f) => DIMENSIONS[f.dim].format(f.value)).join(" · ")
    : "Andhra Pradesh";

  // ---- Map: thematic layer, scope dimming, fit -------------------------------------------------
  useEffect(() => {
    const scoped = filters.length > 0;
    const misMap: MisMapState = {
      theme,
      lineClass: {},
      ssClass: {},
      ssValue: {},
      scopeSsIds: scoped ? scope.ss.map((r) => r.id) : null,
      scopeLineIds: scoped ? scope.lines.map((r) => r.id) : null,
    };
    if (theme === "age") {
      for (const r of scope.lines) misMap.lineClass[r.id] = r.ageBand === "unknown" ? 4 : Number(r.ageBand);
    } else if (theme === "n1") {
      for (const r of scope.lines) if (r.islanded.length) misMap.lineClass[r.id] = 0;
      for (const r of scope.ss) {
        if (r.role === "articulation") misMap.ssClass[r.id] = 0;
        else if (r.role === "single-fed") misMap.ssClass[r.id] = 1;
      }
    } else if (theme === "downstream") {
      for (const r of scope.ss) if (r.discomSsIds.length) misMap.ssValue[r.id] = r.discomSsIds.length;
    }
    setCtx({ misMap, fit: { key: encodeFilters(filters) || "all", bounds: scoped ? bboxOf(scope.ss) : null } });
  }, [scope, theme, filters, setCtx]);

  useEffect(() => () => useAppStore.getState().setWorkspaceContext({ misMap: null, fit: null }), []);

  const ssRow = selectedId ? model.ssById.get(selectedId) : undefined;
  const lineRow = selectedId ? model.lineById.get(selectedId) : undefined;
  const legend = themeLegend(theme, basemap);

  const goTab = (t: ThemeTab, th?: MisTheme) => setCtx({ misTab: t, ...(th ? { misTheme: th } : {}) });

  return (
    <div className="min-h-full">
      {/* Scope bar — the drill path + map theme. Sticky so the context never scrolls away. */}
      <div className="sticky top-0 z-20 border-b border-line bg-surface/95 px-4 py-2 backdrop-blur">
        <nav aria-label="Drill path" className="flex flex-wrap items-center gap-1 text-xs">
          <button
            type="button"
            onClick={() => setFilters([], "circle")}
            className={`rounded-md px-1.5 py-0.5 font-semibold ${filters.length ? "text-accent hover:bg-accent/10" : "text-ink"}`}
          >
            Andhra Pradesh
          </button>
          {filters.map((f, i) => (
            <span key={f.dim} className="inline-flex items-center gap-1">
              <span className="text-ink-2" aria-hidden>
                ›
              </span>
              <span className="inline-flex items-center rounded-full border border-line bg-surface-2 pl-2 text-ink">
                <button
                  type="button"
                  onClick={() => setFilters(filters.slice(0, i + 1))}
                  className="py-0.5 hover:underline"
                  title="Go back to this level"
                >
                  <span className="text-ink-2">{DIMENSIONS[f.dim].label}:</span> {DIMENSIONS[f.dim].format(f.value)}
                </button>
                <button
                  type="button"
                  onClick={() => setFilters(filters.filter((_, j) => j !== i))}
                  aria-label={`Remove ${DIMENSIONS[f.dim].label} filter`}
                  className="ml-0.5 rounded-full px-1.5 py-0.5 text-ink-2 hover:bg-surface-3 hover:text-ink"
                >
                  ×
                </button>
              </span>
            </span>
          ))}
          <span className="ml-auto flex items-center gap-2">
            <span className="hidden text-[11px] text-ink-2 sm:inline">Map theme</span>
            <Segmented
              label="Map theme"
              value={theme}
              onChange={(t) => setCtx({ misTheme: t })}
              options={MIS_THEMES.map((t) => ({ id: t, label: MIS_THEME_LABEL[t] }))}
            />
          </span>
        </nav>
        {legend.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-2">
            {legend.map((l) => (
              <span key={l.label} className="inline-flex items-center gap-1.5">
                {l.shape === "line" ? (
                  <span className="h-[3px] w-4 rounded-full" style={{ backgroundColor: l.color }} />
                ) : l.shape === "ring" ? (
                  <span className="h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: l.color }} />
                ) : (
                  <span className="h-3 w-3 rounded-full border" style={{ borderColor: l.color, backgroundColor: `${l.color}38` }} />
                )}
                {l.label}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="mx-auto max-w-[1100px] space-y-3 p-3 sm:p-4">
        {ssRow && <SsDossier model={model} row={ssRow} onClose={() => select(null)} />}
        {lineRow && <LineDossier model={model} row={lineRow} onClose={() => select(null)} />}

        {/* KPI strip for the current scope */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <StatTile label="Substations" value={nf0(total.ss)} sub={`400 · 220 · 132 kV: ${total.ssByV[400]} · ${total.ssByV[220]} · ${total.ssByV[132]}`}>
            <VoltageSegBar byV={total.ssByV} unit="SS" />
          </StatTile>
          <StatTile label="Circuit-km" value={nf0(total.ckm)} sub={`${nf0(total.routeKm)} route-km · ${nf0(total.lines)} line rows`}>
            <VoltageSegBar byV={total.ckmByV} unit="ckm" />
          </StatTile>
          <StatTile
            label="Σ indicative rating"
            value={gva(total.mva).replace("≈ ", "")}
            sub={`${nf0(total.ratedLines)} of ${nf0(total.lines)} rows rated · conductor-based`}
            onClick={() => goTab("conductor")}
          />
          <StatTile
            label="Line fleet age"
            value={total.meanAge == null ? "—" : `${total.meanAge.toFixed(1)} yrs`}
            sub={`${pct(total.pctPastLife)} of ckm ≥ ${LINE_USEFUL_LIFE_YRS} yrs (CERC life)`}
            onClick={() => goTab("age", "age")}
            title="Show the age analysis and colour the map by line age"
          />
          <StatTile
            label="N-1 exposure"
            value={nf0(total.bridges)}
            sub={`bridge lines · ${total.singleFed} single-fed · ${total.articulation} cut-point SS`}
            onClick={() => goTab("n1", "n1")}
            title="Show the N-1 screening and mark exposed assets on the map"
          />
          <StatTile
            label="33/11 kV SS fed"
            value={conn ? nf0(total.discomSs) : connError ? "—" : "…"}
            sub={
              conn
                ? `via ${nf0(total.feeders)} traced 33 kV feeders · APSPDCL map partial`
                : connError
                  ? "connectivity index unavailable"
                  : "loading 33 kV index"
            }
            onClick={() => goTab("downstream", "downstream")}
            title="Show 33 kV downstream load and size substations by it on the map"
          />
        </div>

        <Breakdown
          rows={groups}
          by={by}
          onBy={(d) => setCtx({ misBy: d })}
          onDrill={(key) => drill(by, key)}
          total={total}
          usedDims={usedDims}
        />

        <section className="overflow-hidden rounded-xl border border-line bg-surface-2/60 shadow-sm">
          <Tabs tabs={THEME_TABS} value={tab} onChange={(t) => setCtx({ misTab: t })} label="Thematic analysis" />
          {tab === "age" && <AgeTab model={model} scope={scope} filters={filters} onDrill={drill} />}
          {tab === "n1" && <N1Tab model={model} scope={scope} filters={filters} onDrill={drill} />}
          {tab === "downstream" && <DownstreamTab model={model} scope={scope} filters={filters} onDrill={drill} />}
          {tab === "conductor" && <ConductorTab model={model} scope={scope} filters={filters} onDrill={drill} />}
          {tab === "interfaces" && <InterfacesTab model={model} scope={scope} filters={filters} onDrill={drill} />}
        </section>

        <Register scope={scope} label={scopeLabel} />

        <footer className="space-y-1 px-1 pb-4 text-[11px] leading-snug text-ink-2">
          <VoltageLegend />
          <p>
            Source: AP-TRANSCO enterprise GIS (gridmap layers)
            {live?.lastSuccess ? `, synced ${timeAgo(live.lastSuccess)}` : ""}; DISCOM 33 kV networks from APSPDCL /
            APEPDCL open GIS and APCPDCL’s export. Circuit-km counts each circuit once (a DC tower line digitised as
            Ckt-1 + Ckt-2 rows is not double-counted; DC/SC = one circuit strung). Topology, N-1 roles and 33 kV links are
            inferred from geometry; ratings are indicative. Use for screening and planning conversations, not operations.
          </p>
        </footer>
      </div>
    </div>
  );
}
