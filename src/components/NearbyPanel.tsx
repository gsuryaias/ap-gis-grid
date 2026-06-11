import type { Position } from "geojson";
import type { GridData } from "../data/types.ts";
import { useAppStore } from "../state/store.ts";
import { bearingDeg, compass8, formatLength, haversineMeters } from "../lib/geo.ts";
import { CloseIcon, SubstationIcon, TargetIcon } from "./icons.tsx";
import { VoltageDot } from "./VoltageBadge.tsx";

const COUNT = 6;

/**
 * Lists the nearest substations to the query origin (a GPS fix or a picked map point). Respects the
 * active voltage + circle filters, so "nearest 220 kV in Kurnool" falls out of the existing toggles.
 */
export function NearbyPanel({ data }: { data: GridData }) {
  const origin = useAppStore((s) => s.nearbyOrigin);
  const filters = useAppStore((s) => s.filters);
  const select = useAppStore((s) => s.select);
  const clearNearby = useAppStore((s) => s.clearNearby);
  if (!origin) return null;

  const o: Position = [origin.lng, origin.lat];
  const hits = data.substations
    .filter((s) => filters.voltages[s.voltage] && (!filters.circle || s.circle === filters.circle))
    .map((s) => ({ s, m: haversineMeters(o, [s.lng, s.lat]) }))
    .sort((a, b) => a.m - b.m)
    .slice(0, COUNT);

  return (
    <aside
      className="pointer-events-auto flex min-h-0 max-h-full w-[320px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface/96 shadow-[var(--shadow-panel)] backdrop-blur"
      aria-label="Nearby substations"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
        <span className="text-ink-2">
          <TargetIcon width={18} height={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wide text-ink-2">Nearest substations</div>
          <h2 className="truncate text-[15px] font-semibold leading-snug text-ink">{origin.label}</h2>
        </div>
        <button
          onClick={clearNearby}
          aria-label="Close nearby"
          className="shrink-0 rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink"
        >
          <CloseIcon width={16} height={16} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
        {hits.length === 0 ? (
          <p className="px-2 py-3 text-sm text-ink-2">No substations match the current voltage / circle filter.</p>
        ) : (
          hits.map(({ s, m }) => (
            <button
              key={s.id}
              onClick={() => select(s.id, { fly: true })}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2"
            >
              <VoltageDot voltage={s.voltage} />
              <span className="shrink-0 text-ink-2">
                <SubstationIcon width={14} height={14} />
              </span>
              <span className="min-w-0 flex-1 truncate text-ink">{s.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-ink-2">
                {formatLength(m)} · {compass8(bearingDeg(o, [s.lng, s.lat]))}
              </span>
            </button>
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-line px-4 py-1.5 text-[11px] text-ink-2">
        {origin.lat.toFixed(4)}, {origin.lng.toFixed(4)} · within current voltage{filters.circle ? " + circle" : ""} filter
      </div>
    </aside>
  );
}
