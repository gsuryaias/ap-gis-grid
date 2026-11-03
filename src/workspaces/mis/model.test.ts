import { describe, expect, it } from "vitest";
import type { LineProps, SubstationProps, Voltage } from "../../data/types.ts";
import {
  ageBand,
  applyScope,
  bboxOf,
  bridgeImpacts,
  buildModel,
  commissioningHistogram,
  conductorFamily,
  decodeFilters,
  encodeFilters,
  groupBy,
  metrics,
  NONE,
  roleOf,
} from "./model.ts";

const ss = (id: string, voltage: Voltage, over: Partial<SubstationProps> = {}): SubstationProps => ({
  id,
  kind: "substation",
  name: id.toUpperCase(),
  descriptiveName: null,
  ssCode: null,
  voltage,
  circle: "Guntur",
  circleInferred: false,
  doc: null,
  lng: 80,
  lat: 16,
  connectedLineIds: [],
  connectedLineCount: 0,
  zone: "Vijayawada",
  division: "Guntur",
  coastalBand: 3,
  ...over,
});

const line = (id: string, a: string, b: string, over: Partial<LineProps> = {}): LineProps => ({
  id,
  kind: "line",
  name: id,
  voltage: 220,
  circuit: "SC",
  lengthKm: 10,
  ckm: 10,
  circuits: 1,
  routeKm: 10,
  circle: "Guntur",
  connectsSS: [a, b],
  endpointLabels: null,
  fromSS: { ssId: a, distM: 0, confidence: "high" },
  toSS: { ssId: b, distM: 0, confidence: "high" },
  circuitAmbiguous: false,
  voltageMismatch: false,
  conductor: "Zebra",
  commissioned: "Jan 2000",
  ...over,
});

// A — B — C, with C — D radial; B is a cut point, D single-fed; l3 is a bridge islanding D.
const substations = [
  ss("a", 400),
  ss("b", 220, { circle: "Ongole", zone: "Vijayawada", division: "Ongole", coastalBand: 0, lng: 81, lat: 17 }),
  ss("c", 220),
  ss("d", 132, { division: null }),
];
const lines = [
  line("l1", "a", "b", { voltage: 400, commissioned: "Mar 1985", conductor: "Twin Moose", ckm: 20, circuits: 2, circuit: "DC" }),
  line("l2", "b", "c", { circle: "Ongole" }),
  line("l3", "c", "d", { voltage: 132, commissioned: null, conductor: "UG Cable", externalEndpoints: [{ name: "X", category: "Railway" }] }),
];
const ga = {
  feedDegrees: new Map([["a", 1], ["b", 2], ["c", 2], ["d", 1]]),
  articulationIds: new Set(["b", "c"]),
  bridgeImpacts: new Map([["l3", ["d"]], ["l1", ["a"]]]),
};
const conn = {
  bySs: {
    d: [
      ["f1", "F1", "APCPDCL", 5, "name", ["x1", "x2"]],
      ["f2", "F2", "APCPDCL", 3, "proximity", ["x2"]],
    ],
  } as never,
};
const model = buildModel({ substations, lines }, ga, conn, 2026);

describe("row derivation", () => {
  it("assigns roles, downstream and line attributes", () => {
    expect(model.ssById.get("b")!.role).toBe("articulation");
    expect(model.ssById.get("a")!.role).toBe("single-fed");
    expect(model.ssById.get("d")!.discomSsIds.sort()).toEqual(["x1", "x2"]);
    expect(model.ssById.get("d")!.feederKm).toBe(8);
    const l1 = model.lineById.get("l1")!;
    expect(l1.age).toBe(41);
    expect(l1.ageBand).toBe("3");
    expect(l1.conductor).toBe("Twin Moose");
    expect(l1.zone).toBe("Vijayawada");
    expect(model.lineById.get("l3")!.division).toBe("Guntur"); // from its first end (c)
    expect(model.lineById.get("l3")!.mva).toBeNull();
  });

  it("helpers", () => {
    expect(roleOf("z", 0, new Set())).toBe("isolated");
    expect(roleOf("z", 3, new Set())).toBe("meshed");
    expect(ageBand(null)).toBe("unknown");
    expect(ageBand(14)).toBe("0");
    expect(ageBand(35)).toBe("3");
    expect(conductorFamily("Quad Moose")).toBe("Quad Moose");
    expect(conductorFamily("Lynx, Panther")).toBe("Lynx");
    expect(conductorFamily("UG Cable")).toBeNull();
  });
});

