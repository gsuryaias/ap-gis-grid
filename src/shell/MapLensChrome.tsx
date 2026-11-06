// Chrome of the map lenses (Explore / Field / Storm): the docked lens panel on desktop, and what
// floats over the map — the toolbar (Layers · filter chips · Measure · Nearby) + Layers drawer, the
// legend, the Inspector / nearby list, the data-table pill — or, on a phone, the search + toolbar on
// top and ONE bottom sheet holding the Inspector, the nearby list or the lens panel.
import { useEffect, useState } from "react";
import { NearbyPanel } from "../components/NearbyPanel.tsx";
import { LayerDrawer } from "../layers/LayerDrawer.tsx";
import { MapLegend } from "../layers/Legend.tsx";
import { MapToolbar } from "./MapToolbar.tsx";
import { Omnibox } from "../search/Omnibox.tsx";
import { ChevronDown, PanelLeftIcon, TableIcon } from "../components/icons.tsx";
import type { GridData } from "../data/types.ts";
import { Inspector } from "../inspector/Inspector.tsx";
import { LENS_ICON, LensPanel } from "../lenses/panels.tsx";
import { LENS_BY_ID, type LensId } from "../lenses/registry.ts";
import { useAppStore } from "../state/store.ts";
import { BottomSheet, type Snap } from "./BottomSheet.tsx";

const PANEL_KEY = "apgg-lens-panel";

function readPanelOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) !== "0";
  } catch {
    return true;
  }
}

function LensTitle({ lens, children }: { lens: LensId; children?: React.ReactNode }) {
  const def = LENS_BY_ID[lens];
  const Icon = LENS_ICON[lens];
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Icon width={16} height={16} className="shrink-0 text-accent" aria-hidden />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold leading-tight text-ink">{def.label}</h2>
        <p className="truncate text-[11px] text-ink-2">{def.audience}</p>
      </div>
      {children}
    </div>
  );
}

/** Desktop: the lens panel docked left of the map (collapsible; the choice is remembered). */
export function LensSidePanel({ lens, data }: { lens: LensId; data: GridData }) {
  const [open, setOpen] = useState(readPanelOpen);
  const set = (v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(PANEL_KEY, v ? "1" : "0");
    } catch {
      /* fine */
    }
  };
  if (!open)
    return (
      <div className="flex shrink-0 flex-col items-center gap-2 border-r border-line bg-surface px-1 py-2">
        <button
          type="button"
          onClick={() => set(true)}
          aria-label={`Show the ${LENS_BY_ID[lens].label} panel`}
          title="Show panel"
          className="rounded-md p-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink"
        >
          <PanelLeftIcon width={16} height={16} />
        </button>
      </div>
    );
  return (
    <aside
      aria-label={`${LENS_BY_ID[lens].label} panel`}
      style={{ width: LENS_BY_ID[lens].panelWidth }}
      className="flex shrink-0 flex-col border-r border-line bg-surface"
    >
      <div className="shrink-0 border-b border-line">
        <LensTitle lens={lens}>
          <button
            type="button"
            onClick={() => set(false)}
            aria-label="Hide panel"
            title="Hide panel"
            className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <PanelLeftIcon width={16} height={16} />
          </button>
        </LensTitle>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4 pt-3">
        <LensPanel lens={lens} data={data} />
      </div>
    </aside>
  );
}

/** Desktop: what floats over the map in a map lens. */
export function MapLensOverlays({ data }: { data: GridData }) {
  const tableOpen = useAppStore((s) => s.tableOpen);
  const toggleTable = useAppStore((s) => s.toggleTable);
  const nearbyOrigin = useAppStore((s) => s.nearbyOrigin);
  // Keep the toolbar clear of the Inspector / nearby card while one is open on the right.
  const rightCard = useAppStore((s) => !!(s.selectedId || s.here?.length || s.nearbyOrigin));
  return (
    <>
      <div className={`pointer-events-none absolute left-3 top-3 z-30 ${rightCard ? "right-[364px]" : "right-3"}`}>
        <MapToolbar data={data} />
      </div>
      <LayerDrawer />
      <MapLegend />
      <div className="pointer-events-none absolute right-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] max-w-[calc(100%-1.5rem)] flex-col">
        {nearbyOrigin ? <NearbyPanel data={data} /> : <Inspector />}
      </div>
      {!tableOpen && (
        <button
          onClick={() => toggleTable(true)}
          className="pointer-events-auto absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface/95 px-4 py-2 text-sm font-medium text-ink shadow-[var(--shadow-panel)] backdrop-blur hover:bg-surface-2"
        >
          <TableIcon width={16} height={16} /> Browse data table
        </button>
      )}
      <div className="pointer-events-none absolute bottom-1 left-[120px] z-10 text-[10px] leading-tight text-ink-2/70">
        Network data: AP-TRANSCO · Places: GeoNames (CC BY 4.0) · Weather: Open-Meteo · Radar: RainViewer · Cyclones: GDACS
      </div>
    </>
  );
}

/** Phone: search + map tools on top, one bottom sheet below. */
export function MapLensPhone({ lens, data }: { lens: LensId; data: GridData }) {
  const selectedId = useAppStore((s) => s.selectedId);
  const hereOpen = useAppStore((s) => !!s.here?.length);
  const nearbyOrigin = useAppStore((s) => s.nearbyOrigin);
  const content: "inspect" | "nearby" | "lens" = selectedId || hereOpen ? "inspect" : nearbyOrigin ? "nearby" : "lens";
  const [snap, setSnap] = useState<Snap>("peek");
  // A tap / search pick opens the sheet half-way; closing it drops back to the lens title row.
  useEffect(() => setSnap((s) => (content === "lens" ? "peek" : s === "peek" ? "half" : s)), [content, selectedId]);

  return (
    <>
      <div className="pointer-events-none absolute inset-x-2 top-2 z-20 flex flex-col gap-2">
        <div className="pointer-events-auto">
          <Omnibox data={data} />
        </div>
        <MapToolbar data={data} phone />
      </div>
      <LayerDrawer phone />
      {content === "lens" ? (
        <BottomSheet
          snap={snap}
          onSnap={setSnap}
          label={`${LENS_BY_ID[lens].label} panel`}
          header={
            <LensTitle lens={lens}>
              <button
                type="button"
                onClick={() => setSnap(snap === "peek" ? "half" : "peek")}
                aria-label={snap === "peek" ? "Open panel" : "Collapse panel"}
                className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink"
              >
                <ChevronDown width={16} height={16} className={snap === "peek" ? "rotate-180" : ""} />
              </button>
            </LensTitle>
          }
        >
          <div className="px-3 pb-6 pt-1">
            <LensPanel lens={lens} data={data} />
          </div>
        </BottomSheet>
      ) : (
        <BottomSheet snap={snap} onSnap={setSnap} label={content === "nearby" ? "Nearby substations" : "Details"} body="fill">
          {content === "nearby" ? <NearbyPanel data={data} sheet /> : <Inspector variant="sheet" />}
        </BottomSheet>
      )}
    </>
  );
}
