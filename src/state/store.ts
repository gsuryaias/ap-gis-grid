import { create } from "zustand";
import { loadGridData } from "../data/load.ts";
import type { FilterState } from "../data/selectors.ts";
import { CIRCUITS, VOLTAGES, type Circuit, type GridData, type Voltage } from "../data/types.ts";
import { defaultHashState, type HashState } from "../url/hash.ts";

export type Basemap = "light" | "dark";
type Status = "loading" | "ready" | "error";

export interface FlySignal {
  id: string;
  ts: number;
}

interface AppState {
  status: Status;
  error: string | null;
  data: GridData | null;

  selectedId: string | null;
  hoverId: string | null;
  basemap: Basemap;
  tableOpen: boolean;
  qualityOpen: boolean;
  filters: FilterState;
  flySignal: FlySignal | null;

  init: () => Promise<void>;
  select: (id: string | null, opts?: { fly?: boolean }) => void;
  setHover: (id: string | null) => void;
  setBasemap: (b: Basemap) => void;
  toggleTable: (open?: boolean) => void;
  toggleQuality: (open?: boolean) => void;
  toggleVoltage: (v: Voltage) => void;
  toggleCircuit: (c: Circuit) => void;
  toggleShow: (k: "showSubstations" | "showLines") => void;
  applyHash: (h: Partial<HashState>) => void;
  hashState: () => HashState;
}

function freshFilters(): FilterState {
  return {
    voltages: { 400: true, 220: true, 132: true },
    circuits: { SC: true, DC: true },
    showSubstations: true,
    showLines: true,
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  status: "loading",
  error: null,
  data: null,

  selectedId: null,
  hoverId: null,
  basemap: "light",
  tableOpen: false,
  qualityOpen: false,
  filters: freshFilters(),
  flySignal: null,

  init: async () => {
    try {
      const data = await loadGridData();
      set({ data, status: "ready" });
      // If a deep link pre-selected a feature, fly to it now that data is ready.
      const sel = get().selectedId;
      if (sel && data.byId.has(sel)) set({ flySignal: { id: sel, ts: Date.now() } });
    } catch (e) {
      set({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  },

  select: (id, opts) =>
    set({
      selectedId: id,
      flySignal: id && opts?.fly ? { id, ts: Date.now() } : get().flySignal,
    }),

  setHover: (id) => set({ hoverId: id }),
  setBasemap: (basemap) => set({ basemap }),
  toggleTable: (open) => set((s) => ({ tableOpen: open ?? !s.tableOpen })),
  toggleQuality: (open) => set((s) => ({ qualityOpen: open ?? !s.qualityOpen })),

  toggleVoltage: (v) =>
    set((s) => ({ filters: { ...s.filters, voltages: { ...s.filters.voltages, [v]: !s.filters.voltages[v] } } })),
  toggleCircuit: (c) =>
    set((s) => ({ filters: { ...s.filters, circuits: { ...s.filters.circuits, [c]: !s.filters.circuits[c] } } })),
  toggleShow: (k) => set((s) => ({ filters: { ...s.filters, [k]: !s.filters[k] } })),

  applyHash: (h) =>
    set((s) => {
      const voltages = h.voltages
        ? { 400: h.voltages.includes(400), 220: h.voltages.includes(220), 132: h.voltages.includes(132) }
        : s.filters.voltages;
      const circuits = h.circuits
        ? { SC: h.circuits.includes("SC"), DC: h.circuits.includes("DC") }
        : s.filters.circuits;
      const selectedId = h.selectedId !== undefined ? h.selectedId : s.selectedId;
      const flySignal =
        selectedId && selectedId !== s.selectedId && s.data?.byId.has(selectedId)
          ? { id: selectedId, ts: Date.now() }
          : s.flySignal;
      return {
        selectedId,
        basemap: h.basemap ?? s.basemap,
        tableOpen: h.tableOpen ?? s.tableOpen,
        filters: {
          voltages,
          circuits,
          showSubstations: h.showSubstations ?? s.filters.showSubstations,
          showLines: h.showLines ?? s.filters.showLines,
        },
        flySignal,
      };
    }),

  hashState: () => {
    const s = get();
    return {
      ...defaultHashState,
      selectedId: s.selectedId,
      basemap: s.basemap,
      tableOpen: s.tableOpen,
      voltages: VOLTAGES.filter((v) => s.filters.voltages[v]),
      circuits: CIRCUITS.filter((c) => s.filters.circuits[c]),
      showSubstations: s.filters.showSubstations,
      showLines: s.filters.showLines,
    };
  },
}));
