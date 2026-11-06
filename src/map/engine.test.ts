import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import { DISCOM_DEFS, refDef, TOWER_DEFS, type OverlayDef } from "../overlays/catalog.ts";
import { attachEngine, SENTINEL } from "./engine.ts";
import { buildLayers, LAYER, SRC } from "./layers.ts";
import { FOCUS_LAYER, overlayLayerIds, overlayRegistry, overlaySourceId, type OverlayRegistryState } from "./registry/overlays.ts";
import { FakeMap } from "./testing/fake-map.ts";

beforeAll(() => vi.stubGlobal("requestAnimationFrame", () => 1));
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

function setup(opts: { grid?: boolean; enabled?: string[]; loaded?: string[] } = {}) {
  const map = new FakeMap();
  if (opts.grid !== false) addGrid(map);
  const defs: Record<string, OverlayDef> = Object.fromEntries([DLINES, DSS, TOWERS, NH, FOREST].map((d) => [d.id, d]));
  const state: OverlayRegistryState = {
    basemap: "light",
    layers: {
      defs,
      enabled: Object.fromEntries((opts.enabled ?? Object.keys(defs)).map((id) => [id, true])),
      discoms: { APSPDCL: true, APEPDCL: true, APCPDCL: true },
      focus: null,
    },
  };
  const loaded = new Set(opts.loaded ?? Object.keys(defs));
  const ctl = { state, loaded, map };
  const engine = attachEngine(map.api, {
    getState: () => ctl.state,
    subscribe: () => () => {},
    defs: overlayRegistry((id) => (ctl.loaded.has(id) ? FC : undefined)),
  });
  return { ...ctl, ctl, engine, set: (fn: (s: OverlayRegistryState) => OverlayRegistryState) => (ctl.state = fn(ctl.state)) };
}

function addGrid(map: FakeMap) {
  if (!map.getSource(SRC.lines)) map.addSource(SRC.lines);
  if (!map.getSource(SRC.substations)) map.addSource(SRC.substations);
  for (const l of buildLayers("light")) map.addLayer(l);
}

/** Assert ids appear in this order (bottom → top) in the map's layer stack. */
function expectOrder(map: FakeMap, ids: string[]) {
  const order = map.getLayersOrder();
  for (const id of ids) expect(order, `${id} on map`).toContain(id);
  const pos = ids.map((id) => order.indexOf(id));
  expect(pos, ids.join(" < ")).toEqual([...pos].sort((a, b) => a - b));
}

const L = overlayLayerIds;

