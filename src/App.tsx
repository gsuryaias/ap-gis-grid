import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType, type LazyExoticComponent } from "react";
import { useAppStore } from "./state/store.ts";
import { useIsMobile } from "./lib/useMediaQuery.ts";
import { WORKSPACES, type WorkspaceId } from "./workspaces/registry.ts";
import { useHashSync } from "./url/useHashSync.ts";
import { MapPane, type MapPaneMode } from "./map/MapPane.tsx";
import { WORKSPACE_LAYER_PRESETS } from "./map/layer-presets.ts";
import { BrandHeader } from "./components/BrandHeader.tsx";
import { SearchBar } from "./components/SearchBar.tsx";
import { ControlPanel } from "./components/ControlPanel.tsx";
import { MapLayerPanel } from "./components/MapLayerPanel.tsx";
import { WorkspaceChrome, workspaceMapWidth } from "./components/WorkspaceChrome.tsx";
import { MeasureControl } from "./components/MeasureControl.tsx";
import { NearbyControl } from "./components/NearbyControl.tsx";
import { DetailPanel } from "./components/DetailPanel.tsx";
import { NearbyPanel } from "./components/NearbyPanel.tsx";
import { DataTableSheet } from "./components/DataTableSheet.tsx";
import { DataQualityView } from "./components/DataQualityView.tsx";
import { SummaryView } from "./components/SummaryView.tsx";
import { WeatherView } from "./components/WeatherView.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { TableIcon } from "./components/icons.tsx";

const LAZY_WORKSPACES = Object.fromEntries(
  WORKSPACES.filter((w) => w.load).map((w) => [w.id, lazy(w.load!)]),
) as Partial<Record<WorkspaceId, LazyExoticComponent<ComponentType>>>;

function Loading() {
  return (
    <div className="grid h-full place-items-center bg-surface-2">
      <div className="flex flex-col items-center gap-3 text-ink-2">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" />
        <p className="text-sm">Loading the AP-TRANSCO network…</p>
      </div>
    </div>
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="grid h-full place-items-center bg-surface-2 p-6">
      <div className="max-w-md rounded-[var(--radius-panel)] border border-line bg-surface p-6 text-center shadow-[var(--shadow-panel)]">
        <h1 className="text-lg font-semibold text-ink">Couldn't load the map data</h1>
        <p className="mt-2 text-sm text-ink-2">{message}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function MapResizeHandle() {
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
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`transition-transform ${collapsed ? "rotate-180" : ""}`}
        aria-hidden
      >
        <path d="m15 18-6-6 6-6" />
      </svg>
      <span className="hidden text-[8px] font-medium uppercase tracking-wide group-hover:block">Map</span>
    </button>
  );
}

