import type { GridData } from "../data/types.ts";
import { formatInt } from "../lib/format.ts";
import { useAppStore } from "../state/store.ts";
import { InfoIcon } from "./icons.tsx";

export function BrandHeader({ data }: { data: GridData }) {
  const toggleQuality = useAppStore((s) => s.toggleQuality);
  const km = Math.round(data.meta.totalLengthKm);

  return (
    <section className="rounded-[var(--radius-panel)] border border-line bg-surface/95 px-4 py-3 shadow-[var(--shadow-panel)] backdrop-blur">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-white">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
          </svg>
        </span>
        <div>
          <h1 className="text-[15px] font-bold leading-none text-ink">AP-TRANSCO Grid Atlas</h1>
          <p className="mt-0.5 text-[11px] text-ink-2">Transmission network · 400 / 220 / 132 kV</p>
        </div>
      </div>
      <div className="mt-2.5 flex items-center justify-between">
        <p className="text-xs text-ink-2">
          <span className="font-semibold text-ink">{formatInt(data.meta.counts.substations)}</span> SS ·{" "}
          <span className="font-semibold text-ink">{formatInt(data.meta.counts.lines)}</span> lines ·{" "}
          <span className="font-semibold text-ink">{formatInt(km)}</span> km
        </p>
        <button
          onClick={() => toggleQuality(true)}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
        >
          <InfoIcon width={13} height={13} /> Quality
        </button>
      </div>
    </section>
  );
}
