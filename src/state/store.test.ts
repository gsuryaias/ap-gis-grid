import { afterEach, describe, expect, it, vi } from "vitest";
import { useOverlayStore } from "../overlays/store.ts";
import { layersStorage, LAYERS_STORAGE_KEY, mergeLayers, parseStoredLayers, partializeLayers } from "./slices/layers.ts";
import { useAppStore } from "./store.ts";

function memoryStorage(init: Record<string, string> = {}): Storage & { writes: number } {
  const m = new Map(Object.entries(init));
  return {
    writes: 0,
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem(k: string, v: string) {
      this.writes++;
      m.set(k, v);
    },
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("persisted overlay choices (legacy apgg-overlays-v1)", () => {
  it("reads the old raw shape, a zustand envelope, and survives junk", () => {
    expect(parseStoredLayers({ enabled: ["discom-ss", "ref:districts"], discoms: ["APEPDCL"] })).toEqual({
      enabled: ["discom-ss", "ref:districts"],
      discoms: ["APEPDCL"],
    });
    expect(parseStoredLayers({ state: { enabled: ["towers-400"], discoms: [] }, version: 1 })).toEqual({
      enabled: ["towers-400"],
      discoms: [],
    });
    expect(parseStoredLayers({ enabled: [1, "", "x", "x"], discoms: ["NOPE", "APSPDCL"] })).toEqual({
      enabled: ["x"],
      discoms: ["APSPDCL"],
    });
    expect(parseStoredLayers(null)).toBeNull();
    expect(parseStoredLayers("nope")).toBeNull();
  });

  it("storage adapter keeps the raw on-disk shape and skips no-op writes", () => {
    const mem = memoryStorage({ [LAYERS_STORAGE_KEY]: JSON.stringify({ enabled: ["discom-lines"], discoms: ["APCPDCL"] }) });
    const st = layersStorage(() => mem);
    const got = st.getItem(LAYERS_STORAGE_KEY);
    expect(got).toEqual({ state: { enabled: ["discom-lines"], discoms: ["APCPDCL"] }, version: 1 });
    // Writing back the same thing is a no-op…
    st.setItem(LAYERS_STORAGE_KEY, { state: { enabled: ["discom-lines"], discoms: ["APCPDCL"] }, version: 1 });
    expect(mem.writes).toBe(0);
    // …a change is written in the legacy raw shape (readable by older builds).
    st.setItem(LAYERS_STORAGE_KEY, { state: { enabled: [], discoms: ["APCPDCL"] }, version: 1 });
    expect(mem.writes).toBe(1);
    expect(JSON.parse(mem.getItem(LAYERS_STORAGE_KEY)!)).toEqual({ enabled: [], discoms: ["APCPDCL"] });
  });

  it("storage adapter never throws (blocked / missing storage, corrupt JSON)", () => {
    const blocked = layersStorage(() => {
      throw new Error("SecurityError");
    });
    expect(blocked.getItem(LAYERS_STORAGE_KEY)).toBeNull();
    expect(() => blocked.setItem(LAYERS_STORAGE_KEY, { state: { enabled: [], discoms: [] }, version: 1 })).not.toThrow();
    expect(layersStorage(() => undefined).getItem(LAYERS_STORAGE_KEY)).toBeNull();
    expect(layersStorage(() => memoryStorage({ [LAYERS_STORAGE_KEY]: "{oops" })).getItem(LAYERS_STORAGE_KEY)).toBeNull();
  });

  it("merge folds persisted choices into the layers slice; partialize round-trips", () => {
    const base = useAppStore.getState();
    const merged = mergeLayers({ enabled: ["discom-ss"], discoms: ["APEPDCL"] }, base);
    expect(merged.layers.enabled).toEqual({ "discom-ss": true });
    expect(merged.layers.discoms).toEqual({ APSPDCL: false, APEPDCL: true, APCPDCL: false });
    expect(partializeLayers(merged)).toEqual({ enabled: ["discom-ss"], discoms: ["APEPDCL"] });
    // An empty DISCOM list keeps the default (all on), as the old store did.
    expect(mergeLayers({ enabled: [], discoms: [] }, base).layers.discoms).toEqual(base.layers.discoms);
    // Nothing usable stored → state untouched.
    expect(mergeLayers(undefined, base)).toBe(base);
  });
});

describe("app store slices", () => {
  const initial = useAppStore.getState();
  afterEach(() => useAppStore.setState(initial, true));

  it("a gen/pg/wx deep link only sets visibility — no fetch side effects in the store", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    useAppStore.getState().applyUrl({ showGeneration: true, showPowerGrid: true, showWeather: true, voltages: [400] });
    const f = useAppStore.getState().filters;
    expect([f.showGeneration, f.showPowerGrid, f.showWeather]).toEqual([true, true, true]);
    expect(f.voltages).toEqual({ 400: true, 220: false, 132: false });
    // Sub-toggles not in the hash are preserved.
    expect(f.genTypes).toEqual(initial.filters.genTypes);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("urlState round-trips through applyUrl", () => {
    const s = useAppStore.getState();
    s.toggleVoltage(132);
    s.setRegionCircle("Kadapa");
    s.setCoastalBand(1);
    s.setCamera({ lng: 80.123456, lat: 16.5, zoom: 9.876 });
    s.select("s-ss-132kv-chnd");
    const u = useAppStore.getState().urlState();
    expect(u.camera).toEqual({ lng: 80.1235, lat: 16.5, zoom: 9.88 });
    useAppStore.setState(initial, true);
    useAppStore.getState().applyUrl(u);
    expect(useAppStore.getState().urlState()).toEqual(u);
  });

  it("a linked camera wins over flying to the linked selection; Back-style applies clear the breadcrumb", () => {
    const s = useAppStore.getState();
    s.select("s-a");
    s.select("s-b");
    expect(useAppStore.getState().history).toEqual(["s-a"]);
    useAppStore.getState().applyUrl({ selectedId: "s-c", camera: { lng: 80, lat: 16, zoom: 8 } });
    const st = useAppStore.getState();
    expect(st.history).toEqual([]);
    expect(st.flySignal?.id).not.toBe("s-c");
    expect(st.cameraSignal).toMatchObject({ camera: { lng: 80, lat: 16, zoom: 8 }, animate: true });
    useAppStore.getState().applyUrl({ selectedId: "s-d" }, { initial: true });
    expect(useAppStore.getState().flySignal?.id).toBe("s-d");
  });

  it("a link's `lyr` overlays replace the remembered ones; no `lyr` leaves them alone", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {})); // loads stay pending
    useAppStore.getState().layers.toggle("discom-ss", true);
    useAppStore.getState().applyUrl({ selectedId: null });
    expect(useAppStore.getState().layers.enabled).toEqual({ "discom-ss": true });
    useAppStore.getState().applyUrl({ overlays: ["discom-lines"] });
    expect(useAppStore.getState().layers.enabled).toEqual({ "discom-lines": true });
    expect(useAppStore.getState().layers.status["discom-lines"]).toBe("loading"); // restore() fetched it
    fetchSpy.mockRestore();
  });

  it("switching lens keeps selection + filters and swaps the lens default layers", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    const s = useAppStore.getState();
    s.select("s-ss-132kv-chnd");
    s.toggleVoltage(132);
    s.layers.toggle("districts", true); // the viewer's own layer
    useAppStore.getState().setLens("storm");
    let st = useAppStore.getState();
    expect(st.lens).toBe("storm");
    expect(st.selectedId).toBe("s-ss-132kv-chnd");
    expect(st.filters.voltages[132]).toBe(false);
    expect(st.filters.showWeather).toBe(true);
    expect(Object.keys(st.layers.enabled).filter((k) => st.layers.enabled[k]).sort()).toEqual(["crz-boundary", "cyclone-shelters", "districts"]);
    // The lens presets are not remembered as the viewer's choice; their own layer is.
    expect(partializeLayers(st).enabled).toEqual(["districts"]);
    useAppStore.getState().setLens("plan");
    st = useAppStore.getState();
    expect(st.filters.showWeather).toBe(false);
    expect(st.mapLayout).not.toBe("atlas-only");
    expect(Object.keys(st.layers.enabled).filter((k) => st.layers.enabled[k])).toEqual(["districts"]);
    fetchSpy.mockRestore();
  });

  it("a link into a lens brings its defaults unless it carries `lyr`; Back out of it drops them", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    useAppStore.getState().applyUrl({ lens: "field" }, { initial: true });
    let st = useAppStore.getState();
    expect(st.layers.enabled["towers-400kv"]).toBe(true);
    expect(st.layers.status["towers-400kv"]).toBe("loading");
    useAppStore.getState().applyUrl({ lens: "explore" });
    st = useAppStore.getState();
    expect(Object.values(st.layers.enabled).some(Boolean)).toBe(false);
    useAppStore.getState().applyUrl({ lens: "storm", showSubstations: true, showLines: true, showGeneration: false, showPowerGrid: false, showWeather: false, overlays: [] });
    st = useAppStore.getState();
    expect(st.lens).toBe("storm");
    expect(st.filters.showWeather).toBe(false); // the link's own layer set wins
    fetchSpy.mockRestore();
  });

  it("resetFilters clears only the slicing filters", () => {
    const s = useAppStore.getState();
    s.toggleVoltage(400);
    s.toggleCircuit("SC");
    s.setRegionCircle("Nellore");
    s.setCoastalBand(0);
    s.toggleGeneration(true);
    useAppStore.getState().resetFilters();
    const f = useAppStore.getState().filters;
    expect(f.voltages).toEqual({ 400: true, 220: true, 132: true });
    expect(f.circuits).toEqual({ SC: true, DC: true });
    expect(f.circle).toBeNull();
    expect(f.coastalBand).toBeNull();
    expect(f.showGeneration).toBe(true);
  });

  it("measure and nearby tools are mutually exclusive", () => {
    const s = useAppStore.getState();
    s.toggleNearbyMode(true);
    s.setMeasureMode("distance");
    expect(useAppStore.getState().nearbyMode).toBe(false);
    useAppStore.getState().toggleNearbyMode(true);
    expect(useAppStore.getState().measureMode).toBeNull();
  });

  it("setHover with the same id is a no-op (no re-render storm)", () => {
    useAppStore.getState().setHover("s-1");
    const before = useAppStore.getState();
    useAppStore.getState().setHover("s-1");
    expect(useAppStore.getState()).toBe(before);
  });
});

describe("useOverlayStore facade", () => {
  it("reads and writes the layers slice of the one store", () => {
    useOverlayStore.getState().toggleDiscom("APSPDCL");
    expect(useAppStore.getState().layers.discoms.APSPDCL).toBe(false);
    useOverlayStore.getState().toggleDiscom("APSPDCL");
    expect(useOverlayStore.getState().discoms.APSPDCL).toBe(true);
  });

  it("subscribe fires only for layers changes, not hover/selection", () => {
    const fn = vi.fn();
    const off = useOverlayStore.subscribe(fn);
    useAppStore.getState().setHover("s-x");
    useAppStore.getState().select("s-y");
    expect(fn).not.toHaveBeenCalled();
    useOverlayStore.getState().setFocus({ lines: ["dl-1"], ss: [] });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].focus).toEqual({ lines: ["dl-1"], ss: [] });
    useOverlayStore.getState().setFocus(null);
    off();
  });
});
