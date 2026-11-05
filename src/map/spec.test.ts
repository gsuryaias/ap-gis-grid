import { describe, expect, it } from "vitest";
import { ENERGY_TYPES, type SubstationProps } from "../data/types.ts";
import type { WeatherData } from "../data/weather.ts";
import { freshFilters } from "../state/slices/filters.ts";
import { buildLayers, gridSpec, LAYER, spotlightSpec, SRC } from "./layers.ts";
import { MIS_LAYER, misThemeSpec, type MisMapState } from "./mis-layers.ts";
import { applySpec, mergeSpecs, sameValue, syncFeatureState } from "./spec.ts";
import { FakeMap } from "./testing/fake-map.ts";
import { weatherOn, WX_LAYER, wxRiskIds, wxRiskSpec } from "./weather-layers.ts";

function gridMap(): FakeMap {
  const m = new FakeMap();
  m.addSource(SRC.lines);
  m.addSource(SRC.substations);
  for (const l of buildLayers("light")) m.addLayer(l);
  m.addLayer({ id: MIS_LAYER.lines, type: "line", source: SRC.lines, layout: { visibility: "none" } });
  m.addLayer({ id: MIS_LAYER.ss, type: "circle", source: SRC.substations, layout: { visibility: "none" } });
  return m;
}

describe("sameValue / mergeSpecs", () => {
  it("compares style values structurally, treating null ≡ undefined", () => {
    expect(sameValue(["in", ["get", "v"], ["literal", [1, 2]]], ["in", ["get", "v"], ["literal", [1, 2]]])).toBe(true);
    expect(sameValue(["literal", [1, 2]], ["literal", [2, 1]])).toBe(false);
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue(0, null)).toBe(false);
    expect(sameValue(0.95, 0.95)).toBe(true);
  });

  it("merges paint per property and lets later visibility / filter win", () => {
    const m = mergeSpecs(
      { a: { visibility: "visible", filter: ["x"], paint: { p: 1, q: 1 } } },
      { a: { visibility: "none", paint: { q: 2 } }, b: { filter: null } },
    );
    expect(m).toEqual({ a: { visibility: "none", filter: ["x"], paint: { p: 1, q: 2 } }, b: { filter: null } });
  });
});

describe("applySpec", () => {
  it("writes only differences — a second apply makes zero writes", () => {
    const map = gridMap();
    const spec = mergeSpecs(gridSpec({ ...freshFilters(), circle: "Kadapa" }), spotlightSpec(null));
    expect(applySpec(map.api, spec)).toBeGreaterThan(0);
    map.writes = [];
    expect(applySpec(map.api, spec)).toBe(0);
    expect(map.writes).toEqual([]);
  });

  it("skips layers that aren't on the map (lazy overlays)", () => {
    const map = gridMap();
    applySpec(map.api, gridSpec(freshFilters()));
    expect(map.writes.some((w) => w.includes(LAYER.generation) || w.includes(LAYER.pgLines))).toBe(false);
  });

  it("treats an unset visibility as visible and a null filter as no filter", () => {
    const map = new FakeMap();
    map.addLayer({ id: "x", type: "circle", source: "s" });
    expect(applySpec(map.api, { x: { visibility: "visible", filter: null } })).toBe(0);
    expect(applySpec(map.api, { x: { visibility: "none" } })).toBe(1);
  });

  it("re-applies everything after a style reload re-adds the layers with defaults", () => {
    const map = gridMap();
    const spec = gridSpec({ ...freshFilters(), showLines: false });
    applySpec(map.api, spec);
    map.reloadStyle();
    for (const l of buildLayers("light")) map.addLayer(l);
    map.writes = [];
    expect(applySpec(map.api, spec)).toBeGreaterThan(0);
    expect(map.getLayoutProperty(LAYER.linesSC, "visibility")).toBe("none");
  });
});

