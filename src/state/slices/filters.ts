import { PG_CLASSES, WX_LAYERS, type FilterState, type PgClass, type WxLayer } from "../../data/selectors.ts";
import { ENERGY_TYPES, type EnergyType } from "../../data/types.ts";
import type { FiltersSlice, SliceCreator } from "../types.ts";

export function freshFilters(): FilterState {
  return {
    voltages: { 400: true, 220: true, 132: true },
    circuits: { SC: true, DC: true },
    circle: null,
    coastalBand: null,
    showSubstations: true,
    showLines: true,
    showGeneration: false, // lazy — off until the user opts in
    genTypes: Object.fromEntries(ENERGY_TYPES.map((t) => [t, true])) as Record<EnergyType, boolean>,
    showPowerGrid: false, // lazy — off until the user opts in
    pgClasses: Object.fromEntries(PG_CLASSES.map((c) => [c, true])) as Record<PgClass, boolean>,
    showWeather: false, // lazy — off until the user opts in
    wxLayers: Object.fromEntries(WX_LAYERS.map((l) => [l, true])) as Record<WxLayer, boolean>,
  };
}

export const createFiltersSlice: SliceCreator<FiltersSlice> = (set) => {
  const patch = (fn: (f: FilterState) => Partial<FilterState>) => set((s) => ({ filters: { ...s.filters, ...fn(s.filters) } }));
  return {
    filters: freshFilters(),

    isolateVoltage: (v) =>
      set((s) => ({
        filters: { ...s.filters, voltages: { 400: v === 400, 220: v === 220, 132: v === 132 } },
        summaryOpen: false,
      })),
    toggleVoltage: (v) => patch((f) => ({ voltages: { ...f.voltages, [v]: !f.voltages[v] } })),
    toggleCircuit: (c) => patch((f) => ({ circuits: { ...f.circuits, [c]: !f.circuits[c] } })),
    setRegionCircle: (circle) => set((s) => ({ filters: { ...s.filters, circle }, summaryOpen: false })),
    setCoastalBand: (coastalBand) => set((s) => ({ filters: { ...s.filters, coastalBand }, summaryOpen: false })),
    resetFilters: () => {
      const f = freshFilters();
      patch(() => ({ voltages: f.voltages, circuits: f.circuits, circle: null, coastalBand: null }));
    },
    toggleShow: (k) => patch((f) => ({ [k]: !f[k] })),

    toggleGeneration: (open) => patch((f) => ({ showGeneration: open ?? !f.showGeneration })),
    toggleGenType: (t) => patch((f) => ({ genTypes: { ...f.genTypes, [t]: !f.genTypes[t] } })),
    togglePowerGrid: (open) => patch((f) => ({ showPowerGrid: open ?? !f.showPowerGrid })),
    togglePgClass: (c) => patch((f) => ({ pgClasses: { ...f.pgClasses, [c]: !f.pgClasses[c] } })),
    toggleWeather: (open) => patch((f) => ({ showWeather: open ?? !f.showWeather })),
    toggleWxLayer: (l) => patch((f) => ({ wxLayers: { ...f.wxLayers, [l]: !f.wxLayers[l] } })),
  };
};
