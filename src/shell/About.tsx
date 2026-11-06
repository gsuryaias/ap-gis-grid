// About & sources — opened from the ⋯ menu or ⌘K (store `aboutOpen`).
import { useRef } from "react";
import { CloseIcon } from "../components/icons.tsx";
import { Dialog } from "../components/Dialog.tsx";
import type { GridData } from "../data/types.ts";
import { useAppStore } from "../state/store.ts";

export function About({ data }: { data: GridData }) {
  const open = useAppStore((s) => s.aboutOpen);
  const toggle = useAppStore((s) => s.toggleAbout);
  const closeRef = useRef<HTMLButtonElement>(null);
  if (!open) return null;
  const onClose = () => toggle(false);
  const built = new Date(data.meta.generatedAt);
  return (
    <Dialog
      label="About the Grid Atlas"
      onClose={onClose}
      initialFocus={closeRef}
      className="max-h-full w-[480px] max-w-full overflow-y-auto rounded-[var(--radius-panel)] border border-line bg-surface p-5 shadow-[var(--shadow-panel)]"
    >
      <div className="flex items-start gap-2">
        <h2 id="about-title" className="flex-1 text-lg font-semibold text-ink">
          About the Grid Atlas
        </h2>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink">
          <CloseIcon width={16} height={16} />
        </button>
      </div>
      <p className="mt-2 text-sm text-ink-2">
        A public, static map and lookup of the AP-TRANSCO transmission network (400 / 220 / 132 kV) with the DISCOM 33 / 11 kV
        networks, generation, the inter-state grid, reference layers and live weather. Connections, capacities and risk
        screens are <strong className="text-ink">inferred and indicative</strong> — not operational data.
      </p>
      <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Sources</h3>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-2">
        <li>Network: AP-TRANSCO enterprise GIS (open layers) and the DISCOMs' open GIS services</li>
        <li>Reference layers: AP Real-Time Governance Society (RTGS) shapefile library</li>
        <li>Places: GeoNames (CC BY 4.0)</li>
        <li>Weather: Open-Meteo · Radar: RainViewer · Cyclones: GDACS (UN / EC JRC)</li>
        <li>Basemaps: © CARTO, © OpenStreetMap contributors · Satellite: Esri World Imagery</li>
      </ul>
      <p className="mt-4 text-xs text-ink-2">Data built {built.toLocaleString("en-IN")}.</p>
    </Dialog>
  );
}
