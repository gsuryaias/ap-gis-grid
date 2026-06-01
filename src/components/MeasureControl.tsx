import { useAppStore } from "../state/store.ts";
import { formatArea, formatLength } from "../lib/geo.ts";
import type { MeasureMode } from "../map/measure.ts";
import { AreaIcon, CloseIcon, RulerIcon, TrashIcon } from "./icons.tsx";

const MODES: { id: MeasureMode; label: string; icon: typeof RulerIcon }[] = [
  { id: "distance", label: "Distance", icon: RulerIcon },
  { id: "area", label: "Area", icon: AreaIcon },
];

function Readout() {
  const mode = useAppStore((s) => s.measureMode);
  const stats = useAppStore((s) => s.measureStats);
  const clearMeasure = useAppStore((s) => s.clearMeasure);

  const hasResult = stats != null && stats.count > 0;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-2 pt-1.5">
      <div className="min-w-0">
        {hasResult ? (
          <>
            <div className="text-base font-semibold leading-tight text-ink tabular-nums">
              {mode === "area" ? formatArea(stats.areaM2) : formatLength(stats.lengthM)}
            </div>
            <div className="text-[11px] text-ink-2">
              {mode === "area"
                ? `Perimeter ${formatLength(stats.lengthM)} · ${stats.count} pt${stats.count === 1 ? "" : "s"}`
                : `${stats.count} point${stats.count === 1 ? "" : "s"}${stats.finished ? " · done" : ""}`}
            </div>
          </>
        ) : (
          <p className="text-[11px] leading-snug text-ink-2">
            Click the map to add points.
            <br />
            Double-click or <kbd className="rounded border border-line px-1 text-[10px]">Enter</kbd> to finish.
          </p>
        )}
      </div>
      <button
        onClick={clearMeasure}
        disabled={!hasResult}
        aria-label="Clear measurement"
        className="shrink-0 rounded-md p-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <TrashIcon width={16} height={16} />
      </button>
    </div>
  );
}

export function MeasureControl() {
  const measureMode = useAppStore((s) => s.measureMode);
  const setMeasureMode = useAppStore((s) => s.setMeasureMode);
  const active = measureMode != null;

  return (
    <div className="pointer-events-auto flex w-[208px] flex-col gap-1.5 rounded-[var(--radius-panel)] border border-line bg-surface/95 p-1.5 shadow-[var(--shadow-panel)] backdrop-blur">
      <div className="flex items-center gap-1">
        {MODES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setMeasureMode(id)}
            aria-pressed={measureMode === id}
            title={`Measure ${label.toLowerCase()}`}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium ${
              measureMode === id
                ? "border-accent bg-surface-3 text-ink"
                : "border-line text-ink-2 hover:bg-surface-2"
            }`}
          >
            <Icon width={14} height={14} />
            {label}
          </button>
        ))}
        {active && (
          <button
            onClick={() => setMeasureMode(null)}
            aria-label="Exit measurement"
            className="shrink-0 rounded-md p-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <CloseIcon width={15} height={15} />
          </button>
        )}
      </div>
      {active && <Readout />}
    </div>
  );
}
