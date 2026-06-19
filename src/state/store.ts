import { create } from "zustand";
import { loadGeneration, loadGridData, loadPlaces, loadPowerGrid } from "../data/load.ts";
import { PG_CLASSES, WX_LAYERS, type FilterState, type PgClass, type WxLayer } from "../data/selectors.ts";
import { loadWeather, type WeatherData } from "../data/weather.ts";
import { circlePoints } from "../lib/weather.ts";
import type { MeasureMode, MeasureStats } from "../map/measure.ts";
import {
  CIRCUITS,
  ENERGY_TYPES,
  VOLTAGES,
  type Circuit,
  type EnergyType,
  type GenerationData,
  type GridData,
  type PlaceItem,
  type PowerGridData,
  type Voltage,
} from "../data/types.ts";
import { defaultHashState, defaultMapLayout, type HashState, type MapLayout } from "../url/hash.ts";
import type { WorkspaceId } from "../workspaces/registry.ts";

export type Basemap = "light" | "dark" | "satellite";
type Status = "loading" | "ready" | "error";
/** Lazy lifecycle for an optional overlay: untouched → fetching → loaded / failed. */
type GenStatus = "idle" | "loading" | "ready" | "error";

export interface FlySignal {
  id: string;
  ts: number;
}

/** Query anchor for the nearest-substation tool. `fly` eases the map there (GPS), not for map picks. */
/** Factor breakdown for a Risk Room register row (indicative screening — not in hash). */
export interface RiskSelectionContext {
  id: string;
  hazard: number;
  vulnerability: number;
  criticality: number;
  composite: number;
  tier: string;
  hazardFactors: string[];
  vulnFactors: string[];
  critFactors: string[];
}

/** Cross-workspace analysis focus — persisted in the URL hash when a DSS workspace is active. */
export interface WorkspaceContext {
  /** Risk Room scenario preset id (`scenario=` hash key). */
  scenario?: string;
  /** @deprecated alias kept for map focus — prefer `scenario`. */
  hazard?: string;
  /** Risk register sort column (`sort=` hash key). */
  sort?: string;
  /** Map fly-to circle (also mirrored by the global `circle=` filter when set from Risk). */
  circle?: string;
  /** Risk Room: composite scores keyed by substation id (transient map overlay). */
  riskScores?: Record<string, number>;
  /** Risk Room: substation ids to emphasize on the embedded map (transient). */
  highlightIds?: string[];
  /** Risk Room: active register row factor breakdown (transient). */
  riskSelection?: RiskSelectionContext | null;
}

export interface NearbyOrigin {
  lng: number;
  lat: number;
  label: string;
  fly: boolean;
  /** Explicit target zoom for search-picked places (may zoom OUT, e.g. to a district); GPS/picks leave it unset. */
  zoom?: number;
}

interface AppState {
  status: Status;
  error: string | null;
  data: GridData | null;

  /** Active workspace (DSS shell). "atlas" renders the original app tree unchanged. */
  workspace: WorkspaceId;
  /** Split-layout map pane state (`map=` hash key when not the viewport default). */
  mapLayout: MapLayout;
  /** Transient cross-workspace analysis focus (chart/table row clicks, hazard context, …). */
  workspaceContext: WorkspaceContext;

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

  // POWERGRID (PGCIL) overlay (lazy-loaded)
  powergrid: PowerGridData | null;
  pgStatus: GenStatus;
  pgError: string | null;

  // Connection spotlight: dim core features outside the selection's inferred neighborhood
  // (transient — never persisted to the URL hash). Stays armed across selections; inert when
  // nothing (or an overlay feature) is selected.
  spotlight: boolean;

  // Measurement tool (transient — never persisted to the URL hash)
  measureMode: MeasureMode | null;
  measureStats: MeasureStats | null;
  measureClearNonce: number;

  // Nearest-substation tool (transient — never persisted to the URL hash)
  nearbyMode: boolean;
  nearbyOrigin: NearbyOrigin | null;

  // Live-weather overlay + dashboard (lazy-fetched, auto-refreshed while in use)
  weather: WeatherData | null;
  wxStatus: GenStatus;
  wxError: string | null;
  weatherOpen: boolean;

  // Place-search gazetteer (lazy-loaded on first use of the search box)
  places: PlaceItem[] | null;
  placesStatus: GenStatus;

