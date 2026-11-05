import type { SelectionSlice, SliceCreator } from "../types.ts";

export const createSelectionSlice: SliceCreator<SelectionSlice> = (set) => ({
  selectedId: null,
  history: [],
  hoverId: null,
  flySignal: null,

  select: (id, opts) =>
    set((s) => ({
      selectedId: id,
      // Push the previous selection so the detail panel can offer a "back" breadcrumb.
      history: id ? (s.selectedId && s.selectedId !== id ? [...s.history, s.selectedId].slice(-25) : s.history) : [],
      flySignal: id && opts?.fly ? { id, ts: Date.now() } : s.flySignal,
    })),

  back: () =>
    set((s) => {
      const h = [...s.history];
      const prev = h.pop() ?? null;
      return { selectedId: prev, history: h, flySignal: prev ? { id: prev, ts: Date.now() } : s.flySignal };
    }),

  setHover: (id) => set((s) => (s.hoverId === id ? s : { hoverId: id })),
});
