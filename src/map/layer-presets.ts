// Layer composition presets for MapPane — which layer groups a workspace's map may mount (the
// registry defs in `registry/core.ts` gate on these).
import type { WorkspaceId } from "../workspaces/registry.ts";

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
