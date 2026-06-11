// Unit tests for the Planning Studio's pure scenario model (node env, like etl-lib/geo).
// The flow maths itself is dcflow.ts's (tested there) — here we test the scenario layer:
// spec building, per-circle growth injections, the sandbox expansion, runFlowCase parity
// with the dcflow primitives, and the KPI/delta derivations.
import { describe, expect, it } from "vitest";
import type { LineProps } from "../../data/types.ts";
import {
  buildDcNetwork,
  lineUtilisation,
  n1Screen,
  solveDcFlow,
  uniformInjections,
} from "../../lib/dcflow.ts";
import { buildGridGraph } from "../../lib/graph.ts";
import { haversineMeters } from "../../lib/geo.ts";
import {
  generatorCandidates,
  growthFactor,
  kpisFor,
  n1Severity,
  relievedCorridors,
  runFlowCase,
  sandboxWireLines,
  scenarioInjections,
  topContingencies,
  toWireLines,
  wireToLineProps,
  type FlowCaseResult,
  type FlowCaseSpec,
  type WireLine,
} from "./scenario.ts";

// A small ring + spur network: s1—s2—s3—s1 (ring), s3—s4 (spur ⇒ bridge).
function wire(id: string, a: string, b: string, lengthKm = 50): WireLine {
  return { id, name: id, voltage: 220, circuit: "SC", conductor: "Zebra", lengthKm, a, b };
}

const SUBS = [
  { id: "s1", circle: "A" },
  { id: "s2", circle: "A" },
  { id: "s3", circle: "B" },
  { id: "s4", circle: null },
];
const WIRES = [wire("l1", "s1", "s2"), wire("l2", "s2", "s3"), wire("l3", "s3", "s1"), wire("l4", "s3", "s4")];

function spec(over: Partial<FlowCaseSpec> = {}): FlowCaseSpec {
  return {
    substations: SUBS,
    lines: WIRES,
    generatorIds: ["s1"],
    cagrPctByCircle: {},
    years: 0,
    baseDemandMw: 300,
    ...over,
  };
}

describe("growthFactor", () => {
  it("compounds and clamps negative years", () => {
    expect(growthFactor(0, 10)).toBe(1);
    expect(growthFactor(5, 0)).toBe(1);
    expect(growthFactor(10, 2)).toBeCloseTo(1.21, 10);
    expect(growthFactor(7, -3)).toBe(1);
  });
});

describe("generatorCandidates", () => {
  it("collects both snapped ends of Generation-endpoint lines, sorted and deduped", () => {
    const lines = [
      {
        fromSS: { ssId: "s2", distM: 0, confidence: "high" },
        toSS: { ssId: "s1", distM: 0, confidence: "high" },
        externalEndpoints: [{ name: "NTPC X", category: "Generation" }],
      },
      {
        fromSS: { ssId: "s3", distM: 0, confidence: "high" },
        toSS: null,
        externalEndpoints: [{ name: "RTSS Y", category: "Railway" }],
      },
      {
        fromSS: null,
        toSS: { ssId: "s2", distM: 0, confidence: "high" },
        externalEndpoints: [{ name: "Solar Z", category: "Generation" }],
      },
    ] as unknown as LineProps[];
    expect(generatorCandidates(lines)).toEqual(["s1", "s2"]);
  });
});

