// Network MIS workspace — an analyst's view of the AP-TRANSCO network built on the live GIS data.
//
// Drill model: a breadcrumb of (dimension = value) filters defines the SCOPE; every panel on the
// page (KPIs, breakdown, thematic tabs, register) and the embedded map (dimming + fit + thematic
// layer) follows it. Clicking a breakdown row adds a filter and regroups by the next sensible
// dimension; clicking an asset opens its dossier. The drill state lives in the URL hash
// (`by`, `mf`, `tab`, `theme`), so any view is shareable.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { graphAnalysis } from "../../data/graph-data.ts";
import { loadConnectivity, type ConnectivityIndex } from "../../data/connectivity.ts";
import { timeAgo, useLiveStatus } from "../../data/live-status.ts";
import { isMisTheme, MIS_THEME_LABEL, MIS_THEMES, themeLegend, type MisMapState, type MisTheme } from "../../map/mis-layers.ts";
import { useAppStore } from "../../state/store.ts";
import { interfaceSecurity } from "../../lib/supply-security.ts";
import { LineDossier, SsDossier } from "./Dossier.tsx";
import { MisSearch } from "./MisSearch.tsx";
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
  type MapFocus,
  type ScopeFilter,
  type SsRow,
} from "./model.ts";
import { Breakdown, nextDim, Register } from "./tables.tsx";
import {
  AgeTab,
  ConductorTab,
  DownstreamTab,
  InterfacesTab,
  isThemeTab,
  N1Tab,
  RadialTab,
  THEME_TABS,
  type ThemeTab,
} from "./themes.tsx";
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
  const tab: ThemeTab = isThemeTab(ctx.misTab) ? ctx.misTab : "radial";
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

  // Transient map highlight (a radial pocket, a feed path, a bus-outage island…). Cleared on re-scope.
  const [focus, setFocus] = useState<MapFocus | null>(null);
  useEffect(() => setFocus(null), [ctx.misFilters]);
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
      scopeSsIds: focus ? focus.ssIds : scoped ? scope.ss.map((r) => r.id) : null,
      scopeLineIds: focus ? focus.lineIds : scoped ? scope.lines.map((r) => r.id) : null,
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
    } else if (theme === "supply") {
      for (const r of scope.lines) if (r.corridorBridge) misMap.lineClass[r.id] = (r.corridorCircuits ?? 1) <= 1 ? 0 : 1;
      for (const r of scope.ss) {
        if (r.supply.cls === "radial-sc") misMap.ssClass[r.id] = 0;
        else if (r.supply.cls === "radial-dc") misMap.ssClass[r.id] = 1;
        else if (r.supply.cls === "unconnected") misMap.ssClass[r.id] = 2;
      }
    }
    const fit = focus
      ? { key: `${encodeFilters(filters)}|${focus.key}`, bounds: bboxOf(focus.ssIds.map((id) => model.ssById.get(id)).filter((r): r is SsRow => !!r)) }
      : { key: encodeFilters(filters) || "all", bounds: scoped ? bboxOf(scope.ss) : null };
    setCtx({ misMap, fit });
  }, [scope, theme, filters, focus, model, setCtx]);

  useEffect(() => () => useAppStore.getState().setWorkspaceContext({ misMap: null, fit: null }), []);

  const ssRow = selectedId ? model.ssById.get(selectedId) : undefined;
  const lineRow = selectedId ? model.lineById.get(selectedId) : undefined;
  const legend = themeLegend(theme, basemap);
  const tabProps = { model, scope, filters, onDrill: drill, onFocus: setFocus, focusKey: focus?.key ?? null };

  const goTab = (t: ThemeTab, th?: MisTheme) => setCtx({ misTab: t, ...(th ? { misTheme: th } : {}) });

  // Interfaces (plants / traction / EHT consumers) hanging on ONE circuit, within the scope.
  const weakIfaces = useMemo(() => {
    const inScope = new Set(scope.lines.map((r) => r.id));
    const out = { Generation: 0, Railway: 0, total: 0 };
    for (const f of model.sec.interfaces) {
      if (f.category === "HT consumer" || !f.lineIds.some((id) => inScope.has(id))) continue;
      if (interfaceSecurity(f) !== "single-circuit") continue;
      if (f.category === "Generation") out.Generation++;
      if (f.category === "Railway") out.Railway++;
      out.total++;
    }
    return out;
  }, [model, scope.lines]);

  // Bring the dossier into view whenever a core asset is picked (search, register, lists).
  const dossierRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectedId && (model.ssById.has(selectedId) || model.lineById.has(selectedId))) {
      dossierRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [selectedId, model]);
  const openAsset = useCallback((id: string) => select(id, { fly: true }), [select]);

  return (
    <div className="min-h-full">
      {/* Scope bar — the drill path + map theme. Sticky so the context never scrolls away. */}
      <div className="sticky top-0 z-20 border-b border-line bg-surface/95 px-4 py-2 backdrop-blur">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <MisSearch model={model} conn={conn} onDrill={drill} onPick={openAsset} />
          <span className="ml-auto flex items-center gap-2">
            <span className="hidden text-[11px] text-ink-2 sm:inline">Map theme</span>
            <Segmented
              label="Map theme"
              value={theme}
              onChange={(t) => setCtx({ misTheme: t })}
              options={MIS_THEMES.map((t) => ({ id: t, label: MIS_THEME_LABEL[t] }))}
            />
          </span>
        </div>
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
          {focus && (
            <span className="ml-auto inline-flex max-w-full items-center rounded-full border border-accent/50 bg-accent/10 pl-2 text-ink">
              <span className="truncate py-0.5" title="Map highlight — everything else is dimmed">
                ◎ {focus.label}
              </span>
              <button
                type="button"
                onClick={() => setFocus(null)}
                aria-label="Clear map highlight"
                className="ml-0.5 rounded-full px-1.5 py-0.5 text-ink-2 hover:bg-surface-3 hover:text-ink"
              >
                ×
              </button>
            </span>
          )}
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
        <div ref={dossierRef} className="scroll-mt-28 space-y-3 empty:hidden">
          {ssRow && <SsDossier model={model} row={ssRow} onClose={() => select(null)} onFocus={setFocus} />}
          {lineRow && <LineDossier model={model} row={lineRow} onClose={() => select(null)} onFocus={setFocus} />}
        </div>

        {/* KPI strip for the current scope */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
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
            label="Radially fed SS"
            value={nf0(total.radialSc + total.radialDc)}
            sub={`${total.radialSc} on a single circuit · ${total.radialDc} on one corridor${conn ? ` · ${nf0(total.radialDiscomSs)} 33/11 kV SS behind them` : ""}`}
            onClick={() => goTab("radial", "supply")}
            title="Show the radial-feed analysis and mark radial feeds on the map"
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
          <StatTile
            label="Single-circuit interfaces"
            value={nf0(weakIfaces.total)}
            sub={`${weakIfaces.Generation} generating stations · ${weakIfaces.Railway} traction SS on one circuit`}
            onClick={() => goTab("interfaces")}
            title="Show how generation, traction and EHT consumers are connected"
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
          {tab === "radial" && <RadialTab {...tabProps} />}
          {tab === "age" && <AgeTab {...tabProps} />}
          {tab === "n1" && <N1Tab {...tabProps} />}
          {tab === "downstream" && <DownstreamTab {...tabProps} />}
          {tab === "conductor" && <ConductorTab {...tabProps} />}
          {tab === "interfaces" && <InterfacesTab {...tabProps} />}
        </section>

        <Register model={model} scope={scope} label={scopeLabel} />

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