/** Draggable divider between the map pane and the analysis column (split workspaces only). */
function PaneSplitter({ onDrag, onReset, onNudge }: { onDrag: (clientX: number) => void; onReset: () => void; onNudge: (dx: number) => void }) {
  const dragging = useRef(false);

  const begin = (e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  const move = (e: React.PointerEvent) => {
    if (dragging.current) onDrag(e.clientX);
  };
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
      tabIndex={0}
      onPointerDown={begin}
      onPointerMove={move}
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

const MIN_MAP_PANE = 320;
const MIN_ANALYSIS_PANE = 380;
const MAP_PANE_STORAGE_KEY = "dss-map-pane-w";

export function App() {
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const data = useAppStore((s) => s.data);
  const basemap = useAppStore((s) => s.basemap);
  const tableOpen = useAppStore((s) => s.tableOpen);
  const toggleTable = useAppStore((s) => s.toggleTable);
  const nearbyOrigin = useAppStore((s) => s.nearbyOrigin);
  const selectedId = useAppStore((s) => s.selectedId);
  const isMobile = useIsMobile();
  const workspace = useAppStore((s) => s.workspace);
  const mapLayout = useAppStore((s) => s.mapLayout);
  const workspaceContext = useAppStore((s) => s.workspaceContext);
  const init = useAppStore((s) => s.init);

  // Draggable map / analysis split (split workspaces only). Width persists across reloads;
  // null = fall back to the responsive CSS default. The MapPane ResizeObserver redraws the canvas.
  const rowRef = useRef<HTMLDivElement>(null);
  const [mapPaneWidth, setMapPaneWidth] = useState<number | null>(null);

  useEffect(() => {
    const saved = Number(localStorage.getItem(MAP_PANE_STORAGE_KEY));
    if (Number.isFinite(saved) && saved >= MIN_MAP_PANE) setMapPaneWidth(saved);
  }, []);

  const clampPaneWidth = useCallback((w: number) => {
    const max = Math.max(MIN_MAP_PANE, window.innerWidth - MIN_ANALYSIS_PANE);
    return Math.round(Math.min(Math.max(w, MIN_MAP_PANE), max));
  }, []);

  const resizeMapPane = useCallback(
    (clientX: number) => {
      const left = rowRef.current?.getBoundingClientRect().left ?? 0;
      const next = clampPaneWidth(clientX - left);
      setMapPaneWidth(next);
      localStorage.setItem(MAP_PANE_STORAGE_KEY, String(next));
    },
    [clampPaneWidth],
  );

  const nudgeMapPane = useCallback(
    (dx: number) => {
      setMapPaneWidth((w) => {
        const base = w ?? Math.min(520, Math.round(window.innerWidth * 0.44));
        const next = clampPaneWidth(base + dx);
        localStorage.setItem(MAP_PANE_STORAGE_KEY, String(next));
        return next;
      });
    },
    [clampPaneWidth],
  );

  const resetMapPane = useCallback(() => {
    setMapPaneWidth(null);
    localStorage.removeItem(MAP_PANE_STORAGE_KEY);
  }, []);

  // Keep a px width within bounds when the browser window shrinks.
  useEffect(() => {
    const onResize = () => setMapPaneWidth((w) => (w == null ? w : clampPaneWidth(w)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampPaneWidth]);

  useHashSync();

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", basemap !== "light");
  }, [basemap]);

  // Pre-fetch overlays the active workspace expects; visibility stays user-controlled via MapLayerPanel.
  useEffect(() => {
    if (workspace === "atlas") return;
    const preset = WORKSPACE_LAYER_PRESETS[workspace];
    const st = useAppStore.getState();
    if (preset.weather && !st.filters.showWeather) st.toggleWeather(true);
    if (preset.powergrid && !st.filters.showPowerGrid) st.togglePowerGrid(true);
    if (preset.generation && !st.filters.showGeneration) st.toggleGeneration(true);
  }, [workspace]);

  if (status === "loading") return <Loading />;
  if (status === "error" || !data) return <ErrorScreen message={error ?? "Unknown error"} />;

  const isAtlas = workspace === "atlas";
  const mapCollapsed = !isAtlas && mapLayout === "collapsed";
  const LazyWorkspace = !isAtlas ? LAZY_WORKSPACES[workspace] : undefined;

  const mapMode: MapPaneMode = isAtlas ? "full" : mapCollapsed ? "hidden" : "embedded";
  const layerPreset = WORKSPACE_LAYER_PRESETS[workspace];
  const mapWidth = workspaceMapWidth(workspace);

  return (
    <ErrorBoundary>
      <div className="flex h-full w-full flex-col overflow-hidden">
        <header className="shrink-0 border-b border-line bg-surface/95 px-3 py-2 backdrop-blur">
          <BrandHeader data={data} variant="bar" />
        </header>

        <div ref={rowRef} className="flex min-h-0 flex-1">
          {/* Map column — full in Atlas; resizable split in analysis workspaces */}
          <div
            className={
              isAtlas
                ? "relative min-h-0 flex-1"
                : mapCollapsed
                  ? "relative min-h-0 w-0 min-w-0 shrink-0 overflow-hidden"
                  : "relative min-h-0 shrink-0"
            }
            style={
              !isAtlas && !mapCollapsed
                ? { width: mapPaneWidth != null ? `${mapPaneWidth}px` : mapWidth, minWidth: MIN_MAP_PANE }
                : undefined
            }
          >
            <div
              className={
                mapCollapsed ? "invisible absolute left-0 top-0 h-full w-[320px]" : "relative h-full w-full"
              }
            >
              <MapPane
                data={data}
                mode={mapMode}
                layers={layerPreset}
                interactive
                highlightIds={workspace === "risk" ? workspaceContext.highlightIds : undefined}
              />
            </div>

            {!isAtlas && !mapCollapsed && (
              <>
                <MapLayerPanel data={data} preset={layerPreset} variant="overlay" workspace={workspace} />
                <MapResizeHandle />
              </>
            )}

            {isAtlas && (
              <>
                {isMobile ? (
                  <>
                    {/* Mobile: one full-width top stack so panels never overlap each other or block the map.
                        Layers default collapsed; detail/nearby move to a bottom sheet. */}
                    <div className="pointer-events-none absolute inset-x-2 top-2 z-20 flex flex-col gap-2">
                      <div className="pointer-events-auto">
                        <SearchBar data={data} />
                      </div>
                      <div className="pointer-events-auto flex flex-col gap-2">
                        <MeasureControl />
                        <NearbyControl />
                      </div>
                      <div className="pointer-events-auto flex max-h-[52dvh] min-h-0 flex-col">
                        <ControlPanel data={data} defaultOpen={false} />
                      </div>
                    </div>

                    {/* Bottom sheet — DetailPanel renders null when nothing is selected, so this is empty/idle otherwise. */}
                    <div className="pointer-events-none absolute inset-x-2 bottom-2 z-30 flex max-h-[55dvh] flex-col">
                      {nearbyOrigin ? <NearbyPanel data={data} /> : <DetailPanel data={data} />}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="pointer-events-none absolute left-3 top-3 z-20 flex max-h-[calc(100dvh-5.5rem)] w-[268px] max-w-[calc(100vw-1.5rem)] flex-col gap-2.5">
                      <div className="pointer-events-auto">
                        <SearchBar data={data} />
                      </div>
                      <div className="pointer-events-none flex min-h-0 flex-1 flex-col">
                        <ControlPanel data={data} />
                      </div>
                    </div>

                    <div className="pointer-events-none absolute left-1/2 top-3 z-30 flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 flex-wrap items-start justify-center gap-2">
                      <MeasureControl />
                      <NearbyControl />
                    </div>

                    <div className="pointer-events-none absolute right-3 top-3 z-20 flex max-h-[calc(100dvh-5.5rem)] max-w-[calc(100vw-1.5rem)] flex-col">
                      {nearbyOrigin ? <NearbyPanel data={data} /> : <DetailPanel data={data} />}
                    </div>
                  </>
                )}

                {!tableOpen && !(isMobile && (nearbyOrigin || selectedId)) && (
                  <button
                    onClick={() => toggleTable(true)}
                    className="pointer-events-auto absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface/95 px-4 py-2 text-sm font-medium text-ink shadow-[var(--shadow-panel)] backdrop-blur hover:bg-surface-2"
                  >
                    <TableIcon width={16} height={16} /> Browse data table
                  </button>
                )}

                <div className="pointer-events-none absolute bottom-1 left-2 z-10 max-w-[58%] text-[10px] leading-tight text-ink-2/70 sm:max-w-none">
                  Network data: AP-TRANSCO · Places: GeoNames (CC BY 4.0) · Weather: Open-Meteo · Radar: RainViewer · Cyclones: GDACS
                </div>
              </>
            )}

            {!isAtlas && !mapCollapsed && (
              <div className="pointer-events-none absolute bottom-3 right-3 z-10 flex max-h-[min(280px,calc(100%-6rem))] max-w-[min(300px,calc(100%-1.5rem))] flex-col">
                <DetailPanel data={data} />
              </div>
            )}
          </div>

          {!isAtlas && !mapCollapsed && (
            <PaneSplitter onDrag={resizeMapPane} onReset={resetMapPane} onNudge={nudgeMapPane} />
          )}

          {!isAtlas && (
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface-2">
              <WorkspaceChrome />
              <div className="min-h-0 flex-1 overflow-y-auto">
                {LazyWorkspace && (
                  <Suspense fallback={<Loading />}>
                    <LazyWorkspace />
                  </Suspense>
                )}
              </div>
            </div>
          )}
        </div>

        {isAtlas && (
          <>
            <DataTableSheet data={data} />
            <SummaryView data={data} />
            <DataQualityView data={data} />
            <WeatherView data={data} />
          </>
        )}
      </div>
    </ErrorBoundary>
  );
}
