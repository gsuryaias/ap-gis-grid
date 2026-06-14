import type { GridData } from "../data/types.ts";
import { ATLAS_LAYERS } from "../map/layer-presets.ts";
import { MapLayerPanel } from "./MapLayerPanel.tsx";

/** Atlas sidebar — full layer + legend panel (delegates to MapLayerPanel). */
export function ControlPanel({ data, defaultOpen }: { data: GridData; defaultOpen?: boolean }) {
  return (
    <MapLayerPanel data={data} preset={ATLAS_LAYERS} variant="sidebar" workspace="atlas" defaultOpen={defaultOpen} />
  );
}
