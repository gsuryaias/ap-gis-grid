import { DEFAULT_LENS, LENS_BY_ID, switchLensLayers } from "../../lenses/registry.ts";
import { defaultMapLayout } from "../../url/layout.ts";
import { roundCamera } from "../../url/v2.ts";
import { layerOnOf, withLayerOn } from "../layer-on.ts";
import type { SliceCreator, ViewSlice } from "../types.ts";

export const createViewSlice: SliceCreator<ViewSlice> = (set, get) => ({
  lens: DEFAULT_LENS,
  mapLayout: "atlas-only",
  basemap: "light",
  spotlight: false,
  camera: null,
  cameraSignal: null,

  // A lens is a preset, never a filter: the selection and filters stay; its default layers come on
  // (and the previous lens's go off) — anything switched on by hand stays on.
  setLens: (lens) => {
    if (lens === get().lens) return;
    set((s) => ({
      lens,
      mapLayout: LENS_BY_ID[lens].layout === "map" ? "atlas-only" : s.mapLayout === "atlas-only" ? defaultMapLayout() : s.mapLayout,
      workspaceContext: {},
      solo: null,
      ...withLayerOn(s, switchLensLayers(layerOnOf(s), s.lens, lens)),
    }));
    get().layers.restore(); // fetch the overlays the lens switched on
  },
  setMapLayout: (mapLayout) => set({ mapLayout }),
  setBasemap: (basemap) => set({ basemap }),
  toggleSpotlight: () => set((s) => ({ spotlight: !s.spotlight })),
  setCamera: (c) =>
    set((s) => {
      const camera = roundCamera(c);
      const p = s.camera;
      return p && p.lng === camera.lng && p.lat === camera.lat && p.zoom === camera.zoom ? s : { camera };
    }),
});
