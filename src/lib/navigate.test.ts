import { describe, expect, it } from "vitest";
import { isIos, navLinks, navTarget } from "./navigate.ts";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

describe("navLinks", () => {
  it("gives Google Maps directions + a geo: link on Android", () => {
    const [g, app] = navLinks(83.123456789, 18.2, "132 kV X & Y", ANDROID);
    expect(g.href).toBe("https://www.google.com/maps/dir/?api=1&destination=18.2,83.123457&travelmode=driving");
    expect(app).toEqual({ label: "Maps app", href: "geo:18.2,83.123457?q=18.2,83.123457(132%20kV%20X%20%26%20Y)" });
  });
  it("uses Apple Maps on iOS and passes the user's fix as the origin", () => {
    expect(isIos(IPHONE)).toBe(true);
    expect(isIos(ANDROID)).toBe(false);
    const [g, app] = navLinks(83, 18, "SS", IPHONE, [83.5, 18.5]);
    expect(g.href).toContain("&origin=18.5,83.5&destination=18,83");
    expect(app.href).toBe("https://maps.apple.com/?daddr=18,83&q=SS");
  });
});

describe("navTarget", () => {
  const line = { type: "LineString" as const, coordinates: [[80, 15], [80.1, 15], [80.2, 15], [80.3, 15]] };
  it("a point is itself", () => {
    expect(navTarget({ type: "Point", coordinates: [80, 15] })).toEqual({ lng: 80, lat: 15, how: "point", meters: null });
    expect(navTarget({ type: "Point", coordinates: [80, 15] }, [80, 15])!.meters).toBe(0);
  });
  it("a line goes to the vertex nearest the user, else its middle", () => {
    expect(navTarget(line, [80.29, 15.01])).toMatchObject({ lng: 80.3, lat: 15, how: "nearest" });
    expect(navTarget(line, [80.29, 15.01])!.meters).toBeLessThan(2000);
    expect(navTarget(line)).toMatchObject({ lng: 80.2, lat: 15, how: "middle" });
    expect(navTarget({ type: "MultiLineString", coordinates: [[[1, 1], [2, 2]], [[5, 5], [6, 6]]] }, [6, 6])).toMatchObject({ lng: 6, lat: 6 });
  });
  it("nothing to go to", () => {
    expect(navTarget(null)).toBeNull();
    expect(navTarget({ type: "LineString", coordinates: [] })).toBeNull();
  });
});
