// Registry defs for everything the map draws besides the catalog overlays: the core transmission
// grid, the Network MIS themes, generation plants, the power-grid group and live weather. Pure
// (state in → defs out); every spec / feature-state is memoised on its inputs so the engine can
// skip unchanged defs — the reconcile runs on every hover.
import type { MapGeoJSONFeature } from "maplibre-gl";
import { graphAnalysis, spotlightFor, type SpotlightSets } from "../../data/graph-data.ts";
import type { FilterState } from "../../data/selectors.ts";
import type { GenerationData, GridData, PowerGridData } from "../../data/types.ts";
import type { WeatherData } from "../../data/weather.ts";
import type { AppState } from "../../state/types.ts";
import { RAILWAY_COLOR, BULKLOAD_COLOR } from "../../theme/palette.ts";
import type { LayerPreset } from "../layer-presets.ts";
import {
  buildGenerationLayers,
  buildLayers,
  buildLoadLayers,
  buildPowerGridLayers,
  gridSpec,
  LAYER,
  SRC,
  spotlightSpec,
} from "../layers.ts";
import { sourceForId } from "../map-helpers.ts";
import { misLineLayers, misSsLayers, misThemeSpec, type MisMapState } from "../mis-layers.ts";
import type { FeatureStateSpec, FeatureStateValue, MapSpec } from "../spec.ts";
import {
  cycloneFc,
  cycloneFillLayers,
  cycloneLineLayers,
  RADAR_SOURCE_OPTIONS,
  radarLayers,
  radarOpacitySpec,
  riskSubstationLayers,
  weatherOn,
  WX_SRC,
  wxRiskIds,
  wxRiskSpec,
} from "../weather-layers.ts";
import { overlayRegistry } from "./overlays.ts";
import { memo, type Interaction, type LayerDef } from "./types.ts";

/** Everything the map's defs read: the store plus the data the map was given / has loaded. */
export interface MapState {
  app: AppState;
  data: GridData;
  gen: GenerationData | undefined;
  pg: PowerGridData | undefined;
  wx: WeatherData | undefined;
  /** Which layer groups this lens's map may mount. */
  preset: LayerPreset;
}
type S = MapState;
type Def = LayerDef<S>;

// ---- shared derived state (memoised) ----------------------------------------------------------
const gridSpecOf = memo((f: FilterState) => gridSpec(f));

/** Dim everything outside the focus: an armed selection's 1-hop neighbourhood, else the MIS scope. */
const spotlightOf = memo(
  (data: GridData, armed: boolean, selectedId: string | null, mm: MisMapState | null): SpotlightSets | null => {
    if (armed && selectedId) {
      const f = data.byId.get(selectedId);
      if (f && f.kind !== "generation") return spotlightFor(graphAnalysis(data), f);
    }
    if (mm?.scopeSsIds && mm.scopeLineIds) return { ssIds: new Set(mm.scopeSsIds), lineIds: new Set(mm.scopeLineIds) };
    return null;
  },
);
const spotSpecOf = memo((spot: SpotlightSets | null) => spotlightSpec(spot));
const misStateOf = (s: S): MisMapState | null => (s.app.lens === "plan" ? (s.app.workspaceContext.misMap ?? null) : null);
const spotlightSpecOf = (s: S) => spotSpecOf(spotlightOf(s.data, s.app.spotlight, s.app.selectedId, misStateOf(s)));

/** A per-def memo that keeps just the def's own layers out of one or more shared specs. */
function pickFor(ids: string[]) {
  return memo((...specs: MapSpec[]): MapSpec => {
    const out: MapSpec = {};
    for (const id of ids) {
      for (const spec of specs) {
        const st = spec[id];
        if (!st) continue;
        const cur = (out[id] ??= {});
        if (st.visibility !== undefined) cur.visibility = st.visibility;
        if (st.filter !== undefined) cur.filter = st.filter;
        if (st.paint) cur.paint = { ...cur.paint, ...st.paint };
      }
    }
    return out;
  });
}

/** Selected / hovered highlight for the features of one source. */
function selectionFs(source: string) {
  const build = memo(
    (sel: string | null, hover: string | null, data: GridData, gen: GenerationData | undefined, pg: PowerGridData | undefined): FeatureStateSpec[] => {
      const states: Record<string, Record<string, FeatureStateValue>> = {};
      if (sel && sourceForId(data, gen, pg, sel) === source) (states[sel] ??= {}).selected = true;
      if (hover && sourceForId(data, gen, pg, hover) === source) (states[hover] ??= {}).hover = true;
      return [{ source, keys: ["selected", "hover"], states }];
    },
  );
  return (s: S) => build(s.app.selectedId, s.app.hoverId, s.data, s.gen, s.pg);
}

