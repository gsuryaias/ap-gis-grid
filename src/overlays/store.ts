// Facade: the overlay store is now the `layers` slice of the one app store (state/slices/layers.ts).
// Kept so call sites can migrate file by file; same API as before (hook + getState + subscribe),
// minus `data` — feature collections live in the `overlayLayer` resource.
import { useAppStore } from "../state/store.ts";
import type { LayersState } from "../state/types.ts";

export type { OverlayFocus } from "../state/types.ts";
export { overlayLayer, refCatalog } from "./resources.ts";

function useLayers<T>(selector: (s: LayersState) => T): T {
  return useAppStore((s) => selector(s.layers));
}

export const useOverlayStore = Object.assign(useLayers, {
  getState: (): LayersState => useAppStore.getState().layers,
  /** Fires only when the `layers` slice changes (not on hover, selection, …). */
  subscribe: (fn: (s: LayersState, prev: LayersState) => void): (() => void) =>
    useAppStore.subscribe((s, prev) => {
      if (s.layers !== prev.layers) fn(s.layers, prev.layers);
    }),
});
