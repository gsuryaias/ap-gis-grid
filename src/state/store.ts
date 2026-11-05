// The ONE app store (Atlas 2.0 phase 1): slices composed into a single zustand store.
//
//   state/types.ts      slice shapes          state/slices/*   slice creators
//   state/hooks.ts      named hooks (useShallow) — preferred for new code
//   useAppStore         flat legacy facade (= the store itself)
//   useOverlayStore     facade over the `layers` slice (overlays/store.ts)
//
// Lazy data (core grid, generation, power grid, weather, overlays) lives in resources
// (`data/resources.ts`); the store holds only the core grid mirror (`data`) and UI state.
// Persisted: only the overlay choices, under the legacy `apgg-overlays-v1` key/shape.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createCoreSlice } from "./slices/core.ts";
import { createCtxSlice } from "./slices/ctx.ts";
import { createFiltersSlice } from "./slices/filters.ts";
import { createLayersSlice, LAYERS_STORAGE_KEY, LAYERS_STORAGE_VERSION, layersStorage, mergeLayers, partializeLayers } from "./slices/layers.ts";
import { createSelectionSlice } from "./slices/selection.ts";
import { createUiSlice } from "./slices/ui.ts";
import { createUrlSlice } from "./slices/url.ts";
import { createViewSlice } from "./slices/view.ts";
import type { AppState, PersistedLayers } from "./types.ts";

export type { AppState, Basemap, FitRequest, FlySignal, NearbyOrigin, WorkspaceContext } from "./types.ts";

export const useAppStore = create<AppState>()(
  persist(
    (...a) => ({
      ...createCoreSlice(...a),
      ...createSelectionSlice(...a),
      ...createViewSlice(...a),
      ...createFiltersSlice(...a),
      ...createUiSlice(...a),
      ...createCtxSlice(...a),
      ...createLayersSlice(...a),
      ...createUrlSlice(...a),
    }),
    {
      name: LAYERS_STORAGE_KEY,
      version: LAYERS_STORAGE_VERSION,
      storage: layersStorage(),
      partialize: (s): PersistedLayers => partializeLayers(s),
      merge: (persisted, current) => mergeLayers(persisted, current),
    },
  ),
);
