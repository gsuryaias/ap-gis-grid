import { CIRCUITS, VOLTAGES } from "../../data/types.ts";
import { defaultMapLayout } from "../../url/layout.ts";
import { defaultUrlState, type UrlState } from "../../url/v2.ts";
import type { SliceCreator, UrlSlice } from "../types.ts";

/**
 * URL v2 bridge. Pure state mapping: a link that switches a layer on only sets the flag — whatever
 * draws the layer loads its resource (catalog overlays are fetched by `layers.restore()`).
 */
export const createUrlSlice: SliceCreator<UrlSlice> = (set, get) => ({
  applyUrl: (u, opts) => {
    set((s) => {
      const voltages = u.voltages
        ? { 400: u.voltages.includes(400), 220: u.voltages.includes(220), 132: u.voltages.includes(132) }
        : s.filters.voltages;
      const circuits = u.circuits ? { SC: u.circuits.includes("SC"), DC: u.circuits.includes("DC") } : s.filters.circuits;
      const selectedId = u.selectedId !== undefined ? u.selectedId : s.selectedId;
      const changed = selectedId !== s.selectedId;
      // A link's own camera wins over flying to its selection (the sender's view, or the view Back returns to).
      const flySignal = selectedId && changed && !u.camera ? { id: selectedId, ts: Date.now() } : s.flySignal;
      const workspace = u.workspace ?? s.workspace;
      const mapLayout =
        u.mapLayout ?? (workspace === "atlas" ? "atlas-only" : s.mapLayout === "atlas-only" ? defaultMapLayout() : s.mapLayout);
      const workspaceContext = { ...s.workspaceContext };
      if (u.misBy !== undefined) workspaceContext.misBy = u.misBy ?? undefined;
      if (u.misFilters !== undefined) workspaceContext.misFilters = u.misFilters ?? undefined;
      if (u.misTab !== undefined) workspaceContext.misTab = u.misTab ?? undefined;
      if (u.misTheme !== undefined) workspaceContext.misTheme = u.misTheme ?? undefined;
      const layers = u.overlays
        ? { ...s.layers, enabled: Object.fromEntries(u.overlays.map((id) => [id, true])), version: s.layers.version + 1 }
        : s.layers;
      return {
        workspace,
        mapLayout,
        workspaceContext,
        selectedId,
        history: changed ? [] : s.history,
        here: changed ? null : s.here,
        basemap: u.basemap ?? s.basemap,
        tableOpen: u.tableOpen ?? s.tableOpen,
        filters: {
          ...s.filters,
          voltages,
          circuits,
          circle: u.circle !== undefined ? u.circle : s.filters.circle,
          coastalBand: u.coastalBand !== undefined ? u.coastalBand : s.filters.coastalBand,
          showSubstations: u.showSubstations ?? s.filters.showSubstations,
          showLines: u.showLines ?? s.filters.showLines,
          showGeneration: u.showGeneration ?? s.filters.showGeneration,
          showPowerGrid: u.showPowerGrid ?? s.filters.showPowerGrid,
          showWeather: u.showWeather ?? s.filters.showWeather,
        },
        layers,
        flySignal,
        camera: u.camera ?? s.camera,
        cameraSignal: u.camera ? { camera: u.camera, ts: Date.now(), animate: !opts?.initial } : s.cameraSignal,
      };
    });
    // Overlays a link switched on: fetch them (and the RTGS catalogue if one is a reference layer).
    if (u.overlays) get().layers.restore();
  },

  urlState: (): UrlState => {
    const s = get();
    const ctx = s.workspaceContext;
    return {
      ...defaultUrlState(),
      workspace: s.workspace,
      selectedId: s.selectedId,
      camera: s.camera,
      basemap: s.basemap,
      voltages: VOLTAGES.filter((v) => s.filters.voltages[v]),
      circuits: CIRCUITS.filter((c) => s.filters.circuits[c]),
      circle: s.filters.circle,
      coastalBand: s.filters.coastalBand,
      showSubstations: s.filters.showSubstations,
      showLines: s.filters.showLines,
      showGeneration: s.filters.showGeneration,
      showPowerGrid: s.filters.showPowerGrid,
      showWeather: s.filters.showWeather,
      overlays: Object.keys(s.layers.enabled)
        .filter((id) => s.layers.enabled[id])
        .sort(),
      tableOpen: s.tableOpen,
      mapLayout: s.workspace === "atlas" ? "atlas-only" : s.mapLayout,
      misBy: ctx.misBy ?? null,
      misFilters: ctx.misFilters ?? null,
      misTab: ctx.misTab ?? null,
      misTheme: ctx.misTheme ?? null,
    };
  },
});
