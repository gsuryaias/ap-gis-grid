import { CIRCUITS, VOLTAGES } from "../../data/types.ts";
import { LENS_BY_ID, switchLensLayers, type LayerOn } from "../../lenses/registry.ts";
import { defaultMapLayout } from "../../url/layout.ts";
import { defaultUrlState, type UrlState } from "../../url/v2.ts";
import { layerOnOf, withLayerOn } from "../layer-on.ts";
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
      const lens = u.lens ?? s.lens;
      const mapLayout =
        u.mapLayout ?? (LENS_BY_ID[lens].layout === "map" ? "atlas-only" : s.mapLayout === "atlas-only" ? defaultMapLayout() : s.mapLayout);
      // Entering a lens brings its default layers; the link's own layer keys (`lyr`, v1 flags) win.
      const cur = lens !== s.lens ? switchLensLayers(layerOnOf(s), s.lens, lens) : layerOnOf(s);
      const on: LayerOn = {
        showSubstations: u.showSubstations ?? cur.showSubstations,
        showLines: u.showLines ?? cur.showLines,
        showGeneration: u.showGeneration ?? cur.showGeneration,
        showPowerGrid: u.showPowerGrid ?? cur.showPowerGrid,
        showWeather: u.showWeather ?? cur.showWeather,
        overlays: u.overlays ?? cur.overlays,
      };
      const { filters: layerFilters, layers } = withLayerOn(s, on);
      const workspaceContext = { ...s.workspaceContext };
      if (u.misBy !== undefined) workspaceContext.misBy = u.misBy ?? undefined;
      if (u.misFilters !== undefined) workspaceContext.misFilters = u.misFilters ?? undefined;
      if (u.misTab !== undefined) workspaceContext.misTab = u.misTab ?? undefined;
      if (u.misTheme !== undefined) workspaceContext.misTheme = u.misTheme ?? undefined;
      return {
        lens,
        mapLayout,
        workspaceContext,
        selectedId,
        history: changed ? [] : s.history,
        here: changed ? null : s.here,
        basemap: u.basemap ?? s.basemap,
        tableOpen: u.tableOpen ?? s.tableOpen,
        filters: {
          ...layerFilters,
          voltages,
          circuits,
          circle: u.circle !== undefined ? u.circle : s.filters.circle,
          coastalBand: u.coastalBand !== undefined ? u.coastalBand : s.filters.coastalBand,
        },
        layers,
        flySignal,
        camera: u.camera ?? s.camera,
        cameraSignal: u.camera ? { camera: u.camera, ts: Date.now(), animate: !opts?.initial } : s.cameraSignal,
      };
    });
    // Overlays the link (or its lens) switched on: fetch them (and the RTGS catalogue for reference layers).
    get().layers.restore();
  },

  urlState: (): UrlState => {
    const s = get();
    const ctx = s.workspaceContext;
    return {
      ...defaultUrlState(),
      ...layerOnOf(s),
      lens: s.lens,
      selectedId: s.selectedId,
      camera: s.camera,
      basemap: s.basemap,
      voltages: VOLTAGES.filter((v) => s.filters.voltages[v]),
      circuits: CIRCUITS.filter((c) => s.filters.circuits[c]),
      circle: s.filters.circle,
      coastalBand: s.filters.coastalBand,
      tableOpen: s.tableOpen,
      mapLayout: LENS_BY_ID[s.lens].layout === "map" ? "atlas-only" : s.mapLayout,
      misBy: ctx.misBy ?? null,
      misFilters: ctx.misFilters ?? null,
      misTab: ctx.misTab ?? null,
      misTheme: ctx.misTheme ?? null,
    };
  },
});
