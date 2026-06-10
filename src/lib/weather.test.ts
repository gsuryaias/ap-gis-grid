import { describe, expect, it } from "vitest";
import type { Polygon } from "geojson";
import type { SubstationProps } from "../data/types.ts";
import { pointInPolygonGeom, pointInRing } from "./geo.ts";
import { assetsInCone, circlePoints, cycloneInBasin, wmoGroup, wmoLabel } from "./weather.ts";

function ss(id: string, circle: string | null, lng: number, lat: number): SubstationProps {
  return {
    id,
    kind: "substation",
    name: id,
    descriptiveName: null,
    ssCode: null,
    voltage: 220,
    circle,
    circleInferred: false,
    doc: null,
    lng,
    lat,
    connectedLineIds: [],
    connectedLineCount: 0,
  };
}

describe("wmoLabel / wmoGroup", () => {
  it("labels the common codes", () => {
    expect(wmoLabel(0)).toBe("Clear sky");
    expect(wmoLabel(3)).toBe("Overcast");
    expect(wmoLabel(63)).toBe("Rain");
    expect(wmoLabel(95)).toBe("Thunderstorm");
    expect(wmoLabel(424)).toBe("—"); // unknown code degrades, never throws
  });

  it("buckets codes into icon families", () => {
    expect(wmoGroup(0)).toBe("clear");
    expect(wmoGroup(2)).toBe("cloud");
    expect(wmoGroup(45)).toBe("fog");
    expect(wmoGroup(61)).toBe("rain");
    expect(wmoGroup(80)).toBe("rain");
    expect(wmoGroup(73)).toBe("snow");
    expect(wmoGroup(96)).toBe("storm");
  });
});

describe("circlePoints", () => {
  it("returns one centroid per circle, sorted, skipping circle-less substations", () => {
    const pts = circlePoints([
      ss("a", "Vijayawada", 80, 16),
      ss("b", "Vijayawada", 82, 18),
      ss("c", "Anantapur", 77.5, 14.5),
      ss("d", null, 99, 99), // no circle → ignored
    ]);
    expect(pts.map((p) => p.circle)).toEqual(["Anantapur", "Vijayawada"]);
    const vja = pts.find((p) => p.circle === "Vijayawada")!;
    expect(vja.lng).toBeCloseTo(81, 6);
    expect(vja.lat).toBeCloseTo(17, 6);
  });
});

describe("cycloneInBasin", () => {
  it("accepts Bay of Bengal / Arabian Sea systems and rejects other basins", () => {
    expect(cycloneInBasin(85, 13)).toBe(true); // Bay of Bengal
    expect(cycloneInBasin(65, 15)).toBe(true); // Arabian Sea
    expect(cycloneInBasin(156.1, 28.7)).toBe(false); // western Pacific
    expect(cycloneInBasin(-75, 25)).toBe(false); // Atlantic
  });
});

describe("pointInRing / pointInPolygonGeom / assetsInCone", () => {
  const square: Polygon = {
    type: "Polygon",
    coordinates: [[[80, 15], [82, 15], [82, 17], [80, 17], [80, 15]]],
  };

  it("detects containment in a simple ring", () => {
    expect(pointInRing([81, 16], square.coordinates[0])).toBe(true);
    expect(pointInRing([83, 16], square.coordinates[0])).toBe(false);
  });

  it("respects holes", () => {
    const withHole: Polygon = {
      type: "Polygon",
      coordinates: [
        [[80, 15], [82, 15], [82, 17], [80, 17], [80, 15]],
        [[80.8, 15.8], [81.2, 15.8], [81.2, 16.2], [80.8, 16.2], [80.8, 15.8]],
      ],
    };
    expect(pointInPolygonGeom([81, 16], withHole)).toBe(false); // inside the hole
    expect(pointInPolygonGeom([80.4, 16], withHole)).toBe(true); // in the donut
  });

  it("filters substations to those inside any polygon", () => {
    const inside = ss("in", "X", 81, 16);
    const outside = ss("out", "X", 78, 13);
    expect(assetsInCone([inside, outside], [square]).map((s) => s.id)).toEqual(["in"]);
    expect(assetsInCone([inside, outside], [])).toEqual([]);
  });
});
