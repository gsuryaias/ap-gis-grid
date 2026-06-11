import { describe, expect, it } from "vitest";
import type { LineProps, SnapRef, SubstationProps } from "../data/types.ts";
import { buildGridGraph } from "./graph.ts";
import {
  buildDcNetwork,
  DEFAULT_ASSUMED_LENGTH_KM,
  DEFAULT_BASE_MVA,
  DEFAULT_OHM_PER_KM,
  lineUtilisation,
  n1Screen,
  solveDcFlow,
  uniformInjections,
} from "./dcflow.ts";

type SS = Pick<SubstationProps, "id">;

const ref = (ssId: string): SnapRef => ({ ssId, distM: 0, confidence: "high" });
const ss = (id: string): SS => ({ id });

/** Full LineProps fixture: 132 kV SC Panther, 30 km, both ends resolved. */
const mkLine = (id: string, from: string, to: string, over: Partial<LineProps> = {}): LineProps => ({
  id,
  kind: "line",
  name: id,
  voltage: 132,
  circuit: "SC",
  lengthKm: 30,
  ckm: 30,
  circle: null,
  connectsSS: [from, to],
  endpointLabels: null,
  fromSS: ref(from),
  toSS: ref(to),
  circuitAmbiguous: false,
  voltageMismatch: false,
  conductor: "Panther",
  ...over,
});

const netOf = (substations: SS[], lines: LineProps[], opts?: Parameters<typeof buildDcNetwork>[2]) =>
  buildDcNetwork(buildGridGraph(substations, lines), lines, opts);

// Panther @ 132 kV SC: √3 · 132 · 480 / 1000 ≈ 109.74 → capacity.ts rounds to 110 MVA.
const PANTHER_132_MVA = 110;

// ---------------------------------------------------------------------------------------
// Fixture 1 — equal-reactance triangle: A ── B, A ── C, C ── B (all 132 kV, 30 km).
// Inject +90 at A, −90 at B. Known analytic answer: the direct path A→B has reactance x,
// the two-hop path A→C→B has 2x, so flow splits 2:1 — 60 MW direct, 30 MW via C.
// ---------------------------------------------------------------------------------------
const TRI_SS = ["A", "B", "C"].map(ss);
const TRI_LINES = [mkLine("l-ab", "A", "B"), mkLine("l-ac", "A", "C"), mkLine("l-cb", "C", "B")];
const triNet = netOf(TRI_SS, TRI_LINES);
const triSol = solveDcFlow(triNet, new Map([["A", 90], ["B", -90]]));

// ---------------------------------------------------------------------------------------
// Fixture 2 — parallel circuits: A ══ B (two identical 132 kV circuits).
// ---------------------------------------------------------------------------------------
const PAIR_SS = ["A", "B"].map(ss);
const PAIR_LINES = [mkLine("l-p1", "A", "B"), mkLine("l-p2", "A", "B")];
const pairNet = netOf(PAIR_SS, PAIR_LINES);

// ---------------------------------------------------------------------------------------
// Fixture 3 — triangle + radial spur: A/B/C as above, plus C ── D (l-cd).
// ---------------------------------------------------------------------------------------
const SPUR_SS = ["A", "B", "C", "D"].map(ss);
const SPUR_LINES = [...TRI_LINES, mkLine("l-cd", "C", "D")];
const spurNet = netOf(SPUR_SS, SPUR_LINES);
const SPUR_INJ = new Map([["A", 90], ["B", -30], ["C", -30], ["D", -30]]);

