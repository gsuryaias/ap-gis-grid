import type { SliceCreator, UiSlice } from "../types.ts";

export const createUiSlice: SliceCreator<UiSlice> = (set) => ({
  tableOpen: false,
  qualityOpen: false,
  summaryOpen: false,
  weatherOpen: false,
  measureMode: null,
  measureStats: null,
  measureClearNonce: 0,
  nearbyMode: false,
  nearbyOrigin: null,

  toggleTable: (open) => set((s) => ({ tableOpen: open ?? !s.tableOpen })),
  toggleQuality: (open) => set((s) => ({ qualityOpen: open ?? !s.qualityOpen })),
  toggleSummary: (open) => set((s) => ({ summaryOpen: open ?? !s.summaryOpen })),
  // The dashboard loads weather itself while mounted (useResource) — no fetch plumbing here.
  toggleWeatherView: (open) => set((s) => ({ weatherOpen: open ?? !s.weatherOpen })),

  // Passing the active mode again toggles the tool off; clears any prior readout on every change.
  // Measure and the nearest-substation tool both hijack map clicks, so enabling one disables the other.
  setMeasureMode: (m) =>
    set((s) => {
      const measureMode = s.measureMode === m ? null : m;
      return measureMode
        ? { measureMode, measureStats: null, nearbyMode: false, nearbyOrigin: null }
        : { measureMode, measureStats: null };
    }),
  clearMeasure: () => set((s) => ({ measureClearNonce: s.measureClearNonce + 1, measureStats: null })),
  setMeasureStats: (measureStats) => set({ measureStats }),

  toggleNearbyMode: (on) =>
    set((s) => {
      const next = on ?? !s.nearbyMode;
      return next ? { nearbyMode: true, measureMode: null, measureStats: null } : { nearbyMode: false };
    }),
  setNearbyOrigin: (nearbyOrigin) => set({ nearbyOrigin }),
  clearNearby: () => set({ nearbyMode: false, nearbyOrigin: null }),
});
