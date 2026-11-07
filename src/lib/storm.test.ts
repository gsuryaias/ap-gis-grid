import { readFileSync } from "node:fs";
import type { FeatureCollection, Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import type { ConnectivityIndex } from "../data/connectivity.ts";
import { stormPicture, stormSystem } from "../data/storm.ts";
import type { GridData, LineProps, SubstationProps } from "../data/types.ts";
import type { CycloneEvent, WeatherData } from "../data/weather.ts";
import {
  circleBoard,
  distanceToPathsKm,
  exposedLines,
  overallStatus,
  stormSituation,
  warningEnvelope,
  type StormFeeder,
  type StormSystem,
} from "./storm.ts";
import { computeSupplySecurity, type SecLine } from "./supply-security.ts";

const box = (x0: number, y0: number, x1: number, y1: number): Polygon => ({
  type: "Polygon",
  coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
});

// Meshed triangle a-b-c; c → d (single circuit) → e (single circuit); f hangs off b. The cone sits on
// d only; the b-f line's route crosses the cone although neither end is in it. g is a coastal SS
// ~85 km from the track; h is at the same spot but inland.
const SS = [
  { id: "a", lng: 80, lat: 15, coastalBand: 3 },
  { id: "b", lng: 80.5, lat: 15, coastalBand: 3 },
  { id: "c", lng: 80.25, lat: 15.5, coastalBand: 3 },
  { id: "d", lng: 81, lat: 16, coastalBand: 1 },
  { id: "e", lng: 81.5, lat: 16.5, coastalBand: 2 },
  { id: "f", lng: 79, lat: 14, coastalBand: 3 },
  { id: "g", lng: 83, lat: 15.6, coastalBand: 0 },
  { id: "h", lng: 83, lat: 15.6, coastalBand: 3 },
] as const;
const SEC_LINES: SecLine[] = [
  ["ab", "a", "b"],
  ["bc", "b", "c"],
  ["ca", "c", "a"],
  ["cd", "c", "d"],
  ["de", "d", "e"],
  ["bf", "b", "f"],
].map(([id, a, b]): SecLine => ({ id, fromSS: { ssId: a }, toSS: { ssId: b }, circuits: 1, routeKm: 10 }));
// A plant switchyard hanging off e: a corridor-graph node, never an at-risk "substation".
const PLANT: SecLine = { id: "ep", fromSS: { ssId: "e" }, toSS: null, circuits: 1, routeKm: 5, externalEndpoints: [{ name: "Plant", category: "Generation" }] };
const at = (id: string) => SS.find((s) => s.id === id)!;
const GEOM = SEC_LINES.map((l) => ({
  id: l.id,
  coastalBand: 3,
  coords: [l.id === "bf" ? [[80.5, 15], [81, 15.95], [79, 14]] : [[at(l.fromSS!.ssId).lng, at(l.fromSS!.ssId).lat], [at(l.toSS!.ssId).lng, at(l.toSS!.ssId).lat]]],
}));
const SYS: StormSystem = {
  id: 7,
  name: "Test",
  alertLevel: "Orange",
  cones: [box(80.9, 15.9, 81.1, 16.1)],
  track: [[[84, 14], [81, 16]]],
};
const F = (id: string, discom: string, ...ss: string[]): StormFeeder => [id, id, discom, 5, "name", ss];
const FEEDERS: Record<string, StormFeeder[]> = {
  d: [F("fd1", "APEPDCL", "x1", "x2")],
  e: [F("fe1", "APEPDCL", "x2", "x3"), F("fe2", "APCPDCL", "y1")],
  f: [F("ff1", "APSPDCL", "z1")],
  a: [F("fa1", "APSPDCL", "z9")],
};

describe("geometry", () => {
  it("measures point → polyline distance in km", () => {
    // 1° of latitude ≈ 111 km
    expect(distanceToPathsKm([80, 16], [[[79, 15], [81, 15]]])).toBeCloseTo(111.3, 0);
    expect(distanceToPathsKm([80, 15], [[[80, 15]]])).toBe(0);
    expect(distanceToPathsKm([80, 15], [])).toBe(Infinity);
  });
});

describe("warningEnvelope", () => {
  it("is the cone plus coastal substations near the track", () => {
    const hits = warningEnvelope(SS, [SYS]);
    expect(hits.map((h) => [h.id, h.reason])).toEqual([
      ["d", "cone"],
      ["g", "coast-track"],
    ]);
    expect(hits[0]).toMatchObject({ systemIds: [7], alertLevel: "Orange", trackKm: 0 });
    expect(hits[1].trackKm).toBeGreaterThan(80);
    expect(hits[1].trackKm).toBeLessThan(90);
  });
  it("honours the distance and band options, and is empty with no systems", () => {
    expect(warningEnvelope(SS, [SYS], { trackKm: 50 }).map((h) => h.id)).toEqual(["d"]);
    expect(warningEnvelope(SS, [SYS], { coastBand: 3 }).map((h) => h.id)).toContain("h");
    expect(warningEnvelope(SS, [])).toEqual([]);
  });
});

describe("exposedLines", () => {
  it("flags lines with a vertex in the cone (even when both ends are outside)", () => {
    expect([...exposedLines(GEOM, [SYS])].sort()).toEqual(["bf", "cd", "de"]);
  });
});

describe("stormSituation", () => {
  const sec = computeSupplySecurity(SS, [...SEC_LINES, PLANT]);
  const sit = stormSituation({ substations: SS, lines: GEOM, sec, feeders: FEEDERS, systems: [SYS] });

  it("adds substations whose radial feed crosses exposure (never a plant switchyard)", () => {
    expect(sec.bySs.has("gen:plant")).toBe(true);
    expect(Object.fromEntries(sit.atRisk)).toEqual({ d: "envelope", g: "envelope", e: "feed", f: "feed" });
  });
  it("lists exposed cut points with what they island", () => {
    expect(sit.cuts).toEqual([{ id: "d", islanded: ["e"], discomSs: 3 }]);
  });
  it("lists exposed radial pockets ranked by 33/11 kV load", () => {
    expect(sit.pockets.map((p) => [p.headId, p.atRiskIds.sort(), p.discomSs])).toEqual([
      ["c", ["d", "e"], 4],
      ["b", ["f"], 1],
    ]);
  });
  it("sums the 33 kV downstream of every at-risk SS, by DISCOM", () => {
    expect(sit.downstream.feeders).toBe(4);
    expect(sit.downstream.discomSs).toBe(5);
    expect(sit.downstream.byDiscom).toEqual([
      { discom: "APEPDCL", feeders: 2, discomSs: 3 },
      { discom: "APCPDCL", feeders: 1, discomSs: 1 },
      { discom: "APSPDCL", feeders: 1, discomSs: 1 },
    ]);
    expect(sit.downstream.rows.map((r) => [r.transcoId, r.via])).toContainEqual(["e", "feed"]);
  });
  it("has nothing at risk with no system", () => {
    const calm = stormSituation({ substations: SS, lines: GEOM, sec, feeders: FEEDERS, systems: [] });
    expect(calm.atRisk.size + calm.pockets.length + calm.cuts.length + calm.downstream.feeders).toBe(0);
  });
});

describe("circleBoard", () => {
  const circleOf: Record<string, string> = { d: "X", e: "X", f: "Y" };
  const sit = { envelopeIds: new Set(["d"]), atRisk: new Map([["d", "envelope"], ["e", "feed"], ["f", "feed"]] as const) };
  const fc = (circle: string, gust = 30, rain = 5) => ({ circle, gustMaxKmh: gust, rainMaxMm: rain });

  it("ranks warning > watch > no information > clear", () => {
    const rows = circleBoard(["W", "X", "Y", "Z", "V"], (id) => circleOf[id], sit, [fc("X"), fc("Y"), fc("Z"), fc("V", 70, 130)], true);
    expect(rows.map((r) => [r.circle, r.status])).toEqual([
      ["X", "warning"],
      ["Y", "watch"],
      ["V", "watch"],
      ["W", "noinfo"],
      ["Z", "clear"],
    ]);
    expect(rows[0]).toMatchObject({ envelope: 1, atRisk: 1 });
    expect(rows[2].reasons).toEqual(["gusts to 70 km/h", "130 mm/day rain"]);
    expect(rows[3].reasons).toEqual(["no forecast"]);
    expect(overallStatus(rows)).toBe("warning");
  });
  it("never says clear when the cyclone feed is down", () => {
    const rows = circleBoard(["Z"], () => null, { envelopeIds: new Set(), atRisk: new Map() }, [fc("Z")], false);
    expect(rows[0]).toMatchObject({ status: "noinfo", reasons: ["cyclone feed unavailable"] });
    expect(overallStatus(rows)).toBe("noinfo");
    expect(overallStatus([])).toBe("noinfo");
  });
});

describe("on the real network (public/data)", () => {
  const json = <T,>(f: string): T => JSON.parse(readFileSync(new URL(`../../public/data/${f}`, import.meta.url), "utf8")) as T;
  const substationsFc = json<FeatureCollection>("substations.geojson");
  const linesFc = json<FeatureCollection>("lines.geojson");
  const data = {
    substations: substationsFc.features.map((f) => f.properties as SubstationProps),
    lines: linesFc.features.map((f) => f.properties as LineProps),
    linesFc,
    meta: json("meta.json"),
  } as unknown as GridData;
  const conn = json<ConnectivityIndex>("transco-33kv.json");
  // A synthetic landfall near Kakinada, coming in from the south-east.
  const ev = {
    id: 1,
    name: "Synthetic",
    alertLevel: "Red",
    conePolygons: [box(81.9, 16.6, 82.6, 17.3)],
    geometry: {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { wxKind: "track" }, geometry: { type: "LineString", coordinates: [[85, 14.5], [82.25, 16.95], [81.5, 17.6]] } }],
    },
  } as unknown as CycloneEvent;
  const weather = { cyclones: [ev], circles: [], marine: [], radar: null, fetchedAt: 1, sourceErrors: [] } as WeatherData;
  const pic = stormPicture(data, weather, conn);
  const { situation: sit } = pic;

  it("puts Kakinada-area substations in the envelope, and the coast beyond the cone too", () => {
    expect(stormSystem(ev).track).toHaveLength(1);
    expect(sit.envelope.filter((h) => h.reason === "cone").length).toBeGreaterThan(5);
    expect(sit.envelope.some((h) => h.reason === "coast-track")).toBe(true);
    for (const h of sit.envelope.filter((x) => x.reason === "coast-track")) {
      const s = data.substations.find((x) => x.id === h.id)!;
      expect(s.coastalBand).toBeLessThanOrEqual(1);
      expect(h.trackKm).toBeLessThanOrEqual(150);
    }
  });
  it("adds supply-exposed substations and reconciles the downstream count with the index", () => {
    expect([...sit.atRisk.values()].some((v) => v !== "envelope")).toBe(true);
    // Every at-risk id is a real TRANSCO substation (so the headline count = the listed rows).
    const ids = new Set(data.substations.map((x) => x.id));
    expect([...sit.atRisk.keys()].filter((id) => !ids.has(id))).toEqual([]);
    const expected = [...sit.atRisk.keys()].reduce((n, id) => n + (conn.bySs[id]?.length ?? 0), 0);
    expect(sit.downstream.feeders).toBe(expected);
    expect(sit.downstream.byDiscom.reduce((n, d) => n + d.feeders, 0)).toBe(expected);
  });
  it("rates the landfall circle Warning and the rest No information without forecasts", () => {
    const top = pic.board[0];
    expect(top.status).toBe("warning");
    expect(top.envelope).toBe(Math.max(...pic.board.map((r) => r.envelope))); // most SS in the envelope first
    expect(pic.board.find((r) => r.circle === "Rajamahendravaram")!.status).toBe("warning"); // Kakinada
    expect(pic.board.some((r) => r.circle === "Unassigned")).toBe(false);
    expect(pic.board.filter((r) => r.status === "clear")).toEqual([]);
    expect(stormPicture(data, weather, conn)).toBe(pic); // memoised
  });
});
