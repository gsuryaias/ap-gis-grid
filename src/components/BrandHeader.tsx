import type { GridData } from "../data/types.ts";
import { formatInt } from "../lib/format.ts";
import { useAppStore } from "../state/store.ts";
import { WORKSPACES, type WorkspaceId } from "../workspaces/registry.ts";
import { CloudIcon, InfoIcon, LayersIcon } from "./icons.tsx";

// Compact tab captions so all four fit the 268 px column; full label + description in the tooltip.
const TAB_LABEL: Record<WorkspaceId, string> = { atlas: "Atlas", risk: "Risk", planning: "Plan", mis: "MIS" };

export function BrandHeader({ data }: { data: GridData }) {
  const toggleQuality = useAppStore((s) => s.toggleQuality);
  const toggleSummary = useAppStore((s) => s.toggleSummary);
  const toggleWeatherView = useAppStore((s) => s.toggleWeatherView);
  const workspace = useAppStore((s) => s.workspace);
  const setWorkspace = useAppStore((s) => s.setWorkspace);
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
      <p className="mt-2.5 text-xs text-ink-2">
        <span className="font-semibold text-ink">{formatInt(data.meta.counts.substations)}</span> SS ·{" "}
        <span className="font-semibold text-ink">{formatInt(data.meta.counts.lines)}</span> lines ·{" "}
        <span className="font-semibold text-ink">{formatInt(km)}</span> km
      </p>
      <nav aria-label="Workspace" className="mt-2 grid grid-cols-4 gap-0.5 rounded-lg border border-line bg-surface-2/70 p-0.5">
        {WORKSPACES.map((w) => {
          const active = workspace === w.id;
          return (
            <button
              key={w.id}
              onClick={() => setWorkspace(w.id)}
              title={`${w.label} — ${w.description}`}
              aria-current={active ? "page" : undefined}
              className={`rounded-md px-1 py-1 text-[11px] font-medium transition-colors ${
                active ? "bg-accent text-white" : "text-ink-2 hover:bg-surface-3 hover:text-ink"
              }`}
            >
              {TAB_LABEL[w.id]}
            </button>
          );
        })}
      </nav>
      {/* Summary/Weather/Quality open views mounted only in the Atlas tree — hide elsewhere. */}
      {workspace === "atlas" && (
        <div className="mt-2 flex gap-1.5">
          <button
            onClick={() => toggleSummary(true)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-line py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
          >
            <LayersIcon width={13} height={13} /> Summary
          </button>
          <button
            onClick={() => toggleWeatherView(true)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-line py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
          >
            <CloudIcon width={13} height={13} /> Weather
          </button>
          <button
            onClick={() => toggleQuality(true)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-line py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <InfoIcon width={13} height={13} /> Quality
          </button>
        </div>
      )}
    </section>
  );
}
