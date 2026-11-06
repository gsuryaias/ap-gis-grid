// The store's layer switches as one `LayerOn` (`lenses/registry.ts`) — read for the URL and lens
// switches, written back as one state patch. Layer flags live in two slices (`filters.show*` and the
// catalog overlays' `layers.enabled`); this is the only place that maps between them.
import type { LayerOn } from "../lenses/registry.ts";
import type { AppState } from "./types.ts";

export function layerOnOf(s: Pick<AppState, "filters" | "layers">): LayerOn {
  return layerOnFrom(s.filters, s.layers.enabled);
}

/** The same, from the two parts (lets a component memoise on exactly what it reads). */
export function layerOnFrom(f: AppState["filters"], enabled: Record<string, boolean>): LayerOn {
  return {
    showSubstations: f.showSubstations,
    showLines: f.showLines,
    showGeneration: f.showGeneration,
    showPowerGrid: f.showPowerGrid,
    showWeather: f.showWeather,
    overlays: Object.keys(enabled)
      .filter((id) => enabled[id])
      .sort(),
  };
}

/** A state patch that sets every layer switch to `on` (`layers` changes only if the overlays do). */
export function withLayerOn(s: AppState, on: Partial<LayerOn>): Pick<AppState, "filters" | "layers"> {
  const f = s.filters;
  const filters = {
    ...f,
    showSubstations: on.showSubstations ?? f.showSubstations,
    showLines: on.showLines ?? f.showLines,
    showGeneration: on.showGeneration ?? f.showGeneration,
    showPowerGrid: on.showPowerGrid ?? f.showPowerGrid,
    showWeather: on.showWeather ?? f.showWeather,
  };
  if (!on.overlays) return { filters, layers: s.layers };
  const cur = layerOnOf(s).overlays;
  const same = cur.length === on.overlays.length && cur.every((id, i) => id === [...on.overlays!].sort()[i]);
  const layers = same
    ? s.layers
    : { ...s.layers, enabled: Object.fromEntries(on.overlays.map((id) => [id, true])), version: s.layers.version + 1 };
  return { filters, layers };
}
