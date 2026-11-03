import type { LineProps } from "../data/types.ts";
import { useOverlayStore } from "../overlays/store.ts";
import { useAppStore } from "../state/store.ts";

/**
 * Tower summary for a line (from the live tower layers, matched by line name) + a button that
 * switches on that voltage's tower layer and zooms to the line. Renders nothing when the line has
 * no matched towers.
 */
export function LineTowers({ line, compact }: { line: LineProps; compact?: boolean }) {
  const id = `towers-${line.voltage}kv`;
  const on = useOverlayStore((s) => !!s.enabled[id]);
  const toggle = useOverlayStore((s) => s.toggle);
  const t = line.towers;
  if (!t) return null;
  const other = t.n - t.cp - t.sp;
  const show = () => {
    if (!on) toggle(id, true);
    useAppStore.getState().select(line.id, { fly: true });
  };
  return (
    <div className={compact ? "" : "mt-2 rounded-lg border border-line px-2.5 py-2"}>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-ink-2">Towers</span>
        <span className="text-right font-medium text-ink">
          {t.n.toLocaleString("en-IN")}
          <span className="ml-1 font-normal text-ink-2">
            · {t.cp} CP / {t.sp} SP{other > 0 ? ` / ${other} other` : ""}
          </span>
        </span>
      </div>
      {t.types.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1" title="Tower types as recorded in the GIS (design type + body extension)">
          {t.types.slice(0, 6).map(([type, n]) => (
            <span key={type} className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink">
              {type} <span className="text-ink-2">×{n}</span>
            </span>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={show}
        className="mt-1.5 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink hover:bg-surface-2"
      >
        {on ? "Zoom to towers" : "Show towers on map"}
      </button>
    </div>
  );
}
