// What picking an omnisearch hit does (the impure half of `omni.ts`).
import { copyText } from "../components/CopyLink.tsx";
import { passesSlice } from "../data/selectors.ts";
import type { GridData } from "../data/types.ts";
import { primeNetItem } from "../inspector/resources.ts";
import { downloadText, linesToCsv, substationsToCsv } from "../lib/export.ts";
import { useAppStore } from "../state/store.ts";
import type { ActionId, OmniTarget } from "./omni.ts";

/** Map-jump zoom per place type — districts are wide, villages / landmarks are tight. */
const PLACE_ZOOM: Record<string, number> = { state: 7, district: 9, mandal: 11, city: 12 };
const PLACE_ZOOM_DEFAULT = 13;

/** Drill the Network MIS into one area, keeping its voltage slicer if Plan is already open. */
export function drillPath(current: string | undefined, dim: string, value: string): string {
  const slicer = (current ?? "").split("~").find((p) => p.startsWith("voltage:"));
  return [slicer, `${dim}:${value}`].filter(Boolean).join("~");
}

function runAction(id: ActionId, data: GridData): void {
  const s = useAppStore.getState();
  switch (id) {
    case "copy-link":
      void copyText(window.location.href);
      return;
    case "base-light":
    case "base-dark":
    case "base-satellite":
      s.setBasemap(id.slice(5) as "light" | "dark" | "satellite");
      return;
    case "table":
      s.toggleTable(true);
      return;
    case "export-ss":
      downloadText("ap-transco-substations.csv", "text/csv", substationsToCsv(data.substations.filter((f) => passesSlice(f, s.filters))));
      return;
    case "export-lines":
      downloadText("ap-transco-lines.csv", "text/csv", linesToCsv(data.lines.filter((f) => passesSlice(f, s.filters))));
      return;
    case "summary":
      s.toggleSummary(true);
      return;
    case "weather":
      s.toggleWeatherView(true);
      return;
    case "quality":
      s.toggleQuality(true);
      return;
    case "layers":
      s.toggleLayersDrawer(true);
      return;
    case "clear-filters":
      s.resetFilters();
      return;
    case "about":
      s.toggleAbout(true);
      return;
    case "near-me":
      // GPS when allowed; otherwise fall back to picking a point on the map.
      if (!("geolocation" in navigator)) return s.toggleNearbyMode(true);
      navigator.geolocation.getCurrentPosition(
        (pos) => useAppStore.getState().setNearbyOrigin({ lng: pos.coords.longitude, lat: pos.coords.latitude, label: "Your location", fly: true }),
        () => useAppStore.getState().toggleNearbyMode(true),
        { enableHighAccuracy: true, timeout: 10000 },
      );
      return;
  }
}

export function runTarget(t: OmniTarget, data: GridData): void {
  const s = useAppStore.getState();
  switch (t.t) {
    case "select":
      s.setNearbyOrigin(null);
      s.select(t.ref, { fly: true });
      return;
    case "net":
      // A distribution asset: the Inspector shows its attributes + inferred supply path; its layer
      // is switched on, highlighted and flown to (inspector/useInspected.ts).
      s.setNearbyOrigin(null);
      s.select(primeNetItem(t.item), { fly: true });
      return;
    case "place": {
      // A place isn't a selectable feature — jump there and anchor the nearest-SS list on it.
      const p = t.item;
      s.select(null);
      s.setNearbyOrigin({ lng: p.lng, lat: p.lat, label: p.name, fly: true, zoom: PLACE_ZOOM[p.type] ?? PLACE_ZOOM_DEFAULT });
      return;
    }
    case "area": {
      const prev = s.lens === "plan" ? s.workspaceContext.misFilters : undefined;
      s.setLens("plan");
      useAppStore.getState().setWorkspaceContext({ misFilters: drillPath(prev, t.dim, t.value) });
      return;
    }
    case "layer":
      s.setLayer(t.id);
      return;
    case "action":
      runAction(t.id, data);
      return;
    case "lens":
      s.setLens(t.id);
      return;
  }
}
