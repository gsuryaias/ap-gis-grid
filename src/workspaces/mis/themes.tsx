// Network MIS thematic deep-dives: asset age, N-1 exposure, 33 kV downstream, conductors &
// capacity, and interfaces (generation / railway / bulk-load / PGCIL). Every list row is a drill
// (adds a scope filter) or a pick (opens the asset dossier + flies the map).
import { useEffect, useMemo } from "react";
import { VoltageBadge } from "../../components/VoltageBadge.tsx";
import { useLiveStatus } from "../../data/live-status.ts";
import { ENERGY_TYPES, type EnergyType, type Voltage } from "../../data/types.ts";
import { DISCOM_COLOR, type DiscomId } from "../../overlays/catalog.ts";
import { useAppStore } from "../../state/store.ts";
import { BULKLOAD_COLOR, ENERGY_COLOR, ENERGY_LABEL, POWERGRID_COLOR, RAILWAY_COLOR } from "../../theme/palette.ts";
import { BarList, StackedColumns, type StackedColumn } from "./charts.tsx";
import {
  AGE_BAND_LABEL,
  AGE_BAND_ORDER,
  bridgeImpacts,
  commissioningHistogram,
  groupBy,
  LINE_USEFUL_LIFE_YRS,
  ROLE_HINT,
  ROLE_LABEL,
  ROLE_ORDER,
  topBy,
  type DimId,
  type MisModel,
  type Scope,
  type ScopeFilter,
} from "./model.ts";
import { Card, gva, nf0, nf1, Note, pct, StatTile, VoltageLegend } from "./ui.tsx";

export type ThemeTab = "age" | "n1" | "downstream" | "conductor" | "interfaces";
export const THEME_TABS: { id: ThemeTab; label: string }[] = [
  { id: "age", label: "Asset age" },
  { id: "n1", label: "N-1 exposure" },
  { id: "downstream", label: "33 kV downstream" },
  { id: "conductor", label: "Conductors & rating" },
  { id: "interfaces", label: "Generation & interfaces" },
];
export function isThemeTab(v: unknown): v is ThemeTab {
  return THEME_TABS.some((t) => t.id === v);
}

interface TabProps {
  model: MisModel;
  scope: Scope;
  filters: ScopeFilter[];
  onDrill: (dim: DimId, key: string) => void;
}

const pick = (id: string) => useAppStore.getState().select(id, { fly: true });

// ---------------------------------------------------------------------------------------------

