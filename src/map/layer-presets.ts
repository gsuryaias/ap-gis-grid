// Layer composition presets for MapPane — which layer groups a lens's map may mount (the registry
// defs in `registry/core.ts` gate on these). Every lens may mount everything today: a lens presets
// which layers are ON (`lenses/registry.ts`), it never takes one away.
import type { LensId } from "../lenses/registry.ts";

/** Which overlay groups MapPane may mount for a lens. */
export interface LayerPreset {
  grid: boolean;
  generation: boolean;
  powergrid: boolean;
  weather: boolean;
}

const ALL: LayerPreset = { grid: true, generation: true, powergrid: true, weather: true };

export const LENS_LAYER_PRESETS: Record<LensId, LayerPreset> = {
  explore: ALL,
  field: ALL,
  // Plan: the core grid carries the MIS thematic layer; the MIS loads generation / power-grid data
  // itself (useResource) without switching their map layers on.
  plan: ALL,
  storm: ALL,
};

/** One-line map context shown at the foot of a lens's layer list. */
export const LENS_MAP_HINTS: Record<LensId, string> = {
  explore: "",
  field: "",
  plan: "Features outside the drill-down scope are dimmed. Pick a map theme in the MIS scope bar.",
  storm: "Weather layers are indicative third-party model output — verify against IMD advisories.",
};