describe("buildDcNetwork", () => {
  it("restricts the network to the largest connected component", () => {
    const lines = [mkLine("l-ab", "A", "B"), mkLine("l-bc", "B", "C"), mkLine("l-xy", "X", "Y")];
    const net = netOf(["A", "B", "C", "X", "Y"].map(ss), lines);
    expect(net.nodes).toEqual(["A", "B", "C"]);
    expect(net.edges.map((e) => e.lineId).sort()).toEqual(["l-ab", "l-bc"]);
  });

  it("computes per-unit reactance from Ω/km × length on the 100 MVA base", () => {
    const edge = triNet.edges.find((e) => e.lineId === "l-ab")!;
    const expectedXPu = (DEFAULT_OHM_PER_KM[132] * 30 * DEFAULT_BASE_MVA) / (132 * 132);
    expect(edge.xPu).toBeCloseTo(expectedXPu, 10);
    expect(edge.susceptancePu).toBeCloseTo(1 / expectedXPu, 8);
    expect(edge.assumedLength).toBe(false);
  });

  it("falls back to the default length for missing/zero lengthKm and flags the line", () => {
    const lines = [
      mkLine("l-known", "A", "B"),
      mkLine("l-null", "B", "C", { lengthKm: null }),
      mkLine("l-zero", "C", "A", { lengthKm: 0 }),
    ];
    const net = netOf(TRI_SS, lines);
    expect(net.assumedLengthLineIds).toEqual(["l-null", "l-zero"]);
    const assumed = net.edges.find((e) => e.lineId === "l-null")!;
    expect(assumed.assumedLength).toBe(true);
    const expectedXPu =
      (DEFAULT_OHM_PER_KM[132] * DEFAULT_ASSUMED_LENGTH_KM * DEFAULT_BASE_MVA) / (132 * 132);
    expect(assumed.xPu).toBeCloseTo(expectedXPu, 10);
  });

  it("prefers a 400 kV-incident substation as slack even when another node has higher degree", () => {
    const lines = [
      mkLine("l-ab", "A", "B", { voltage: 400, conductor: "Quad Moose" }),
      mkLine("l-bc", "B", "C"),
      mkLine("l-cd", "C", "D"),
      mkLine("l-ce", "C", "E"),
    ];
    // C has degree 3 but no 400 kV line; B touches the 400 kV edge with degree 2.
    const net = netOf(["A", "B", "C", "D", "E"].map(ss), lines);
    expect(net.slack).toBe("B");
  });

  it("falls back to the highest-degree node (ties → smallest id) without 400 kV lines, and honours slackId", () => {
    expect(triNet.slack).toBe("A"); // all degree 2, tie → "A"
    expect(spurNet.slack).toBe("C"); // degree 3 beats the rest
    expect(netOf(TRI_SS, TRI_LINES, { slackId: "B" }).slack).toBe("B");
    expect(() => netOf(TRI_SS, TRI_LINES, { slackId: "ZZ" })).toThrow(/largest connected component/);
  });
});

describe("solveDcFlow", () => {
  it("splits flow 2:1 between the direct and two-hop paths of an equal-reactance triangle", () => {
    expect(triSol.flowsMw.get("l-ab")).toBeCloseTo(60, 6);
    expect(triSol.flowsMw.get("l-ac")).toBeCloseTo(30, 6); // signed A → C
    expect(triSol.flowsMw.get("l-cb")).toBeCloseTo(30, 6); // signed C → B
    expect(triSol.angles.get(triSol.slack)).toBe(0);
  });

  it("splits flow equally across identical parallel circuits", () => {
    const sol = solveDcFlow(pairNet, new Map([["A", 100], ["B", -100]]));
    expect(sol.flowsMw.get("l-p1")).toBeCloseTo(50, 6);
    expect(sol.flowsMw.get("l-p2")).toBeCloseTo(50, 6);
  });

  it("carries exactly the downstream injection on a radial line", () => {
    const lines = [mkLine("l-ab", "A", "B"), mkLine("l-bc", "B", "C")];
    const net = netOf(["A", "B", "C"].map(ss), lines);
    const sol = solveDcFlow(net, new Map([["A", 50], ["C", -50]]));
    expect(sol.flowsMw.get("l-ab")).toBeCloseTo(50, 6);
    expect(sol.flowsMw.get("l-bc")).toBeCloseTo(50, 6);
    // The radial spur of fixture 3 carries exactly D's 30 MW load.
    expect(solveDcFlow(spurNet, SPUR_INJ).flowsMw.get("l-cd")).toBeCloseTo(30, 6);
  });

  it("auto-balances unbalanced injections at the slack and ignores ids outside the network", () => {
    const lines = [mkLine("l-ab", "A", "B")];
    const net = netOf(PAIR_SS, lines);
    expect(net.slack).toBe("A");
    const sol = solveDcFlow(net, new Map([["B", -80], ["no-such-node", 999]]));
    expect(sol.slackInjectionMw).toBeCloseTo(80, 6);
    expect(sol.flowsMw.get("l-ab")).toBeCloseTo(80, 6);
  });
});

