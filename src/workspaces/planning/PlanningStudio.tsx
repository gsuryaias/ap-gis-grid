// Planning Studio v1 (DSS revamp spec §4, milestone M5) — load-growth scenarios vs corridor
// headroom, a full N-1 contingency screen and a what-if network sandbox, all computed by the
// indicative DC flow (src/lib/dcflow.ts) inside a web worker (flow.worker.ts). An ANALYSIS
// workspace: rows sync selection + fly-to on the persistent embedded map pane. Scenario and
// sandbox state are transient local React state: no store slice, no hash keys.
//
// Three flow cases run per scenario:
//   reference — no growth (years 0): the KPI baseline       ("no-growth base")
//   horizon   — per-circle CAGR growth to the horizon year  (the main readout)
//   sandbox   — horizon + the what-if lines (when present)  (drives the delta view)
import { useEffect, useMemo, useState } from "react";
import type { Circuit, GridData, Voltage } from "../../data/types.ts";
import { MethodCard } from "../../components/MethodCard.tsx";
import { csvCell, downloadText, toCsv } from "../../lib/export.ts";
import { defaultPlanningMap, useAppStore } from "../../state/store.ts";
import { HEADROOM_PULSE_PCT } from "../../map/planning-map.ts";
import {
  BASE_YEAR,
  DEFAULT_CAGR_PCT,
  BASE_DEMAND_MW,
  HONESTY_NOTE,
  SANDBOX_ID_PREFIX,
  INFERRED_DC_SUFFIX,
  expandImplicitDcCircuits,
  generatorCandidates,
  kpisFor,
  n1Severity,
  relievedCorridors,
  sandboxWireLines,
  topContingencies,
  toWireLines,
  toWireSubstations,
  type FlowCaseResult,
  type FlowCaseSpec,
  type N1Result,
  type SandboxLine,
  type UtilRow,
} from "./scenario.ts";
import { ScenarioControls, type GenMode } from "./ScenarioControls.tsx";
import { SandboxPanel } from "./SandboxPanel.tsx";
import {
  Card,
  ComputingBadge,
  DeltaTag,
  ErrorNote,
  fmt1,
  fmtInt,
  HonestyFootnote,
  MiniButton,
  PctPill,
  SkeletonRows,
  VoltTag,
} from "./ui.tsx";
import { useDebounced, useFlowCase, useFlowEngine, type FlowRunState } from "./useFlowEngine.ts";

const HEADROOM_TOP = 50;
const N1_TOP = 25;
const EMPTY_GENERATORS: string[] = [];

interface LineInfo {
  name: string;
  voltage: Voltage;
  circuit: Circuit;
  sandbox: boolean;
  inferred: boolean;
}

export default function PlanningStudio() {
  const data = useAppStore((s) => s.data);
  if (!data) return null;
  return <Studio data={data} />;
}

