// Field lens panel: near me, trace a transformer / feeder, and the layer list (towers + 33 kV on).
import { useLocateMe } from "../components/NearbyControl.tsx";
import { PinIcon, SearchIcon, TargetIcon } from "../components/icons.tsx";
import { useAppStore } from "../state/store.ts";
import { LayersBlock } from "./ExplorePanel.tsx";
import { PanelSection, StartHere } from "./StartHere.tsx";

/** Focus the app's search box (the one omnisearch input). */
export function focusSearch() {
  (document.getElementById("app-search") as HTMLInputElement | null)?.focus();
}

const bigBtn =
  "flex min-h-11 w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm font-medium transition-colors";

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
            <span className="block text-[11px] font-normal text-ink-2">DTR code, 11 kV or 33 kV feeder name — traced up to its TRANSCO substation</span>
          </span>
        </button>
        <p className="mt-1.5 px-1 text-[11px] leading-snug text-ink-2">
          The trace is inferred from the DISCOMs' open GIS: APEPDCL is near-complete, APSPDCL is partial and APCPDCL publishes no 11 kV data.
        </p>
      </PanelSection>
      <LayersBlock />
    </div>
  );
}