describe("gridSpec", () => {
  it("default filters: every voltage + circuit, no region slice, core layers visible, overlays off", () => {
    const s = gridSpec(freshFilters());
    expect(s[LAYER.substations]).toEqual({
      filter: ["all", ["in", ["get", "voltage"], ["literal", [400, 220, 132]]]],
      visibility: "visible",
    });
    expect(s[LAYER.linesSC].filter).toEqual([
      "all",
      ["==", ["get", "circuit"], "SC"],
      ["in", ["get", "voltage"], ["literal", [400, 220, 132]]],
    ]);
    expect(s[LAYER.linesCasing].filter).toContainEqual(["in", ["get", "circuit"], ["literal", ["SC", "DC"]]]);
    expect(s[LAYER.generation].visibility).toBe("none");
    expect(s[LAYER.pgLines].visibility).toBe("none");
    expect(s[LAYER.railwaySubstations].visibility).toBe("none");
  });

  it("voltage, circle and coastal slices AND onto every core layer", () => {
    const f = freshFilters();
    const s = gridSpec({ ...f, voltages: { 400: true, 220: false, 132: true }, circle: "Kadapa", coastalBand: 1 });
    const coast = ["all", ["has", "coastalBand"], ["<=", ["get", "coastalBand"], 1]];
    for (const id of [LAYER.linesCasing, LAYER.linesSC, LAYER.linesDC, LAYER.substations, LAYER.ssLabels]) {
      const parts = s[id].filter as unknown[];
      expect(parts).toContainEqual(["in", ["get", "voltage"], ["literal", [400, 132]]]);
      expect(parts).toContainEqual(["==", ["get", "circle"], "Kadapa"]);
      expect(parts).toContainEqual(coast);
    }
  });

  it("circuit toggles hide their line layer; showLines / showSubstations gate the core layers", () => {
    const f = freshFilters();
    const s = gridSpec({ ...f, circuits: { SC: true, DC: false }, showSubstations: false });
    expect(s[LAYER.linesSC].visibility).toBe("visible");
    expect(s[LAYER.linesDC].visibility).toBe("none");
    expect(s[LAYER.substations].visibility).toBe("none");
    expect(s[LAYER.ssLabels].visibility).toBe("none");
    expect(gridSpec({ ...f, showLines: false })[LAYER.linesCasing].visibility).toBe("none");
  });

  it("generation: energy sub-filter; power grid: master × per-class", () => {
    const f = freshFilters();
    const g = gridSpec({ ...f, showGeneration: true, genTypes: { ...f.genTypes, Solar: false } });
    expect(g[LAYER.generation].visibility).toBe("visible");
    expect(g[LAYER.generation].filter).toEqual([
      "in", ["get", "energy"], ["literal", ENERGY_TYPES.filter((t) => t !== "Solar")],
    ]);
    expect(g[LAYER.genLabels].filter).toEqual(g[LAYER.generation].filter);
    const p = gridSpec({ ...f, showPowerGrid: true, pgClasses: { ...f.pgClasses, railway: false } });
    expect(p[LAYER.pgSubstations].visibility).toBe("visible");
    expect(p[LAYER.railwaySubstations].visibility).toBe("none");
    expect(p[LAYER.bulkloadLabels].visibility).toBe("visible");
  });
});

describe("spotlightSpec", () => {
  it("null restores the exact default opacities — zero writes on a freshly-built grid", () => {
    const map = gridMap();
    expect(applySpec(map.api, spotlightSpec(null))).toBe(0);
  });

  it("dims everything outside the id sets, independent of Set order", () => {
    const a = spotlightSpec({ ssIds: new Set(["s-2", "s-1"]), lineIds: new Set(["l-9", "l-1"]) });
    const b = spotlightSpec({ ssIds: new Set(["s-1", "s-2"]), lineIds: new Set(["l-1", "l-9"]) });
    expect(a).toEqual(b);
    expect(a[LAYER.substations].paint!["circle-opacity"]).toEqual([
      "case", ["in", ["get", "id"], ["literal", ["s-1", "s-2"]]], 0.95, 0.15,
    ]);
    expect(a[LAYER.linesSC].paint!["line-opacity"]).toEqual([
      "case", ["in", ["get", "id"], ["literal", ["l-1", "l-9"]]], 0.95, 0.12,
    ]);
  });
});

const misState = (over: Partial<MisMapState> = {}): MisMapState => ({
  theme: "age",
  lineClass: { "l-1": 0, "l-2": 3 },
  ssClass: {},
  ssValue: {},
  scopeSsIds: null,
  scopeLineIds: null,
  ...over,
});