  init: () => Promise<void>;
  setWorkspace: (w: WorkspaceId) => void;
  setMapLayout: (layout: MapLayout) => void;
  setWorkspaceContext: (ctx: Partial<WorkspaceContext>) => void;
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
  setRegionCircle: (circle: string | null) => void;
  setCoastalBand: (band: 0 | 1 | 2 | 3 | null) => void;
  toggleShow: (k: "showSubstations" | "showLines") => void;
  toggleGeneration: (open?: boolean) => void;
  toggleGenType: (t: EnergyType) => void;
  togglePowerGrid: (open?: boolean) => void;
  togglePgClass: (c: PgClass) => void;
  toggleWeather: (open?: boolean) => void;
  toggleWxLayer: (l: WxLayer) => void;
  toggleWeatherView: (open?: boolean) => void;
  refreshWeather: () => void;
  toggleSpotlight: () => void;
  setMeasureMode: (m: MeasureMode | null) => void;
  clearMeasure: () => void;
  setMeasureStats: (s: MeasureStats | null) => void;
  toggleNearbyMode: (on?: boolean) => void;
  setNearbyOrigin: (o: NearbyOrigin | null) => void;
  clearNearby: () => void;
  ensurePlaces: () => void;
  applyHash: (h: Partial<HashState>) => void;
  hashState: () => HashState;
}

