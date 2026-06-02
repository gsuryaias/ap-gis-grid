import { useState } from "react";
import { useAppStore } from "../state/store.ts";
import { CloseIcon, PinIcon, TargetIcon } from "./icons.tsx";

/**
 * Nearest-substation tool. "Locate me" uses the browser geolocation API; "Pick point" lets the user
 * click anywhere on the map. Either way it sets the query origin, and {@link NearbyPanel} lists the
 * closest substations. Mutually exclusive with the measure tool (both capture map clicks).
 */
export function NearbyControl() {
  const nearbyMode = useAppStore((s) => s.nearbyMode);
  const nearbyOrigin = useAppStore((s) => s.nearbyOrigin);
  const toggleNearbyMode = useAppStore((s) => s.toggleNearbyMode);
  const setNearbyOrigin = useAppStore((s) => s.setNearbyOrigin);
  const clearNearby = useAppStore((s) => s.clearNearby);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const active = nearbyMode || nearbyOrigin != null;

  const locateMe = () => {
    if (!("geolocation" in navigator)) {
      setGeoError("Geolocation isn’t available in this browser.");
      return;
    }
    setGeoError(null);
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setNearbyOrigin({ lng: pos.coords.longitude, lat: pos.coords.latitude, label: "Your location", fly: true });
      },
      () => {
        setLocating(false);
        setGeoError("Couldn’t get your location.");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const status = locating
    ? "Locating…"
    : geoError
      ? geoError
      : nearbyOrigin
        ? `Nearest to ${nearbyOrigin.label}`
        : nearbyMode
          ? "Click anywhere on the map."
          : null;

  return (
    <div className="pointer-events-auto flex w-[208px] flex-col gap-1.5 rounded-[var(--radius-panel)] border border-line bg-surface/95 p-1.5 shadow-[var(--shadow-panel)] backdrop-blur">
      <div className="flex items-center gap-1">
        <button
          onClick={locateMe}
          title="Find substations near your current location"
          className="flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-line px-2 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
        >
          <TargetIcon width={14} height={14} className="shrink-0" /> Locate me
        </button>
        <button
          onClick={() => toggleNearbyMode()}
          aria-pressed={nearbyMode}
          title="Click a point on the map to find nearby substations"
          className={`flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border px-2 py-1.5 text-xs font-medium ${
            nearbyMode ? "border-accent bg-surface-3 text-ink" : "border-line text-ink-2 hover:bg-surface-2"
          }`}
        >
          <PinIcon width={14} height={14} className="shrink-0" /> Pick point
        </button>
        {active && (
          <button
            onClick={clearNearby}
            aria-label="Exit nearby"
            className="shrink-0 rounded-md p-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <CloseIcon width={15} height={15} />
          </button>
        )}
      </div>
      {status && <p className="border-t border-line px-2 pt-1.5 text-[11px] leading-snug text-ink-2">{status}</p>}
    </div>
  );
}