describe("uniformInjections", () => {
  it("spreads generation over generatorIds and load uniformly over the rest, summing to ~0", () => {
    const inj = uniformInjections(triNet, TRI_SS, 90, ["A"]);
    expect(inj.get("A")).toBeCloseTo(90, 9);
    expect(inj.get("B")).toBeCloseTo(-45, 9);
    expect(inj.get("C")).toBeCloseTo(-45, 9);
    const sum = [...inj.values()].reduce((acc, v) => acc + v, 0);
    expect(sum).toBeCloseTo(0, 9);
  });

  it("defaults generation to the slack when no generatorIds are given (or none are in the network)", () => {
    const inj = uniformInjections(spurNet, SPUR_SS, 90, ["outside-the-net"]);
    expect(inj.get(spurNet.slack)).toBeCloseTo(90, 9); // slack = "C"
    expect(inj.get("A")).toBeCloseTo(-30, 9);
    expect(inj.get("B")).toBeCloseTo(-30, 9);
    expect(inj.get("D")).toBeCloseTo(-30, 9);
  });
});

describe("lineUtilisation", () => {
  it("rates lines per circuit via capacity.ts and reports |flow|/rating as a percentage", () => {
    const util = lineUtilisation(triSol, TRI_LINES);
    const ab = util.get("l-ab")!;
    expect(ab.ratingMva).toBe(PANTHER_132_MVA);
    expect(ab.flowMw).toBeCloseTo(60, 6);
    expect(ab.pct).toBeCloseTo((60 / PANTHER_132_MVA) * 100, 4);
  });

  it("returns null rating and pct for an unratable conductor", () => {
    const lines = [mkLine("l-ab", "A", "B", { conductor: "UG Cable" }), mkLine("l-p2", "A", "B")];
    const net = netOf(PAIR_SS, lines);
    const util = lineUtilisation(solveDcFlow(net, new Map([["B", -40]])), lines);
    expect(util.get("l-ab")).toEqual({ flowMw: expect.any(Number), ratingMva: null, pct: null });
    expect(util.get("l-p2")!.ratingMva).toBe(PANTHER_132_MVA);
  });
});

describe("n1Screen", () => {
  // Base case for the parallel pair: 150 MW transfer → 75 MW per circuit (≈ 68% of 110 MVA).
  const PAIR_INJ = new Map([["A", 150], ["B", -150]]);

  it("doubles the survivor's flow when one parallel circuit trips, and flags the new overload", () => {
    const results = n1Screen(pairNet, PAIR_LINES, PAIR_INJ);
    expect(results).toHaveLength(2);
    const outP1 = results.find((r) => r.outageLineId === "l-p1")!;
    expect(outP1.islanded).toEqual([]);
    expect(outP1.overloads).toHaveLength(1);
    const survivor = outP1.overloads[0];
    expect(survivor.lineId).toBe("l-p2");
    expect(survivor.flowMw).toBeCloseTo(150, 6); // 75 → 150: doubled
    expect(survivor.ratingMva).toBe(PANTHER_132_MVA);
    expect(survivor.pct).toBeCloseTo((150 / PANTHER_132_MVA) * 100, 4);
    expect(survivor.basePct).toBeCloseTo((75 / PANTHER_132_MVA) * 100, 4);
  });

  it("reports no overloads when the post-contingency loading stays within ratings", () => {
    const results = n1Screen(pairNet, PAIR_LINES, new Map([["A", 100], ["B", -100]]));
    for (const r of results) expect(r.overloads).toEqual([]);
  });

  it("detects islanding when a radial edge is removed", () => {
    const results = n1Screen(spurNet, SPUR_LINES, SPUR_INJ);
    const spurOutage = results.find((r) => r.outageLineId === "l-cd")!;
    expect(spurOutage.islanded).toEqual(["D"]);
    // The mesh outages island nobody.
    for (const r of results) {
      if (r.outageLineId !== "l-cd") expect(r.islanded).toEqual([]);
    }
  });

  it("limits the screen to topK candidates by base-case loading", () => {
    const results = n1Screen(spurNet, SPUR_LINES, SPUR_INJ, { topK: 1 });
    expect(results).toHaveLength(1);
    // Base flows: l-ab 40, l-ac 50, l-cb −10, l-cd 30 → the most-loaded line screens first.
    expect(results[0].outageLineId).toBe("l-ac");
  });
});
