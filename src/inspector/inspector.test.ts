// Inspector adapters on the real emitted network (public/data) + fixtures: sections are data, so
// what each panel shows is checked here without rendering.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FeatureCollection } from "geojson";
import { graphAnalysis } from "../data/graph-data.ts";
import type { NetItem } from "../data/network-search.ts";
import { connectedLines } from "../data/selectors.ts";
import type { FeatureProps, GridData, LineProps, SubstationProps } from "../data/types.ts";
import { DISCOM_DEFS, refDef, TOWER_DEFS, type OverlayDef } from "../overlays/catalog.ts";
import { decodeTowers, type WebTowersFile } from "../overlays/towers.ts";
import { rankHits } from "../map/interaction.ts";
import { overlayPick } from "../map/registry/overlays.ts";
import type { Interaction } from "../map/registry/types.ts";
import { propertyRows, traceLevels, type NetEntity } from "./adapters/net.ts";
import { ADAPTERS, inspect, mergeSections, needsOf } from "./inspect.ts";
import { isValidRef, netRef, parseRefFeature, parseTowerRef, refKind, towerRef } from "./refs.ts";
import type { InspectorCtx, Section } from "./types.ts";

const json = <T,>(f: string): T => JSON.parse(readFileSync(new URL(`../../public/data/${f}`, import.meta.url), "utf8")) as T;
const substationsFc = json<FeatureCollection>("substations.geojson");
const linesFc = json<FeatureCollection>("lines.geojson");
const substations = substationsFc.features.map((f) => f.properties as SubstationProps);
const lines = linesFc.features.map((f) => f.properties as LineProps);
const byId = new Map<string, FeatureProps>([...substations, ...lines].map((f) => [f.id, f]));
const data = { substations, lines, substationsFc, linesFc, byId, meta: json("meta.json") } as unknown as GridData;

const overlays: Record<string, FeatureCollection> = {};
const defs: Record<string, OverlayDef> = Object.fromEntries([...DISCOM_DEFS, ...TOWER_DEFS].map((d) => [d.id, d]));
const ctx = (extra: Partial<InspectorCtx> = {}): InspectorCtx => ({
  data,
  overlay: (id) => overlays[id],
  overlayDef: (id) => defs[id],
  year: 2026,
  ...extra,
});
const ids = (s: Section[]) => s.map((x) => x.id);

describe("refs", () => {
  it("classifies every selectable kind by prefix", () => {
    expect(refKind("s-ss-132kv-chnd")).toBe("core-ss");
    expect(refKind("l-17")).toBe("core-line");
    expect(refKind("g-vtps")).toBe("plant");
    expect(refKind("pl-3")).toBe("pg-line");
    expect(refKind("ds-ep-1")).toBe("net");
    expect(refKind("f11-ep-01111101")).toBe("net");
    expect(refKind("dtr:034400109033")).toBe("net");
    expect(refKind("tw:400:12")).toBe("tower");
    expect(refKind("ref:districts:3")).toBe("ref");
    expect(refKind("x-1")).toBeNull();
    expect(refKind("s-")).toBeNull();
  });

  it("round-trips tower / reference refs and builds net refs", () => {
    expect(towerRef("towers-220kv", 41)).toBe("tw:220:41");
    expect(parseTowerRef("tw:220:41")).toEqual({ layer: "towers-220kv", index: 41 });
    expect(parseRefFeature("ref:reserve-forest:9")).toEqual({ layer: "reserve-forest", index: 9 });
    expect(netRef({ kind: "f11", ref: "f11-ep-1", label: "x" })).toBe("f11-ep-1");
    expect(netRef({ kind: "dtr", ref: "", label: "0344" })).toBe("dtr:0344");
    expect(netRef({ kind: "sec", ref: "", label: "Etcherla section" })).toBe("sec:Etcherla section");
  });

  it("validates refs from a URL", () => {
    expect(isValidRef("s-ss-132kv-chnd")).toBe(true);
    expect(isValidRef("sec:Etcherla section")).toBe(true);
    expect(isValidRef("dtr:03 44")).toBe(false);
    expect(isValidRef('s-"><img')).toBe(false);
    expect(isValidRef("nope")).toBe(false);
  });

  it("only the adapters that need lazy data ask for it", () => {
    expect(needsOf("s-x")).toEqual({});
    expect(needsOf("g-x")).toEqual({ gen: true });
    expect(needsOf("dl-ep-1")).toEqual({ overlay: "discom-lines", net: true });
    expect(needsOf("dtr:1234")).toEqual({ overlay: "discom-11kv-lines", net: true });
    expect(needsOf("sec:x")).toEqual({ overlay: null, net: true });
    expect(needsOf("tw:132:5")).toEqual({ overlay: "towers-132kv" });
  });
});