describe("scenarioInjections", () => {
  it("matches uniformInjections in the no-growth case", () => {
    const lines = WIRES.map(wireToLineProps);
    const net = buildDcNetwork(buildGridGraph(SUBS, lines), lines);
    const ours = scenarioInjections(net, SUBS, spec());
    const reference = uniformInjections(net, SUBS, 300, ["s1"]);
    expect([...ours.entries()].sort()).toEqual([...reference.entries()].sort());
  });

  it("scales each load by its circle's CAGR and balances generation to total load", () => {
    const lines = WIRES.map(wireToLineProps);
    const net = buildDcNetwork(buildGridGraph(SUBS, lines), lines);
    const inj = scenarioInjections(net, SUBS, spec({ cagrPctByCircle: { A: 10, B: 0 }, years: 2 }));
    // 3 loads (s2, s3, s4) at 100 MW base each. s2 (circle A) grows 1.1²; s3 (B) flat;
    // s4 (no circle) grows at the mean CAGR (5 %) ⇒ 1.05².
    expect(inj.get("s2")).toBeCloseTo(-121, 6);
    expect(inj.get("s3")).toBeCloseTo(-100, 6);
    expect(inj.get("s4")).toBeCloseTo(-100 * 1.05 ** 2, 6);
    const totalLoad = -(inj.get("s2")! + inj.get("s3")! + inj.get("s4")!);
    expect(inj.get("s1")).toBeCloseTo(totalLoad, 9);
  });

  it("falls back to the slack bus when no generator id survives the network filter", () => {
    const lines = WIRES.map(wireToLineProps);
    const net = buildDcNetwork(buildGridGraph(SUBS, lines), lines);
    const inj = scenarioInjections(net, SUBS, spec({ generatorIds: ["nope"] }));
    expect(inj.get(net.slack)).toBeGreaterThan(0);
    const sum = [...inj.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(0, 9);
  });
});

describe("runFlowCase", () => {
  it("agrees with the dcflow primitives applied directly", () => {
    const result = runFlowCase(spec());

    const lines = WIRES.map(wireToLineProps);
    const net = buildDcNetwork(buildGridGraph(SUBS, lines), lines);
    const inj = uniformInjections(net, SUBS, 300, ["s1"]);
    const sol = solveDcFlow(net, inj);
    const util = lineUtilisation(sol, lines);
    const n1 = n1Screen(net, lines, inj);

    expect(result.nodes).toBe(net.nodes.length);
    expect(result.edgesSolved).toBe(net.edges.length);
    expect(result.slack).toBe(net.slack);
    expect(result.totalLoadMw).toBeCloseTo(300, 9);
    expect(result.generatorCount).toBe(1);
    const utilById = new Map(result.util.map((u) => [u.lineId, u]));
    for (const [id, u] of util) {
      expect(utilById.get(id)!.flowMw).toBeCloseTo(u.flowMw, 9);
      expect(utilById.get(id)!.pct).toBeCloseTo(u.pct!, 9);
    }
    expect(result.n1).toEqual(n1);
    // The spur line l4 is the one bridge: outaging it islands s4.
    const l4 = result.n1.find((r) => r.outageLineId === "l4")!;
    expect(l4.islanded).toEqual(["s4"]);
    expect(result.n1.filter((r) => r.islanded.length > 0)).toHaveLength(1);
  });

  it("reports phases in order", () => {
    const phases: string[] = [];
    runFlowCase(spec(), (p) => phases.push(p));
    expect(phases).toHaveLength(3);
    expect(phases[0]).toMatch(/network/i);
    expect(phases[1]).toMatch(/base case/i);
    expect(phases[2]).toMatch(/N−1/);
  });
});

describe("sandboxWireLines", () => {
  const ssById = new Map([
    ["s1", { name: "Alpha", lng: 80, lat: 16 }],
    ["s2", { name: "Beta", lng: 80.5, lat: 16.2 }],
  ]);

  it("expands a DC entry into two parallel single-circuit wires with typical conductor + haversine length", () => {
    const wires = sandboxWireLines([{ fromId: "s1", toId: "s2", voltage: 400, circuit: "DC" }], ssById);
    expect(wires).toHaveLength(2);
    const expectKm = haversineMeters([80, 16], [80.5, 16.2]) / 1000;
    for (const w of wires) {
      expect(w.id.startsWith("sb-")).toBe(true);
      expect(w.sandbox).toBe(true);
      expect(w.circuit).toBe("SC"); // each wire is ONE circuit, per the dataset convention
      expect(w.conductor).toBe("Twin Moose");
      expect(w.lengthKm!).toBeCloseTo(expectKm, 0);
      expect(w.a).toBe("s1");
      expect(w.b).toBe("s2");
    }
    expect(wires[0].id).not.toBe(wires[1].id);
  });

  it("keeps an SC entry single and skips self-loops / unknown endpoints", () => {
    expect(
      sandboxWireLines([{ fromId: "s1", toId: "s2", voltage: 132, circuit: "SC" }], ssById),
    ).toHaveLength(1);
    expect(sandboxWireLines([{ fromId: "s1", toId: "s1", voltage: 220, circuit: "SC" }], ssById)).toEqual([]);
    expect(sandboxWireLines([{ fromId: "s1", toId: "missing", voltage: 220, circuit: "SC" }], ssById)).toEqual([]);
  });
});

describe("KPIs, contingency ranking and deltas", () => {
  const res = (util: FlowCaseResult["util"], n1: FlowCaseResult["n1"] = []): FlowCaseResult => ({
    nodes: 0,
    edgesSolved: 0,
    slack: "s",
    slackInjectionMw: 0,
    totalLoadMw: 0,
    generatorCount: 0,
    assumedLengthLines: 0,
    util,
    n1,
  });

  it("kpisFor counts tiers over rated lines only", () => {
    const k = kpisFor(
      res(
        [
          { lineId: "a", flowMw: 90, ratingMva: 100, pct: 90 },
          { lineId: "b", flowMw: 110, ratingMva: 100, pct: 110 },
          { lineId: "c", flowMw: 10, ratingMva: 100, pct: 10 },
          { lineId: "d", flowMw: 5, ratingMva: null, pct: null },
        ],
        [
          { outageLineId: "a", islanded: ["x"], overloads: [] },
          { outageLineId: "b", islanded: [], overloads: [{ lineId: "c", flowMw: 1, ratingMva: 1, pct: 120, basePct: 50 }] },
        ],
      ),
    );
    expect(k.ratedLines).toBe(3);
    expect(k.over80).toBe(2); // ≥ 80 includes the ≥ 100 line
    expect(k.over100).toBe(1);
    expect(k.pctOver80).toBeCloseTo((2 / 3) * 100, 9);
    expect(k.n1OverloadContingencies).toBe(1);
    expect(k.n1IslandingContingencies).toBe(1);
  });

  it("topContingencies ranks islanding above overloads and drops benign outages", () => {
    const islanding = { outageLineId: "i", islanded: ["x", "y"], overloads: [] };
    const overloading = {
      outageLineId: "o",
      islanded: [],
      overloads: [{ lineId: "z", flowMw: 1, ratingMva: 1, pct: 130, basePct: 60 }],
    };
    const benign = { outageLineId: "b", islanded: [], overloads: [] };
    expect(n1Severity(islanding)).toBeGreaterThan(n1Severity(overloading));
    expect(topContingencies([benign, overloading, islanding], 25).map((r) => r.outageLineId)).toEqual(["i", "o"]);
    expect(topContingencies([islanding, overloading], 1)).toHaveLength(1);
  });

  it("relievedCorridors reports ≥ 5 pp drops with the freed MVA, biggest first", () => {
    const before = res([
      { lineId: "a", flowMw: 90, ratingMva: 200, pct: 90 },
      { lineId: "b", flowMw: 50, ratingMva: 100, pct: 50 },
      { lineId: "c", flowMw: 70, ratingMva: 100, pct: 70 },
    ]);
    const after = res([
      { lineId: "a", flowMw: 60, ratingMva: 200, pct: 60 }, // −30 pp
      { lineId: "b", flowMw: 47, ratingMva: 100, pct: 47 }, // −3 pp ⇒ below threshold
      { lineId: "c", flowMw: 80, ratingMva: 100, pct: 80 }, // worsened
    ]);
    const deltas = relievedCorridors(before, after);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ lineId: "a", beforePct: 90, afterPct: 60 });
    expect(deltas[0].dropPp).toBeCloseTo(30, 9);
    expect(deltas[0].headroomGainMva).toBeCloseTo(60, 9); // 30 % of 200 MVA
  });
});

