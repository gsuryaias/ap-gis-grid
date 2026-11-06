// Explore lens panel: start-here tips, the network at a glance, and what is on the map.
import type { GridData, Voltage } from "../data/types.ts";
import { VOLTAGES } from "../data/types.ts";
import { LayersIcon } from "../components/icons.tsx";
import { useCatalogue } from "../layers/LayerDrawer.tsx";
import { SwatchMark } from "../layers/ui.tsx";
import { formatInt } from "../lib/format.ts";
import { useAppStore } from "../state/store.ts";
import { VOLTAGE_COLOR } from "../theme/palette.ts";
import { PanelSection, StartHere } from "./StartHere.tsx";

const km = (n: number) => `${formatInt(Math.round(n))} km`;

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-2 px-2.5 py-1.5">
      <div className="text-[15px] font-semibold tabular-nums text-ink">{value}</div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-ink-2">{label}</div>
    </div>
  );
}

/** Counts + route-km + circuit-km, and a circuit-km bar per voltage (click = show only that voltage). */
export function NetworkAtAGlance({ data }: { data: GridData }) {
  const isolateVoltage = useAppStore((s) => s.isolateVoltage);
  const toggleSummary = useAppStore((s) => s.toggleSummary);
  const m = data.meta;
  const max = Math.max(...VOLTAGES.map((v) => m.byVoltage[String(v)]?.circuitKm ?? 0));
  return (
    <PanelSection
      title="Network at a glance"
      action={
        <button type="button" onClick={() => toggleSummary(true)} className="text-[11px] font-medium text-accent hover:underline">
          Full summary
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-1.5">
        <Kpi label="Substations" value={formatInt(m.counts.substations)} />
        <Kpi label="Line circuits" value={formatInt(m.counts.lines)} />
        <Kpi label="Route length" value={km(m.totalLengthKm)} />
        <Kpi label="Circuit length" value={km(m.totalCircuitKm)} />
      </div>
      <ul className="mt-2 space-y-1">
        {VOLTAGES.map((v: Voltage) => {
          const st = m.byVoltage[String(v)];
          if (!st) return null;
          return (
            <li key={v}>
              <button
                type="button"
                onClick={() => isolateVoltage(v)}
                title={`Show only ${v} kV on the map and in the table`}
                className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-[11px] hover:bg-surface-2"
              >
                <span className="w-10 shrink-0 font-semibold text-ink">{v} kV</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                  <span className="block h-full rounded-full" style={{ width: `${max ? (st.circuitKm / max) * 100 : 0}%`, backgroundColor: VOLTAGE_COLOR[v] }} />
                </span>
                <span className="shrink-0 whitespace-nowrap text-right tabular-nums text-ink-2">
                  {formatInt(st.substations)} SS · {km(st.circuitKm)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </PanelSection>
  );
}

/** What is on the map now (names only) + the way into the Layers drawer. */
export function LayersBlock() {
  const { entries, on } = useCatalogue();
  const toggle = useAppStore((s) => s.toggleLayersDrawer);
  const active = entries.filter((e) => on.has(e.id));
  return (
    <PanelSection
      title={`On the map · ${active.length}`}
      action={
        <button type="button" onClick={() => toggle(true)} className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline">
          <LayersIcon width={12} height={12} /> Layers
        </button>
      }
    >
      <ul className="space-y-0.5">
        {active.map((e) => (
          <li key={e.id} className="flex items-center gap-2 text-[12px] text-ink">
            <SwatchMark s={e.swatch} />
            <span className="truncate">{e.label}</span>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => toggle(true)} className="mt-2 w-full rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2">
        Add or remove layers
      </button>
    </PanelSection>
  );
}

export default function ExplorePanel({ data }: { data: GridData }) {
  return (
    <div className="flex flex-col gap-3">
      <StartHere lens="explore" />
      <NetworkAtAGlance data={data} />
      <LayersBlock />
    </div>
  );
}
