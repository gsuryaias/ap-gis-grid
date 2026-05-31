import { create } from "zustand";
import { loadGeneration, loadGridData } from "../data/load.ts";
import type { FilterState } from "../data/selectors.ts";
import {
  CIRCUITS,
  ENERGY_TYPES,
  VOLTAGES,
  type Circuit,
  type EnergyType,
  type GenerationData,
  type GridData,
  type Voltage,
} from "../data/types.ts";
import { defaultHashState, type HashState } from "../url/hash.ts";

export type Basemap = "light" | "dark" | "satellite";
type Status = "loading" | "ready" | "error";
/** Lazy lifecycle for the generation overlay: untouched → fetching → loaded / failed. */
type GenStatus = "idle" | "loading" | "ready" | "error";

export interface FlySignal {
  id: string;
  ts: number;
}

interface AppState {
  status: Status;
  error: string | null;
  data: GridData | null;

  selectedId: string | null;
  history: string[];
  hoverId: string | null;
  basemap: Basemap;
  tableOpen: boolean;
  qualityOpen: boolean;
  summaryOpen: boolean;
  filters: FilterState;
  flySignal: FlySignal | null;

  // Generation overlay (lazy-loaded)
  generation: GenerationData | null;
  genStatus: GenStatus;
  genError: string | null;

  init: () => Promise<void>;
  select: (id: string | null, opts?: { fly?: boolean }) => void;
  back: () => void;
  setHover: (id: string | null) => void;
  setBasemap: (b: Basemap) => void;
  toggleTable: (open?: boolean) => void;
  toggleQuality: (open?: boolean) => void;
  toggleSummary: (open?: boolean) => void;
  isolateVoltage: (v: Voltage) => void;
  toggleVoltage: (v: Voltage) => void;
  toggleCircuit: (c: Circuit) => void;
  toggleShow: (k: "showSubstations" | "showLines") => void;
  toggleGeneration: (open?: boolean) => void;
  toggleGenType: (t: EnergyType) => void;
  applyHash: (h: Partial<HashState>) => void;
  hashState: () => HashState;
}

function freshFilters(): FilterState {
  return {
    voltages: { 400: true, 220: true, 132: true },
    circuits: { SC: true, DC: true },
    showSubstations: true,
    showLines: true,
    showGeneration: false, // lazy — off until the user opts in
    genTypes: Object.fromEntries(ENERGY_TYPES.map((t) => [t, true])) as Record<EnergyType, boolean>,
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  status: "loading",
  error: null,
  data: null,

  selectedId: null,
  history: [],
  hoverId: null,
  basemap: "light",
  tableOpen: false,
  qualityOpen: false,
  summaryOpen: false,
  filters: freshFilters(),
  flySignal: null,

  generation: null,
  genStatus: "idle",
  genError: null,

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

  setHover: (id) => set({ hoverId: id }),
  setBasemap: (basemap) => set({ basemap }),
  toggleTable: (open) => set((s) => ({ tableOpen: open ?? !s.tableOpen })),
  toggleQuality: (open) => set((s) => ({ qualityOpen: open ?? !s.qualityOpen })),
  toggleSummary: (open) => set((s) => ({ summaryOpen: open ?? !s.summaryOpen })),
  isolateVoltage: (v) =>
    set((s) => ({
      filters: { ...s.filters, voltages: { 400: v === 400, 220: v === 220, 132: v === 132 } },
      summaryOpen: false,
    })),

  toggleVoltage: (v) =>
    set((s) => ({ filters: { ...s.filters, voltages: { ...s.filters.voltages, [v]: !s.filters.voltages[v] } } })),
  toggleCircuit: (c) =>
    set((s) => ({ filters: { ...s.filters, circuits: { ...s.filters.circuits, [c]: !s.filters.circuits[c] } } })),
  toggleShow: (k) => set((s) => ({ filters: { ...s.filters, [k]: !s.filters[k] } })),

  toggleGeneration: (open) => {
    const next = open ?? !get().filters.showGeneration;
    set((s) => ({ filters: { ...s.filters, showGeneration: next } }));
    // Lazy-fetch the overlay the first time it's switched on; cache thereafter.
    if (next && get().genStatus === "idle") {
      set({ genStatus: "loading", genError: null });
      loadGeneration()
        .then((generation) => set({ generation, genStatus: "ready" }))
        .catch((e) =>
          set({ genStatus: "error", genError: e instanceof Error ? e.message : String(e) }),
        );
    }
  },

  toggleGenType: (t) =>
    set((s) => ({ filters: { ...s.filters, genTypes: { ...s.filters.genTypes, [t]: !s.filters.genTypes[t] } } })),

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
      const showGeneration = h.showGeneration ?? s.filters.showGeneration;
      // A deep link with gen=1 must kick off the lazy fetch just like a manual toggle.
      if (showGeneration && get().genStatus === "idle") {
        Promise.resolve().then(() => get().toggleGeneration(true));
      }
      return {
        selectedId,
        history: selectedId === s.selectedId ? s.history : [],
        basemap: h.basemap ?? s.basemap,
        tableOpen: h.tableOpen ?? s.tableOpen,
        filters: {
          voltages,
          circuits,
          showSubstations: h.showSubstations ?? s.filters.showSubstations,
          showLines: h.showLines ?? s.filters.showLines,
          showGeneration,
          genTypes: s.filters.genTypes,
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
      showGeneration: s.filters.showGeneration,
    };
  },
}));
