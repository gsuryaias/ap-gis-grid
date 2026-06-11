import { lazy, Suspense, useEffect, type ComponentType, type LazyExoticComponent } from "react";
import { useAppStore } from "./state/store.ts";
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

export function App() {
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const data = useAppStore((s) => s.data);
  const basemap = useAppStore((s) => s.basemap);
  const tableOpen = useAppStore((s) => s.tableOpen);
  const toggleTable = useAppStore((s) => s.toggleTable);
  const nearbyOrigin = useAppStore((s) => s.nearbyOrigin);
  const workspace = useAppStore((s) => s.workspace);
  const mapLayout = useAppStore((s) => s.mapLayout);
  const workspaceContext = useAppStore((s) => s.workspaceContext);
  const init = useAppStore((s) => s.init);

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

        <div className="flex min-h-0 flex-1">
          {/* Map column — full in Atlas; workspace-tuned split in analysis workspaces */}
          <div
            className={
              isAtlas
                ? "relative min-h-0 flex-1"
                : mapCollapsed
                  ? "relative min-h-0 w-0 min-w-0 shrink-0 overflow-hidden"
                  : "relative min-h-0 shrink-0 border-r border-line"
            }
            style={!isAtlas && !mapCollapsed && mapWidth ? { width: mapWidth, minWidth: 280 } : undefined}
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

                {!tableOpen && (
                  <button
                    onClick={() => toggleTable(true)}
                    className="pointer-events-auto absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface/95 px-4 py-2 text-sm font-medium text-ink shadow-[var(--shadow-panel)] backdrop-blur hover:bg-surface-2"
                  >
                    <TableIcon width={16} height={16} /> Browse data table
                  </button>
                )}

                <div className="pointer-events-none absolute bottom-1 left-2 z-10 text-[10px] text-ink-2/70">
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
