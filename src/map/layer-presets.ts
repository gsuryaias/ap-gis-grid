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
export { HEADROOM_PULSE_PCT, UTIL_COLOR } from "./planning-map.ts";
export { addRiskLayers, applyRiskScores, applyRiskVisibility, RISK_LAYER, RISK_SRC } from "./risk-layers.ts";

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

export const RISK_LAYERS: LayerPreset = {
  grid: true,
  generation: false,
  powergrid: true,
  weather: true,
};

export const PLANNING_LAYERS: LayerPreset = {
  grid: true,
  generation: true,
  powergrid: false,
  weather: false,
};

export const MIS_LAYERS: LayerPreset = {
  grid: true,
  generation: true,
  powergrid: false,
  weather: false,
};

export const WORKSPACE_LAYER_PRESETS: Record<WorkspaceId, LayerPreset> = {
  atlas: ATLAS_LAYERS,
  risk: RISK_LAYERS,
  planning: PLANNING_LAYERS,
  mis: MIS_LAYERS,
};

/** One-line map context shown at the foot of each workspace's layer panel. */
export const WORKSPACE_MAP_HINTS: Record<WorkspaceId, string> = {
  atlas: "",
  risk: "Substations are tinted by composite risk score under the active scenario.",
  planning: "Line colour shows indicative corridor loading from the DC flow model.",
  mis: "Geographic reference — toggle generation plants to compare with CEA mix.",
};
