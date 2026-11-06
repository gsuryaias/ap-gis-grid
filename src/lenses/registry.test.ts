// Lens registry invariants + the layer rules a lens switch and the URL `lyr` key rely on.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STATIC_OVERLAY_DEFS } from "../overlays/resources.ts";
import {
  decodeLayerDiff,
  encodeLayerDiff,
  isLensId,
  LENS_BY_ID,
  LENSES,
  lensDefaults,
  switchLensLayers,
  type LayerOn,
} from "./registry.ts";

const catalog = JSON.parse(readFileSync(new URL("../../public/data/ref/catalog.json", import.meta.url), "utf8")) as { id: string }[];
const base: LayerOn = { showSubstations: true, showLines: true, showGeneration: false, showPowerGrid: false, showWeather: false, overlays: [] };

describe("lens registry", () => {
  it("has the four lenses, unique, Explore first", () => {
    expect(LENSES.map((l) => l.id)).toEqual(["explore", "field", "plan", "storm"]);
    for (const l of LENSES) {
      expect(isLensId(l.id)).toBe(true);
      expect(LENS_BY_ID[l.id]).toBe(l);
      expect(l.startHere.tips.length).toBeGreaterThan(0);
    }
    expect(isLensId("atlas")).toBe(false);
  });

  it("every preset overlay exists (static def or RTGS catalogue)", () => {
    const known = new Set([...Object.keys(STATIC_OVERLAY_DEFS), ...catalog.map((c) => c.id)]);
    for (const l of LENSES) for (const id of l.defaults.overlays ?? []) expect(known.has(id), `${l.id}: ${id}`).toBe(true);
  });

  it("Explore and Plan preset only the core grid (v2 links from phase 2 keep their meaning)", () => {
    expect(lensDefaults("explore")).toEqual(base);
    expect(lensDefaults("plan")).toEqual(base);
  });
});

describe("switching lens", () => {
  it("brings the new lens's defaults, drops the old lens's, keeps the viewer's own layers", () => {
    const mine = { ...base, showGeneration: true, overlays: ["districts"] };
    const storm = switchLensLayers(mine, "explore", "storm");
    expect(storm).toEqual({ ...mine, showWeather: true, overlays: ["crz-boundary", "cyclone-shelters", "districts"] });
    expect(switchLensLayers(storm, "storm", "explore")).toEqual(mine);
    const field = switchLensLayers(storm, "storm", "field");
    expect(field.showWeather).toBe(false);
    expect(field.overlays).toEqual(["discom-lines", "discom-ss", "districts", "towers-132kv", "towers-220kv", "towers-400kv"]);
  });

  it("a hidden core grid comes back on entering a lens (it is every lens's default)", () => {
    expect(switchLensLayers({ ...base, showLines: false }, "explore", "field").showLines).toBe(true);
  });

  it("same lens is a no-op", () => {
    const cur = { ...base, showSubstations: false };
    expect(switchLensLayers(cur, "storm", "storm")).toBe(cur);
  });
});

describe("lyr diff", () => {
  it("round-trips any layer set in any lens", () => {
    const sets: LayerOn[] = [
      base,
      { ...base, showSubstations: false, showWeather: true },
      { ...base, showGeneration: true, showPowerGrid: true, overlays: ["discom-ss", "towers-400kv"] },
      lensDefaults("storm"),
      lensDefaults("field"),
    ];
    for (const lens of LENSES.map((l) => l.id)) {
      for (const s of sets) expect(decodeLayerDiff(encodeLayerDiff(s, lens), lens)).toEqual(s);
    }
  });

  it("writes on-tokens, then overlays, then off-tokens", () => {
    expect(encodeLayerDiff({ ...base, showGeneration: true, showLines: false, overlays: ["b", "a"] }, "explore")).toBe("gen,a,b,-ln");
    expect(encodeLayerDiff(base, "storm", (id) => `ref:${id}`)).toBe("-wx,-ref:crz-boundary,-ref:cyclone-shelters");
  });

  it("drops tokens the validator rejects", () => {
    expect(decodeLayerDiff("gen,../x,-ok", "explore", (t) => (/^[a-z-]+$/.test(t) ? t : null))).toEqual({ ...base, showGeneration: true });
  });
});
