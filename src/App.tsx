// The shell (Atlas 2.0 phase 3): header (lens tabs · search · Live · ⋯) over ONE map that every lens
// shares. A map lens (Explore / Field / Storm) docks its panel beside the map — on a phone the panel,
// the Inspector and the nearby list share one bottom sheet. Plan splits the map with the Network MIS
// (stacked on a phone). The map column keeps its place in the tree, so the map is never re-created.
import { Suspense, useEffect, useRef } from "react";
import { useAppStore } from "./state/store.ts";
import { useIsMobile } from "./lib/useMediaQuery.ts";
import { useUrlSync } from "./url/useUrlSync.ts";
import { MapPane, type MapPaneMode } from "./map/MapPane.tsx";
import { LENS_LAYER_PRESETS } from "./map/layer-presets.ts";
import { LENS_BY_ID } from "./lenses/registry.ts";
import { PanelLoading, PlanWorkspace } from "./lenses/panels.tsx";
import { Header } from "./shell/Header.tsx";
import { About } from "./shell/About.tsx";
import { OnDemandDialogs } from "./shell/Dialogs.tsx";
import { ShortcutsSheet, useGlobalShortcuts } from "./shell/Shortcuts.tsx";
import { LensSidePanel, MapLensOverlays, MapLensPhone } from "./shell/MapLensChrome.tsx";
import { DEFAULT_MAP_PANE, MapResizeHandle, MIN_MAP_PANE, PaneSplitter, PlanHeader, useMapPaneWidth } from "./shell/PlanChrome.tsx";
import { LayerDrawer } from "./layers/LayerDrawer.tsx";
import { LayersButton } from "./shell/MapToolbar.tsx";
import { useInspectorSync } from "./inspector/useInspected.ts";
import { DataTableSheet } from "./components/DataTableSheet.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { ErrorState, LoadingState } from "./components/states.tsx";
import { Toaster } from "./shell/Toaster.tsx";
import { useOverlayStore } from "./overlays/store.ts";

function Loading() {
  return (
    <div className="h-full bg-surface-2">
      <LoadingState label="Loading the AP-TRANSCO network…" block />
    </div>
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="h-full bg-surface-2">
      <ErrorState title="Couldn’t load the map data" message={message} onRetry={() => window.location.reload()} block />
    </div>
  );
}

export function App() {
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const data = useAppStore((s) => s.data);
  const basemap = useAppStore((s) => s.basemap);
  const lens = useAppStore((s) => s.lens);
  const mapLayout = useAppStore((s) => s.mapLayout);
  const init = useAppStore((s) => s.init);
  const isMobile = useIsMobile();
  const rowRef = useRef<HTMLDivElement>(null);
  const pane = useMapPaneWidth(rowRef);

  useUrlSync();
  useInspectorSync();
  useGlobalShortcuts();

  useEffect(() => {
    void init();
    // Re-enable the overlays this viewer had on last time (per-device convenience).
    useOverlayStore.getState().restore();
  }, [init]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", basemap !== "light");
  }, [basemap]);

  if (status === "loading") return <Loading />;
  if (status === "error" || !data) return <ErrorScreen message={error ?? "Unknown error"} />;

  const split = LENS_BY_ID[lens].layout === "split";
  const mapHidden = split && mapLayout === "collapsed";
  const mapMode: MapPaneMode = !split ? "full" : mapHidden ? "hidden" : "embedded";
  const preset = LENS_LAYER_PRESETS[lens];

  // Map column: full in a map lens; beside (desktop) or above (phone) the analysis in Plan.
  const mapColClass = !split
    ? "relative min-h-0 min-w-0 flex-1"
    : mapHidden
      ? "relative h-0 min-h-0 w-0 min-w-0 shrink-0 overflow-hidden"
      : isMobile
        ? "relative h-[42dvh] shrink-0"
        : "relative min-h-0 shrink-0";
  const mapColStyle =
    split && !mapHidden && !isMobile ? { width: pane.width != null ? `${pane.width}px` : DEFAULT_MAP_PANE, minWidth: MIN_MAP_PANE } : undefined;

  return (
    <ErrorBoundary>
      <div className="flex h-full w-full flex-col overflow-hidden">
        <Header data={data} isMobile={isMobile} />

        <div ref={rowRef} className={`flex min-h-0 flex-1 ${split && isMobile ? "flex-col" : ""}`}>
          {!split && !isMobile ? <LensSidePanel key={lens} lens={lens} data={data} /> : null}

          <div className={mapColClass} style={mapColStyle}>
            <div className={mapHidden ? "invisible absolute left-0 top-0 h-full w-[320px]" : "relative h-full w-full"}>
              <MapPane data={data} mode={mapMode} layers={preset} />
            </div>
            {split && !mapHidden && (
              <>
                {/* Plan's own slicer + drill scope the analysis; the map gets the Layers drawer only. */}
                <div className="pointer-events-none absolute left-2.5 top-2.5 z-30">
                  <div className="pointer-events-auto">
                    <LayersButton />
                  </div>
                </div>
                <LayerDrawer phone={isMobile} />
                {!isMobile && <MapResizeHandle />}
              </>
            )}
            {!split && (isMobile ? <MapLensPhone lens={lens} data={data} /> : <MapLensOverlays data={data} />)}
          </div>

          {split && !mapHidden && !isMobile ? <PaneSplitter onDrag={pane.onDrag} onReset={pane.onReset} onNudge={pane.onNudge} value={pane.width} /> : null}

          {split ? (
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface-2">
              <PlanHeader data={data} withSearch={isMobile} />
              <div className="min-h-0 flex-1 overflow-y-auto">
                <Suspense fallback={<PanelLoading />}>
                  <PlanWorkspace />
                </Suspense>
              </div>
            </div>
          ) : null}
        </div>

        {!split && <DataTableSheet data={data} />}
        <OnDemandDialogs data={data} />
        <About data={data} />
        <ShortcutsSheet />
        <Toaster />
      </div>
    </ErrorBoundary>
  );
}
