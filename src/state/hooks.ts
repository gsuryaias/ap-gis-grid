// Named store hooks (Atlas 2.0 phase 1). Prefer these in new / migrated code over ad-hoc
// `useAppStore((s) => …)` selectors: each returns a shallow-compared slice view, so a component
// re-renders only when a field it reads changes.
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "./store.ts";

/** The core grid (null until loaded) + its load status. */
export const useGrid = () => useAppStore(useShallow((s) => ({ data: s.data, status: s.status, error: s.error })));

/** The shared filter model + its actions — map, data table, Plan slicer and Storm all read this. */
export const useFilters = () =>
  useAppStore(
    useShallow((s) => ({
      filters: s.filters,
      toggleVoltage: s.toggleVoltage,
      isolateVoltage: s.isolateVoltage,
      toggleCircuit: s.toggleCircuit,
      setRegionCircle: s.setRegionCircle,
      setCoastalBand: s.setCoastalBand,
      resetFilters: s.resetFilters,
    })),
  );

/** Current selection + navigation. */
export const useSelection = () =>
  useAppStore(useShallow((s) => ({ selectedId: s.selectedId, history: s.history, select: s.select, back: s.back })));

/** View state: lens, map layout, basemap, spotlight. */
export const useView = () =>
  useAppStore(
    useShallow((s) => ({
      lens: s.lens,
      mapLayout: s.mapLayout,
      basemap: s.basemap,
      spotlight: s.spotlight,
      setLens: s.setLens,
      setMapLayout: s.setMapLayout,
      setBasemap: s.setBasemap,
      toggleSpotlight: s.toggleSpotlight,
    })),
  );
