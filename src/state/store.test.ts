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
    useAppStore.getState().applyHash({ showGeneration: true, showPowerGrid: true, showWeather: true, voltages: [400] });
    const f = useAppStore.getState().filters;
    expect([f.showGeneration, f.showPowerGrid, f.showWeather]).toEqual([true, true, true]);
    expect(f.voltages).toEqual({ 400: true, 220: false, 132: false });
    // Sub-toggles not in the hash are preserved.
    expect(f.genTypes).toEqual(initial.filters.genTypes);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("hashState round-trips through applyHash", () => {
    const s = useAppStore.getState();
    s.toggleVoltage(132);
    s.setRegionCircle("Kadapa");
    s.setCoastalBand(1);
    const h = useAppStore.getState().hashState();
    useAppStore.setState(initial, true);
    useAppStore.getState().applyHash(h);
    expect(useAppStore.getState().hashState()).toEqual(h);
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