describe("scope + aggregation", () => {
  it("narrows both asset types on a shared dimension", () => {
    const s = applyScope(model, [{ dim: "circle", value: "Ongole" }]);
    expect(s.ss.map((r) => r.id)).toEqual(["b"]);
    expect(s.lines.map((r) => r.id)).toEqual(["l2"]);
  });

  it("scopes substations through lines for a line-only dimension", () => {
    const s = applyScope(model, [{ dim: "age", value: "3" }]);
    expect(s.lines.map((r) => r.id)).toEqual(["l1"]);
    expect(s.ss.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("scopes lines through substations for a substation-only dimension", () => {
    const s = applyScope(model, [{ dim: "role", value: "articulation" }]);
    expect(s.ss.map((r) => r.id).sort()).toEqual(["b", "c"]);
    expect(s.lines.map((r) => r.id).sort()).toEqual(["l1", "l2", "l3"]);
  });

  it("computes ckm-weighted age, past-life share and distinct downstream SS", () => {
    const m = metrics(model.ss, model.lines);
    expect(m.ckm).toBe(40);
    expect(m.ckmByV[400]).toBe(20);
    // ages: l1 41y × 20 ckm, l2 26y × 10 ckm; l3 unknown
    expect(m.meanAge).toBeCloseTo((41 * 20 + 26 * 10) / 30);
    expect(m.pctPastLife).toBeCloseTo(20 / 30);
    expect(m.discomSs).toBe(2);
    expect(m.bridges).toBe(2);
    expect(m.coastalSs).toBe(1);
  });

  it("groups in the dimension's fixed order with the unknown bucket last", () => {
    const rows = groupBy(applyScope(model, []), "voltage");
    expect(rows.map((r) => r.key)).toEqual(["400", "220", "132"]);
    const div = groupBy(applyScope(model, []), "division");
    expect(div.at(-1)!.key).toBe(NONE);
    const role = groupBy(applyScope(model, []), "role");
    expect(role[0].key).toBe("articulation");
    expect(role[0].hasLines).toBe(false);
  });
});

describe("thematic views", () => {
  it("bins commissioned ckm by 5-year period and voltage", () => {
    const h = commissioningHistogram(model.lines);
    expect(h[0].start).toBe(1985);
    expect(h.at(-1)!.start).toBe(2000);
    expect(h.length).toBe(4);
    expect(h[0].ckmByV[400]).toBe(20);
    expect(h[3].ckmByV[220]).toBe(10);
  });

  it("ranks bridges by downstream 33/11 kV dependence", () => {
    const b = bridgeImpacts(model, model.lines);
    expect(b[0].row.id).toBe("l3");
    expect(b[0].discomSs).toBe(2);
    expect(b[0].feeders).toBe(2);
    expect(b[1].row.id).toBe("l1");
  });

  it("round-trips the drill path and computes bounds", () => {
    const f = [
      { dim: "circle" as const, value: "Ongole" },
      { dim: "voltage" as const, value: "220" },
    ];
    expect(decodeFilters(encodeFilters(f))).toEqual(f);
    expect(decodeFilters("bogus:1~circle:")).toEqual([]);
    expect(bboxOf(model.ss)).toEqual([
      [80, 16],
      [81, 17],
    ]);
    expect(bboxOf([])).toBeNull();
  });
});
