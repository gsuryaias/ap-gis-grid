// Network MIS workspace — an analyst's view of the AP-TRANSCO network built on the live GIS data.
//
// Drill model: a breadcrumb of (dimension = value) filters defines the SCOPE; every panel on the
// page (KPIs, breakdown, thematic tabs, register) and the embedded map (dimming + fit + thematic
// layer) follows it. Clicking a breakdown row adds a filter and regroups by the next sensible
// dimension; clicking an asset opens it in the Inspector (with the MIS sections, inspector-ext.tsx). The drill state lives in the URL hash
// (`by`, `mf`, `tab`, `theme`), so any view is shareable.
//
// A multi-select voltage SLICER sits outside the ordered drill path and is applied first.
// Every number on the page is a drill-DOWN: it opens the records behind it (drill.ts), which
// reconcile to the figure, light up on the map, export to CSV and can become the page filter.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { graphAnalysis } from "../../data/graph-data.ts";
import { connectivity } from "../../data/connectivity.ts";
import { useResource } from "../../data/resources.ts";
import { timeAgo, useLiveStatus } from "../../data/live-status.ts";
import { isMisTheme, MIS_THEME_LABEL, MIS_THEMES, themeLegend, type MisMapState, type MisTheme } from "../../map/mis-layers.ts";
import { useAppStore } from "../../state/store.ts";
import type { Voltage } from "../../data/types.ts";
import { drillRecords, METRICS, recordsFocus, scopeInterfaces, type DrillSpec } from "./drill.ts";
import { DrillPanel } from "./DrillPanel.tsx";
import { misInspector } from "./inspector-ext.tsx";
import { Inspector } from "../../inspector/Inspector.tsx";
import { MisSearch } from "./MisSearch.tsx";
import {
  applyScope,
  bboxOf,
  buildModel,
  decodeFilters,
  DIMENSIONS,
  encodeFilters,
  formatFilter,
  groupBy,
  groupScope,
  isDimId,
  LINE_USEFUL_LIFE_YRS,
  metrics,
  pinnedDims,
  withSlicer,
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
import {
  DrillContext,
  drillKey,
  DrillNum,
  gva,
  nf0,
  pct,
  Segmented,
  StatTile,
  Tabs,
  VoltageLegend,
  VoltageSegBar,
  VoltageSlicer,
  type DrillApi,
} from "./ui.tsx";

export default function MisWorkspace() {
  const data = useAppStore((s) => s.data)!;
  const ctx = useAppStore((s) => s.workspaceContext);
  const setCtx = useAppStore((s) => s.setWorkspaceContext);
  const selectedId = useAppStore((s) => s.selectedId);
  const select = useAppStore((s) => s.select);
  const basemap = useAppStore((s) => s.basemap);
  const live = useLiveStatus();

  const connRes = useResource(connectivity);
  const conn = connRes.data ?? null;
  const connError = connRes.status === "error";

  const model = useMemo(
    () => buildModel(data, graphAnalysis(data), conn, new Date().getFullYear()),
    [data, conn],
  );

  // ---- Drill state (hash-synced) --------------------------------------------------------------
  // `filters` = slicer first, then the ordered drill path (`path`).
  const { kv, path, all: filters } = useMemo(() => withSlicer(decodeFilters(ctx.misFilters)), [ctx.misFilters]);
  const kvValues = useMemo(() => (kv ? (kv.values.map(Number) as Voltage[]) : null), [kv]);
  const usedDims = useMemo(() => pinnedDims(filters), [filters]);
  const byRaw: DimId = isDimId(ctx.misBy) ? ctx.misBy : "circle";
  const by = usedDims.has(byRaw) ? nextDim(byRaw, usedDims) : byRaw;
  const tab: ThemeTab = isThemeTab(ctx.misTab) ? ctx.misTab : "radial";
  const theme: MisTheme = isMisTheme(ctx.misTheme) ? ctx.misTheme : "voltage";

  /** Commit a drill path (+ optional slicer), keeping the slicer first. */
  const commit = useCallback(
    (p: ScopeFilter[], kvF: ScopeFilter | null, nextBy?: DimId) => {
      const f = kvF ? [kvF, ...p] : p;
      setCtx({ misFilters: f.length ? encodeFilters(f) : undefined, ...(nextBy ? { misBy: nextBy } : {}) });
    },
    [setCtx],
  );
  const setFilters = useCallback((p: ScopeFilter[], nextBy?: DimId) => commit(p, kv, nextBy), [commit, kv]);
  const setSlicer = useCallback(
    (v: Voltage[] | null) => commit(path, v ? { dim: "voltage", values: v.map(String) } : null),
    [commit, path],
  );
  /** Add / replace one filter (voltage goes to the slicer) and regroup by the next sensible dimension. */
  const applyFilter = useCallback(
    (f: ScopeFilter) => {
      const nextKv = f.dim === "voltage" ? f : kv;
      const nextPath = f.dim === "voltage" ? path : [...path.filter((x) => x.dim !== f.dim), f];
      const pinned = pinnedDims(nextKv ? [nextKv, ...nextPath] : nextPath);
      commit(nextPath, nextKv, pinned.has(by) ? nextDim(f.dim, pinned) : undefined);
    },
    [commit, kv, path, by],
  );
  /** "Apply as filter" from a breakdown-group drill: pin the group AND the metric's filter. */
  const applyFilterPair = useCallback(
    (gDim: DimId, gKey: string, f: ScopeFilter) => {
      const g: ScopeFilter = { dim: gDim, values: [gKey] };
      let nextKv = kv;
      let nextPath = path;
      // Same dimension (e.g. supply group "radial-sc" × metric "radial") → intersect, never widen.
      const merged = f.dim === gDim ? [{ dim: gDim, values: f.values.filter((v) => v === gKey).length ? [gKey] : g.values }] : [g, f];
      for (const x of merged) {
        if (x.dim === "voltage") nextKv = x;
        else nextPath = [...nextPath.filter((y) => y.dim !== x.dim), x];
      }
      const pinned = pinnedDims(nextKv ? [nextKv, ...nextPath] : nextPath);
      commit(nextPath, nextKv, pinned.has(by) ? nextDim(f.dim, pinned) : undefined);
    },
    [commit, kv, path, by],
  );
  const drill = useCallback(
    (dim: DimId, value: string) => {
      const nextKv = dim === "voltage" ? { dim, values: [value] } : kv;
      const nextPath = dim === "voltage" ? path : [...path.filter((f) => f.dim !== dim), { dim, values: [value] }];
      commit(nextPath, nextKv, nextDim(dim, pinnedDims(nextKv ? [nextKv, ...nextPath] : nextPath)));
    },
    [commit, kv, path],
  );

  const scope = useMemo(() => applyScope(model, filters), [model, filters]);
  // What each voltage would show in the current drill path (slicer tooltips).
  const slicerCounts = useMemo(() => {
    const base = applyScope(model, path);
    const m = metrics(base.ss, base.lines);
    const out = {} as Record<Voltage, string>;
    for (const v of [400, 220, 132] as Voltage[]) out[v] = `${v} kV here: ${nf0(m.ssByV[v])} SS · ${nf0(m.ckmByV[v])} ckm`;
    return out;
  }, [model, path]);

  // Transient map highlight (a radial pocket, a feed path, a bus-outage island…). Cleared on re-scope.
  const [focus, setFocus] = useState<MapFocus | null>(null);
  useEffect(() => setFocus(null), [ctx.misFilters]);
  const total = useMemo(() => metrics(scope.ss, scope.lines), [scope]);
  const groups = useMemo(() => groupBy(scope, by), [scope, by]);
  const pathLabel = path.length ? path.map(formatFilter).join(" · ") : "Andhra Pradesh";
  const scopeLabel = kv ? `${pathLabel} · ${formatFilter(kv)}` : pathLabel;

  // ---- Drill-down (the records behind a number) ------------------------------------------------
  // Follows the slicer live; closed when the drill path changes (the page itself moved).
  const [dd, setDd] = useState<(DrillSpec & { map: boolean }) | null>(null);
  const pathKey = encodeFilters(path);
  useEffect(() => setDd(null), [pathKey]);
  const ddRecords = useMemo(() => {
    if (!dd) return null;
    const sc = dd.group ? groupScope(scope, dd.group.dim, dd.group.key) : scope;
    return drillRecords(model, conn, sc, dd.metric);
  }, [dd, scope, model, conn]);
  const ddFocus = useMemo(
    () =>
      dd?.map && ddRecords
        ? recordsFocus(model, ddRecords, `drill:${drillKey(dd)}:${encodeFilters(filters)}`, `${METRICS[dd.metric].title}${dd.group ? ` · ${dd.group.label}` : ""}`)
        : null,
    [dd, ddRecords, model, filters],
  );
  const mapFocus = focus ?? ddFocus;
  const ddRef = useRef<HTMLDivElement>(null);
  const drillApi = useMemo<DrillApi>(
    () => ({
      active: dd,
      open: (spec) => {
        setFocus(null);
        setDd((cur) => (cur && drillKey(cur) === drillKey(spec) ? null : { ...spec, map: true }));
        requestAnimationFrame(() => ddRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
      },
    }),
    [dd],
  );

  // ---- Map: thematic layer, scope dimming, fit -------------------------------------------------
  useEffect(() => {
    const scoped = filters.length > 0;
    const misMap: MisMapState = {
      theme,
      lineClass: {},
      ssClass: {},
      ssValue: {},
      scopeSsIds: mapFocus ? mapFocus.ssIds : scoped ? scope.ss.map((r) => r.id) : null,
      scopeLineIds: mapFocus ? mapFocus.lineIds : scoped ? scope.lines.map((r) => r.id) : null,
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
    const fit = mapFocus
      ? { key: `${encodeFilters(filters)}|${mapFocus.key}`, bounds: bboxOf(mapFocus.ssIds.map((id) => model.ssById.get(id)).filter((r): r is SsRow => !!r)) }
      : { key: encodeFilters(filters) || "all", bounds: scoped ? bboxOf(scope.ss) : null };
    setCtx({ misMap, fit });
  }, [scope, theme, filters, mapFocus, model, setCtx]);

  useEffect(() => () => useAppStore.getState().setWorkspaceContext({ misMap: null, fit: null }), []);

  const inspectorExt = useMemo(() => misInspector(model, setFocus), [model]);
  const legend = themeLegend(theme, basemap);
  const tabProps = { model, scope, filters, onDrill: drill, onFocus: setFocus, focusKey: focus?.key ?? null };

  const goTab = (t: ThemeTab, th?: MisTheme) => setCtx({ misTab: t, ...(th ? { misTheme: th } : {}) });

  // Interfaces (plants / traction SS) hanging on ONE circuit, within the scope.
  const weakIfaces = useMemo(() => {
    const all = scopeInterfaces(model, scope.lines);
    const n = (c: string) => all.filter((f) => f.category === c).length;
    return { Generation: n("Generation"), Railway: n("Railway"), total: all.length };
  }, [model, scope.lines]);

  // Bring the Inspector into view whenever something is picked (search, register, lists, map).
  const dossierRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectedId) dossierRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [selectedId]);
  const openAsset = useCallback((id: string) => select(id, { fly: true }), [select]);

  const chipFocus = mapFocus;
  const clearChip = () => (focus ? setFocus(null) : setDd((d) => d && { ...d, map: false }));

  return (
    <DrillContext.Provider value={drillApi}>
    <div className="min-h-full">
      {/* Scope bar — slicer + drill path + map theme. Sticky so the context never scrolls away. */}
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
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <VoltageSlicer value={kvValues} onChange={setSlicer} counts={slicerCounts} />
          <span className="h-4 w-px bg-line" aria-hidden />
          <nav aria-label="Drill path" className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-xs">
            <button
              type="button"
              onClick={() => setFilters([], "circle")}
              className={`rounded-md px-1.5 py-0.5 font-semibold ${path.length ? "text-accent hover:bg-accent/10" : "text-ink"}`}
            >
              Andhra Pradesh
            </button>
            {path.map((f, i) => (
              <span key={f.dim} className="inline-flex items-center gap-1">
                <span className="text-ink-2" aria-hidden>
                  ›
                </span>
                <span className="inline-flex items-center rounded-full border border-line bg-surface-2 pl-2 text-ink">
                  <button
                    type="button"
                    onClick={() => setFilters(path.slice(0, i + 1))}
                    className="py-0.5 hover:underline"
                    title="Go back to this level"
                  >
                    <span className="text-ink-2">{DIMENSIONS[f.dim].label}:</span> {formatFilter(f)}
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilters(path.filter((_, j) => j !== i))}
                    aria-label={`Remove ${DIMENSIONS[f.dim].label} filter`}
                    className="ml-0.5 rounded-full px-1.5 py-0.5 text-ink-2 hover:bg-surface-3 hover:text-ink"
                  >
                    ×
                  </button>
                </span>
              </span>
            ))}
            {chipFocus && (
              <span className="ml-auto inline-flex max-w-full items-center rounded-full border border-accent/50 bg-accent/10 pl-2 text-ink">
                <span className="truncate py-0.5" title="Map highlight — everything else is dimmed">
                  ◎ {chipFocus.label}
                </span>
                <button
                  type="button"
                  onClick={clearChip}
                  aria-label="Clear map highlight"
                  className="ml-0.5 rounded-full px-1.5 py-0.5 text-ink-2 hover:bg-surface-3 hover:text-ink"
                >
                  ×
                </button>
              </span>
            )}
          </nav>
        </div>
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
          <Inspector variant="inline" extend={inspectorExt} />
        </div>

        <div ref={ddRef} className="scroll-mt-28 empty:hidden">
          {dd && ddRecords && (
            <DrillPanel
              key={drillKey(dd)}
              model={model}
              spec={dd}
              records={ddRecords}
              loading={!conn && !connError && (ddRecords.kind === "discom" || ddRecords.kind === "feeders")}
              scopeLabel={scopeLabel}
              mapOn={dd.map}
              onToggleMap={() => {
                setFocus(null);
                setDd((d) => d && { ...d, map: !d.map });
              }}
              onApply={
                METRICS[dd.metric].asFilter
                  ? () => {
                      if (dd.group) applyFilterPair(dd.group.dim, dd.group.key, METRICS[dd.metric].asFilter!);
                      else applyFilter(METRICS[dd.metric].asFilter!);
                    }
                  : undefined
              }
              onClose={() => setDd(null)}
              onFocus={setFocus}
            />
          )}
        </div>

        {/* KPI strip for the current scope — every number drills down to its records */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatTile
            label="Substations"
            value={nf0(total.ss)}
            metric="ss"
            sub={
              <>
                400 · 220 · 132 kV: <DrillNum metric="ss400">{total.ssByV[400]}</DrillNum> ·{" "}
                <DrillNum metric="ss220">{total.ssByV[220]}</DrillNum> · <DrillNum metric="ss132">{total.ssByV[132]}</DrillNum>
              </>
            }
          >
            <VoltageSegBar byV={total.ssByV} unit="SS" partMetric={(v) => `ss${v}` as const} />
          </StatTile>
          <StatTile
            label="Circuit-km"
            value={nf0(total.ckm)}
            metric="lines"
            sub={
              <>
                <DrillNum metric="route">{nf0(total.routeKm)}</DrillNum> route-km · <DrillNum metric="lines">{nf0(total.lines)}</DrillNum> line rows
              </>
            }
          >
            <VoltageSegBar byV={total.ckmByV} unit="ckm" partMetric={(v) => `ckm${v}` as const} />
          </StatTile>
          <StatTile
            label="Σ indicative rating"
            value={gva(total.mva).replace("≈ ", "")}
            metric="mva"
            sub={
              <>
                <DrillNum metric="mva">{nf0(total.ratedLines)}</DrillNum> of {nf0(total.lines)} rows rated
                {total.lines > total.ratedLines && (
                  <>
                    {" "}
                    · <DrillNum metric="unrated">{nf0(total.lines - total.ratedLines)}</DrillNum> unrated
                  </>
                )}{" "}
                · conductor-based
              </>
            }
            more={{ onClick: () => goTab("conductor"), title: "Open the conductors & rating analysis" }}
          />
          <StatTile
            label="Line fleet age"
            value={total.meanAge == null ? "—" : `${total.meanAge.toFixed(1)} yrs`}
            metric={total.meanAge == null ? undefined : "age"}
            sub={
              <>
                {total.pctPastLife ? <DrillNum metric="past">{pct(total.pctPastLife)}</DrillNum> : pct(total.pctPastLife)} of ckm ≥{" "}
                {LINE_USEFUL_LIFE_YRS} yrs (CERC life)
              </>
            }
            more={{ onClick: () => goTab("age", "age"), title: "Open the age analysis and colour the map by line age" }}
          />
          <StatTile
            label="Radially fed SS"
            value={nf0(total.radialSc + total.radialDc)}
            metric="radial"
            sub={
              <>
                <DrillNum metric="radialSc">{total.radialSc}</DrillNum> on a single circuit ·{" "}
                <DrillNum metric="radialDc">{total.radialDc}</DrillNum> on one corridor
                {conn && (
                  <>
                    {" "}
                    · <DrillNum metric="radialDiscom">{nf0(total.radialDiscomSs)}</DrillNum> 33/11 kV SS behind them
                  </>
                )}
              </>
            }
            more={{ onClick: () => goTab("radial", "supply"), title: "Open the radial-feed analysis and mark radial feeds on the map" }}
          />
          <StatTile
            label="N-1 exposure"
            value={nf0(total.bridges)}
            metric="bridges"
            sub={
              <>
                bridge lines · <DrillNum metric="singleFed">{total.singleFed}</DrillNum> single-fed ·{" "}
                <DrillNum metric="cut">{total.articulation}</DrillNum> cut-point SS
              </>
            }
            more={{ onClick: () => goTab("n1", "n1"), title: "Open the N-1 screening and mark exposed assets on the map" }}
          />
          <StatTile
            label="33/11 kV SS fed"
            value={conn ? nf0(total.discomSs) : connError ? "—" : "…"}
            metric={conn ? "discomSs" : undefined}
            sub={
              conn ? (
                <>
                  via <DrillNum metric="feeders">{nf0(total.feeders)}</DrillNum> traced 33 kV feeders · APSPDCL map partial
                </>
              ) : connError ? (
                "connectivity index unavailable"
              ) : (
                "loading 33 kV index"
              )
            }
            more={{ onClick: () => goTab("downstream", "downstream"), title: "Open the 33 kV downstream analysis and size substations by it" }}
          />
          <StatTile
            label="Single-circuit interfaces"
            value={nf0(weakIfaces.total)}
            metric="ifaceWeak"
            sub={
              <>
                <DrillNum metric="ifaceGen">{weakIfaces.Generation}</DrillNum> generating stations ·{" "}
                <DrillNum metric="ifaceRail">{weakIfaces.Railway}</DrillNum> traction SS on one circuit
              </>
            }
            more={{ onClick: () => goTab("interfaces"), title: "Open how generation, traction and EHT consumers are connected" }}
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
            The voltage filter classes a substation by its highest voltage; topology (radial, N-1) is always computed on
            the whole network, so slicing never makes a meshed substation look radial.
          </p>
        </footer>
      </div>
    </div>
    </DrillContext.Provider>
  );
}
