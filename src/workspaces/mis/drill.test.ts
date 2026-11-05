// Reconciliation: every number the MIS prints must equal what its drill-down lists. Runs on the
// real emitted network (public/data), over the whole state, every circle and voltage slices.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ConnectivityIndex } from "../../data/connectivity.ts";
import { graphAnalysis } from "../../data/graph-data.ts";
import type { GridData, LineProps, SubstationProps } from "../../data/types.ts";
import { drillRecords, METRICS, recordsFocus, scopeInterfaces, type MetricId } from "./drill.ts";
import { applyScope, buildModel, DIMENSIONS, groupBy, groupScope, metrics, type Scope, type ScopeFilter } from "./model.ts";

const json = <T,>(f: string): T => JSON.parse(readFileSync(new URL(`../../../public/data/${f}`, import.meta.url), "utf8")) as T;
const props = <T,>(f: string) => json<{ features: { properties: T }[] }>(f).features.map((x) => x.properties);

const data = {
  substations: props<SubstationProps>("substations.geojson"),
  lines: props<LineProps>("lines.geojson"),
} as unknown as GridData;
const conn = json<ConnectivityIndex>("transco-33kv.json");
const model = buildModel(data, graphAnalysis(data), conn, 2026);

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6 * Math.max(1, Math.abs(b)));

/** The figure each metric labels, recomputed exactly as the KPI tiles / breakdown compute it. */
function figure(scope: Scope, metric: MetricId): number {
  const m = metrics(scope.ss, scope.lines);
  switch (metric) {
    case "ss":
      return m.ss;
    case "ss400":
    case "ss220":
    case "ss132":
      return m.ssByV[Number(metric.slice(2)) as 400];
    case "lines":
      return m.ckm;
    case "ckm400":
    case "ckm220":
    case "ckm132":
      return m.ckmByV[Number(metric.slice(3)) as 400];
    case "route":
      return m.routeKm;
    case "mva":
      return m.mva;
    case "unrated":
      return m.lines - m.ratedLines;
    case "age":
      return m.meanAge ?? 0;
    case "past":
      return (m.pctPastLife ?? 0) * m.ageKnownCkm;
    case "ageUnknown":
      return scope.lines.filter((r) => r.age == null).length;
    case "radial":
      return m.radialSc + m.radialDc;
    case "radialSc":
      return m.radialSc;
    case "radialDc":
      return m.radialDc;
    case "radialDiscom":
      return m.radialDiscomSs;
    case "bridges":
      return m.bridges;
    case "bridgeDiscom": {
      const s = new Set<string>();
      for (const l of scope.lines) for (const id of l.islanded) for (const d of model.ssById.get(id)?.discomSsIds ?? []) s.add(d);
      return s.size;
    }
    case "singleFed":
      return m.singleFed;
    case "cut":
      return m.articulation;
    case "feedingSs":
      return scope.ss.filter((r) => r.feeders > 0).length;
    case "feeders":
      return m.feeders;
    case "discomSs":
      return m.discomSs;
    case "ifaceWeak":
      return scopeInterfaces(model, scope.lines).length;
    case "ifaceGen":
      return scopeInterfaces(model, scope.lines).filter((f) => f.category === "Generation").length;
    case "ifaceRail":
      return scopeInterfaces(model, scope.lines).filter((f) => f.category === "Railway").length;
  }
}

/** Reduce a record list to the same kind of figure (count, sum or weighted mean). */
function fromRecords(scope: Scope, metric: MetricId): number {
  const r = drillRecords(model, conn, scope, metric);
  if (r.kind !== "lines") return r.rows.length;
  const rows = r.rows;
  switch (metric) {
    case "lines":
    case "ckm400":
    case "ckm220":
    case "ckm132":
    case "past":
      return rows.reduce((a, x) => a + x.ckm, 0);
    case "route":
      return rows.reduce((a, x) => a + x.routeKm, 0);
    case "mva":
      return rows.reduce((a, x) => a + x.mva!, 0);
    case "age": {
      const ckm = rows.reduce((a, x) => a + x.ckm, 0);
      return ckm ? rows.reduce((a, x) => a + x.age! * x.ckm, 0) / ckm : 0;
    }
    default:
      return rows.length;
  }
}

const ALL = Object.keys(METRICS) as MetricId[];
const check = (scope: Scope) => {
  for (const id of ALL) close(fromRecords(scope, id), figure(scope, id));
};

describe("drill-down reconciliation (real network)", () => {
  it("has the network and the 33 kV index loaded", () => {
    expect(model.ss.length).toBeGreaterThan(350);
    expect(model.lines.length).toBeGreaterThan(1100);
    expect(model.hasDownstream).toBe(true);
  });

  it("reconciles every metric statewide", () => check({ ss: model.ss, lines: model.lines }));

  it("reconciles every metric in every breakdown group (circle, voltage, supply, age)", () => {
    const all = { ss: model.ss, lines: model.lines };
    for (const dim of ["circle", "voltage", "supply", "age"] as const)
      for (const g of groupBy(all, dim)) check(groupScope(all, dim, g.key));
  });

  it("reconciles under a multi-voltage slicer + drill path", () => {
    const f: ScopeFilter[] = [
      { dim: "voltage", values: ["400", "220"] },
      { dim: "circle", values: ["Kadapa"] },
    ];
    const s = applyScope(model, f);
    expect(s.ss.every((r) => r.voltage !== 132)).toBe(true);
    check(s);
  });

  it("offers an exact page filter where it claims one", () => {
    const all = { ss: model.ss, lines: model.lines };
    for (const id of ALL) {
      const af = METRICS[id].asFilter;
      if (!af) continue;
      const recs = drillRecords(model, conn, all, id);
      const filtered = applyScope(model, [af]);
      const ids = new Set(recs.rows.map((r) => (r as { id: string }).id));
      const pool = recs.kind === "ss" ? filtered.ss : filtered.lines;
      expect(new Set(pool.map((r) => r.id)), id).toEqual(ids);
    }
  });

  it("lights the assets of a record set on the map", () => {
    const f = recordsFocus(model, drillRecords(model, conn, { ss: model.ss, lines: model.lines }, "bridges"), "k", "l");
    expect(f.lineIds.length).toBe(metrics(model.ss, model.lines).bridges);
    expect(f.ssIds.length).toBeGreaterThan(0);
  });

  it("no dimension value contains the hash separators", () => {
    for (const d of Object.values(DIMENSIONS)) {
      for (const r of model.ss) if (d.ss) expect(d.ss(r)).not.toMatch(/[,~]/);
      for (const r of model.lines) if (d.line) expect(d.line(r)).not.toMatch(/[,~]/);
    }
  });
});
