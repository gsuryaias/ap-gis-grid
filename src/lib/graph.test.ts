import { describe, expect, it } from "vitest";
import type { LineProps, SnapRef, SubstationProps } from "../data/types.ts";
import {
  articulationSubstations,
  bridgeLines,
  buildGridGraph,
  connectedComponents,
  feedDegree,
  lineOutageImpact,
  neighborhood,
  singleFedSubstations,
} from "./graph.ts";

type SS = Pick<SubstationProps, "id">;
type Line = Pick<LineProps, "id" | "fromSS" | "toSS">;

const ref = (ssId: string): SnapRef => ({ ssId, distM: 0, confidence: "high" });
const line = (id: string, from: string | null, to: string | null): Line => ({
  id,
  fromSS: from ? ref(from) : null,
  toSS: to ? ref(to) : null,
});

// Hand-built fixture:
//
//   A ══ B ── C ── D        A══B is a double-circuit corridor (parallel l-ab1 / l-ab2);
//        ╱│    │   │        B──C (l-bc) is the only path into the C/D/E triangle;
//       ╱ └────E───┘        F is isolated; X──Y is a separate two-node component.
//
// Plus l-half (one resolved end) and l-none (no resolved ends) — never edges.
const SUBSTATIONS: SS[] = ["A", "B", "C", "D", "E", "F", "X", "Y"].map((id) => ({ id }));
const LINES: Line[] = [
  line("l-ab1", "A", "B"),
  line("l-ab2", "A", "B"),
  line("l-bc", "B", "C"),
  line("l-cd", "C", "D"),
  line("l-de", "D", "E"),
  line("l-ce", "C", "E"),
  line("l-xy", "X", "Y"),
  line("l-half", "A", null),
  line("l-none", null, null),
];
const g = buildGridGraph(SUBSTATIONS, LINES);

describe("buildGridGraph", () => {
  it("keeps every substation as a node, even isolated ones", () => {
    expect(g.nodes.size).toBe(8);
    expect(g.nodes.has("F")).toBe(true);
  });

  it("ignores lines with unresolved ends as edges", () => {
    expect(g.edges.size).toBe(7);
    expect(g.edges.has("l-half")).toBe(false);
    expect(g.edges.has("l-none")).toBe(false);
  });

  it("keeps parallel circuits as separate multigraph edges", () => {
    const abEdges = (g.adjacency.get("A") ?? []).map((e) => e.lineId).sort();
    expect(abEdges).toEqual(["l-ab1", "l-ab2"]);
    expect(g.edges.get("l-ab1")).toEqual({ lineId: "l-ab1", a: "A", b: "B" });
  });
});

describe("neighborhood", () => {
  it("returns the 1-hop ego network with all induced lines", () => {
    const { ssIds, lineIds } = neighborhood(g, "C", 1);
    expect([...ssIds].sort()).toEqual(["B", "C", "D", "E"]);
    // l-de is induced (both D and E are 1-hop neighbours) even though it's 2 hops out.
    expect([...lineIds].sort()).toEqual(["l-bc", "l-cd", "l-ce", "l-de"]);
  });

  it("includes both parallel circuits of a corridor", () => {
    const { ssIds, lineIds } = neighborhood(g, "A", 1);
    expect([...ssIds].sort()).toEqual(["A", "B"]);
    expect([...lineIds].sort()).toEqual(["l-ab1", "l-ab2"]);
  });

  it("expands at 2 hops without leaking past the frontier", () => {
    const { ssIds, lineIds } = neighborhood(g, "A", 2);
    expect([...ssIds].sort()).toEqual(["A", "B", "C"]);
    expect([...lineIds].sort()).toEqual(["l-ab1", "l-ab2", "l-bc"]);
  });
});

describe("connectedComponents", () => {
  it("returns components largest-first with sorted ids", () => {
    expect(connectedComponents(g)).toEqual([
      ["A", "B", "C", "D", "E"],
      ["X", "Y"],
      ["F"],
    ]);
  });
});

describe("feedDegree / singleFedSubstations", () => {
  it("counts distinct neighbours, not circuits", () => {
    expect(feedDegree(g, "A")).toBe(1); // double-circuit, but ONE neighbouring SS
    expect(feedDegree(g, "B")).toBe(2);
    expect(feedDegree(g, "C")).toBe(3);
    expect(feedDegree(g, "F")).toBe(0);
  });

  it("flags single-fed substations (degree exactly 1)", () => {
    expect(singleFedSubstations(g)).toEqual(["A", "X", "Y"]);
  });
});

describe("bridgeLines", () => {
  it("never reports a single circuit of a parallel corridor", () => {
    const bridges = bridgeLines(g);
    expect(bridges).not.toContain("l-ab1");
    expect(bridges).not.toContain("l-ab2");
  });

  it("finds true bridges, including in secondary components", () => {
    expect(bridgeLines(g)).toEqual(["l-bc", "l-xy"]);
  });

  it("leaves cycle edges alone", () => {
    const bridges = bridgeLines(g);
    for (const id of ["l-cd", "l-de", "l-ce"]) expect(bridges).not.toContain(id);
  });
});

describe("lineOutageImpact", () => {
  it("islands the smaller side of a bridge outage", () => {
    expect(lineOutageImpact(g, "l-bc")).toEqual({ islanded: ["A", "B"] });
  });

  it("reports no impact for one circuit of a parallel corridor", () => {
    expect(lineOutageImpact(g, "l-ab1")).toEqual({ islanded: [] });
    expect(lineOutageImpact(g, "l-ab2")).toEqual({ islanded: [] });
  });

  it("reports no impact for cycle edges and unknown line ids", () => {
    expect(lineOutageImpact(g, "l-cd")).toEqual({ islanded: [] });
    expect(lineOutageImpact(g, "no-such-line")).toEqual({ islanded: [] });
  });

  it("breaks an even split deterministically (keeps the side with the smallest id)", () => {
    expect(lineOutageImpact(g, "l-xy")).toEqual({ islanded: ["Y"] });
  });
});

describe("articulationSubstations", () => {
  it("finds the cut vertices of the hand-built fixture", () => {
    // B separates A from the triangle; C separates the triangle's D/E from A/B.
    expect(articulationSubstations(g)).toEqual(["B", "C"]);
  });

  it("reports none for a pure cycle", () => {
    const cycle = buildGridGraph(
      [{ id: "P" }, { id: "Q" }, { id: "R" }],
      [line("l-pq", "P", "Q"), line("l-qr", "Q", "R"), line("l-rp", "R", "P")],
    );
    expect(articulationSubstations(cycle)).toEqual([]);
    expect(bridgeLines(cycle)).toEqual([]);
  });
});
