import { lazy, Suspense, useEffect, type ComponentType, type LazyExoticComponent } from "react";
import { useAppStore } from "./state/store.ts";
import { WORKSPACES, type WorkspaceId } from "./workspaces/registry.ts";
import { useHashSync } from "./url/useHashSync.ts";
import { MapView } from "./map/MapView.tsx";
import { BrandHeader } from "./components/BrandHeader.tsx";
import { SearchBar } from "./components/SearchBar.tsx";
import { ControlPanel } from "./components/ControlPanel.tsx";
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

// One stable React.lazy component per non-atlas workspace (module-level so identity survives
// re-renders); each dynamic import becomes its own Vite chunk, loaded on first entry only.
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

export function App() {
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const data = useAppStore((s) => s.data);
  const basemap = useAppStore((s) => s.basemap);
  const tableOpen = useAppStore((s) => s.tableOpen);
  const toggleTable = useAppStore((s) => s.toggleTable);
  const nearbyOrigin = useAppStore((s) => s.nearbyOrigin);
  const workspace = useAppStore((s) => s.workspace);
  const init = useAppStore((s) => s.init);

  useHashSync();

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    // Dark UI chrome for both the dark basemap and satellite imagery.
    document.documentElement.classList.toggle("dark", basemap !== "light");
  }, [basemap]);

  if (status === "loading") return <Loading />;
  if (status === "error" || !data) return <ErrorScreen message={error ?? "Unknown error"} />;

  // Non-atlas workspaces: render the lazy chunk full-screen (no MapView) with the BrandHeader
  // kept on top so the user can always switch back. The Atlas path below is untouched.
  const LazyWorkspace = workspace !== "atlas" ? LAZY_WORKSPACES[workspace] : undefined;
  if (LazyWorkspace) {
    return (
      <ErrorBoundary>
        <div className="relative h-full w-full overflow-hidden">
          <Suspense fallback={<Loading />}>
            <LazyWorkspace />
          </Suspense>
          <div className="pointer-events-none absolute left-3 top-3 z-20 w-[268px] max-w-[calc(100vw-1.5rem)]">
            <div className="pointer-events-auto">
              <BrandHeader data={data} />
            </div>
          </div>
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <div className="relative h-full w-full overflow-hidden">
        <MapView data={data} />

        {/* Top-left control stack — bounded to the viewport so the Layers panel scrolls
            internally on short screens instead of overflowing. The panel wrapper flexes into
            the remaining height and is itself pointer-events-none, so its empty area below the
            panel stays click-through to the map (only the <section> is interactive). */}
        <div className="pointer-events-none absolute left-3 top-3 z-20 flex max-h-[calc(100dvh-1.5rem)] w-[268px] max-w-[calc(100vw-1.5rem)] flex-col gap-2.5">
          <div className="pointer-events-auto">
            <BrandHeader data={data} />
          </div>
          <div className="pointer-events-auto">
            <SearchBar data={data} />
          </div>
          <div className="pointer-events-none flex min-h-0 flex-1 flex-col">
            <ControlPanel data={data} />
          </div>
        </div>

        {/* Map tools (top-center). Wraps + bounded so the pills never spill off a narrow screen. */}
        <div className="pointer-events-none absolute left-1/2 top-3 z-30 flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 flex-wrap items-start justify-center gap-2">
          <MeasureControl />
          <NearbyControl />
        </div>

        {/* Right panel — bounded to the viewport so long detail lists scroll internally. */}
        <div className="pointer-events-none absolute right-3 top-3 z-20 flex max-h-[calc(100dvh-1.5rem)] max-w-[calc(100vw-1.5rem)] flex-col">
          {nearbyOrigin ? <NearbyPanel data={data} /> : <DetailPanel data={data} />}
        </div>

        {/* Browse-table affordance */}
        {!tableOpen && (
          <button
            onClick={() => toggleTable(true)}
            className="pointer-events-auto absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface/95 px-4 py-2 text-sm font-medium text-ink shadow-[var(--shadow-panel)] backdrop-blur hover:bg-surface-2"
          >
            <TableIcon width={16} height={16} /> Browse data table
          </button>
        )}

        <DataTableSheet data={data} />
        <SummaryView data={data} />
        <DataQualityView data={data} />
        <WeatherView data={data} />

        {/* Data-source credit (basemap credit is the MapLibre attribution control) */}
        <div className="pointer-events-none absolute bottom-1 left-2 z-10 text-[10px] text-ink-2/70">
          Network data: AP-TRANSCO · Places: GeoNames (CC BY 4.0) · Weather: Open-Meteo · Radar: RainViewer · Cyclones: GDACS
        </div>
      </div>
    </ErrorBoundary>
  );
}
