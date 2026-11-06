import { defaultMapLayout } from "../../url/layout.ts";
import { roundCamera } from "../../url/v2.ts";
import type { SliceCreator, ViewSlice } from "../types.ts";

export const createViewSlice: SliceCreator<ViewSlice> = (set) => ({
  workspace: "atlas",
  mapLayout: "atlas-only",
  basemap: "light",
  spotlight: false,
  camera: null,
  cameraSignal: null,

  setWorkspace: (workspace) =>
    set((s) => ({
      workspace,
      mapLayout: workspace === "atlas" ? "atlas-only" : s.mapLayout === "atlas-only" ? defaultMapLayout() : s.mapLayout,
      workspaceContext: workspace === s.workspace ? s.workspaceContext : {},
    })),
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
