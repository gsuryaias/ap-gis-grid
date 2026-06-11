import type { FeatureCollection } from "geojson";
import { describe, expect, it } from "vitest";
import type { GridData, SubstationProps } from "../../data/types.ts";
import {
  applyScenario,
  registerToCsv,
  riskBaseRows,
  SCENARIOS,
  type BaseRow,
  type ScenarioId,
} from "./model.ts";

const scenario = (id: ScenarioId) => SCENARIOS.find((s) => s.id === id)!;

function fakeSS(name: string): SubstationProps {
  return {
    id: `s-${name}`,
    kind: "substation",
    name,
    descriptiveName: null,
    ssCode: null,
    voltage: 220,
    circle: "Vijayawada",
    circleInferred: false,
    doc: null,
    lng: 80,
    lat: 16,
    connectedLineIds: [],
    connectedLineCount: 2,
    coastalKm: 12.5,
  };
}

function makeRow(name: string, over: Partial<BaseRow> = {}): BaseRow {
  return {
    ss: fakeSS(name),
    windVb: 44,
    coastalBand: 1,
    feedDegree: 2,
    liveInCone: false,
    vulnerability: 50,
    vulnFactors: [],
    criticality: 40,
    critFactors: [],
    ...over,
  };
}

describe("applyScenario", () => {
  it("normal: no cone is assumed even when a live cone covers the asset", () => {
    const [r] = applyScenario([makeRow("a", { liveInCone: true })], scenario("normal"));
    expect(r.inCone).toBe(false);
    expect(r.hazard).toBe(38); // wind 44 → 20 + coastal band 1 → 18
  });

  it("watch: forces in-cone for coastal bands ≤ 1 and scales every hazard ×1.15", () => {
    const rows = applyScenario(
      [makeRow("coastal", { coastalBand: 1 }), makeRow("mid", { coastalBand: 2, windVb: 39 })],
      scenario("watch"),
    );
    const coastal = rows.find((r) => r.ss.name === "coastal")!;
    const mid = rows.find((r) => r.ss.name === "mid")!;
    expect(coastal.inCone).toBe(true);
    expect(coastal.hazard).toBe(78); // round((20+18+30) × 1.15)
    expect(mid.inCone).toBe(false); // band 2 is outside the watch assumption
    expect(mid.hazard).toBe(18); // round((8+8) × 1.15) — the storm-wide factor still applies
  });

  it("severe: forces in-cone for coastal bands ≤ 2, scales ×1.3 and clamps at 100", () => {
    const rows = applyScenario(
      [makeRow("worst", { windVb: 50, coastalBand: 0 }), makeRow("band2", { windVb: 39, coastalBand: 2 })],
      scenario("severe"),
    );
    const worst = rows.find((r) => r.ss.name === "worst")!;
    const band2 = rows.find((r) => r.ss.name === "band2")!;
    expect(worst.hazard).toBe(100); // (40+30+30) × 1.3 clamps
    expect(band2.inCone).toBe(true);
    expect(band2.hazard).toBe(60); // round((8+8+30) × 1.3)
  });

  it("active: uses the real live-cone flag, with no synthetic scaling", () => {
    const rows = applyScenario(
      [
        makeRow("inside", { windVb: null, coastalBand: 3, liveInCone: true }),
        makeRow("outside", { windVb: null, coastalBand: 3, liveInCone: false }),
      ],
      scenario("active"),
    );
    expect(rows.find((r) => r.ss.name === "inside")!.hazard).toBe(38); // 8 + 30 cone
    expect(rows.find((r) => r.ss.name === "outside")!.hazard).toBe(8);
  });

  it("returns rows sorted by composite, descending", () => {
    const rows = applyScenario(
      [makeRow("mild", { windVb: 39, coastalBand: 3, vulnerability: 10, criticality: 10 }), makeRow("hot", { windVb: 50, coastalBand: 0, vulnerability: 90, criticality: 90 })],
      scenario("normal"),
    );
    expect(rows[0].ss.name).toBe("hot");
    expect(rows[0].composite).toBeGreaterThan(rows[1].composite);
    expect(rows[0].tier).toBeDefined();
  });
});

describe("registerToCsv", () => {
  it("emits the documented briefing columns", () => {
    const csv = registerToCsv(applyScenario([makeRow("a")], scenario("normal")));
    const [header, row] = csv.split("\r\n");
    expect(header).toBe(
      "name,voltage_kv,circle,coastal_km,wind_vb_ms,feed_degree,hazard,vulnerability,criticality,composite,tier",
    );
    expect(row.startsWith("a,220,Vijayawada,12.5,44,2,38,50,40,")).toBe(true);
  });
});

describe("riskBaseRows memoisation", () => {
  const zones: FeatureCollection = { type: "FeatureCollection", features: [] };
  const data = { substations: [], lines: [] } as unknown as GridData;

  it("returns the identical array for identical (data, weather, zones) identities", () => {
    expect(riskBaseRows(data, null, zones)).toBe(riskBaseRows(data, null, zones));
  });

  it("recomputes when any input identity changes", () => {
    const first = riskBaseRows(data, null, zones);
    const otherZones: FeatureCollection = { type: "FeatureCollection", features: [] };
    expect(riskBaseRows(data, null, otherZones)).not.toBe(first);
  });
});
