// Shapes of the app store, one interface per slice (Atlas 2.0 phase 1). The slices compose into
// ONE zustand store (`state/store.ts`); `useAppStore` (flat, legacy) and `useOverlayStore`
// (`layers` slice) are facades over it, so call sites can migrate to `state/hooks.ts` file by file.
import type { StateCreator } from "zustand";
import type { OverlayDef, DiscomId } from "../overlays/catalog.ts";
import type { NetItem } from "../data/network-search.ts";
import type { FilterState, PgClass, WxLayer } from "../data/selectors.ts";
import type { Circuit, EnergyType, GridData, Voltage } from "../data/types.ts";
import type { MeasureMode, MeasureStats } from "../map/measure.ts";
import type { MisMapState } from "../map/mis-layers.ts";
import type { HashState, MapLayout } from "../url/hash.ts";
import type { WorkspaceId } from "../workspaces/registry.ts";

export type Basemap = "light" | "dark" | "satellite";
export type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface FlySignal {
  id: string;
  ts: number;
}

/** Map viewport request from an analysis workspace: fit `bounds` whenever `key` changes. */
export interface FitRequest {
  key: string;
  bounds: [[number, number], [number, number]] | null;
}

/** Cross-workspace analysis focus. The `mis*` strings are URL-hash synced; the rest is transient. */
export interface WorkspaceContext {
  /** Network MIS: group-by dimension (`by=`). */
  misBy?: string;
  /** Network MIS: drill path "dim:value~dim:value" (`mf=`). */
  misFilters?: string;
  /** Network MIS: thematic tab (`tab=`). */
  misTab?: string;
  /** Network MIS: map theme (`theme=`). */
  misTheme?: string;
  /** Network MIS: thematic map classes + scope ids for the embedded map (transient). */
  misMap?: MisMapState | null;
  /** Fit the embedded map to the analysis scope (transient). */
  fit?: FitRequest | null;
}

/** Query anchor for the nearest-substation tool. `fly` eases the map there (GPS), not for map picks. */
export interface NearbyOrigin {
  lng: number;
  lat: number;
  label: string;
  fly: boolean;
  /** Explicit target zoom for search-picked places (may zoom OUT, e.g. to a district); GPS/picks leave it unset. */
  zoom?: number;
}

/** Core grid lifecycle. `data` mirrors `gridRes` so the ~100 sync readers keep working. */
export interface CoreSlice {
  status: "loading" | "ready" | "error";
  error: string | null;
  data: GridData | null;
  init: () => Promise<void>;
}

export interface SelectionSlice {
  selectedId: string | null;
  history: string[];
  hoverId: string | null;
  flySignal: FlySignal | null;
  select: (id: string | null, opts?: { fly?: boolean }) => void;
  back: () => void;
  setHover: (id: string | null) => void;
}

export interface ViewSlice {
  /** Active workspace (DSS shell). */
  workspace: WorkspaceId;
  /** Split-layout map pane state (`map=` hash key when not the viewport default). */
  mapLayout: MapLayout;
  basemap: Basemap;
  /**
   * Connection spotlight: dim core features outside the selection's inferred neighbourhood
   * (transient). Stays armed across selections; inert when nothing (or an overlay) is selected.
   */
  spotlight: boolean;
  setWorkspace: (w: WorkspaceId) => void;
  setMapLayout: (layout: MapLayout) => void;
  setBasemap: (b: Basemap) => void;
  toggleSpotlight: () => void;
}

/**
 * The ONE filter model — read by the map, the data table and (later) the Plan slicer and Storm.
 * Toggling an overlay here only changes visibility; whoever draws it loads its resource.
 */
export interface FiltersSlice {
  filters: FilterState;
  isolateVoltage: (v: Voltage) => void;
  toggleVoltage: (v: Voltage) => void;
  toggleCircuit: (c: Circuit) => void;
  setRegionCircle: (circle: string | null) => void;
  setCoastalBand: (band: 0 | 1 | 2 | 3 | null) => void;
  /** Clear the slicing filters (voltage, circuit, circle, coast) — not layer visibility. */
  resetFilters: () => void;
  toggleShow: (k: "showSubstations" | "showLines") => void;
  toggleGeneration: (open?: boolean) => void;
  toggleGenType: (t: EnergyType) => void;
  togglePowerGrid: (open?: boolean) => void;
  togglePgClass: (c: PgClass) => void;
  toggleWeather: (open?: boolean) => void;
  toggleWxLayer: (l: WxLayer) => void;
}

