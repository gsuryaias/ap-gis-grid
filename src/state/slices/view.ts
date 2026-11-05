import { defaultMapLayout } from "../../url/hash.ts";
import type { SliceCreator, ViewSlice } from "../types.ts";

export const createViewSlice: SliceCreator<ViewSlice> = (set) => ({
  workspace: "atlas",
  mapLayout: "atlas-only",
  basemap: "light",
  spotlight: false,

  setWorkspace: (workspace) =>
    set((s) => ({
      workspace,
      mapLayout: workspace === "atlas" ? "atlas-only" : s.mapLayout === "atlas-only" ? defaultMapLayout() : s.mapLayout,
      workspaceContext: workspace === s.workspace ? s.workspaceContext : {},
    })),
  setMapLayout: (mapLayout) => set({ mapLayout }),
  setBasemap: (basemap) => set({ basemap }),
  toggleSpotlight: () => set((s) => ({ spotlight: !s.spotlight })),
});
