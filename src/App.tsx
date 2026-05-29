import { useEffect } from "react";
import { useAppStore } from "./state/store.ts";
import { useHashSync } from "./url/useHashSync.ts";
import { MapView } from "./map/MapView.tsx";
import { BrandHeader } from "./components/BrandHeader.tsx";
import { SearchBar } from "./components/SearchBar.tsx";
import { ControlPanel } from "./components/ControlPanel.tsx";
import { DetailPanel } from "./components/DetailPanel.tsx";
import { DataTableSheet } from "./components/DataTableSheet.tsx";
import { DataQualityView } from "./components/DataQualityView.tsx";
import { SummaryView } from "./components/SummaryView.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { TableIcon } from "./components/icons.tsx";

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
  const init = useAppStore((s) => s.init);

  useHashSync();

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", basemap === "dark");
  }, [basemap]);

  if (status === "loading") return <Loading />;
  if (status === "error" || !data) return <ErrorScreen message={error ?? "Unknown error"} />;

  return (
    <ErrorBoundary>
      <div className="relative h-full w-full overflow-hidden">
        <MapView data={data} />

        {/* Top-left control stack */}
        <div className="pointer-events-none absolute left-3 top-3 z-20 flex w-[268px] max-w-[calc(100vw-1.5rem)] flex-col gap-2.5">
          <div className="pointer-events-auto">
            <BrandHeader data={data} />
          </div>
          <div className="pointer-events-auto">
            <SearchBar data={data} />
          </div>
          <div className="pointer-events-auto">
            <ControlPanel data={data} />
          </div>
        </div>

        {/* Detail panel (right) */}
        <div className="pointer-events-none absolute right-3 top-3 z-20 max-h-[calc(100%-1.5rem)]">
          <DetailPanel data={data} />
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

        {/* Data-source credit (basemap credit is the MapLibre attribution control) */}
        <div className="pointer-events-none absolute bottom-1 left-2 z-10 text-[10px] text-ink-2/70">
          Network data: AP-TRANSCO
        </div>
      </div>
    </ErrorBoundary>
  );
}