/** Tap = select the feature; hover = highlight it. */
const selectOnTap = (priority: number, kind: string, layers: string[]): Interaction => ({
  priority,
  kind,
  layers,
  pad: 0,
  hover: true,
  pick: (f: MapGeoJSONFeature) => (f.id != null ? { ref: String(f.id), label: String(f.properties?.name ?? f.id) } : null),
});

const layersOf = (all: ReturnType<typeof buildLayers>, ids: string[]) => all.filter((l) => ids.includes(l.id));

// ---- core grid ---------------------------------------------------------------------------------
const LINE_IDS = [LAYER.linesCasing, LAYER.linesSC, LAYER.linesDC];
const SS_IDS = [LAYER.substations, LAYER.ssLabels];
const pickLines = pickFor(LINE_IDS);
const pickSs = pickFor(SS_IDS);

const CORE_LINES: Def = {
  id: "core-lines",
  band: "grid",
  source: { kind: "geojson", id: SRC.lines, data: (s) => s.data.linesFc, options: { promoteId: "id" } },
  layers: (s) => layersOf(buildLayers(s.app.basemap), LINE_IDS),
  visible: (s) => s.preset.grid,
  spec: (s) => pickLines(gridSpecOf(s.app.filters), spotlightSpecOf(s)),
  featureState: selectionFs(SRC.lines),
  interaction: selectOnTap(20, "TRANSCO line", [LAYER.linesSC, LAYER.linesDC]),
};

const CORE_SS: Def = {
  id: "core-substations",
  band: "top",
  source: { kind: "geojson", id: SRC.substations, data: (s) => s.data.substationsFc, options: { promoteId: "id" } },
  layers: (s) => layersOf(buildLayers(s.app.basemap), SS_IDS),
  visible: (s) => s.preset.grid,
  spec: (s) => pickSs(gridSpecOf(s.app.filters), spotlightSpecOf(s)),
  featureState: selectionFs(SRC.substations),
  interaction: selectOnTap(10, "TRANSCO substation", [LAYER.substations]),
};

// ---- Network MIS themes (ride the core sources) ------------------------------------------------
const misSpecOf = memo((mm: MisMapState | null, basemap: AppState["basemap"]) => misThemeSpec(mm, basemap));
const misLinesFs = memo((spec: ReturnType<typeof misThemeSpec>) => [spec.lines]);
const misSsFs = memo((spec: ReturnType<typeof misThemeSpec>) => [spec.ss]);
const misSpec = (s: S) => misSpecOf(misStateOf(s), s.app.basemap);

const MIS_LINES: Def = {
  id: "mis-lines",
  band: "grid",
  source: { kind: "ride", on: SRC.lines },
  layers: misLineLayers,
  visible: (s) => s.preset.grid,
  spec: (s) => misSpec(s).layers,
  featureState: (s) => misLinesFs(misSpec(s)),
};

const MIS_SS: Def = {
  id: "mis-substations",
  band: "above-grid",
  source: { kind: "ride", on: SRC.substations },
  layers: misSsLayers,
  visible: (s) => s.preset.grid,
  spec: (s) => misSpec(s).layers,
  featureState: (s) => misSsFs(misSpec(s)),
};

// ---- generation plants (lazy) ------------------------------------------------------------------
const GEN_IDS = [LAYER.generation, LAYER.genLabels];
const pickGen = pickFor(GEN_IDS);
const GENERATION: Def = {
  id: "generation",
  band: "top",
  source: { kind: "geojson", id: SRC.generation, data: (s) => s.gen?.fc, options: { promoteId: "id" } },
  layers: (s) => buildGenerationLayers(s.app.basemap),
  visible: (s) => s.preset.generation && s.app.filters.showGeneration,
  spec: (s) => pickGen(gridSpecOf(s.app.filters)),
  featureState: selectionFs(SRC.generation),
  interaction: selectOnTap(30, "Generation plant", [LAYER.generation]),
};