describe("map engine — overlays", () => {
  it("mounts enabled + loaded overlays into their bands, in cartographic order", () => {
    const { map, engine } = setup();
    engine.reconcile();
    expectOrder(map, [
      L("forest").fill, L("forest").line, L("discom-lines").line, L("national-highways").line, L("discom-ss").circle,
      L("discom-ss").label, FOCUS_LAYER.lines, FOCUS_LAYER.ss, SENTINEL.beneath, LAYER.linesCasing, LAYER.linesDC,
      SENTINEL.grid, L(TOWERS.id).circle, L(TOWERS.id).label, SENTINEL["above-grid"], LAYER.substations, FOCUS_LAYER.point, SENTINEL.top,
    ]);
    expect(map.getLayersOrder().at(-1)).toBe(SENTINEL.top);
    // The focus highlight on the 11 kV source waits for that source.
    expect(map.getLayer(FOCUS_LAYER.lines11)).toBeUndefined();
  });

  it("a second reconcile makes zero writes", () => {
    const { map, engine } = setup();
    engine.reconcile();
    map.writes = [];
    expect(engine.reconcile()).toBe(0);
    expect(map.writes).toEqual([]);
  });

  it("the DISCOM sub-filter only rewrites the DISCOM layers' filters", () => {
    const { map, engine, set } = setup();
    engine.reconcile();
    map.writes = [];
    set((s) => ({ ...s, layers: { ...s.layers, discoms: { ...s.layers.discoms, APCPDCL: false } } }));
    engine.reconcile();
    expect(map.writes.sort()).toEqual(
      [`filter:${L("discom-lines").line}`, `filter:${L("discom-ss").circle}`, `filter:${L("discom-ss").label}`].sort(),
    );
    expect(map.getFilter(L("discom-ss").circle)).toEqual(["in", ["get", "discom"], ["literal", ["APSPDCL", "APEPDCL"]]]);
  });

  it("switching an overlay off hides it (the source stays); nothing mounts until shown + loaded", () => {
    const { map, engine, set, ctl } = setup({ enabled: ["discom-lines"], loaded: [] });
    engine.reconcile();
    expect(map.getSource(overlaySourceId("discom-lines"))).toBeUndefined();
    ctl.loaded.add("discom-lines");
    engine.reconcile();
    expect(map.getLayer(L("discom-lines").line)).toBeDefined();
    expect(map.getLayoutProperty(L("discom-lines").line, "visibility") ?? "visible").toBe("visible");
    expect(map.getSource(overlaySourceId("forest"))).toBeUndefined(); // not enabled → never mounted

    set((s) => ({ ...s, layers: { ...s.layers, enabled: {} } }));
    map.writes = [];
    engine.reconcile();
    expect(map.writes).toEqual([`vis:${L("discom-lines").line}`]);
    expect(map.getSource(overlaySourceId("discom-lines"))).toBeDefined();
  });

  it("re-mounts everything after a style reload, then settles", () => {
    const { map, engine } = setup();
    engine.reconcile();
    const before = map.getLayersOrder();
    map.reloadStyle();
    addGrid(map); // MapPane re-adds the core grid on styledata
    engine.reconcile();
    engine.reconcile();
    expect(map.getLayersOrder()).toEqual(before);
    map.writes = [];
    expect(engine.reconcile()).toBe(0);
  });

  it("keeps bands right when the grid is added after the overlays (first load)", () => {
    const { map, engine } = setup({ grid: false });
    engine.reconcile();
    addGrid(map); // appended on top of everything
    engine.reconcile();
    expectOrder(map, [
      L("discom-lines").line, SENTINEL.beneath, LAYER.linesCasing, LAYER.linesDC, SENTINEL.grid,
      L(TOWERS.id).circle, SENTINEL["above-grid"], LAYER.substations, LAYER.ssLabels, FOCUS_LAYER.point, SENTINEL.top,
    ]);
    map.writes = [];
    expect(engine.reconcile()).toBe(0);
  });

  it("layers added outside the engine above `top` get `top` moved back over them", () => {
    const { map, engine } = setup();
    engine.reconcile();
    map.addLayer({ id: "measure-line", type: "line", source: "src-measure" });
    engine.reconcile();
    expect(map.getLayersOrder().at(-1)).toBe(SENTINEL.top);
    map.writes = [];
    expect(engine.reconcile()).toBe(0);
  });

  it("focus: filters the highlight layers and re-uploads the pin only when it moves", () => {
    const { map, engine, set } = setup();
    engine.reconcile();
    map.writes = [];
    const focus = { lines: ["dl-1"], ss: ["ds-ep-2"], point: [81, 16] as [number, number] };
    set((s) => ({ ...s, layers: { ...s.layers, focus } }));
    engine.reconcile();
    expect(map.writes.sort()).toEqual([`filter:${FOCUS_LAYER.lines}`, `filter:${FOCUS_LAYER.ss}`, "set-data:ov-focus-point-src"].sort());
    expect(map.getFilter(FOCUS_LAYER.lines)).toEqual(["in", ["get", "id"], ["literal", ["dl-1"]]]);
    // Same pin, new list object → no re-upload.
    set((s) => ({ ...s, layers: { ...s.layers, focus: { ...focus, point: [81, 16] } } }));
    map.writes = [];
    expect(engine.reconcile()).toBe(0);
  });

  it("bails while the style is loading (idle retries)", () => {
    const { map, engine } = setup();
    map.styleLoaded = false;
    expect(engine.reconcile()).toBe(0);
    expect(map.getLayer(SENTINEL.top)).toBeUndefined();
  });
});

describe("overlay registry", () => {
  it("orders polygons < lines < points, then the focus defs; towers go above the grid lines", () => {
    const { state } = setup();
    const defs = overlayRegistry(() => FC)(state);
    expect(defs.map((d) => d.id)).toEqual([
      "forest", "discom-lines", "national-highways", "discom-ss", TOWERS.id,
      FOCUS_LAYER.lines, FOCUS_LAYER.ss, FOCUS_LAYER.lines11, FOCUS_LAYER.point,
    ]);
    expect(defs.find((d) => d.id === TOWERS.id)!.band).toBe("above-grid");
    expect(defs.find((d) => d.id === FOCUS_LAYER.point)!.band).toBe("top");
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
  });

  it("outline-only polygons get no fill layer; dark basemaps flip the label + stroke colours", () => {
    const { state } = setup();
    const defs = overlayRegistry(() => FC)(state);
    const nh = defs.find((d) => d.id === "national-highways")!;
    expect(nh.layers(state).map((l) => l.id)).toEqual([L("national-highways").line]);
    const ss = defs.find((d) => d.id === "discom-ss")!;
    const light = JSON.stringify(ss.layers(state));
    const dark = JSON.stringify(ss.layers({ ...state, basemap: "dark" }));
    expect(dark).not.toEqual(light);
  });
});
