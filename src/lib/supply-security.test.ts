import { describe, expect, it } from "vitest";
import { computeSupplySecurity, interfaceSecurity, type SecLine } from "./supply-security.ts";

const L = (id: string, a: string | null, b: string | null, over: Partial<SecLine> = {}): SecLine => ({
  id,
  fromSS: a ? { ssId: a } : null,
  toSS: b ? { ssId: b } : null,
  circuits: 1,
  routeKm: 10,
  ...over,
});
const S = (...ids: string[]) => ids.map((id) => ({ id }));

// Meshed triangle A-B-C. From C: a DC corridor (2 rows × 1 ckt) to D, then a single circuit D-E.
// F hangs off B on a whole-DC row (circuits 2). G is isolated. A plant P is fed from A + B.
const ss = S("a", "b", "c", "d", "e", "f", "g");
const lines: SecLine[] = [
  L("ab", "a", "b"),
  L("bc", "b", "c"),
  L("ca", "c", "a"),
  L("cd1", "c", "d", { routeKm: 6 }),
  L("cd2", "c", "d", { routeKm: 6 }),
  L("de", "d", "e", { routeKm: 20 }),
  L("bf", "b", "f", { circuits: 2, routeKm: 15 }),
  L("pa", "a", null, { externalEndpoints: [{ name: "Plant", category: "Generation" }] }),
  L("pb", null, "b", { externalEndpoints: [{ name: "Plant", category: "Generation" }] }),
  L("rt", "e", null, { externalEndpoints: [{ name: "RTSS X", category: "Railway" }] }),
  L("open", "f", null),
];

describe("computeSupplySecurity", () => {
  const r = computeSupplySecurity(ss, lines);

  it("finds the meshed core (incl. a plant switchyard that closes a loop)", () => {
    expect([...r.coreIds].sort()).toEqual(["a", "b", "c", "gen:plant"]);
    expect(r.bySs.get("a")!.cls).toBe("meshed");
  });

  it("classifies radial feeds by their weakest corridor", () => {
    const d = r.bySs.get("d")!;
    expect(d.cls).toBe("radial-dc"); // two circuits C-D on one corridor
    expect(d.bottleneck).toBe(2);
    expect(d.headId).toBe("c");
    expect(d.radialKm).toBe(12);
    const e = r.bySs.get("e")!;
    expect(e.cls).toBe("radial-sc"); // D-E is a single circuit
    expect(e.depth).toBe(2);
    expect(e.bottleneck).toBe(1);
    expect(e.radialKm).toBe(32);
    expect(e.pocket).toBe(d.pocket);
    expect(r.bySs.get("f")!.cls).toBe("radial-dc"); // whole-DC row carries 2 circuits
    expect(r.bySs.get("g")!.cls).toBe("unconnected");
  });

  it("groups radial nodes into pockets with their lines", () => {
    const p = r.pocketByKey.get("c|d")!;
    expect(p.headId).toBe("c");
    expect(p.ssIds).toEqual(["d", "e"]);
    expect(p.entryCircuits).toBe(2);
    expect(p.maxDepth).toBe(2);
    expect(p.scCount).toBe(1);
    expect(p.lineIds.sort()).toEqual(["cd1", "cd2", "de", "rt"]);
  });

  it("reports what a cut-point substation's outage islands", () => {
    expect(r.cutImpacts.get("c")).toEqual(["d", "e"]);
    expect(r.cutImpacts.get("d")).toEqual(["e"]);
    expect(r.cutImpacts.has("a")).toBe(false);
  });

  it("counts unresolved far ends and interface feeds", () => {
    expect(r.openEnds.get("f")).toBe(1);
    const plant = r.interfaces.find((f) => f.name === "Plant")!;
    expect(plant.ssIds.sort()).toEqual(["a", "b"]);
    expect(interfaceSecurity(plant)).toBe("multi-ss");
    const rt = r.interfaces.find((f) => f.name === "RTSS X")!;
    expect(interfaceSecurity(rt)).toBe("single-circuit");
    expect(interfaceSecurity({ circuits: 2, ssIds: ["a"] })).toBe("single-ss");
    expect(interfaceSecurity({ circuits: 1, ssIds: [] })).toBe("unresolved");
  });
});
