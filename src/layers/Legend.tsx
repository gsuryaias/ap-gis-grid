// The map legend: only layers that are on AND drawn at the current zoom (ArcGIS
// `respectLayerVisibility`). Keys only — switches live in the Layers drawer. Collapsible.
import { useState } from "react";
import { ChevronDown } from "../components/icons.tsx";
import { useAppStore } from "../state/store.ts";
import { inZoom } from "./catalogue.ts";
import { EntryDetail, hasDetail } from "./details.tsx";
import { useCatalogue } from "./LayerDrawer.tsx";
import { Key } from "./ui.tsx";

export function MapLegend() {
  const { entries, on } = useCatalogue();
  const zoom = useAppStore((s) => s.camera?.zoom ?? null);
  const [open, setOpen] = useState(true);
  const shown = entries.filter((e) => on.has(e.id) && inZoom(e, zoom));
  // The core grid is one legend block (voltage colours), not two.
  const items = shown.filter((e) => !(e.id === "ss" && on.has("ln")));
  if (!items.length) return null;
  return (
    <section
      aria-label="Legend"
      className="pointer-events-auto absolute bottom-8 left-3 z-10 flex max-h-[45%] w-[220px] flex-col overflow-hidden rounded-xl border border-line bg-surface/92 shadow-[var(--shadow-panel)] backdrop-blur"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex shrink-0 items-center justify-between px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-2 hover:text-ink"
      >
        Legend
        <ChevronDown width={13} height={13} className={open ? "" : "rotate-180"} />
      </button>
      {open && (
        <div className="min-h-0 overflow-y-auto overscroll-contain px-3 pb-2">
          {items.map((e) =>
            hasDetail(e.id, true) ? (
              <div key={e.id} className="pt-1">
                <div className="text-[11px] font-medium text-ink-2">{e.id === "ln" ? "Transmission grid" : e.label}</div>
                <EntryDetail entry={e} compact />
              </div>
            ) : (
              <Key key={e.id} swatch={e.swatch} label={e.label} />
            ),
          )}
        </div>
      )}
    </section>
  );
}