describe("toWireLines round-trip", () => {
  it("preserves the solver-relevant fields through the worker wire format", () => {
    const line: LineProps = {
      id: "l-1",
      kind: "line",
      name: "220kV Foo–Bar Ckt-1",
      voltage: 220,
      circuit: "DC",
      lengthKm: 42.5,
      ckm: 85,
      circle: "Guntur",
      connectsSS: ["Foo", "Bar"],
      endpointLabels: ["Foo", "Bar"],
      fromSS: { ssId: "s-foo", distM: 12, confidence: "high" },
      toSS: { ssId: "s-bar", distM: 480, confidence: "medium" },
      circuitAmbiguous: false,
      voltageMismatch: false,
      conductor: "Twin Moose",
    };
    const [w] = toWireLines([line]);
    expect(w).toEqual({
      id: "l-1",
      name: "220kV Foo–Bar Ckt-1",
      voltage: 220,
      circuit: "DC",
      conductor: "Twin Moose",
      lengthKm: 42.5,
      a: "s-foo",
      b: "s-bar",
    });
    const back = wireToLineProps(w);
    expect(back.fromSS?.ssId).toBe("s-foo");
    expect(back.toSS?.ssId).toBe("s-bar");
    expect(back.conductor).toBe("Twin Moose");
    expect(back.voltage).toBe(220);
  });
});