function Studio({ data }: { data: GridData }) {
  const select = useAppStore((s) => s.select);
  const setWorkspaceContext = useAppStore((s) => s.setWorkspaceContext);
  const setPlanningMap = useAppStore((s) => s.setPlanningMap);
  const workspaceContext = useAppStore((s) => s.workspaceContext);
  const setRegionCircle = useAppStore((s) => s.setRegionCircle);

  // ---- Scenario state (horizon + circle synced to URL hash) -------------------------
  const circles = data.meta.circles;
  const [cagrByCircle, setCagrByCircle] = useState<Record<string, number>>(() =>
    Object.fromEntries(circles.map((c) => [c, DEFAULT_CAGR_PCT])),
  );
  const [horizonYear, setHorizonYear] = useState(() => workspaceContext.horizon ?? BASE_YEAR + 5);
  const [genMode, setGenMode] = useState<GenMode>("generators");
  const [sandbox, setSandbox] = useState<SandboxLine[]>([]);

  useEffect(() => {
    if (workspaceContext.horizon != null && workspaceContext.horizon !== horizonYear) {
      setHorizonYear(workspaceContext.horizon);
    }
  }, [workspaceContext.horizon, horizonYear]);

  useEffect(() => {
    if (workspaceContext.horizon === horizonYear) return;
    setWorkspaceContext({ horizon: horizonYear });
  }, [horizonYear, setWorkspaceContext, workspaceContext.horizon]);

  useEffect(() => {
    const c = useAppStore.getState().filters.circle;
    if (c) setWorkspaceContext({ circle: c });
  }, [setWorkspaceContext]);

  const debouncedCagr = useDebounced(cagrByCircle, 300);

  // ---- Serialisable network spec (Maps/Sets → arrays before the worker boundary) ----
  const wireSubstations = useMemo(() => toWireSubstations(data.substations), [data]);
  const wireLines = useMemo(
    () => expandImplicitDcCircuits(toWireLines(data.lines)),
    [data.lines],
  );
  const genCandidates = useMemo(() => generatorCandidates(data.lines), [data]);
  const ssById = useMemo(() => new Map(data.substations.map((s) => [s.id, s])), [data]);

  const generatorIds = genMode === "generators" ? genCandidates : EMPTY_GENERATORS;

  const referenceSpec = useMemo<FlowCaseSpec>(
    () => ({
      substations: wireSubstations,
      lines: wireLines,
      generatorIds,
      cagrPctByCircle: {},
      years: 0,
      baseDemandMw: BASE_DEMAND_MW,
    }),
    [wireSubstations, wireLines, generatorIds],
  );

  const years = horizonYear - BASE_YEAR;
  const horizonSpec = useMemo<FlowCaseSpec>(
    () => ({ ...referenceSpec, cagrPctByCircle: debouncedCagr, years }),
    [referenceSpec, debouncedCagr, years],
  );

  const sandboxWires = useMemo(() => sandboxWireLines(sandbox, ssById), [sandbox, ssById]);
  const sandboxSpec = useMemo<FlowCaseSpec | null>(
    () => (sandboxWires.length > 0 ? { ...horizonSpec, lines: [...wireLines, ...sandboxWires] } : null),
    [horizonSpec, wireLines, sandboxWires],
  );

  // ---- Worker runs ------------------------------------------------------------------
  const engine = useFlowEngine();
  const referenceRun = useFlowCase(engine, referenceSpec);
  const horizonRun = useFlowCase(engine, horizonSpec);
  const sandboxRun = useFlowCase(engine, sandboxSpec);

  const usingSandbox = sandboxSpec !== null;
  const activeRun = usingSandbox ? sandboxRun : horizonRun;
  const activeResult = activeRun.result;

  const computing = [referenceRun, horizonRun, sandboxRun].find((r) => r.status === "computing");

  const [n1PreviewId, setN1PreviewId] = useState<string | null>(null);

  // ---- Sync indicative flow results to the embedded map pane -------------------------
  useEffect(() => {
    if (!activeResult) {
      setPlanningMap({ active: false, utilByLine: {}, pulseLineIds: [], n1Preview: null });
      return;
    }
    const utilByLine = Object.fromEntries(activeResult.util.map((u) => [u.lineId, u.pct]));
    const pulseLineIds = activeResult.util
      .filter((u): u is UtilRow & { pct: number } => u.pct !== null && u.pct >= HEADROOM_PULSE_PCT)
      .map((u) => u.lineId);
    setPlanningMap({ active: true, utilByLine, pulseLineIds });
  }, [activeResult, setPlanningMap]);

  useEffect(() => {
    if (!activeResult || !n1PreviewId) {
      setPlanningMap({ n1Preview: null });
      return;
    }
    const row = activeResult.n1.find((r) => r.outageLineId === n1PreviewId);
    setPlanningMap(
      row
        ? { n1Preview: { outageLineId: row.outageLineId, islandedSsIds: row.islanded } }
        : { n1Preview: null },
    );
  }, [activeResult, n1PreviewId, setPlanningMap]);

  useEffect(() => () => setPlanningMap(defaultPlanningMap()), [setPlanningMap]);

  // ---- Derived readouts ---------------------------------------------------------------
  const lineInfo = useMemo(() => {
    return (id: string): LineInfo | null => {
      if (id.startsWith(SANDBOX_ID_PREFIX)) {
        const w = sandboxWires.find((x) => x.id === id);
        return w ? { name: w.name, voltage: w.voltage, circuit: w.circuit, sandbox: true, inferred: false } : null;
      }
      const inferredWire = wireLines.find((x) => x.id === id);
      if (inferredWire?.inferred) {
        return {
          name: inferredWire.name,
          voltage: inferredWire.voltage,
          circuit: inferredWire.circuit,
          sandbox: false,
          inferred: true,
        };
      }
      const f = data.byId.get(id);
      return f && f.kind === "line"
        ? { name: f.name, voltage: f.voltage, circuit: f.circuit, sandbox: false, inferred: false }
        : null;
    };
  }, [data, sandboxWires, wireLines]);

  const ssName = (id: string): string => ssById.get(id)?.name ?? id;

  const headroomRows = useMemo<UtilRow[]>(() => {
    if (!activeResult) return [];
    return activeResult.util
      .filter((u): u is UtilRow & { pct: number } => u.pct !== null)
      .sort((a, b) => b.pct! - a.pct! || a.lineId.localeCompare(b.lineId))
      .slice(0, HEADROOM_TOP);
  }, [activeResult]);

  const worstContingencies = useMemo<N1Result[]>(
    () => (activeResult ? topContingencies(activeResult.n1, N1_TOP) : []),
    [activeResult],
  );

  const kpis = activeResult ? kpisFor(activeResult) : null;
  const baseKpis = referenceRun.result ? kpisFor(referenceRun.result) : null;

  const focusOnMap = (id: string) => {
    if (id.startsWith(SANDBOX_ID_PREFIX) || id.endsWith(INFERRED_DC_SUFFIX)) return;
    const f = data.byId.get(id);
    const circle = f && "circle" in f ? f.circle ?? undefined : undefined;
    setWorkspaceContext({ circle });
    if (circle) setRegionCircle(circle);
    select(id, { fly: true });
  };

  const exportScenarioJson = () => {
    const payload = {
      horizonYear,
      baseYear: BASE_YEAR,
      baseDemandMw: BASE_DEMAND_MW,
      cagrPctByCircle: debouncedCagr,
      genMode,
      sandboxLines: sandbox,
      networkVintage: data.meta.generatedAt.slice(0, 10),
      honestyNote: HONESTY_NOTE,
      exportedAt: new Date().toISOString(),
    };
    downloadText(`planning-scenario-${horizonYear}.json`, "application/json", JSON.stringify(payload, null, 2));
  };

  // ---- CSV exports (honesty note embedded in every file) ------------------------------
  const exportHeadroomCsv = () => {
    const rows = headroomRows.map((u, i) => {
      const info = lineInfo(u.lineId);
      return [
        i + 1,
        u.lineId,
        info?.name ?? u.lineId,
        info?.voltage ?? "",
        info?.circuit ?? "",
        u.flowMw.toFixed(1),
        u.ratingMva ?? "",
        u.pct === null ? "" : u.pct.toFixed(1),
        info?.sandbox ? "what-if" : "",
      ];
    });
    const csv =
      toCsv(
        ["rank", "line_id", "name", "voltage_kv", "circuit", "flow_mw", "indicative_rating_mva", "utilisation_pct", "kind"],
        rows,
      ) +
      "\r\n" +
      csvCell(`Note: ${HONESTY_NOTE} Scenario horizon ${horizonYear}, base demand ${BASE_DEMAND_MW} MW.`);
    downloadText(`planning-headroom-${horizonYear}.csv`, "text/csv", csv);
  };

  const exportN1Csv = () => {
    const rows = worstContingencies.map((r, i) => {
      const info = lineInfo(r.outageLineId);
      const worst = r.overloads[0];
      return [
        i + 1,
        r.outageLineId,
        info?.name ?? r.outageLineId,
        info?.voltage ?? "",
        r.islanded.length,
        r.islanded.map(ssName).join(" | "),
        r.overloads.length,
        worst ? worst.pct.toFixed(1) : "",
        worst?.lineId ?? "",
        worst ? (lineInfo(worst.lineId)?.name ?? worst.lineId) : "",
        n1Severity(r).toFixed(0),
      ];
    });
    const csv =
      toCsv(
        [
          "rank", "outage_line_id", "outage_name", "voltage_kv", "islanded_ss_count", "islanded_ss",
          "new_overload_count", "worst_overload_pct", "worst_overload_line_id", "worst_overload_line_name", "severity",
        ],
        rows,
      ) +
      "\r\n" +
      csvCell(`Note: ${HONESTY_NOTE} Scenario horizon ${horizonYear}, base demand ${BASE_DEMAND_MW} MW.`);
    downloadText(`planning-n1-${horizonYear}.csv`, "text/csv", csv);
  };

  // ---- Layout: full-screen scroll page; left column sits under the floating BrandHeader ----
  return (
    <div className="h-full w-full overflow-y-auto bg-surface-2">
      <div className="flex gap-3 px-3 pb-16 pt-3 max-lg:flex-col">
        <aside className="w-[268px] shrink-0 space-y-2.5 max-lg:w-full">
          {/* Clearance for the floating BrandHeader the shell renders at left-3/top-3. */}
          <div className="h-[148px]" aria-hidden />
          <ScenarioControls
            circles={circles}
            cagrByCircle={cagrByCircle}
            onCagrChange={(c, pct) => setCagrByCircle((m) => ({ ...m, [c]: pct }))}
            onSetAll={(pct) => setCagrByCircle(Object.fromEntries(circles.map((c) => [c, pct])))}
            horizonYear={horizonYear}
            onHorizonChange={setHorizonYear}
            genMode={genMode}
            onGenModeChange={setGenMode}
            generatorCount={genCandidates.length}
          />
          <SandboxPanel
            data={data}
            sandbox={sandbox}
            onAdd={(l) => setSandbox((s) => [...s, l])}
            onRemove={(i) => setSandbox((s) => s.filter((_, j) => j !== i))}
            onClearAll={() => setSandbox([])}
          />
        </aside>

        <main className="min-w-0 flex-1 space-y-3">
          <header className="flex flex-wrap items-end justify-between gap-2 px-1 pt-1">
            <div>
              <p className="text-xs text-ink-2">
                Corridor headroom · N−1 screen · what-if sandbox — indicative DC flow at{" "}
                <span className="font-semibold text-ink">{horizonYear}</span>
                {usingSandbox && " · what-if network"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {computing && <ComputingBadge phase={computing.phase} />}
              {activeResult && (
                <>
                  <MiniButton onClick={exportScenarioJson}>Scenario JSON</MiniButton>
                  <MiniButton onClick={exportHeadroomCsv} disabled={headroomRows.length === 0}>
                    Utilisation CSV
                  </MiniButton>
                </>
              )}
              {activeResult && (
                <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-medium text-ink-2">
                  {fmtInt(activeResult.totalLoadMw)} MW demand · {fmtInt(activeResult.generatorCount)} gen buses ·{" "}
                  {fmtInt(activeResult.nodes)} buses / {fmtInt(activeResult.edgesSolved)} circuits solved
                </span>
              )}
            </div>
          </header>

          <p className="rounded-lg border border-amber-300/60 bg-amber-100/60 px-3 py-2 text-[11px] leading-snug text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            <span className="font-bold">Screening only.</span> {HONESTY_NOTE}
          </p>

          <KpiStrip kpis={kpis} baseKpis={baseKpis} run={activeRun} />

          {usingSandbox && (
            <DeltaView
              before={horizonRun.result}
              after={sandboxRun.result}
              computing={sandboxRun.status === "computing" || horizonRun.status === "computing"}
              lineInfo={lineInfo}
              onOpen={focusOnMap}
            />
          )}

          <Card
            title={`Corridor headroom — top ${HEADROOM_TOP} by utilisation`}
            subtitle={`Base-case loading at ${horizonYear} vs indicative thermal rating · click a row to open it in the Atlas`}
            right={<MiniButton onClick={exportHeadroomCsv} disabled={headroomRows.length === 0}>CSV</MiniButton>}
          >
            {activeRun.status === "error" ? (
              <ErrorNote message={activeRun.error ?? "unknown"} />
            ) : !activeResult ? (
              <SkeletonRows rows={10} />
            ) : (
              <div className="max-h-[480px] overflow-y-auto">
                <table className="w-full border-collapse text-left text-[11px]">
                  <thead className="sticky top-0 z-[1] bg-surface">
                    <tr className="border-b border-line text-[10px] uppercase tracking-wide text-ink-2">
                      <th className="px-3 py-2 font-semibold">#</th>
                      <th className="px-2 py-2 font-semibold">Line</th>
                      <th className="px-2 py-2 font-semibold">kV</th>
                      <th className="px-2 py-2 font-semibold">Ckt</th>
                      <th className="px-2 py-2 text-right font-semibold">Flow MW</th>
                      <th className="px-2 py-2 text-right font-semibold">Rating MVA</th>
                      <th className="px-3 py-2 font-semibold">Loading</th>
                    </tr>
                  </thead>
                  <tbody className={activeRun.status === "computing" ? "opacity-50" : ""}>
                    {headroomRows.map((u, i) => {
                      const info = lineInfo(u.lineId);
                      return (
                        <tr
                          key={u.lineId}
                          onClick={() => focusOnMap(u.lineId)}
                          className={`border-b border-line/60 text-ink ${
                            info?.sandbox ? "" : "cursor-pointer hover:bg-surface-2"
                          }`}
                        >
                          <td className="px-3 py-1.5 tabular-nums text-ink-2">{i + 1}</td>
                          <td className="max-w-[260px] truncate px-2 py-1.5" title={info?.name ?? u.lineId}>
                            {info?.inferred && (
                              <span className="mr-1 rounded bg-sky-100/80 px-1 py-px text-[9px] font-bold text-sky-800 dark:bg-sky-500/20 dark:text-sky-300">
                                INFERRED
                              </span>
                            )}
                            {info?.sandbox && (
                              <span className="mr-1 rounded bg-violet-100/80 px-1 py-px text-[9px] font-bold text-violet-800 dark:bg-violet-500/20 dark:text-violet-300">
                                WHAT-IF
                              </span>
                            )}
                            {info?.name ?? u.lineId}
                          </td>
                          <td className="px-2 py-1.5">{info && <VoltTag v={info.voltage} />}</td>
                          <td className="px-2 py-1.5 text-ink-2">{info?.circuit ?? "—"}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmt1(Math.abs(u.flowMw))}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-ink-2">
                            {u.ratingMva === null ? "—" : `≈ ${fmtInt(u.ratingMva)}`}
                          </td>
                          <td className="px-3 py-1.5">{u.pct !== null && <PctPill pct={u.pct} />}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <HonestyFootnote />
          </Card>

          <Card
            title={`N−1 screen — worst ${N1_TOP} contingencies`}
            subtitle="Each circuit outaged once, full re-solve: newly-overloaded survivors + islanded substations, ranked by a composite severity"
            right={<MiniButton onClick={exportN1Csv} disabled={worstContingencies.length === 0}>CSV</MiniButton>}
          >
            {activeRun.status === "error" ? (
              <ErrorNote message={activeRun.error ?? "unknown"} />
            ) : !activeResult ? (
              <SkeletonRows rows={8} />
            ) : worstContingencies.length === 0 ? (
              <p className="px-4 py-3 text-xs text-ink-2">
                No contingency in this scenario islands a substation or newly overloads a line.
              </p>
            ) : (
              <div className="max-h-[440px] overflow-y-auto">
                <table className="w-full border-collapse text-left text-[11px]">
                  <thead className="sticky top-0 z-[1] bg-surface">
                    <tr className="border-b border-line text-[10px] uppercase tracking-wide text-ink-2">
                      <th className="px-3 py-2 font-semibold">#</th>
                      <th className="px-2 py-2 font-semibold">Outaged line</th>
                      <th className="px-2 py-2 font-semibold">kV</th>
                      <th className="px-2 py-2 text-right font-semibold">Islanded SS</th>
                      <th className="px-2 py-2 text-right font-semibold">New overloads</th>
                      <th className="px-3 py-2 font-semibold">Worst post-outage loading</th>
                    </tr>
                  </thead>
                  <tbody className={activeRun.status === "computing" ? "opacity-50" : ""}>
                    {worstContingencies.map((r, i) => {
                      const info = lineInfo(r.outageLineId);
                      const worst = r.overloads[0];
                      const worstInfo = worst ? lineInfo(worst.lineId) : null;
                      return (
                        <tr
                          key={r.outageLineId}
                          onClick={() => {
                            setN1PreviewId(r.outageLineId);
                            focusOnMap(r.outageLineId);
                          }}
                          onMouseEnter={() => setN1PreviewId(r.outageLineId)}
                          onMouseLeave={() => setN1PreviewId((cur) => (cur === r.outageLineId ? null : cur))}
                          className={`border-b border-line/60 text-ink ${
                            info?.sandbox ? "" : "cursor-pointer hover:bg-surface-2"
                          } ${n1PreviewId === r.outageLineId ? "bg-amber-50/80 dark:bg-amber-500/10" : ""}`}
                        >
                          <td className="px-3 py-1.5 tabular-nums text-ink-2">{i + 1}</td>
                          <td className="max-w-[240px] truncate px-2 py-1.5" title={info?.name ?? r.outageLineId}>
                            {info?.inferred && (
                              <span className="mr-1 rounded bg-sky-100/80 px-1 py-px text-[9px] font-bold text-sky-800 dark:bg-sky-500/20 dark:text-sky-300">
                                INFERRED
                              </span>
                            )}
                            {info?.sandbox && (
                              <span className="mr-1 rounded bg-violet-100/80 px-1 py-px text-[9px] font-bold text-violet-800 dark:bg-violet-500/20 dark:text-violet-300">
                                WHAT-IF
                              </span>
                            )}
                            {info?.name ?? r.outageLineId}
                          </td>
                          <td className="px-2 py-1.5">{info && <VoltTag v={info.voltage} />}</td>
                          <td
                            className="px-2 py-1.5 text-right tabular-nums"
                            title={r.islanded.length > 0 ? r.islanded.map(ssName).join(", ") : undefined}
                          >
                            {r.islanded.length > 0 ? (
                              <span className="font-semibold text-red-700 dark:text-red-400">{r.islanded.length}</span>
                            ) : (
                              <span className="text-ink-2">—</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {r.overloads.length > 0 ? r.overloads.length : <span className="text-ink-2">—</span>}
                          </td>
                          <td className="max-w-[260px] px-3 py-1.5">
                            {worst ? (
                              <span className="flex items-center gap-1.5">
                                <PctPill pct={worst.pct} />
                                <span className="truncate text-[10px] text-ink-2" title={worstInfo?.name ?? worst.lineId}>
                                  {worstInfo?.name ?? worst.lineId}
                                </span>
                              </span>
                            ) : (
                              <span className="text-ink-2">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <HonestyFootnote />
          </Card>

          <p className="px-1 text-[10px] text-ink-2/70">
            Network data: AP-TRANSCO (vintage {data.meta.generatedAt.slice(0, 10)}) · connectivity inferred
            geometrically · {activeResult ? `${fmtInt(activeResult.assumedLengthLines)} lines solved on an assumed default length` : ""}
          </p>

          <MethodCard
            metric="Corridor utilisation (% of indicative thermal rating)"
            source="AP-TRANSCO Gridmap ETL + inferred conductor ampacity (capacity.ts)"
            vintage={data.meta.generatedAt.slice(0, 10)}
            method="Indicative DC flow at voltage-weighted demand (132 kV primary) with per-circle CAGR growth to the horizon year"
            limitation="Screening only — not a load-flow or system study; demand and generation are crude assumptions"
          />
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI strip
// ---------------------------------------------------------------------------

function KpiCard({
  label,
  value,
  detail,
  delta,
}: {
  label: string;
  value: string;
  detail?: string;
  delta?: { value: number; unit?: string; digits?: number };
}) {
  return (
    <div className="rounded-[var(--radius-panel)] border border-line bg-surface px-3.5 py-3 shadow-[var(--shadow-panel)]">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-2">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums leading-none text-ink">{value}</p>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        {detail ? <span className="text-[10px] text-ink-2">{detail}</span> : <span />}
        {delta && <DeltaTag value={delta.value} unit={delta.unit} digits={delta.digits} />}
      </div>
    </div>
  );
}

function KpiStrip({
  kpis,
  baseKpis,
  run,
}: {
  kpis: ReturnType<typeof kpisFor> | null;
  baseKpis: ReturnType<typeof kpisFor> | null;
  run: FlowRunState;
}) {
  if (!kpis) {
    return (
      <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-[84px] animate-pulse rounded-[var(--radius-panel)] border border-line bg-surface-3" />
        ))}
      </div>
    );
  }
  const dim = run.status === "computing" ? "opacity-60" : "";
  return (
    <div className={`grid grid-cols-4 gap-3 max-md:grid-cols-2 ${dim}`}>
      <KpiCard
        label="Lines ≥ 80% loaded"
        value={`${kpis.pctOver80.toFixed(1)}%`}
        detail={`${fmtInt(kpis.over80)} of ${fmtInt(kpis.ratedLines)} rated`}
        delta={baseKpis ? { value: kpis.pctOver80 - baseKpis.pctOver80, unit: " pp", digits: 1 } : undefined}
      />
      <KpiCard
        label="Lines ≥ 100% loaded"
        value={`${kpis.pctOver100.toFixed(1)}%`}
        detail={`${fmtInt(kpis.over100)} of ${fmtInt(kpis.ratedLines)} rated`}
        delta={baseKpis ? { value: kpis.pctOver100 - baseKpis.pctOver100, unit: " pp", digits: 1 } : undefined}
      />
      <KpiCard
        label="N−1 overload contingencies"
        value={fmtInt(kpis.n1OverloadContingencies)}
        detail="outages newly overloading a line"
        delta={baseKpis ? { value: kpis.n1OverloadContingencies - baseKpis.n1OverloadContingencies } : undefined}
      />
      <KpiCard
        label="Islanding-prone lines"
        value={fmtInt(kpis.n1IslandingContingencies)}
        detail="outages cutting substations off"
        delta={baseKpis ? { value: kpis.n1IslandingContingencies - baseKpis.n1IslandingContingencies } : undefined}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sandbox delta view
// ---------------------------------------------------------------------------

const DELTA_TOP = 12;

function DeltaView({
  before,
  after,
  computing,
  lineInfo,
  onOpen,
}: {
  before: FlowCaseResult | null;
  after: FlowCaseResult | null;
  computing: boolean;
  lineInfo: (id: string) => LineInfo | null;
  onOpen: (id: string) => void;
}) {
  const relieved = useMemo(
    () => (before && after ? relievedCorridors(before, after) : []),
    [before, after],
  );
  const beforeKpis = before ? kpisFor(before) : null;
  const afterKpis = after ? kpisFor(after) : null;
  const totalHeadroomGain = relieved.reduce((s, d) => s + d.headroomGainMva, 0);

  return (
    <Card
      title="What-if delta — horizon scenario with vs without the sandbox lines"
      subtitle={`Corridors relieved by ≥ 5 pp, headroom freed, and the N−1 picture before → after`}
    >
      {!before || !after || computing ? (
        <SkeletonRows rows={5} />
      ) : (
        <div className="px-4 py-3">
          <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
            <BeforeAfter label="Corridors relieved ≥ 5 pp" a={null} b={relieved.length} />
            <BeforeAfter
              label="Indicative headroom freed"
              a={null}
              b={totalHeadroomGain}
              fmt={(n) => `≈ ${fmtInt(n)} MVA`}
            />
            <BeforeAfter
              label="N−1 islanding contingencies"
              a={beforeKpis!.n1IslandingContingencies}
              b={afterKpis!.n1IslandingContingencies}
            />
            <BeforeAfter
              label="N−1 overload contingencies"
              a={beforeKpis!.n1OverloadContingencies}
              b={afterKpis!.n1OverloadContingencies}
            />
          </div>

          {relieved.length === 0 ? (
            <p className="mt-3 text-xs text-ink-2">
              No corridor's utilisation drops by ≥ 5 percentage points under this what-if — try a
              different pair of substations or a higher voltage.
            </p>
          ) : (
            <table className="mt-3 w-full border-collapse text-left text-[11px]">
              <thead>
                <tr className="border-b border-line text-[10px] uppercase tracking-wide text-ink-2">
                  <th className="py-1.5 pr-2 font-semibold">Relieved corridor</th>
                  <th className="px-2 py-1.5 font-semibold">kV</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Before</th>
                  <th className="px-2 py-1.5 text-right font-semibold">After</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Drop</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Headroom freed</th>
                </tr>
              </thead>
              <tbody>
                {relieved.slice(0, DELTA_TOP).map((d) => {
                  const info = lineInfo(d.lineId);
                  return (
                    <tr
                      key={d.lineId}
                      onClick={() => onOpen(d.lineId)}
                      className="cursor-pointer border-b border-line/60 text-ink hover:bg-surface-2"
                    >
                      <td className="max-w-[280px] truncate py-1.5 pr-2" title={info?.name ?? d.lineId}>
                        {info?.name ?? d.lineId}
                      </td>
                      <td className="px-2 py-1.5">{info && <VoltTag v={info.voltage} />}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{d.beforePct.toFixed(0)}%</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-emerald-700 dark:text-emerald-400">
                        {d.afterPct.toFixed(0)}%
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-emerald-700 dark:text-emerald-400">
                        −{d.dropPp.toFixed(1)} pp
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-ink-2">
                        ≈ {fmtInt(d.headroomGainMva)} MVA
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {relieved.length > DELTA_TOP && (
            <p className="mt-1.5 text-[10px] text-ink-2">
              +{relieved.length - DELTA_TOP} more corridors relieved ≥ 5 pp.
            </p>
          )}
        </div>
      )}
      <HonestyFootnote />
    </Card>
  );
}

function BeforeAfter({
  label,
  a,
  b,
  fmt = (n: number) => fmtInt(n),
}: {
  label: string;
  /** Pass null for "result-only" metrics with no before value. */
  a: number | null;
  b: number;
  fmt?: (n: number) => string;
}) {
  const improved = a !== null && b < a;
  const worsened = a !== null && b > a;
  return (
    <div className="rounded-lg border border-line bg-surface-2/60 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-2">{label}</p>
      <p className="mt-0.5 text-sm font-bold tabular-nums text-ink">
        {a !== null && <span className="font-medium text-ink-2">{fmt(a)} → </span>}
        <span
          className={
            improved
              ? "text-emerald-700 dark:text-emerald-400"
              : worsened
                ? "text-red-700 dark:text-red-400"
                : undefined
          }
        >
          {fmt(b)}
        </span>
      </p>
    </div>
  );
}