function freshFilters(): FilterState {
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

// Weather auto-refresh: a single module-level timer, alive only while the overlay or the
// dashboard is in use. Radar regenerates ~5-minutely upstream; 10 min keeps usage polite.
const WX_REFRESH_MS = 10 * 60 * 1000;
let wxTimer: ReturnType<typeof setInterval> | null = null;
let wxFetching = false;

function syncWeatherTimer(get: () => AppState): void {
  const s = get();
  const inUse = s.filters.showWeather || s.weatherOpen;
  if (inUse && !wxTimer) {
    wxTimer = setInterval(() => get().refreshWeather(), WX_REFRESH_MS);
  } else if (!inUse && wxTimer) {
    clearInterval(wxTimer);
    wxTimer = null;
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  status: "loading",
  error: null,
  data: null,

  workspace: "atlas",
  mapLayout: "atlas-only",
  workspaceContext: {},

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

  powergrid: null,
  pgStatus: "idle",
  pgError: null,

  weather: null,
  wxStatus: "idle",
  wxError: null,
  weatherOpen: false,

  spotlight: false,

  measureMode: null,
  measureStats: null,
  measureClearNonce: 0,

  nearbyMode: false,
  nearbyOrigin: null,

  places: null,
  placesStatus: "idle",

  init: async () => {
    try {
      const data = await loadGridData();
      set({ data, status: "ready" });
      // If a deep link pre-selected a feature, fly to it now that data is ready.
      const sel = get().selectedId;
      if (sel && data.byId.has(sel)) set({ flySignal: { id: sel, ts: Date.now() } });
      // A wx=1 deep link arrives before data; the fetch needs circle points, so kick it off now.
      if (get().filters.showWeather && get().wxStatus === "idle") get().refreshWeather();
    } catch (e) {
      set({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  },

  setWorkspace: (workspace) =>
    set((s) => ({
      workspace,
      mapLayout: workspace === "atlas" ? "atlas-only" : s.mapLayout === "atlas-only" ? defaultMapLayout() : s.mapLayout,
      workspaceContext: workspace === s.workspace ? s.workspaceContext : {},
    })),

  setMapLayout: (mapLayout) => set({ mapLayout }),

  setWorkspaceContext: (ctx) =>
    set((s) => {
      let changed = false;
      for (const key of Object.keys(ctx) as (keyof WorkspaceContext)[]) {
        if (s.workspaceContext[key] !== ctx[key]) {
          changed = true;
          break;
        }
      }
      if (!changed) return s;
      return { workspaceContext: { ...s.workspaceContext, ...ctx } };
    }),

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
  setRegionCircle: (circle) => set((s) => ({ filters: { ...s.filters, circle }, summaryOpen: false })),
  setCoastalBand: (coastalBand) => set((s) => ({ filters: { ...s.filters, coastalBand }, summaryOpen: false })),
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

  togglePowerGrid: (open) => {
    const next = open ?? !get().filters.showPowerGrid;
    set((s) => ({ filters: { ...s.filters, showPowerGrid: next } }));
    // Lazy-fetch the overlay the first time it's switched on; cache thereafter.
    if (next && get().pgStatus === "idle") {
      set({ pgStatus: "loading", pgError: null });
      loadPowerGrid()
        .then((powergrid) => set({ powergrid, pgStatus: "ready" }))
        .catch((e) =>
          set({ pgStatus: "error", pgError: e instanceof Error ? e.message : String(e) }),
        );
    }
  },

  togglePgClass: (c) =>
    set((s) => ({ filters: { ...s.filters, pgClasses: { ...s.filters.pgClasses, [c]: !s.filters.pgClasses[c] } } })),

  toggleWeather: (open) => {
    const next = open ?? !get().filters.showWeather;
    set((s) => ({ filters: { ...s.filters, showWeather: next } }));
    // Lazy-fetch on first enable (and retry a failed fetch on re-enable); cache thereafter.
    if (next && get().wxStatus !== "ready") get().refreshWeather();
    syncWeatherTimer(get);
  },

  toggleWxLayer: (l) =>
    set((s) => ({ filters: { ...s.filters, wxLayers: { ...s.filters.wxLayers, [l]: !s.filters.wxLayers[l] } } })),

  toggleWeatherView: (open) => {
    const next = open ?? !get().weatherOpen;
    set({ weatherOpen: next });
    // The dashboard is usable without the map overlay — opening it also triggers the fetch.
    if (next && get().wxStatus !== "ready") get().refreshWeather();
    syncWeatherTimer(get);
  },

  // Fetch (or re-fetch) every weather source. Existing data stays on screen during a refresh;
  // a refresh failure keeps the stale-but-useful data and only surfaces the error when empty.
  refreshWeather: () => {
    const { data } = get();
    if (!data || wxFetching) return; // pre-data deep links retry from init()
    wxFetching = true;
    if (!get().weather) set({ wxStatus: "loading", wxError: null });
    loadWeather(circlePoints(data.substations))
      .then((weather) => set({ weather, wxStatus: "ready", wxError: null }))
      .catch((e) =>
        set((s) => ({
          wxStatus: s.weather ? "ready" : "error",
          wxError: e instanceof Error ? e.message : String(e),
        })),
      )
      .finally(() => {
        wxFetching = false;
      });
  },

  toggleSpotlight: () => set((s) => ({ spotlight: !s.spotlight })),

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

  // Lazy-fetch the search gazetteer on first focus of the search box; cache thereafter.
  // A failed fetch resets to idle so the next focus retries (search degrades gracefully meanwhile).
  ensurePlaces: () => {
    if (get().placesStatus !== "idle") return;
    set({ placesStatus: "loading" });
    loadPlaces()
      .then((places) => set({ places, placesStatus: "ready" }))
      .catch(() => set({ placesStatus: "idle" }));
  },

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
      const showPowerGrid = h.showPowerGrid ?? s.filters.showPowerGrid;
      // A deep link with pg=1 must kick off the lazy fetch just like a manual toggle.
      if (showPowerGrid && get().pgStatus === "idle") {
        Promise.resolve().then(() => get().togglePowerGrid(true));
      }
      const showWeather = h.showWeather ?? s.filters.showWeather;
      // A deep link with wx=1 must kick off the lazy fetch just like a manual toggle.
      // (toggleWeather no-ops the fetch until data is ready; init() then re-triggers it.)
      if (showWeather && get().wxStatus === "idle") {
        Promise.resolve().then(() => get().toggleWeather(true));
      }
      // Hash edits can also flip wx off — keep the auto-refresh timer in sync either way.
      Promise.resolve().then(() => syncWeatherTimer(get));
      const workspace = h.workspace ?? s.workspace;
      const mapLayout =
        h.mapLayout ??
        (workspace === "atlas" ? "atlas-only" : s.mapLayout === "atlas-only" ? defaultMapLayout() : s.mapLayout);
      const workspaceContext = { ...s.workspaceContext };
      if (h.scenario !== undefined) {
        workspaceContext.scenario = h.scenario ?? undefined;
        workspaceContext.hazard = h.scenario ?? undefined;
      }
      if (h.sort !== undefined) workspaceContext.sort = h.sort ?? undefined;
      if (h.circle !== undefined && h.circle) workspaceContext.circle = h.circle;
      return {
        workspace,
        mapLayout,
        workspaceContext,
        selectedId,
        history: selectedId === s.selectedId ? s.history : [],
        basemap: h.basemap ?? s.basemap,
        tableOpen: h.tableOpen ?? s.tableOpen,
        filters: {
          voltages,
          circuits,
          circle: h.circle !== undefined ? h.circle : s.filters.circle,
          coastalBand: h.coastalBand !== undefined ? h.coastalBand : s.filters.coastalBand,
          showSubstations: h.showSubstations ?? s.filters.showSubstations,
          showLines: h.showLines ?? s.filters.showLines,
          showGeneration,
          genTypes: s.filters.genTypes,
          showPowerGrid,
          pgClasses: s.filters.pgClasses,
          showWeather,
          wxLayers: s.filters.wxLayers,
        },
        flySignal,
      };
    }),

  hashState: () => {
    const s = get();
    const ctx = s.workspaceContext;
    return {
      ...defaultHashState,
      workspace: s.workspace,
      mapLayout: s.workspace === "atlas" ? "atlas-only" : s.mapLayout,
      selectedId: s.selectedId,
      basemap: s.basemap,
      tableOpen: s.tableOpen,
      voltages: VOLTAGES.filter((v) => s.filters.voltages[v]),
      circuits: CIRCUITS.filter((c) => s.filters.circuits[c]),
      circle: s.filters.circle,
      coastalBand: s.filters.coastalBand,
      showSubstations: s.filters.showSubstations,
      showLines: s.filters.showLines,
      showGeneration: s.filters.showGeneration,
      showPowerGrid: s.filters.showPowerGrid,
      showWeather: s.filters.showWeather,
      scenario: ctx.scenario ?? ctx.hazard ?? null,
      sort: ctx.sort ?? null,
    };
  },
}));