describe("core adapters (real network)", () => {
  const ga = graphAnalysis(data);
  const ss = substations.find((s) => s.connectedLineIds.length >= 3)!;

  it("a substation: overview, risk, weather, connectivity (every connected line), downstream", () => {
    const ins = inspect(ss.id, ctx())!;
    expect(ins.header).toMatchObject({ kicker: "Substation", title: ss.name, badge: { voltage: ss.voltage } });
    expect(ids(ins.sections)).toEqual(["overview", "risk", "weather", "connectivity", "downstream"]);
    const conn = ins.sections.find((s) => s.id === "connectivity")!;
    expect(conn.kind === "links" && conn.items.map((i) => i.ref)).toEqual(connectedLines(ss, data).map((c) => c.line.id));
    expect(ins.locate).toEqual({ center: [ss.lng, ss.lat], zoom: 11.5 });
    expect(ins.spotlight).toBe(true);
    expect(ins.geojson!()!.features).toHaveLength(1);
  });

  it("a bridge line warns about the substations its outage islands", () => {
    const [bridgeId, islanded] = [...ga.bridgeImpacts].find(([, v]) => v.length > 0)!;
    const ins = inspect(bridgeId, ctx())!;
    const supply = ins.sections.find((s) => s.id === "supply");
    expect(supply?.kind).toBe("callout");
    expect(supply?.kind === "callout" && supply.text).toContain(`island ${islanded.length} substation`);
    expect("bounds" in ins.locate!).toBe(true);
  });

  it("a rated line shows its indicative capacity + method note; DLR only with live weather", () => {
    const line = lines.find((l) => l.conductor && /zebra/i.test(l.conductor))!;
    const ins = inspect(line.id, ctx())!;
    const cap = ins.sections[0].kind === "fields" ? ins.sections[0].rows.find((r) => r.label === "Thermal capacity") : undefined;
    expect(cap?.value).toMatch(/MVA/);
    expect(cap?.method).toBe("capacity"); // the "Indicative" chip opens the capacity method card
    expect(cap?.sub).toBeUndefined();
    expect(ins.sections.at(-1)).toMatchObject({ id: "provenance", kind: "note" });
  });

  it("derived figures carry a method card; every method id used exists", () => {
    const ss = substations[0];
    const sec = inspect(ss.id, ctx())!.sections;
    const risk = sec.find((s) => s.id === "risk");
    const methods = risk?.kind === "fields" ? risk.rows.map((r) => r.method).filter(Boolean) : [];
    expect(methods).toContain("risk");
    expect(sec.find((s) => s.id === "connectivity")?.method).toBe("connectivity");
  });

  it("unknown / not-yet-loaded refs don't resolve", () => {
    expect(inspect("s-does-not-exist", ctx())).toBeNull();
    expect(inspect("g-plant", ctx())).toBeNull(); // generation not loaded
    expect(inspect("garbage", ctx())).toBeNull();
  });
});

