// Layer switching for the Layers drawer (Atlas 2.0 phase 3, PR 9): one setter for every layer token
// (`ss` / `ln` / `gen` / `pg` / `wx` / overlay ids), solo (Alt-click — show only this layer, again to
// restore) and the drawer's open state. Opacity lives with the overlays in the `layers` slice.
import { fromTokens, layerTokens } from "../../lenses/registry.ts";
import { layerOnOf, withLayerOn } from "../layer-on.ts";
import type { CatalogueSlice, SliceCreator } from "../types.ts";

export const createCatalogueSlice: SliceCreator<CatalogueSlice> = (set, get) => ({
  layersOpen: false,
  solo: null,

  toggleLayersDrawer: (open) => set((s) => ({ layersOpen: open ?? !s.layersOpen })),

  setLayer: (id, on) => {
    set((s) => {
      const tokens = layerTokens(layerOnOf(s));
      const next = on ?? !tokens.has(id);
      if (next) tokens.add(id);
      else tokens.delete(id);
      return { ...withLayerOn(s, fromTokens(tokens)), solo: null };
    });
    get().layers.restore();
  },

  soloLayer: (id) => {
    set((s) => {
      if (s.solo?.id === id) return { ...withLayerOn(s, s.solo.prev), solo: null };
      const prev = s.solo?.prev ?? layerOnOf(s);
      return { ...withLayerOn(s, fromTokens(new Set([id]))), solo: { id, prev } };
    });
    get().layers.restore();
  },
});
