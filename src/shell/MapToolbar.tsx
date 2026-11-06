// The map toolbar (top-left of the map): Layers · voltage / circle / coast chips · Measure · Nearby.
// One row on desktop (wraps when narrow); a horizontally scrolling strip under the search on a phone.
// Measure / Nearby open their control card under the row; closing the card ends the tool.
import { useState } from "react";
import { LayersIcon, PinIcon, RulerIcon } from "../components/icons.tsx";
import { MeasureControl } from "../components/MeasureControl.tsx";
import { NearbyControl } from "../components/NearbyControl.tsx";
import type { GridData } from "../data/types.ts";
import { FilterChips } from "../layers/FilterChips.tsx";
import { useCatalogue } from "../layers/LayerDrawer.tsx";
import { useAppStore } from "../state/store.ts";

const btn = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium shadow-sm transition-colors";
const idle = "border-line bg-surface/95 text-ink hover:bg-surface-2";
const pressed = "border-accent bg-accent text-on-accent";

export function LayersButton() {
  const open = useAppStore((s) => s.layersOpen);
  const toggle = useAppStore((s) => s.toggleLayersDrawer);
  const { on } = useCatalogue();
  return (
    <button type="button" onClick={() => toggle()} aria-expanded={open} className={`${btn} ${open ? pressed : idle}`}>
      <LayersIcon width={14} height={14} aria-hidden />
      Layers
      <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${open ? "bg-surface text-ink" : "bg-surface-3 text-ink-2"}`}>{on.size}</span>
      <span className="sr-only"> on</span>
    </button>
  );
}

export function MapToolbar({ data, phone = false, filters = true, tools = true }: { data: GridData; phone?: boolean; filters?: boolean; tools?: boolean }) {
  const [tool, setTool] = useState<"measure" | "nearby" | null>(null);
  const layersOpen = useAppStore((s) => s.layersOpen);
  const setMeasureMode = useAppStore((s) => s.setMeasureMode);
  const clearNearby = useAppStore((s) => s.clearNearby);
  const toggleTool = (t: "measure" | "nearby") => {
    if (tool === t) {
      if (t === "measure") setMeasureMode(null);
      else clearNearby();
      setTool(null);
    } else {
      // The two tools both capture map clicks — opening one ends the other.
      if (tool === "measure") setMeasureMode(null);
      if (tool === "nearby") useAppStore.getState().toggleNearbyMode(false);
      setTool(t);
    }
  };
  return (
    <div className="pointer-events-none flex flex-col items-start gap-2">
      <div
        role="toolbar"
        aria-label="Map tools"
        className={`pointer-events-auto flex items-center gap-1.5 ${phone ? "w-full overflow-x-auto pb-0.5 [scrollbar-width:none]" : "flex-wrap"}`}
      >
        <LayersButton />
        {filters && <FilterChips data={data} />}
        {tools && (
          <>
            <button type="button" onClick={() => toggleTool("measure")} aria-pressed={tool === "measure"} className={`${btn} ${tool === "measure" ? pressed : idle}`}>
              <RulerIcon width={14} height={14} /> Measure
            </button>
            <button type="button" onClick={() => toggleTool("nearby")} aria-pressed={tool === "nearby"} className={`${btn} ${tool === "nearby" ? pressed : idle}`}>
              <PinIcon width={14} height={14} /> Nearby
            </button>
          </>
        )}
      </div>
      {tool && !layersOpen && <div className="pointer-events-auto w-full sm:w-auto">{tool === "measure" ? <MeasureControl /> : <NearbyControl />}</div>}
    </div>
  );
}