describe("distribution network adapter", () => {
  const f11 = {
    type: "Feature" as const,
    geometry: { type: "LineString" as const, coordinates: [[83.9, 18.27], [83.91, 18.28]] },
    properties: {
      id: "f11-ep-1",
      discom: "APEPDCL",
      name: "11KV Arasavalli",
      code: "01111101",
      ss: "Arasavalli",
      ssId: "ds-ep-9",
      linkMethod: "recorded",
      transcoSs: "132 kV CHILAKAPALEM",
      transcoSsId: "s-ss-132kv-ckpm",
      lengthKm: 7.59,
    },
  };
  overlays["discom-11kv-lines"] = { type: "FeatureCollection", features: [f11] };
  const item: NetItem = {
    label: "11KV Arasavalli",
    kind: "f11",
    sub: "APEPDCL · 11 kV from Arasavalli SS",
    lng: 83.9,
    lat: 18.28,
    ref: "f11-ep-1",
    chain: ["ds-ep-9", "Arasavalli", "dl-ep-4", "33KV Arasavalli", "s-ss-132kv-ckpm", "132 kV CHILAKAPALEM"],
  };

  it("an 11 kV feeder: attributes (TRANSCO source + 33/11 SS as links) and the full supply path", () => {
    const ins = inspect("f11-ep-1", ctx({ netItem: item }))!;
    expect(ins.header).toMatchObject({ title: "11KV Arasavalli", kicker: "11 kV feeder · APEPDCL" });
    expect(ids(ins.sections)).toEqual(["overview", "trace", "provenance"]);
    const rows = ins.sections[0].kind === "fields" ? ins.sections[0].rows : [];
    expect(rows[0].label).toBe("DISCOM");
    expect(rows.find((r) => r.label === "TRANSCO source (inferred)")?.ref).toBe("s-ss-132kv-ckpm");
    expect(rows.find((r) => r.label === "33/11 kV SS")?.ref).toBe("ds-ep-9");
    const trace = ins.sections[1].kind === "trace" ? ins.sections[1].levels : [];
    expect(trace.map((l) => l.ref ?? null)).toEqual(["s-ss-132kv-ckpm", "dl-ep-4", "ds-ep-9", null]);
    expect(trace.at(-1)).toMatchObject({ label: "11 kV feeder", here: true });
    expect(ins.focus).toEqual({ lines: [], ss: [], lines11: ["f11-ep-1"], point: null });
    expect(ins.locate).toEqual({ bounds: [[83.9, 18.27], [83.91, 18.28]], maxZoom: 13 });
  });

  it("resolves from the overlay alone (map tap before the trace chain arrives)", () => {
    const ins = inspect("f11-ep-1", ctx({ netItem: null }))!;
    const trace = ins.sections.find((s) => s.id === "trace");
    expect(trace?.kind === "trace" && trace.levels[0]).toMatchObject({ name: "132 kV CHILAKAPALEM", ref: "s-ss-132kv-ckpm" });
  });

  it("a transformer resolves from its search item: attributes, trace up to the 11 kV feeder, a pin", () => {
    const dtr: NetItem = {
      ...item,
      label: "034400109033",
      kind: "dtr",
      ref: "",
      dtr: { attrs: { Capacity: "100 kVA" }, feederId: "f11-ep-1", feederName: "11KV Arasavalli", discom: "APEPDCL" },
    };
    const ins = inspect("dtr:034400109033", ctx({ netItem: dtr }))!;
    expect(ins.header.title).toBe("034400109033");
    const levels = traceLevels(ins.entity as NetEntity);
    expect(levels.slice(-2)).toEqual([
      { label: "11 kV feeder", name: "11KV Arasavalli", ref: "f11-ep-1" },
      { label: "Transformer", name: "034400109033", here: true },
    ]);
    expect(ins.focus).toEqual({ lines: [], ss: [], lines11: ["f11-ep-1"], point: [83.9, 18.28] });
    expect(ins.locate).toEqual({ center: [83.9, 18.28], zoom: 16.5 });
  });

  it("a 33 kV feeder traces only TRANSCO SS → itself", () => {
    const e: NetEntity = { ref: "dl-ep-4", kind: "f33", layer: "discom-lines", feature: null, item: { ...item, kind: "f33", ref: "dl-ep-4", label: "33KV Arasavalli" } };
    expect(traceLevels(e).map((l) => [l.label, l.here ?? false])).toEqual([
      ["TRANSCO substation", false],
      ["33 kV feeder", true],
    ]);
  });

  it("property rows put connectivity first and spell out link methods", () => {
    const rows = propertyRows({ id: "x", name: "n", lengthKm: 1.234, linkMethod: "proximity", discom: "APSPDCL" });
    expect(rows.map((r) => r.label)).toEqual(["DISCOM", "Linked by", "Length (km)"]);
    expect(rows[1].value).toMatch(/1\.5 km/);
  });
});

