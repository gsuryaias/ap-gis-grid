// URL v2 contract: round-trips, defaults omitted, every v1 link still decodes, the `lyr` rule, and
// which changes push a history entry (Back steps through them) vs replace the current one.
import { describe, expect, it } from "vitest";
import { parseHash } from "./hash.ts";
import { decodeUrl, defaultUrlState, encodeUrl, fromV1, historyMode, LAYER_KEYS, type UrlState } from "./v2.ts";

const S = (o: Partial<UrlState> = {}): UrlState => ({ ...defaultUrlState(), ...o });

describe("URL v2 — encode / decode", () => {
  it("defaults encode to just the version", () => {
    expect(encodeUrl(S())).toBe("#v=2");
  });

  it("round-trips a full Explore view", () => {
    const s = S({
      selectedId: "s-ss-132kv-chnd",
      camera: { lng: 80.4012, lat: 15.9001, zoom: 6.25 },
      basemap: "dark",
      voltages: [400, 220],
      circuits: ["DC"],
      circle: "Kadapa",
      coastalBand: 0,
      showGeneration: true,
      showWeather: true,
      showSubstations: false,
      overlays: ["discom-lines", "districts", "towers-400kv"],
      tableOpen: true,
    });
    const h = encodeUrl(s);
    expect(h).toBe(
      "#@80.4012,15.9001,6.25z&v=2&sel=s-ss-132kv-chnd&lyr=gen,wx,discom-lines,ref:districts,towers-400kv,-ss&volt=400,220&circ=DC&circle=Kadapa&coast=0&base=dark&tbl=1",
    );
    expect(decodeUrl(h)).toEqual(s);
  });

  it("round-trips the Plan lens with its drill (MIS keys only there)", () => {
    const s = S({
      workspace: "mis",
      mapLayout: "collapsed",
      misBy: "division",
      misFilters: "voltage:400,220~circle:Kadapa~division:Visakhapatnam Zone-3",
      misTab: "age",
      misTheme: "age",
    });
    const h = encodeUrl(s);
    expect(h).toContain("lens=plan");
    expect(h).toContain("mf=voltage:400,220~circle:Kadapa~division:Visakhapatnam%20Zone-3");
    expect(h).toContain("th=age");
    // No camera / `lyr` in the link → the camera and layers stay as they are.
    const kept = Object.fromEntries(Object.entries(s).filter(([k]) => k !== "camera" && !(LAYER_KEYS as readonly string[]).includes(k)));
    expect(decodeUrl(h)).toEqual(kept);
    expect(encodeUrl({ ...s, workspace: "atlas", mapLayout: "atlas-only" })).not.toMatch(/by=|mf=|tab=|th=/);
  });

  it("`lyr` absent leaves the layers alone; present sets every layer key", () => {
    const none = decodeUrl("#v=2&sel=l-0001");
    for (const k of LAYER_KEYS) expect(none[k]).toBeUndefined();
    const some = decodeUrl("#v=2&lyr=pg");
    expect(LAYER_KEYS.map((k) => some[k])).toEqual([true, true, false, true, false, []]);
  });

  it("an omitted key resets to its default (Back fully restores an entry)", () => {
    expect(decodeUrl("#v=2")).toMatchObject({ selectedId: null, circle: null, coastalBand: null, basemap: "light", tableOpen: false, workspace: "atlas" });
  });

  it("drops junk instead of failing", () => {
    const d = decodeUrl("#@999,99,40z&v=2&sel=%3Cscript%3E&volt=7&circ=XX&coast=9&base=neon&lens=nope&lyr=%E0%A4%A,../x,ref:ok-id");
    expect(d.camera).toBeUndefined();
    expect(d.selectedId).toBeNull();
    expect(d.voltages).toEqual([400, 220, 132]);
    expect(d.coastalBand).toBeNull();
    expect(d.basemap).toBe("light");
    expect(d.workspace).toBe("atlas");
    expect(decodeUrl("#v=2&lyr=ref:ok-id,../x").overlays).toEqual(["ok-id"]);
    expect(decodeUrl("#v=9&sel=s-1")).toEqual({});
    expect(decodeUrl("#sel=s-1")).toEqual({});
  });

  it("field / storm lenses open Explore until phase 3", () => {
    expect(decodeUrl("#v=2&lens=storm").workspace).toBe("atlas");
  });
});

describe("URL v2 — v1 links", () => {
  const V1 = [
    "#v=1&sel=s-1234",
    "#v=1&base=dark&volt=400%2C220&circ=DC&show=ln&gen=1&pg=1&wx=1&tbl=1&circle=Kadapa&coast=0",
    "#v=1&w=mis&by=division&mf=voltage%3A400%2C220~circle%3AKadapa&tab=age&theme=age&map=collapsed",
    "#v=1&w=risk&sel=l-17",
  ];
  it("decode exactly as the v1 parser did", () => {
    for (const h of V1) expect(decodeUrl(h)).toEqual(fromV1(parseHash(h)));
  });
  it("and survive being rewritten to v2", () => {
    for (const h of V1) {
      const s = S(decodeUrl(h));
      expect(S(decodeUrl(encodeUrl(s)))).toEqual(s);
    }
    expect(encodeUrl(S(decodeUrl(V1[2])))).toBe("#v=2&lens=plan&map=collapsed&by=division&mf=voltage:400,220~circle:Kadapa&tab=age&th=age");
  });
});

describe("history policy", () => {
  const a = S({ camera: { lng: 80, lat: 16, zoom: 7 } });
  it("navigation pushes", () => {
    expect(historyMode(a, { ...a, selectedId: "s-1" })).toBe("push");
    expect(historyMode(a, { ...a, workspace: "mis", mapLayout: "open" })).toBe("push");
    expect(historyMode(a, { ...a, circle: "Kadapa" })).toBe("push");
    const plan = { ...a, workspace: "mis" as const, mapLayout: "open" as const };
    expect(historyMode(plan, { ...plan, misFilters: "circle:Kadapa" })).toBe("push");
  });
  it("view tweaks replace", () => {
    expect(historyMode(a, { ...a, camera: { lng: 80.5, lat: 16, zoom: 7 } })).toBe("replace");
    expect(historyMode(a, { ...a, basemap: "dark" })).toBe("replace");
    expect(historyMode(a, { ...a, voltages: [400] })).toBe("replace");
    expect(historyMode(a, { ...a, overlays: ["discom-ss"] })).toBe("replace");
  });
  it("no URL change, no write", () => {
    expect(historyMode(a, { ...a, camera: { lng: 80.00001, lat: 16, zoom: 7 } })).toBe("none");
  });
});