// ---- power grid group: PGCIL lines + SS, railway traction, bulk-load (lazy) ---------------------
const pgOn = (s: S, cls: keyof FilterState["pgClasses"]) => s.preset.powergrid && s.app.filters.showPowerGrid && s.app.filters.pgClasses[cls];
const PG_LINES: Def = {
  id: "pg-lines",
  band: "top",
  source: { kind: "geojson", id: SRC.powergridLines, data: (s) => s.pg?.linesFc, options: { promoteId: "id" } },
  layers: (s) => buildPowerGridLayers(s.app.basemap).filter((l) => l.id === LAYER.pgLines),
  visible: (s) => pgOn(s, "powergrid"),
  featureState: selectionFs(SRC.powergridLines),
  interaction: selectOnTap(30, "POWERGRID line", [LAYER.pgLines]),
};
const PG_SS: Def = {
  id: "pg-substations",
  band: "top",
  source: { kind: "geojson", id: SRC.powergridSubstations, data: (s) => s.pg?.substationsFc, options: { promoteId: "id" } },
  layers: (s) => buildPowerGridLayers(s.app.basemap).filter((l) => l.id !== LAYER.pgLines),
  visible: (s) => pgOn(s, "powergrid"),
  featureState: selectionFs(SRC.powergridSubstations),
  interaction: selectOnTap(30, "POWERGRID substation", [LAYER.pgSubstations]),
};
const RAILWAY: Def = {
  id: "railway-substations",
  band: "top",
  source: { kind: "geojson", id: SRC.railwaySubstations, data: (s) => s.pg?.railwayFc, options: { promoteId: "id" } },
  layers: (s) => buildLoadLayers(s.app.basemap, SRC.railwaySubstations, LAYER.railwaySubstations, LAYER.railwayLabels, RAILWAY_COLOR),
  visible: (s) => pgOn(s, "railway"),
  featureState: selectionFs(SRC.railwaySubstations),
  interaction: selectOnTap(30, "Railway traction SS", [LAYER.railwaySubstations]),
};
const BULKLOAD: Def = {
  id: "bulkload-substations",
  band: "top",
  source: { kind: "geojson", id: SRC.bulkloadSubstations, data: (s) => s.pg?.bulkloadFc, options: { promoteId: "id" } },
  layers: (s) => buildLoadLayers(s.app.basemap, SRC.bulkloadSubstations, LAYER.bulkloadSubstations, LAYER.bulkloadLabels, BULKLOAD_COLOR),
  visible: (s) => pgOn(s, "bulkload"),
  featureState: selectionFs(SRC.bulkloadSubstations),
  interaction: selectOnTap(30, "Bulk-load / HT SS", [LAYER.bulkloadSubstations]),
};

// ---- live weather (lazy) -----------------------------------------------------------------------
const wxOn = (s: S, layer: "radar" | "cyclone") => s.preset.weather && weatherOn(s.app.filters, layer);
const cycloneFcOf = memo((wx: WeatherData) => cycloneFc(wx));
const radarSpecOf = memo((k: number) => radarOpacitySpec(k));
const riskSpecOf = memo((wx: WeatherData | undefined, data: GridData) => wxRiskSpec(wx ? wxRiskIds(wx, data.substations) : []));

const WX_RADAR: Def = {
  id: "wx-radar",
  band: "beneath",
  source: {
    kind: "raster",
    id: WX_SRC.radar,
    tiles: (s) => (s.wx?.radar ? [s.wx.radar.tileUrl] : undefined),
    options: RADAR_SOURCE_OPTIONS,
  },
  layers: radarLayers,
  visible: (s) => wxOn(s, "radar"),
  spec: (s) => radarSpecOf(s.app.layers.opacity.wx ?? 1),
};
const WX_CYCLONE_FILLS: Def = {
  id: "wx-cyclone-fills",
  band: "beneath",
  source: {
    kind: "computed",
    id: WX_SRC.cyclone,
    data: (s) => (s.wx ? cycloneFcOf(s.wx) : undefined),
    key: (s) => String(s.wx?.fetchedAt ?? ""),
  },
  layers: cycloneFillLayers,
  visible: (s) => wxOn(s, "cyclone"),
};
const WX_CYCLONE_LINES: Def = {
  id: "wx-cyclone-lines",
  band: "top",
  source: { kind: "ride", on: WX_SRC.cyclone },
  layers: cycloneLineLayers,
  visible: (s) => wxOn(s, "cyclone"),
};
const WX_RISK: Def = {
  id: "wx-risk-substations",
  band: "top",
  source: { kind: "ride", on: SRC.substations },
  layers: riskSubstationLayers,
  visible: (s) => wxOn(s, "cyclone"),
  spec: (s) => riskSpecOf(s.wx, s.data),
};

// ---- the full registry -------------------------------------------------------------------------
/**
 * Every map def, bottom → top within each band. `overlayData` reads the catalog overlays' loaded
 * GeoJSON (the `overlayLayer` resource).
 */
export function mapRegistry(overlayData: Parameters<typeof overlayRegistry>[0]): (s: S) => Def[] {
  const overlays = overlayRegistry(overlayData);
  const compose = memo((ov: LayerDef<S>[]): Def[] => {
    const pin = ov.filter((d) => d.band === "top");
    const rest = ov.filter((d) => d.band !== "top");
    return [
      WX_RADAR,
      WX_CYCLONE_FILLS,
      ...rest, // beneath: catalog overlays + focus highlight; above-grid: towers
      CORE_LINES,
      MIS_LINES,
      MIS_SS,
      CORE_SS,
      WX_RISK,
      GENERATION,
      PG_LINES,
      PG_SS,
      RAILWAY,
      BULKLOAD,
      WX_CYCLONE_LINES,
      ...pin, // the focus pin tops everything
    ];
  });
  return (s) => compose(overlays(s));
}