export function AgeTab({ scope, onDrill }: TabProps) {
  const hist = useMemo(() => commissioningHistogram(scope.lines), [scope.lines]);
  const bands = useMemo(() => groupBy(scope, "age"), [scope]);
  const total = bands.reduce((a, b) => a + b.m.ckm, 0);
  const oldest = useMemo(
    () => scope.lines.filter((r) => r.age != null).sort((a, b) => b.age! - a.age! || b.ckm - a.ckm).slice(0, 10),
    [scope.lines],
  );
  const asOf = new Date().getFullYear();
  const lifeCut = asOf - LINE_USEFUL_LIFE_YRS;
  const cols: StackedColumn[] = hist.map((b) => ({
    key: String(b.start),
    label: `${String(b.start).slice(2)}–${String(b.start + 4).slice(2)}`,
    byV: b.ckmByV,
    note: `${b.lines} line rows commissioned ${b.start}–${b.start + 4}`,
  }));
  const markerAt = hist.findIndex((b) => b.start + 5 > lifeCut);
  const binCkm = (b: (typeof hist)[number]) => b.ckmByV[400] + b.ckmByV[220] + b.ckmByV[132];
  const peak = hist.reduce<(typeof hist)[number] | null>((best, b) => (!best || binCkm(b) > binCkm(best) ? b : best), null);
  const recent = hist.filter((b) => b.start >= asOf - 10).reduce((a, b) => a + binCkm(b), 0);
  const allCkm = hist.reduce((a, b) => a + binCkm(b), 0);
  const past = bands.find((b) => b.key === "3")?.m.ckm ?? 0;
  const unknown = bands.find((b) => b.key === "unknown")?.m;

  return (
    <div className="space-y-3 p-3">
      <Card
        title="Circuit-km commissioned, by 5-year period"
        subtitle={
          peak
            ? `Peak period ${peak.start}–${peak.start + 4} (${nf0(binCkm(peak))} ckm); ${pct(allCkm ? recent / allCkm : 0)} of dated circuit-km is from the last decade.`
            : undefined
        }
        actions={<VoltageLegend />}
      >
        {cols.length ? (
          <StackedColumns
            columns={cols}
            unit="ckm"
            ariaLabel="Circuit-km commissioned per five-year period, stacked by voltage"
            marker={markerAt > 0 ? { at: markerAt, label: `← past ${LINE_USEFUL_LIFE_YRS}-yr life` } : undefined}
          />
        ) : (
          <p className="text-xs text-ink-2">No commissioning years in this scope.</p>
        )}
        <Note>
          Years from each line’s commissioning date (re-conductored or re-built lines keep their original date in the
          source). {unknown && unknown.lines > 0 && `${unknown.lines} line rows (${nf0(unknown.ckm)} ckm) have no year.`}
        </Note>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Age bands" subtitle={`Share of circuit-km · click to drill · ${nf0(past)} ckm past life`}>
          <BarList
            pickLabel="Drill into this age band"
            onPick={(k) => onDrill("age", k)}
            items={AGE_BAND_ORDER.map((k) => bands.find((b) => b.key === k))
              .filter((b) => !!b)
              .map((b) => ({
                key: b!.key,
                label: AGE_BAND_LABEL[b!.key as keyof typeof AGE_BAND_LABEL],
                value: b!.m.ckm,
                byV: b!.m.ckmByV,
                display: `${nf0(b!.m.ckm)} ckm · ${pct(total ? b!.m.ckm / total : 0)}`,
              }))}
          />
        </Card>
        <Card title="Oldest circuits in scope" subtitle="Candidates for condition assessment / R&M planning">
          <ul className="divide-y divide-line/70 text-xs">
            {oldest.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => pick(r.id)}
                  className="flex w-full items-center gap-2 py-1.5 text-left hover:bg-surface-2"
                >
                  <VoltageBadge voltage={r.voltage} small />
                  <span className="min-w-0 flex-1 truncate text-ink" title={r.line.name}>
                    {r.line.name}
                  </span>
                  <span className="shrink-0 tabular-nums text-ink-2">{r.year}</span>
                  <span className="w-12 shrink-0 text-right font-medium tabular-nums text-ink">{r.age} y</span>
                </button>
              </li>
            ))}
            {!oldest.length && <li className="py-2 text-ink-2">No dated lines in scope.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function N1Tab({ model, scope, onDrill }: TabProps) {
  const roles = useMemo(() => groupBy(scope, "role"), [scope]);
  const bridges = useMemo(() => bridgeImpacts(model, scope.lines), [model, scope.lines]);
  const singles = useMemo(
    () => scope.ss.filter((r) => r.role === "single-fed").sort((a, b) => b.discomSsIds.length - a.discomSsIds.length || b.voltage - a.voltage),
    [scope.ss],
  );
  const exposedDiscom = useMemo(() => {
    const s = new Set<string>();
    for (const b of bridges) for (const r of b.islanded) for (const id of r.discomSsIds) s.add(id);
    return s.size;
  }, [bridges]);

  return (
    <div className="space-y-3 p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Bridge lines" value={nf0(bridges.length)} sub="single-path links whose outage islands SS" />
        <StatTile label="Cut-point SS" value={nf0(roles.find((r) => r.key === "articulation")?.m.ss ?? 0)} sub="loss splits the grid" />
        <StatTile label="Single-fed SS" value={nf0(singles.length)} sub="one neighbouring source" />
        <StatTile label="33/11 kV SS exposed" value={nf0(exposedDiscom)} sub="downstream of an islandable SS" />
      </div>

      <Card
        pad={false}
        title="Bridge lines ranked by consequence"
        subtitle="If this single line trips, these TRANSCO substations lose every inferred path to the rest of the grid."
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-y border-line bg-surface-2/70 text-left text-[11px] text-ink-2">
                <th className="py-2 pl-4 pr-2 font-medium">Line</th>
                <th className="px-2 font-medium">Substations islanded</th>
                <th className="px-2 text-right font-medium" title="33/11 kV SS on 33 kV feeders out of the islanded SS">33/11 SS</th>
                <th className="px-2 pr-4 text-right font-medium">Feeders</th>
              </tr>
            </thead>
            <tbody>
              {bridges.slice(0, 15).map((b) => (
                <tr key={b.row.id} className="cursor-pointer border-b border-line/70 hover:bg-accent/5" onClick={() => pick(b.row.id)}>
                  <td className="max-w-[260px] py-1.5 pl-4 pr-2">
                    <span className="flex items-center gap-1.5">
                      <VoltageBadge voltage={b.row.voltage} small />
                      <span className="truncate text-ink" title={b.row.line.name}>
                        {b.row.line.name}
                      </span>
                    </span>
                  </td>
                  <td className="max-w-[200px] truncate px-2 text-ink-2" title={b.islanded.map((r) => r.ss.name).join(", ")}>
                    {b.islanded.map((r) => r.ss.name).join(", ")}
                  </td>
                  <td className="px-2 text-right font-medium tabular-nums text-ink">{b.discomSs || "·"}</td>
                  <td className="px-2 pr-4 text-right tabular-nums text-ink">{b.feeders || "·"}</td>
                </tr>
              ))}
              {!bridges.length && (
                <tr>
                  <td colSpan={4} className="px-4 py-3 text-ink-2">
                    No bridge lines in this scope — every substation here has an alternative inferred path.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {bridges.length > 15 && <p className="px-4 pt-2 text-[11px] text-ink-2">Top 15 of {bridges.length}; the Lines register lists them all.</p>}
        <p className="px-4 py-2 text-[11px] leading-snug text-ink-2">
          Screening on the geometric connectivity graph: parallel circuits count as separate paths, so a double-circuit
          corridor is not a bridge; 33 kV back-feeds and DISCOM ring interconnections are not modelled. Not a
          contingency study.
        </p>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Network role" subtitle="Click to drill">
          <BarList
            onPick={(k) => onDrill("role", k)}
            items={ROLE_ORDER.map((k) => roles.find((r) => r.key === k))
              .filter((r) => !!r)
              .map((r) => ({
                key: r!.key,
                label: ROLE_LABEL[r!.key as keyof typeof ROLE_LABEL],
                value: r!.m.ss,
                byV: r!.m.ssByV,
                title: ROLE_HINT[r!.key as keyof typeof ROLE_HINT],
                display: `${nf0(r!.m.ss)} SS`,
              }))}
          />
          <VoltageLegend className="mt-2" />
        </Card>
        <Card title="Single-fed substations" subtitle="Sorted by the 33/11 kV substations hanging off them">
          <ul className="max-h-72 divide-y divide-line/70 overflow-y-auto text-xs">
            {singles.slice(0, 40).map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => pick(r.id)} className="flex w-full items-center gap-2 py-1.5 text-left hover:bg-surface-2">
                  <VoltageBadge voltage={r.voltage} small />
                  <span className="min-w-0 flex-1 truncate text-ink">{r.ss.name}</span>
                  <span className="shrink-0 text-ink-2">{r.circle ?? "—"}</span>
                  <span className="w-16 shrink-0 text-right tabular-nums text-ink">{r.discomSsIds.length ? `${r.discomSsIds.length} SS` : "·"}</span>
                </button>
              </li>
            ))}
            {!singles.length && <li className="py-2 text-ink-2">None in scope.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function DownstreamTab({ model, scope }: TabProps) {
  const live = useLiveStatus();
  const top = useMemo(() => topBy(scope.ss, (r) => r.discomSsIds.length, 15), [scope.ss]);
  const fed = scope.ss.filter((r) => r.feeders > 0).length;
  const feeders = scope.ss.reduce((a, r) => a + r.feeders, 0);
  const km = scope.ss.reduce((a, r) => a + r.feederKm, 0);
  const discomSs = new Set(scope.ss.flatMap((r) => r.discomSsIds)).size;
  const cov = live?.connectivity?.byDiscom;

  if (!model.hasDownstream) return <p className="p-4 text-xs text-ink-2">Loading the 33 kV connectivity index…</p>;
  return (
    <div className="space-y-3 p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="TRANSCO SS with 33 kV feeders" value={`${nf0(fed)} / ${nf0(scope.ss.length)}`} />
        <StatTile label="33 kV feeders traced" value={nf0(feeders)} sub={`${nf0(km)} km of route`} />
        <StatTile label="33/11 kV SS served" value={nf0(discomSs)} sub="distinct, on traced feeders" />
        <StatTile label="Avg per feeding SS" value={fed ? nf1(discomSs / fed) : "—"} sub="33/11 kV SS" />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Heaviest 33 kV dependence" subtitle="TRANSCO substations by 33/11 kV substations served">
          <BarList
            onPick={pick}
            pickLabel="Open the substation dossier"
            items={top.map((r) => ({
              key: r.id,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <VoltageBadge voltage={r.voltage} small />
                  {r.ss.name}
                  <span className="text-ink-2">· {r.discoms.join(", ")}</span>
                </span>
              ),
              value: r.discomSsIds.length,
              display: `${r.discomSsIds.length} SS · ${r.feeders} fdr`,
              color: "#2a78d6",
            }))}
          />
          {!top.length && <p className="text-xs text-ink-2">No traced 33 kV feeders in this scope.</p>}
        </Card>

        <Card title="Mapping coverage by DISCOM" subtitle="How much of each DISCOM’s 33 kV network could be traced to TRANSCO">
          {cov ? (
            <ul className="space-y-3 text-xs">
              {(Object.keys(cov) as DiscomId[]).map((d) => {
                const c = cov[d];
                const ssPct = c.substations ? c.substationsTracedToTransco / c.substations : 0;
                const kmPct = c.kmTotal ? c.kmLinked / c.kmTotal : 0;
                return (
                  <li key={d}>
                    <div className="flex items-center gap-1.5 font-medium text-ink">
                      <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: DISCOM_COLOR[d] ?? "#888" }} />
                      {d}
                    </div>
                    <Meter label="33/11 kV SS traced" frac={ssPct} text={`${nf0(c.substationsTracedToTransco)} / ${nf0(c.substations)}`} />
                    <Meter label="33 kV route-km linked" frac={kmPct} text={`${nf0(c.kmLinked)} / ${nf0(c.kmTotal)} km`} />
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-ink-2">Coverage statistics unavailable.</p>
          )}
          <Note>
            APSPDCL publishes only part of its 33 kV line map (no source-SS field), so Rayalaseema circles under-count —
            a low figure there means “not mapped”, not “lightly loaded”.
          </Note>
        </Card>
      </div>
    </div>
  );
}

function Meter({ label, frac, text }: { label: string; frac: number; text: string }) {
  return (
    <div className="mt-1">
      <div className="flex justify-between text-[11px] text-ink-2">
        <span>{label}</span>
        <span className="tabular-nums text-ink">
          {text} · {pct(frac)}
        </span>
      </div>
      <div className="mt-0.5 h-1.5 w-full rounded-full bg-[#2a78d6]/15">
        <div className="h-full rounded-full bg-[#2a78d6]" style={{ width: `${Math.min(1, frac) * 100}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function ConductorTab({ scope, onDrill }: TabProps) {
  const fam = useMemo(() => groupBy(scope, "conductor"), [scope]);
  const volt = useMemo(() => groupBy(scope, "voltage"), [scope]);
  const rated = scope.lines.filter((r) => r.mva != null).length;
  const max = Math.max(0, ...fam.map((f) => f.m.ckm));
  return (
    <div className="space-y-3 p-3">
      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Conductor families" subtitle="Circuit-km by family · click to drill" actions={<VoltageLegend />}>
          <BarList
            max={max}
            onPick={(k) => onDrill("conductor", k)}
            items={fam.slice(0, 12).map((f) => ({
              key: f.key,
              label: f.label,
              value: f.m.ckm,
              byV: f.m.ckmByV,
              display: `${nf0(f.m.ckm)} ckm`,
            }))}
          />
        </Card>
        <Card title="Indicative thermal rating by voltage" subtitle="Σ of per-circuit ratings — installed capability, not loading">
          <BarList
            items={volt.map((v) => ({
              key: v.key,
              label: `${v.key} kV`,
              value: v.m.mva,
              byV: { 400: 0, 220: 0, 132: 0, [Number(v.key) as Voltage]: v.m.mva } as Record<Voltage, number>,
              display: gva(v.m.mva),
              sub: v.m.ckm ? `${nf0(v.m.mva / Math.max(1, v.m.ckm) * 100)} MVA per 100 ckm` : undefined,
            }))}
          />
          <Note>
            {nf0(rated)} of {nf0(scope.lines.length)} line rows rated from conductor nominal ampacity (≈ 40 °C ambient,
            75 °C conductor) × √3 · kV × circuits. Unrated rows are UG cable or unrecognised codes. Real ratings depend
            on ambient, sag and wind — use as a planning indicator only.
          </Note>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function InterfacesTab({ scope, filters }: TabProps) {
  const generation = useAppStore((s) => s.generation);
  const genStatus = useAppStore((s) => s.genStatus);
  const powergrid = useAppStore((s) => s.powergrid);
  const pgStatus = useAppStore((s) => s.pgStatus);
  useEffect(() => {
    useAppStore.getState().ensureGeneration();
    useAppStore.getState().ensurePowerGrid();
  }, []);

  // Overlay assets carry circle (+ interconnection voltage for plants) — scope them by those only.
  const circleF = filters.find((f) => f.dim === "circle")?.value ?? null;
  const voltF = filters.find((f) => f.dim === "voltage")?.value ?? null;
  const otherDims = filters.filter((f) => f.dim !== "circle" && f.dim !== "voltage").length > 0;
  const inCircle = (c: string | null) => !circleF || c === circleF;

  const plants = (generation?.plants ?? []).filter((p) => inCircle(p.circle) && (!voltF || String(p.voltage) === voltF));
  const mix = ENERGY_TYPES.map((t) => {
    const ps = plants.filter((p) => p.energy === t);
    return { t, n: ps.length, mw: ps.reduce((a, p) => a + (p.capacityMw ?? 0), 0), mwKnown: ps.filter((p) => p.capacityMw).length };
  }).filter((x) => x.n > 0);
  const rail = (powergrid?.railway ?? []).filter((r) => inCircle(r.circle));
  const bulk = (powergrid?.bulkload ?? []).filter((r) => inCircle(r.circle));
  const sum = (a: { mva: number | null }[]) => a.reduce((s, r) => s + (r.mva ?? 0), 0);

  const ext = new Map<string, number>();
  for (const r of scope.lines) for (const c of r.external) ext.set(c, (ext.get(c) ?? 0) + 1);
  const EXT_COLOR: Record<string, string> = {
    Generation: ENERGY_COLOR.Thermal,
    Railway: RAILWAY_COLOR,
    PowerGrid: POWERGRID_COLOR,
    "HT consumer": BULKLOAD_COLOR,
  };

  return (
    <div className="space-y-3 p-3">
      <Card title="Lines terminating outside TRANSCO" subtitle="Line rows in scope whose end snaps to a non-TRANSCO facility (≤ 1 km)">
        <BarList
          items={[...ext.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([c, n]) => ({ key: c, label: c, value: n, color: EXT_COLOR[c] ?? "#888", display: `${n} lines` }))}
        />
        {!ext.size && <p className="text-xs text-ink-2">None in scope.</p>}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card
          title="Generation connected"
          subtitle={genStatus === "ready" ? `${plants.length} plants${circleF ? ` in ${circleF}` : ""}${voltF ? ` at ${voltF} kV` : ""}` : "Loading plants…"}
        >
          {genStatus === "error" ? (
            <p className="text-xs text-ink-2">Couldn’t load the generation layer.</p>
          ) : (
            <BarList
              items={mix.map((x) => ({
                key: x.t,
                label: ENERGY_LABEL[x.t as EnergyType],
                value: x.n,
                color: ENERGY_COLOR[x.t as EnergyType],
                display: `${x.n} plants`,
                sub: x.mwKnown ? `${nf0(x.mw)} MW recorded for ${x.mwKnown} of ${x.n}` : "capacity not recorded",
              }))}
            />
          )}
          <Note>The source records MW for only some plants, so capacity totals are partial.</Note>
        </Card>
        <Card title="Bulk consumers & traction" subtitle={pgStatus === "ready" ? undefined : "Loading…"}>
          <ul className="space-y-2 text-xs">
            <IfaceRow color={RAILWAY_COLOR} label="Railway traction SS" n={rail.length} mva={sum(rail)} />
            <IfaceRow color={BULKLOAD_COLOR} label="Bulk-load / HT consumer SS" n={bulk.length} mva={sum(bulk)} />
            <IfaceRow color={POWERGRID_COLOR} label="POWERGRID (PGCIL) SS — statewide" n={powergrid?.substations.length ?? 0} />
          </ul>
          <Note>Contract demand (MVA) as recorded on the source layers. PGCIL substations carry no circle, so they are statewide.</Note>
        </Card>
      </div>
      {otherDims && (
        <p className="px-1 text-[11px] text-ink-2">
          Plants, traction and bulk-load sites carry only a circle (and plants a voltage), so they follow those filters only;
          the line-termination count above follows the full drill path.
        </p>
      )}
    </div>
  );
}

function IfaceRow({ color, label, n, mva }: { color: string; label: string; n: number; mva?: number }) {
  return (
    <li className="flex items-center gap-2">
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      <span className="flex-1 text-ink">{label}</span>
      <span className="tabular-nums font-medium text-ink">{nf0(n)}</span>
      {mva != null && <span className="w-24 text-right tabular-nums text-ink-2">{mva ? `${nf0(mva)} MVA` : "—"}</span>}
    </li>
  );
}