describe("tower + reference adapters", () => {
  it("a tower: its line as a link + every attribute, from the decoded towers file", () => {
    const fc = decodeTowers("towers-400kv", json<WebTowersFile>("towers-400kv.json"));
    overlays["towers-400kv"] = fc;
    const i = fc.features.findIndex((f) => f.properties?.lineId);
    const ins = inspect(towerRef("towers-400kv", i), ctx())!;
    expect(ins.header.title).toBe(`Tower ${fc.features[i].properties!.no}`);
    const rows = ins.sections[0].kind === "fields" ? ins.sections[0].rows : [];
    expect(rows[0]).toMatchObject({ label: "Line", ref: fc.features[i].properties!.lineId });
    expect(rows.length).toBeGreaterThan(3);
    expect(ins.focus?.point).toEqual((fc.features[i].geometry as { coordinates: number[] }).coordinates);
    expect(inspect("tw:400:99999999", ctx())).toBeNull();
  });

  it("a reference feature: title from its label field, attributes, source + vintage", () => {
    const def = refDef({
      id: "districts",
      group: "Boundaries",
      label: "Districts",
      geometry: "polygon",
      file: "ref/districts.geojson",
      count: 1,
      bytes: 1,
      labelField: "name",
      fields: [],
      source: "RTGS",
      vintage: "2023",
      note: null,
    });
    defs.districts = def;
    overlays.districts = {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [[[80, 15], [81, 15], [81, 16], [80, 15]]] }, properties: { name: "Krishna", areaSqKm: 8727 } }],
    };
    const ins = inspect("ref:districts:0", ctx())!;
    expect(ins.header).toMatchObject({ kicker: "Boundaries · Districts", title: "Krishna", icon: "area" });
    expect(ins.sections[0].kind === "fields" && ins.sections[0].rows).toEqual([{ label: "Area (km²)", value: "8,727", ref: undefined }]);
    expect(ins.sections[1]).toMatchObject({ id: "provenance", text: "RTGS · vintage 2023" });
  });
});

describe("taps → refs", () => {
  const tower = TOWER_DEFS[0];
  const it_ = (priority: number, kind: string, layer: string, pick: Interaction["pick"]): Interaction => ({ priority, kind, layers: [layer], pick });

  it("every overlay feature picks a ref some adapter handles", () => {
    expect(overlayPick(tower, { id: 5, properties: { i: 5, no: "12A" } })).toEqual({ ref: "tw:400:5", label: "Tower 12A" });
    expect(overlayPick(DISCOM_DEFS[1], { id: undefined, properties: { id: "ds-ep-1", name: "Revidi" } })).toEqual({ ref: "ds-ep-1", label: "Revidi" });
    expect(overlayPick(DISCOM_DEFS[0], { id: undefined, properties: { id: "dl-sp-1" } })?.label).toBe("Unnamed 33 kV line");
    const forest = refDef({ id: "forest", group: "Environment", label: "Forest", geometry: "polygon", file: "", count: 0, bytes: 0, labelField: null, fields: [], source: "", vintage: null, note: null });
    expect(overlayPick(forest, { id: 3, properties: {} })).toEqual({ ref: "ref:forest:3", label: "Forest" });
    for (const p of [overlayPick(tower, { id: 1, properties: { i: 1 } }), overlayPick(forest, { id: 0, properties: {} })])
      expect(ADAPTERS[refKind(p!.ref)!]).toBeDefined();
  });

  it("What's here: one entry per feature, best priority first", () => {
    const its = [
      it_(20, "TRANSCO line", "grid-lines-sc", (f) => ({ ref: String(f.id), label: "L" })),
      it_(0, "400 kV towers", "tw", (f) => ({ ref: `tw:400:${f.id}`, label: "T" })),
      it_(40, "33/11 kV substations", "ds", (f) => ({ ref: String(f.properties?.id), label: "D" })),
    ];
    const feats = [
      { id: "ds-1", properties: { id: "ds-1" }, layer: { id: "ds" } },
      { id: "l-1", properties: {}, layer: { id: "grid-lines-sc" } },
      { id: 7, properties: {}, layer: { id: "tw" } },
      { id: "l-1", properties: {}, layer: { id: "grid-lines-sc" } }, // same line, another tile
      { id: 1, properties: {}, layer: { id: "unknown" } },
    ] as unknown as Parameters<typeof rankHits>[1];
    expect(rankHits(its, feats).map((h) => h.ref)).toEqual(["tw:400:7", "l-1", "ds-1"]);
  });
});

describe("workspace extension sections", () => {
  const base: Section[] = [
    { id: "overview", kind: "note", text: "o" },
    { id: "supply", kind: "note", text: "base" },
    { id: "connectivity", kind: "note", text: "c" },
  ];
  it("replace by id in place; new ids follow the overview", () => {
    const out = mergeSections(base, [
      { id: "supply", kind: "note", text: "mis" },
      { id: "mis-facts", kind: "note", text: "f" },
    ]);
    expect(out.map((s) => (s.kind === "note" ? `${s.id}:${s.text}` : s.id))).toEqual(["overview:o", "mis-facts:f", "supply:mis", "connectivity:c"]);
    expect(mergeSections(base, [])).toBe(base);
  });
});
