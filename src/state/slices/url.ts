import { CIRCUITS, VOLTAGES } from "../../data/types.ts";
import { defaultHashState, defaultMapLayout } from "../../url/hash.ts";
import type { SliceCreator, UrlSlice } from "../types.ts";

/**
 * v1 URL-hash bridge. Pure state mapping: a deep link that turns an overlay on (gen/pg/wx=1)
 * just sets the filter — whatever draws the overlay loads its resource.
 */
export const createUrlSlice: SliceCreator<UrlSlice> = (set, get) => ({
  applyHash: (h) =>
    set((s) => {
      const voltages = h.voltages
        ? { 400: h.voltages.includes(400), 220: h.voltages.includes(220), 132: h.voltages.includes(132) }
        : s.filters.voltages;
      const circuits = h.circuits ? { SC: h.circuits.includes("SC"), DC: h.circuits.includes("DC") } : s.filters.circuits;
      const selectedId = h.selectedId !== undefined ? h.selectedId : s.selectedId;
      // Any newly linked selection flies: core ids via useMapCamera, the rest once the Inspector resolves them.
      const flySignal = selectedId && selectedId !== s.selectedId ? { id: selectedId, ts: Date.now() } : s.flySignal;
      const workspace = h.workspace ?? s.workspace;
      const mapLayout =
        h.mapLayout ?? (workspace === "atlas" ? "atlas-only" : s.mapLayout === "atlas-only" ? defaultMapLayout() : s.mapLayout);
      const workspaceContext = { ...s.workspaceContext };
      if (h.misBy !== undefined) workspaceContext.misBy = h.misBy ?? undefined;
      if (h.misFilters !== undefined) workspaceContext.misFilters = h.misFilters ?? undefined;
      if (h.misTab !== undefined) workspaceContext.misTab = h.misTab ?? undefined;
      if (h.misTheme !== undefined) workspaceContext.misTheme = h.misTheme ?? undefined;
      return {
        workspace,
        mapLayout,
        workspaceContext,
        selectedId,
        history: selectedId === s.selectedId ? s.history : [],
        basemap: h.basemap ?? s.basemap,
        tableOpen: h.tableOpen ?? s.tableOpen,
        filters: {
          ...s.filters,
          voltages,
          circuits,
          circle: h.circle !== undefined ? h.circle : s.filters.circle,
          coastalBand: h.coastalBand !== undefined ? h.coastalBand : s.filters.coastalBand,
          showSubstations: h.showSubstations ?? s.filters.showSubstations,
          showLines: h.showLines ?? s.filters.showLines,
          showGeneration: h.showGeneration ?? s.filters.showGeneration,
          showPowerGrid: h.showPowerGrid ?? s.filters.showPowerGrid,
          showWeather: h.showWeather ?? s.filters.showWeather,
        },
        flySignal,
      };
    }),

  hashState: () => {
    const s = get();
    const ctx = s.workspaceContext;
    return {
      ...defaultHashState,
      workspace: s.workspace,
      mapLayout: s.workspace === "atlas" ? "atlas-only" : s.mapLayout,
      selectedId: s.selectedId,
      basemap: s.basemap,
      tableOpen: s.tableOpen,
      voltages: VOLTAGES.filter((v) => s.filters.voltages[v]),
      circuits: CIRCUITS.filter((c) => s.filters.circuits[c]),
      circle: s.filters.circle,
      coastalBand: s.filters.coastalBand,
      showSubstations: s.filters.showSubstations,
      showLines: s.filters.showLines,
      showGeneration: s.filters.showGeneration,
      showPowerGrid: s.filters.showPowerGrid,
      showWeather: s.filters.showWeather,
      misBy: ctx.misBy ?? null,
      misFilters: ctx.misFilters ?? null,
      misTab: ctx.misTab ?? null,
      misTheme: ctx.misTheme ?? null,
    };
  },
});
