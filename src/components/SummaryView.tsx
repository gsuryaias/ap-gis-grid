import { useState } from "react";
import { VOLTAGES, type GridData, type GroupStat, type Voltage } from "../data/types.ts";
import { formatInt, formatKm } from "../lib/format.ts";
import { useAppStore } from "../state/store.ts";
import { VOLTAGE_COLOR } from "../theme/palette.ts";
import { ChevronDown, CloseIcon, TargetIcon } from "./icons.tsx";

type GroupBy = "voltage" | "circle";

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2 px-3.5 py-2.5">
      <div className="text-xl font-semibold text-ink">{value}</div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-2">{label}</div>
    </div>
  );
}

/** A metric strip: counts + route-km + circuit-km, with a circuit-km proportion bar. */
function Metrics({ stat, max, color }: { stat: GroupStat; max: number; color: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-line sm:block">
        <div className="h-full rounded-full" style={{ width: `${max ? (stat.circuitKm / max) * 100 : 0}%`, backgroundColor: color }} />
      </div>
      <div className="grid w-[230px] grid-cols-3 gap-2 text-right text-xs tabular-nums">
        <span className="text-ink-2">{formatInt(stat.substations)} SS · {formatInt(stat.lines)} ln</span>
        <span className="text-ink">{formatKm(stat.lengthKm)}</span>
        <span className="font-semibold text-ink">{formatKm(stat.circuitKm)}</span>
      </div>
    </div>
  );
}

export function SummaryView({ data }: { data: GridData }) {
  const open = useAppStore((s) => s.summaryOpen);
  const toggle = useAppStore((s) => s.toggleSummary);
  const isolateVoltage = useAppStore((s) => s.isolateVoltage);
  const [groupBy, setGroupBy] = useState<GroupBy>("voltage");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  if (!open) return null;

  const m = data.meta;
  const maxCkm = Math.max(
    ...VOLTAGES.map((v) => m.byVoltage[v]?.circuitKm ?? 0),
    ...m.circles.map((c) => m.byCircle[c]?.circuitKm ?? 0),
  );
  const toggleRow = (k: string) => setExpanded((s) => {
    const n = new Set(s);
    n.has(k) ? n.delete(k) : n.add(k);
    return n;
  });

  const voltageGroups = VOLTAGES.map((v) => ({
    key: `v${v}`,
    title: `${v} kV`,
    color: VOLTAGE_COLOR[v],
    stat: m.byVoltage[String(v)],
    voltage: v as Voltage,
    children: m.circles
      .map((c) => ({ label: c, stat: m.matrix[String(v)]?.[c], color: VOLTAGE_COLOR[v] }))
      .filter((c) => c.stat)
      .sort((a, b) => (b.stat!.circuitKm ?? 0) - (a.stat!.circuitKm ?? 0)),
  }));

  const circleGroups = m.circles.map((c) => ({
    key: `c${c}`,
    title: c,
    color: "#64748b",
    stat: m.byCircle[c],
    voltage: null as Voltage | null,
    children: VOLTAGES.map((v) => ({ label: `${v} kV`, stat: m.matrix[String(v)]?.[c], color: VOLTAGE_COLOR[v] })).filter(
      (x) => x.stat,
    ),
  }));

  const groups = groupBy === "voltage" ? voltageGroups : circleGroups;

  return (
    <div
      className="absolute inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={() => toggle(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Network summary"
    >
      <div
        className="flex max-h-full w-[720px] max-w-full flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface shadow-[var(--shadow-panel)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div>
            <h2 className="text-lg font-semibold text-ink">Network summary</h2>
            <p className="text-sm text-ink-2">Counts, route-km and circuit-km · drill down by voltage or circle</p>
          </div>
          <button onClick={() => toggle(false)} aria-label="Close" className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink">
            <CloseIcon />
          </button>
        </header>

        <div className="grid grid-cols-2 gap-2.5 px-5 py-4 sm:grid-cols-4">
          <Kpi label="Substations" value={formatInt(m.counts.substations)} />
          <Kpi label="Lines" value={formatInt(m.counts.lines)} />
          <Kpi label="Route-km" value={formatKm(m.totalLengthKm)} />
          <Kpi label="Circuit-km" value={formatKm(m.totalCircuitKm)} />
        </div>

        <div className="flex items-center justify-between px-5 pb-2">
          <div className="flex rounded-lg bg-surface-2 p-0.5 text-sm">
            {(["voltage", "circle"] as GroupBy[]).map((g) => (
              <button
                key={g}
                onClick={() => setGroupBy(g)}
                className={`rounded-md px-3 py-1 font-medium capitalize ${
                  groupBy === g ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"
                }`}
              >
                By {g}
              </button>
            ))}
          </div>
          <div className="hidden w-[230px] grid-cols-3 gap-2 pr-1 text-right text-[10px] font-semibold uppercase tracking-wide text-ink-2 sm:grid">
            <span>Count</span>
            <span>Route</span>
            <span>Circuit</span>
          </div>
        </div>

        <div className="overflow-auto px-3 pb-4">
          {groups.map((g) => {
            if (!g.stat) return null;
            const isOpen = expanded.has(g.key);
            return (
              <div key={g.key} className="border-b border-line/60 last:border-0">
                <div className="flex items-center gap-2 py-2 pl-2 pr-1">
                  <button onClick={() => toggleRow(g.key)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={isOpen}>
                    <ChevronDown width={15} height={15} className={`shrink-0 text-ink-2 transition-transform ${isOpen ? "" : "-rotate-90"}`} />
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: g.color }} />
                    <span className="truncate font-semibold text-ink">{g.title}</span>
                  </button>
                  <Metrics stat={g.stat} max={maxCkm} color={g.color} />
                  {g.voltage && (
                    <button
                      onClick={() => isolateVoltage(g.voltage!)}
                      aria-label={`Show only ${g.title} on map`}
                      title="Isolate on map"
                      className="shrink-0 rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink"
                    >
                      <TargetIcon width={15} height={15} />
                    </button>
                  )}
                </div>
                {isOpen && (
                  <div className="mb-1 ml-7 border-l border-line pl-3">
                    {g.children.map((c) => (
                      <div key={c.label} className="flex items-center gap-2 py-1 pr-1">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                        <span className="min-w-0 flex-1 truncate text-sm text-ink-2">{c.label}</span>
                        <Metrics stat={c.stat!} max={maxCkm} color={c.color} />
                        <span className="w-[23px]" />
                      </div>
                    ))}
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
