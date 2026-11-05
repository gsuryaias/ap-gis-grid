import { gridRes } from "../../data/load.ts";
import type { CoreSlice, SliceCreator } from "../types.ts";

export const createCoreSlice: SliceCreator<CoreSlice> = (set, get) => ({
  status: "loading",
  error: null,
  data: null,

  init: async () => {
    try {
      const data = await gridRes.ensure();
      set({ data, status: "ready", error: null });
      // If a deep link pre-selected a feature, fly to it now that data is ready.
      const sel = get().selectedId;
      if (sel && data.byId.has(sel)) set({ flySignal: { id: sel, ts: Date.now() } });
    } catch (e) {
      set({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  },
});
