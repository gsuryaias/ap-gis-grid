import { useState } from "react";
import type { GridData } from "../data/types.ts";
import type { LayerPreset } from "../map/layer-presets.ts";
import { WORKSPACE_MAP_HINTS } from "../map/layer-presets.ts";
import type { WorkspaceId } from "../workspaces/registry.ts";
import { ChevronDown, LayersIcon } from "./icons.tsx";
import {
  BasemapSection,
  GenerationSection,
  PowerGridSection,
  RegionSection,
  ShowSection,
  VoltageSection,
  WeatherSection,
} from "./layer-controls.tsx";

export type MapLayerPanelVariant = "sidebar" | "overlay";

export interface MapLayerPanelProps {
  data: GridData;
  preset: LayerPreset;
  /** sidebar = Atlas left column; overlay = floating on embedded map pane */
  variant?: MapLayerPanelVariant;
  workspace?: WorkspaceId;
}

function LayerBody({
  data,
  preset,
  workspace,
  compact,
}: {
  data: GridData;
  preset: LayerPreset;
  workspace?: WorkspaceId;
  compact?: boolean;
}) {
  const hint = workspace ? WORKSPACE_MAP_HINTS[workspace] : "";

  return (
    <>
      {preset.grid && (
        <>
          <VoltageSection data={data} compact={compact} />
          <RegionSection data={data} showCoastal={workspace === "risk"} />
          <ShowSection />
        </>
      )}
      {preset.generation && <GenerationSection />}
      {preset.powergrid && <PowerGridSection />}
      {preset.weather && <WeatherSection />}
      <BasemapSection />
      {hint && (
        <p className="mt-2 border-t border-line pt-2 text-[10px] leading-snug text-ink-2/85">{hint}</p>
      )}
    </>
  );
}

/** Contextual GIS layer controls — shows only what the active workspace needs. */
export function MapLayerPanel({ data, preset, variant = "sidebar", workspace }: MapLayerPanelProps) {
  const [open, setOpen] = useState(variant === "sidebar");

  if (variant === "overlay") {
    return (
      <div className="pointer-events-auto absolute left-2.5 top-2.5 z-20 flex max-h-[calc(100%-5rem)] max-w-[min(260px,calc(100%-5rem))] flex-col">
        {!open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-expanded={false}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/95 px-3 py-1.5 text-xs font-medium text-ink shadow-[var(--shadow-panel)] backdrop-blur hover:bg-surface-2"
          >
            <LayersIcon width={14} height={14} className="text-ink-2" />
            Map layers
          </button>
        ) : (
          <section className="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface/95 shadow-[var(--shadow-panel)] backdrop-blur">
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-expanded
              className="flex shrink-0 items-center justify-between px-3 py-2 text-left"
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                <LayersIcon width={14} height={14} className="text-ink-2" />
                Map layers
              </span>
              <ChevronDown width={14} height={14} className="text-ink-2" />
            </button>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-line px-3 pb-2.5 pt-1">
              <LayerBody data={data} preset={preset} workspace={workspace} compact />
            </div>
          </section>
        )}
      </div>
    );
  }

  return (
    <section className="pointer-events-auto flex min-h-0 w-full flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface/95 shadow-[var(--shadow-panel)] backdrop-blur">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full shrink-0 items-center justify-between px-3.5 py-2.5 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-ink">
          <LayersIcon width={16} height={16} className="text-ink-2" /> Layers & legend
        </span>
        <ChevronDown width={16} height={16} className={`text-ink-2 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-line px-3.5 pb-3 pt-1">
          <LayerBody data={data} preset={preset} workspace={workspace} />
        </div>
      )}
    </section>
  );
}
