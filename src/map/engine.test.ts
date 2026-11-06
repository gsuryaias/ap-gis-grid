import { afterAll, describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { GenerationData, GridData } from "../data/types.ts";
import type { WeatherData } from "../data/weather.ts";
import { DISCOM_DEFS, refDef, TOWER_DEFS, type OverlayDef } from "../overlays/catalog.ts";
import { freshFilters } from "../state/slices/filters.ts";
import type { AppState } from "../state/types.ts";
import { attachEngine, SENTINEL } from "./engine.ts";
import { ATLAS_LAYERS } from "./layer-presets.ts";
import { LAYER, SRC } from "./layers.ts";
import { MIS_LAYER, type MisMapState } from "./mis-layers.ts";
import { mapRegistry, type MapState } from "./registry/core.ts";
import { FOCUS_LAYER, overlayLayerIds, overlaySourceId } from "./registry/overlays.ts";
import { FakeMap } from "./testing/fake-map.ts";
import { WX_LAYER, WX_SRC } from "./weather-layers.ts";

// Stubbed at load time: the registry-invariant suite builds its fixture while collecting.
vi.stubGlobal("requestAnimationFrame", () => 1);
afterAll(() => vi.unstubAllGlobals());

const FC: FeatureCollection = { type: "FeatureCollection", features: [] };
const FOREST = refDef({
  id: "forest", group: "Environment", label: "Forest", geometry: "polygon", file: "ref/forest.geojson",
  count: 1, bytes: 1, labelField: "name", fields: [], source: "RTGS", vintage: "2023", note: null,
});
const NH = refDef({
  id: "national-highways", group: "Transport", label: "NH", geometry: "line", file: "ref/nh.geojson",
  count: 1, bytes: 1, labelField: null, fields: [], source: "RTGS", vintage: "2023", note: null,
});
const TOWERS = TOWER_DEFS[0];
const [DLINES, DSS] = DISCOM_DEFS;
const L = overlayLayerIds;

const DATA = {
  linesFc: FC,
  substationsFc: FC,
  substations: [],
  byId: new Map([
    ["s-1", { id: "s-1", kind: "substation" }],
    ["l-1", { id: "l-1", kind: "line" }],
  ]),
} as unknown as GridData;
const GEN = { fc: FC, byId: new Map([["g-1", { id: "g-1" }]]) } as unknown as GenerationData;
const wxAt = (fetchedAt: number, tileUrl = "https://tiles/a/{z}/{x}/{y}.png") =>
  ({ cyclones: [], radar: { tileUrl }, fetchedAt }) as unknown as WeatherData;

function setup(opts: { enabled?: string[]; loaded?: string[] } = {}) {
  const map = new FakeMap();
  const defs: Record<string, OverlayDef> = Object.fromEntries([DLINES, DSS, TOWERS, NH, FOREST].map((d) => [d.id, d]));
  const app = {
    basemap: "light",
    filters: freshFilters(),
    selectedId: null,
    hoverId: null,
    spotlight: false,
    workspace: "atlas",
    workspaceContext: { misMap: null },
    layers: {
      defs,
      enabled: Object.fromEntries((opts.enabled ?? Object.keys(defs)).map((id) => [id, true])),
      discoms: { APSPDCL: true, APEPDCL: true, APCPDCL: true },
      focus: null,
    },
  } as unknown as AppState;
  const ctl = {
    map,
    loaded: new Set(opts.loaded ?? Object.keys(defs)),
    state: { app, data: DATA, gen: undefined, pg: undefined, wx: undefined, preset: ATLAS_LAYERS } as MapState,
    reloads: 0,
  };
  const engine = attachEngine(map.api, {
    getState: () => ctl.state,
    subscribe: () => () => {},
    defs: mapRegistry((id) => (ctl.loaded.has(id) ? FC : undefined)),
    onStyleReload: () => ctl.reloads++,
  });
  const set = (fn: (s: MapState) => Partial<MapState>) => (ctl.state = { ...ctl.state, ...fn(ctl.state) });
  const setApp = (patch: Record<string, unknown>) => set((s) => ({ app: { ...s.app, ...patch } as AppState }));
  return { map, engine, ctl, set, setApp };
}

/** Assert ids appear in this order (bottom → top) in the map's layer stack. */
function expectOrder(map: FakeMap, ids: string[]) {
  const order = map.getLayersOrder();
  for (const id of ids) expect(order, `${id} on map`).toContain(id);
  const pos = ids.map((id) => order.indexOf(id));
  expect(pos, ids.join(" < ")).toEqual([...pos].sort((a, b) => a - b));
}

/** Reconcile until settled (a style reload can take two passes: mount, then order). */
function settle(engine: { reconcile: () => number }) {
  for (let i = 0; i < 5; i++) if (engine.reconcile() === 0) return;
  throw new Error("engine did not settle");
}

describe("map engine", () => {
  it("mounts every def into its band, in order", () => {
    const { map, engine } = setup();
    engine.reconcile();
    expectOrder(map, [
      L("forest").fill, L("forest").line, L("discom-lines").line, L("national-highways").line, L("discom-ss").circle,
      FOCUS_LAYER.lines, FOCUS_LAYER.ss, SENTINEL.beneath,
      LAYER.linesCasing, LAYER.linesSC, LAYER.linesDC, MIS_LAYER.lines, SENTINEL.grid,
      L(TOWERS.id).circle, MIS_LAYER.ss, SENTINEL["above-grid"],
      LAYER.substations, LAYER.ssLabels, WX_LAYER.riskSubstations, FOCUS_LAYER.point, SENTINEL.top,
    ]);
    expect(map.getLayersOrder().at(-1)).toBe(SENTINEL.top);
    // Lazy groups with no data (or switched off) are not mounted; a ride waits for its source.
    expect(map.getLayer(LAYER.generation)).toBeUndefined();
    expect(map.getLayer(WX_LAYER.radar)).toBeUndefined();
    expect(map.getLayer(FOCUS_LAYER.lines11)).toBeUndefined();
  });

  it("a second reconcile makes zero writes", () => {
    const { map, engine } = setup();
    settle(engine);
    map.writes = [];
    expect(engine.reconcile()).toBe(0);
    expect(map.writes).toEqual([]);
  });

  it("hover touches only feature-state, and selection moves between sources", () => {
    const { map, engine, setApp } = setup();
    settle(engine);
    map.writes = [];
    setApp({ hoverId: "s-1" });
    expect(engine.reconcile()).toBe(1);
    expect(map.writes).toEqual([`fs:${SRC.substations}:s-1`]);
    expect(map.state(SRC.substations, "s-1")).toEqual({ hover: true });

    setApp({ hoverId: null, selectedId: "l-1" });
    map.writes = [];
    engine.reconcile();
    expect(map.writes.sort()).toEqual([`fs-rm:${SRC.substations}:s-1:hover`, `fs:${SRC.lines}:l-1`].sort());
    expect(map.state(SRC.lines, "l-1")).toEqual({ selected: true });
  });

  it("slicing filters rewrite only the core layers' filters / visibility", () => {
    const { map, engine, setApp, ctl } = setup();
    settle(engine);
    map.writes = [];
    setApp({ filters: { ...ctl.state.app.filters, circuits: { SC: true, DC: false }, circle: "Kadapa" } });
    engine.reconcile();
    const touched = new Set(map.writes.map((w) => w.split(":")[1]));
    expect([...touched].sort()).toEqual([LAYER.linesCasing, LAYER.linesDC, LAYER.linesSC, LAYER.ssLabels, LAYER.substations].sort());
    expect(map.getLayoutProperty(LAYER.linesDC, "visibility")).toBe("none");
  });

  it("the DISCOM sub-filter only rewrites the DISCOM layers' filters", () => {
    const { map, engine, setApp, ctl } = setup();
    settle(engine);
    map.writes = [];
    setApp({ layers: { ...ctl.state.app.layers, discoms: { APSPDCL: true, APEPDCL: true, APCPDCL: false } } });
    engine.reconcile();
    expect(map.writes.sort()).toEqual(
      [`filter:${L("discom-lines").line}`, `filter:${L("discom-ss").circle}`, `filter:${L("discom-ss").label}`].sort(),
    );
  });

  it("an overlay mounts once shown + loaded; switching it off only hides it", () => {
    const { map, engine, setApp, ctl } = setup({ enabled: ["discom-lines"], loaded: [] });
    settle(engine);
    expect(map.getSource(overlaySourceId("discom-lines"))).toBeUndefined();
    ctl.loaded.add("discom-lines");
    settle(engine);
    expect(map.getLayer(L("discom-lines").line)).toBeDefined();
    expect(map.getSource(overlaySourceId("forest"))).toBeUndefined(); // not enabled → never mounted

    setApp({ layers: { ...ctl.state.app.layers, enabled: {} } });
    map.writes = [];
    engine.reconcile();
    expect(map.writes).toEqual([`vis:${L("discom-lines").line}`]);
    expect(map.getSource(overlaySourceId("discom-lines"))).toBeDefined();
  });

  it("lazy generation mounts when switched on with data, and is hover-highlightable", () => {
    const { map, engine, set, setApp, ctl } = setup();
    settle(engine);
    setApp({ filters: { ...ctl.state.app.filters, showGeneration: true } });
    settle(engine);
    expect(map.getLayer(LAYER.generation)).toBeUndefined(); // no data yet
    set(() => ({ gen: GEN }));
    settle(engine);
    expectOrder(map, [LAYER.substations, LAYER.generation, LAYER.genLabels, FOCUS_LAYER.point]);
    setApp({ hoverId: "g-1" });
    map.writes = [];
    engine.reconcile();
    expect(map.writes).toEqual([`fs:${SRC.generation}:g-1`]);
  });

  it("weather: radar tiles swap in place, cyclone data re-uploads only on a new fetch", () => {
    const { map, engine, set, setApp, ctl } = setup();
    setApp({ filters: { ...ctl.state.app.filters, showWeather: true } });
    set(() => ({ wx: wxAt(1) }));
    settle(engine);
    expectOrder(map, [WX_LAYER.radar, WX_LAYER.cycloneAlert, WX_LAYER.cycloneCone, L("forest").fill, LAYER.linesCasing]);
    expectOrder(map, [LAYER.substations, WX_LAYER.riskSubstations, WX_LAYER.cycloneTrack, FOCUS_LAYER.point]);
    map.writes = [];
    set(() => ({ wx: wxAt(1) })); // a new object, same fetch
    expect(engine.reconcile()).toBe(0);
    set(() => ({ wx: wxAt(2, "https://tiles/b/{z}/{x}/{y}.png") }));
    engine.reconcile();
    expect(map.writes.sort()).toEqual([`set-data:${WX_SRC.cyclone}`, `set-tiles:${WX_SRC.radar}`]);
  });

  it("the MIS theme lands as feature-state + filter on the ride layers", () => {
    const { map, engine, setApp } = setup();
    settle(engine);
    const misMap: MisMapState = {
      theme: "age", lineClass: { "l-1": 2 }, ssClass: {}, ssValue: {}, scopeSsIds: null, scopeLineIds: ["l-1"],
    };
    setApp({ workspace: "mis", workspaceContext: { misMap } });
    engine.reconcile();
    expect(map.state(SRC.lines, "l-1")).toEqual({ misC: 2 });
    expect(map.getLayoutProperty(MIS_LAYER.lines, "visibility")).toBe("visible");
    setApp({ workspace: "atlas" });
    engine.reconcile();
    expect(map.state(SRC.lines, "l-1")).toEqual({});
    expect(map.getLayoutProperty(MIS_LAYER.lines, "visibility")).toBe("none");
  });

  it("re-mounts everything after a style reload (and tells the caller), then settles", () => {
    const { map, engine, ctl, setApp } = setup();
    setApp({ selectedId: "s-1" });
    settle(engine);
    expect(ctl.reloads).toBe(1);
    const before = map.getLayersOrder();
    map.reloadStyle();
    settle(engine);
    expect(ctl.reloads).toBe(2);
    expect(map.getLayersOrder()).toEqual(before);
    expect(map.state(SRC.substations, "s-1")).toEqual({ selected: true });
  });

  it("layers added outside the engine above `top` get `top` moved back over them", () => {
    const { map, engine } = setup();
    settle(engine);
    map.addLayer({ id: "measure-line", type: "line", source: "src-measure" });
    settle(engine);
    expect(map.getLayersOrder().at(-1)).toBe(SENTINEL.top);
  });

  it("focus: filters the highlight layers and re-uploads the pin only when it moves", () => {
    const { map, engine, setApp, ctl } = setup();
    settle(engine);
    map.writes = [];
    const focus = { lines: ["dl-1"], ss: ["ds-ep-2"], point: [81, 16] as [number, number] };
    setApp({ layers: { ...ctl.state.app.layers, focus } });
    engine.reconcile();
    expect(map.writes.sort()).toEqual([`filter:${FOCUS_LAYER.lines}`, `filter:${FOCUS_LAYER.ss}`, "set-data:ov-focus-point-src"].sort());
    setApp({ layers: { ...ctl.state.app.layers, focus: { ...focus, point: [81, 16] } } });
    map.writes = [];
    engine.reconcile();
    expect(map.writes.filter((w) => w.startsWith("set-data"))).toEqual([]);
  });

  it("bails while the style is loading (idle retries)", () => {
    const { map, engine } = setup();
    map.styleLoaded = false;
    expect(engine.reconcile()).toBe(0);
    expect(map.getLayer(SENTINEL.top)).toBeUndefined();
  });
});

describe("map registry invariants", () => {
  const { ctl } = setup();
  const defs = mapRegistry(() => FC)(ctl.state);

  it("def ids and style-layer ids are unique", () => {
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
    const layerIds = defs.flatMap((d) => d.layers(ctl.state).map((l) => l.id));
    expect(new Set(layerIds).size).toBe(layerIds.length);
  });

  it("every tappable layer belongs to its def; priorities follow tower > SS > line > plant/PG > overlays", () => {
    const pri: Record<string, number> = {};
    for (const d of defs) {
      if (!d.interaction) continue;
      const own = d.layers(ctl.state).map((l) => l.id);
      expect(d.interaction.layers.length, d.id).toBeGreaterThan(0);
      for (const id of d.interaction.layers) expect(own, d.id).toContain(id);
      pri[d.id] = d.interaction.priority;
    }
    expect(pri[TOWERS.id]).toBeLessThan(pri["core-substations"]);
    expect(pri["core-substations"]).toBeLessThan(pri["core-lines"]);
    expect(pri["core-lines"]).toBeLessThan(pri.generation);
    expect(pri.generation).toBeLessThan(pri["discom-ss"]);
    expect(pri["discom-ss"]).toBeLessThan(pri["discom-lines"]);
    expect(pri["discom-lines"]).toBeLessThan(pri.forest);
    expect(pri["national-highways"]).toBe(pri["discom-lines"]);
  });

  it("outline-only polygons are not tappable; dark basemaps flip overlay colours", () => {
    const outline = refDef({ ...FOREST, id: "districts", group: "Boundaries" });
    expect(outline.style.fillOpacity).toBeUndefined();
    const st = { ...ctl.state, app: { ...ctl.state.app, layers: { ...ctl.state.app.layers, defs: { districts: outline } } } as AppState };
    expect(mapRegistry(() => FC)(st).find((d) => d.id === "districts")!.interaction).toBeUndefined();
    const ss = defs.find((d) => d.id === "discom-ss")!;
    const dark = { ...ctl.state, app: { ...ctl.state.app, basemap: "dark" } as AppState };
    expect(JSON.stringify(ss.layers(dark))).not.toEqual(JSON.stringify(ss.layers(ctl.state)));
  });
});