describe("misThemeSpec", () => {
  it("no theme / voltage: both layers hidden, every owned state cleared", () => {
    for (const st of [null, misState({ theme: "voltage" })]) {
      const s = misThemeSpec(st, "light");
      expect(s.layers[MIS_LAYER.lines]).toEqual({ visibility: "none" });
      expect(s.layers[MIS_LAYER.ss]).toEqual({ visibility: "none" });
      expect(s.lines.states).toEqual({});
      expect(s.ss).toMatchObject({ keys: ["misC", "misV"], states: {} });
    }
  });

  it("age theme: classes to line feature-state, scope as a filter, ramp follows the basemap", () => {
    const s = misThemeSpec(misState({ scopeLineIds: ["l-1"] }), "light");
    expect(s.lines.states).toEqual({ "l-1": { misC: 0 }, "l-2": { misC: 3 } });
    expect(s.layers[MIS_LAYER.lines].filter).toEqual(["in", ["get", "id"], ["literal", ["l-1"]]]);
    expect(s.layers[MIS_LAYER.lines].visibility).toBe("visible");
    expect(s.layers[MIS_LAYER.ss].visibility).toBe("none");
    expect(s.layers[MIS_LAYER.ss].filter).toBeNull();
    const dark = misThemeSpec(misState(), "dark");
    expect(dark.layers[MIS_LAYER.lines].paint).not.toEqual(s.layers[MIS_LAYER.lines].paint);
  });

  it("downstream theme: proportional symbols from misV", () => {
    const s = misThemeSpec(misState({ theme: "downstream", lineClass: {}, ssValue: { "s-1": 16 } }), "light");
    expect(s.ss.states).toEqual({ "s-1": { misV: 16 } });
    expect(s.layers[MIS_LAYER.ss].visibility).toBe("visible");
    expect(s.layers[MIS_LAYER.lines].visibility).toBe("none");
    expect(JSON.stringify(s.layers[MIS_LAYER.ss].paint!["circle-radius"])).toContain("sqrt");
  });

  it("n1 theme merges ssClass + ssValue per substation", () => {
    const s = misThemeSpec(misState({ theme: "n1", ssClass: { "s-1": 0 }, ssValue: { "s-1": 2, "s-2": 5 } }), "light");
    expect(s.ss.states).toEqual({ "s-1": { misC: 0, misV: 2 }, "s-2": { misV: 5 } });
  });
});

describe("syncFeatureState", () => {
  it("diffs against the last write, leaves keys it doesn't own alone, and is a no-op when unchanged", () => {
    const map = gridMap();
    map.setFeatureState({ source: SRC.lines, id: "l-1" }, { hover: true });
    map.writes = [];
    const a = misThemeSpec(misState(), "light").lines;
    expect(syncFeatureState(map.api, "mis", a)).toBe(2);
    expect(syncFeatureState(map.api, "mis", a)).toBe(0);

    const b = misThemeSpec(misState({ lineClass: { "l-1": 0, "l-3": 1 } }), "light").lines;
    map.writes = [];
    syncFeatureState(map.api, "mis", b);
    expect(map.writes.sort()).toEqual([`fs-rm:${SRC.lines}:l-2:misC`, `fs:${SRC.lines}:l-3`]);
    expect(map.state(SRC.lines, "l-1")).toEqual({ hover: true, misC: 0 });

    syncFeatureState(map.api, "mis", misThemeSpec(null, "light").lines);
    expect(map.state(SRC.lines, "l-1")).toEqual({ hover: true });
    expect(map.state(SRC.lines, "l-3")).toEqual({});
  });

  it("re-writes every state once the source is replaced by a style reload", () => {
    const map = gridMap();
    const spec = misThemeSpec(misState(), "light").lines;
    syncFeatureState(map.api, "mis", spec);
    map.reloadStyle();
    expect(syncFeatureState(map.api, "mis", spec)).toBe(0); // source gone → nothing to write
    map.addSource(SRC.lines);
    expect(syncFeatureState(map.api, "mis", spec)).toBe(2);
    expect(map.state(SRC.lines, "l-2")).toEqual({ misC: 3 });
  });
});

describe("weather specs", () => {
  it("a weather layer is on = master toggle × its sub-toggle", () => {
    const f = freshFilters();
    expect(weatherOn(f, "radar")).toBe(false);
    expect(weatherOn(f, "cyclone")).toBe(false);
    const on = { ...f, showWeather: true, wxLayers: { ...f.wxLayers, radar: false } };
    expect(weatherOn(on, "radar")).toBe(false);
    expect(weatherOn(on, "cyclone")).toBe(true);
  });

  it("the risk halo filters to exactly the substations inside a cone", () => {
    const ss = (id: string, lng: number, lat: number) => ({ id, lng, lat }) as SubstationProps;
    const cone = {
      type: "Polygon" as const,
      coordinates: [[[80, 15], [82, 15], [82, 17], [80, 17], [80, 15]]],
    };
    const wx = { cyclones: [{ conePolygons: [cone] }] } as unknown as WeatherData;
    const ids = wxRiskIds(wx, [ss("s-b", 81, 16), ss("s-out", 78, 13), ss("s-a", 80.5, 15.5)]);
    expect(ids.sort()).toEqual(["s-a", "s-b"]);
    expect(wxRiskSpec(["s-b", "s-a"])).toEqual({
      [WX_LAYER.riskSubstations]: { filter: ["in", ["get", "id"], ["literal", ["s-a", "s-b"]]] },
    });
    expect(wxRiskIds({ cyclones: [] } as unknown as WeatherData, [ss("s-a", 81, 16)])).toEqual([]);
  });
});
