// Layer composition presets for MapPane — workspaces pick a preset; overlay mount helpers
// are re-exported here so analysis surfaces can compose sources without importing all of layers.ts.
import type { WorkspaceId } from "../workspaces/registry.ts";

export {
  addGenerationLayers,
  addGridLayers,
  addPowerGridLayers,
  ALL_INTERACTIVE,
  applyFilters,
  applySpotlight,
  INTERACTIVE_LAYERS,
  LAYER,
  POWERGRID_INTERACTIVE,
  SRC,
} from "./layers.ts";
export { addWeatherLayers, applyWeatherVisibility, WX_LAYER, WX_SRC } from "./weather-layers.ts";
export { addMisLayers, applyMisTheme, MIS_LAYER } from "./mis-layers.ts";

/** Which overlay groups MapPane may mount for a workspace context. */
export interface LayerPreset {
  grid: boolean;
  generation: boolean;
  powergrid: boolean;
  weather: boolean;
}

export const ATLAS_LAYERS: LayerPreset = {
  grid: true,
  generation: true,
  powergrid: true,
  weather: true,
};

// Network MIS: the core grid carries the thematic layer; every overlay stays user-toggleable from
// the map's layer panel (the MIS loads generation / power-grid data itself via `ensure*`, without
// switching their map layers on).
export const MIS_LAYERS: LayerPreset = {
  grid: true,
  generation: true,
  powergrid: true,
  weather: true,
};

export const WORKSPACE_LAYER_PRESETS: Record<WorkspaceId, LayerPreset> = {
  atlas: ATLAS_LAYERS,
  mis: MIS_LAYERS,
};

/** One-line map context shown at the foot of each workspace's layer panel. */
export const WORKSPACE_MAP_HINTS: Record<WorkspaceId, string> = {
  atlas: "",
  mis: "Features outside the drill-down scope are dimmed. Pick a map theme in the MIS scope bar.",
};
