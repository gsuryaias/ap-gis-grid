// Field lens panel: near me, trace a transformer / feeder, map presets (satellite, towers, 11 kV),
// offline packs, and the layer list. Big touch targets throughout — this is used on a phone, on site.
import { useState } from "react";
import { useLocateMe } from "../components/NearbyControl.tsx";
import { PinIcon, SatelliteIcon, SearchIcon, TargetIcon, TowerIcon, LineIcon } from "../components/icons.tsx";
import type { Basemap } from "../state/types.ts";
import { useAppStore } from "../state/store.ts";
import { LayersBlock } from "./ExplorePanel.tsx";
import { OfflinePacks } from "../offline/OfflinePacks.tsx";
import { PanelSection, StartHere } from "./StartHere.tsx";

/** Focus the app's search box (the one omnisearch input). */
export function focusSearch() {
  (document.getElementById("app-search") as HTMLInputElement | null)?.focus();
}

const bigBtn =
  "flex min-h-11 w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm font-medium transition-colors";

const TOWERS = ["towers-400kv", "towers-220kv", "towers-132kv"];
const F11 = "discom-11kv-lines";

/** A full-width, 44 px switch row. */
function Preset({ icon, label, sub, on, toggle }: { icon: React.ReactNode; label: string; sub: string; on: boolean; toggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={toggle}
      className={`${bigBtn} ${on ? "border-accent/60 bg-accent/[0.08]" : "border-line hover:bg-surface-2"} text-ink`}
    >
      <span className="shrink-0 text-ink-2">{icon}</span>
      <span className="min-w-0 flex-1">
        {label}
        <span className="block text-[11px] font-normal text-ink-2">{sub}</span>
      </span>
      <span aria-hidden className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors ${on ? "bg-accent" : "bg-line"}`}>
        <span className="inline-block h-5 w-5 rounded-full bg-white shadow transition-transform" style={{ transform: `translateX(${on ? 18 : 2}px)` }} />
      </span>
    </button>
  );
}

function MapPresets() {
  const basemap = useAppStore((s) => s.basemap);
  const setBasemap = useAppStore((s) => s.setBasemap);
  const setLayer = useAppStore((s) => s.setLayer);
  const towersOn = useAppStore((s) => TOWERS.some((id) => s.layers.enabled[id]));
  const f11On = useAppStore((s) => !!s.layers.enabled[F11]);
  // Satellite off returns to whichever street basemap was in use.
  const [street, setStreet] = useState<Basemap>(basemap === "satellite" ? "light" : basemap);
  const sat = basemap === "satellite";
  return (
    <div className="flex flex-col gap-1.5">
      <Preset
        icon={<SatelliteIcon width={18} height={18} />}
        label="Satellite imagery"
        sub="Esri World Imagery — see the ground, towers and ROW"
        on={sat}
        toggle={() => {
          if (sat) setBasemap(street);
          else {
            setStreet(basemap);
            setBasemap("satellite");
          }
        }}
      />
      <Preset
        icon={<TowerIcon width={18} height={18} />}
        label="Transmission towers"
        sub="400 / 220 / 132 kV, from zoom 9 — tap one for its type"
        on={towersOn}
        toggle={() => TOWERS.forEach((id) => setLayer(id, !towersOn))}
      />
      <Preset
        icon={<LineIcon width={18} height={18} />}
        label="11 kV feeders"
        sub="APEPDCL + APSPDCL, from zoom 10"
        on={f11On}
        toggle={() => setLayer(F11, !f11On)}
      />
    </div>
  );
}

export default function FieldPanel() {
  const { locate, locating, error } = useLocateMe();
  const nearbyMode = useAppStore((s) => s.nearbyMode);
  const nearbyOrigin = useAppStore((s) => s.nearbyOrigin);
  const toggleNearbyMode = useAppStore((s) => s.toggleNearbyMode);
  return (
    <div className="flex flex-col gap-3">
      <StartHere lens="field" />
      <PanelSection title="Near me">
        <div className="flex flex-col gap-1.5">
          <button type="button" onClick={locate} className={`${bigBtn} border-accent bg-accent text-on-accent hover:opacity-90`}>
            <TargetIcon width={18} height={18} className="shrink-0" />
            {locating ? "Locating…" : "Substations near me"}
          </button>
          <button
            type="button"
            onClick={() => toggleNearbyMode()}
            aria-pressed={nearbyMode}
            className={`${bigBtn} ${nearbyMode ? "border-accent bg-surface-3 text-ink" : "border-line text-ink hover:bg-surface-2"}`}
          >
            <PinIcon width={18} height={18} className="shrink-0 text-ink-2" />
            {nearbyMode ? "Tap a point on the map…" : "Nearest to a point on the map"}
          </button>
          {(error || nearbyOrigin) && (
            <p className="px-1 text-[11px] text-ink-2">{error ?? `Showing the nearest substations to ${nearbyOrigin!.label}.`}</p>
          )}
        </div>
      </PanelSection>
      <PanelSection title="Trace">
        <button type="button" onClick={() => focusSearch()} className={`${bigBtn} border-line text-ink hover:bg-surface-2`}>
          <SearchIcon width={18} height={18} className="shrink-0 text-ink-2" />
          <span className="min-w-0">
            Find a transformer or feeder
            <span className="block text-[11px] font-normal text-ink-2">DTR code, 11 kV or 33 kV feeder name — traced up to its TRANSCO substation and down to what it feeds</span>
          </span>
        </button>
        <p className="mt-1.5 px-1 text-[11px] leading-snug text-ink-2">
          The trace is inferred from the DISCOMs' open GIS: APEPDCL is near-complete, APSPDCL's 11 kV comes from its pole survey (Kadapa partial) and APCPDCL publishes no 11 kV data.
        </p>
      </PanelSection>
      <PanelSection title="Map">
        <MapPresets />
      </PanelSection>
      <PanelSection title="Offline">
        <OfflinePacks />
      </PanelSection>
      <LayersBlock />
    </div>
  );
}
