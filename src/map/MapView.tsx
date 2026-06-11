import type { GridData } from "../data/types.ts";
import { ATLAS_LAYERS } from "./layer-presets.ts";
import { MapPane } from "./MapPane.tsx";

/** Atlas full-screen map — thin wrapper over the shared MapPane instance contract. */
export function MapView({ data }: { data: GridData }) {
  return <MapPane data={data} mode="full" layers={ATLAS_LAYERS} interactive />;
}
