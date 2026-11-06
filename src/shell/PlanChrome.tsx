// Chrome of the Plan lens (split layout): the analysis column's title strip with the map toggle,
// the map-pane collapse handle and the drag-resizable splitter. On a phone the map stacks above the
// analysis instead of beside it.
import { useCallback, useEffect, useRef, useState } from "react";
import { MapIcon } from "../components/icons.tsx";
import { LENS_ICON } from "../lenses/panels.tsx";
import { LENS_BY_ID } from "../lenses/registry.ts";
import { StartHere } from "../lenses/StartHere.tsx";
import type { GridData } from "../data/types.ts";
import { Omnibox } from "../search/Omnibox.tsx";
import { useAppStore } from "../state/store.ts";

export const MIN_MAP_PANE = 320;
const MIN_ANALYSIS_PANE = 380;
const MAP_PANE_STORAGE_KEY = "dss-map-pane-w";
export const DEFAULT_MAP_PANE = "min(42%, 520px)";

/** Title strip of the Plan column: what this lens is + Show / Hide map (+ the search box on a phone). */
export function PlanHeader({ data, withSearch = false }: { data: GridData; withSearch?: boolean }) {
  const mapLayout = useAppStore((s) => s.mapLayout);
  const setMapLayout = useAppStore((s) => s.setMapLayout);
  const def = LENS_BY_ID.plan;
  const Icon = LENS_ICON.plan;
  const mapOpen = mapLayout === "open";
  return (
    <div className="shrink-0 border-b border-line bg-surface/90 px-4 py-2 backdrop-blur">
      <div className="flex items-center gap-3">
        <Icon width={16} height={16} className="shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-ink">{def.label} · Network MIS</h2>
          <p className="hidden truncate text-[11px] text-ink-2 sm:block">{def.description.replace(/^Network MIS — /, "")}</p>
        </div>
        <button
          type="button"
          onClick={() => setMapLayout(mapOpen ? "collapsed" : "open")}
          aria-pressed={mapOpen}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
            mapOpen ? "border-accent/40 bg-accent/10 text-accent" : "border-line text-ink-2 hover:bg-surface-2 hover:text-ink"
          }`}
        >
          <MapIcon width={13} height={13} />
          {mapOpen ? "Hide map" : "Show map"}
        </button>
      </div>
      {withSearch && (
        <div className="mt-2">
          <Omnibox data={data} size="sm" />
        </div>
      )}
      <div className="mt-2 empty:hidden">
        <StartHere lens="plan" />
      </div>
    </div>
  );
}

export function MapResizeHandle() {
  const mapLayout = useAppStore((s) => s.mapLayout);
  const setMapLayout = useAppStore((s) => s.setMapLayout);
  const collapsed = mapLayout === "collapsed";
  return (
    <button
      type="button"
      onClick={() => setMapLayout(collapsed ? "open" : "collapsed")}
      title={collapsed ? "Expand map pane" : "Collapse map pane"}
      aria-expanded={!collapsed}
      aria-label={collapsed ? "Expand map pane" : "Collapse map pane"}
      className="group absolute -right-3 top-1/2 z-30 flex h-14 w-6 -translate-y-1/2 flex-col items-center justify-center gap-0.5 rounded-r-lg border border-line border-l-0 bg-surface/95 text-ink-2 shadow-[var(--shadow-panel)] backdrop-blur hover:bg-surface-2 hover:text-ink"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${collapsed ? "rotate-180" : ""}`} aria-hidden>
        <path d="m15 18-6-6 6-6" />
      </svg>
      <span className="hidden text-[8px] font-medium uppercase tracking-wide group-hover:block">Map</span>
    </button>
  );
}

/** Draggable divider between the map pane and the analysis column. */
export function PaneSplitter({ onDrag, onReset, onNudge, value }: { onDrag: (clientX: number) => void; onReset: () => void; onNudge: (dx: number) => void; value: number | null }) {
  const dragging = useRef(false);
  const end = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize map pane"
      aria-valuemin={MIN_MAP_PANE}
      aria-valuemax={typeof window === "undefined" ? 2000 : Math.max(MIN_MAP_PANE, window.innerWidth - MIN_ANALYSIS_PANE)}
      aria-valuenow={value ?? Math.min(520, Math.round((typeof window === "undefined" ? 1200 : window.innerWidth) * 0.42))}
      tabIndex={0}
      onPointerDown={(e) => {
        dragging.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(e) => dragging.current && onDrag(e.clientX)}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onNudge(-24);
        else if (e.key === "ArrowRight") onNudge(24);
        else if (e.key === "Home") onReset();
      }}
      title="Drag to resize · double-click to reset"
      className="group relative z-30 flex w-1.5 shrink-0 cursor-col-resize touch-none items-center justify-center bg-line/40 hover:bg-accent/40 focus:bg-accent/40 focus:outline-none"
    >
      <span className="h-9 w-0.5 rounded-full bg-line group-hover:bg-accent group-focus:bg-accent" />
    </div>
  );
}

/** The draggable map / analysis split. Width persists across reloads; null = the CSS default. */
export function useMapPaneWidth(rowRef: React.RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(MAP_PANE_STORAGE_KEY));
      if (Number.isFinite(saved) && saved >= MIN_MAP_PANE) setWidth(saved);
    } catch {
      /* fine */
    }
  }, []);

  const clamp = useCallback((w: number) => {
    const max = Math.max(MIN_MAP_PANE, window.innerWidth - MIN_ANALYSIS_PANE);
    return Math.round(Math.min(Math.max(w, MIN_MAP_PANE), max));
  }, []);
  const save = (w: number | null) => {
    try {
      if (w == null) localStorage.removeItem(MAP_PANE_STORAGE_KEY);
      else localStorage.setItem(MAP_PANE_STORAGE_KEY, String(w));
    } catch {
      /* fine */
    }
  };

  const onDrag = useCallback(
    (clientX: number) => {
      const next = clamp(clientX - (rowRef.current?.getBoundingClientRect().left ?? 0));
      setWidth(next);
      save(next);
    },
    [clamp, rowRef],
  );
  const onNudge = useCallback(
    (dx: number) =>
      setWidth((w) => {
        const next = clamp((w ?? Math.min(520, Math.round(window.innerWidth * 0.44))) + dx);
        save(next);
        return next;
      }),
    [clamp],
  );
  const onReset = useCallback(() => {
    setWidth(null);
    save(null);
  }, []);

  // Keep a px width within bounds when the window shrinks.
  useEffect(() => {
    const onResize = () => setWidth((w) => (w == null ? w : clamp(w)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  return { width, onDrag, onNudge, onReset };
}