/** Panels and map tools — all transient (never in the URL hash) except `tableOpen`. */
export interface UiSlice {
  tableOpen: boolean;
  qualityOpen: boolean;
  summaryOpen: boolean;
  weatherOpen: boolean;
  measureMode: MeasureMode | null;
  measureStats: MeasureStats | null;
  measureClearNonce: number;
  nearbyMode: boolean;
  nearbyOrigin: NearbyOrigin | null;
  toggleTable: (open?: boolean) => void;
  toggleQuality: (open?: boolean) => void;
  toggleSummary: (open?: boolean) => void;
  toggleWeatherView: (open?: boolean) => void;
  setMeasureMode: (m: MeasureMode | null) => void;
  clearMeasure: () => void;
  setMeasureStats: (s: MeasureStats | null) => void;
  toggleNearbyMode: (on?: boolean) => void;
  setNearbyOrigin: (o: NearbyOrigin | null) => void;
  clearNearby: () => void;
}

export interface CtxSlice {
  /** Transient cross-workspace analysis focus (chart/table row clicks, MIS map theme, …). */
  workspaceContext: WorkspaceContext;
  setWorkspaceContext: (ctx: Partial<WorkspaceContext>) => void;
}

export interface OverlayFocus {
  lines: string[];
  ss: string[];
  lines11?: string[];
  point?: [number, number] | null;
}

/**
 * DISCOM / RTGS / tower overlays (nested under `layers` — it was its own store). Feature data
 * lives in the `overlayLayer` resource; this keeps only what the UI and map derive from it.
 */
export interface LayersState {
  /** All known overlay definitions, by id (DISCOM always; RTGS refs once catalog.json loads). */
  defs: Record<string, OverlayDef>;
  catalogStatus: LoadStatus;
  enabled: Record<string, boolean>;
  status: Record<string, LoadStatus>;
  errors: Record<string, string>;
  /** DISCOM sub-filter (which utilities' features are drawn). */
  discoms: Record<DiscomId, boolean>;
  /** Highlighted DISCOM features: 33 kV lines / 33/11 kV SS / 11 kV feeders / one point (transient). */
  focus: OverlayFocus | null;
  /** Network search pick (33/11 SS, 33 / 11 kV feeder, section, transformer) shown in the trace panel. */
  netFocus: NetItem | null;
  /** One-shot "fit the map to these bounds" request ([[w,s],[e,n]]). */
  fitSignal: { bounds: [[number, number], [number, number]]; ts: number; maxZoom?: number } | null;
  /** Bumped on every change the map must react to. */
  version: number;

  loadCatalog: () => void;
  toggle: (id: string, on?: boolean) => void;
  toggleDiscom: (d: DiscomId) => void;
  /** Start loading every overlay that is enabled (restored from localStorage) but not yet loaded. */
  restore: () => void;
  setFocus: (f: OverlayFocus | null) => void;
  fitTo: (bounds: [[number, number], [number, number]], maxZoom?: number) => void;
  /** Open a network search result: switch on its overlay, highlight it, fly there, show the trace. */
  focusNetwork: (item: NetItem | null) => void;
}

export interface LayersSlice {
  layers: LayersState;
}

/** URL-hash (v1) bridge — replaced by URL v2 in phase 2. */
export interface UrlSlice {
  applyHash: (h: Partial<HashState>) => void;
  hashState: () => HashState;
}

export type AppState = CoreSlice & SelectionSlice & ViewSlice & FiltersSlice & UiSlice & CtxSlice & LayersSlice & UrlSlice;

/** On-disk shape of the persisted overlay choices (unchanged from the old overlay store). */
export interface PersistedLayers {
  enabled: string[];
  discoms: DiscomId[];
}

export type SliceCreator<T> = StateCreator<AppState, [["zustand/persist", unknown]], [], T>;
