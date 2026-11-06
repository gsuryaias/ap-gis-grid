// Omnisearch engine on the real emitted network (public/data): what each kind of query surfaces,
// in which group order, and what a pick would do (targets are data).
import { readFileSync } from "node:fs";
import type { FeatureCollection } from "geojson";
import { describe, expect, it } from "vitest";
import type { NetItem } from "../data/network-search.ts";
import type { FeatureProps, GridData, LineProps, PlaceItem, SearchItem, SubstationProps } from "../data/types.ts";
import { catalogueEntries } from "../layers/catalogue.ts";
import { STATIC_OVERLAY_DEFS } from "../overlays/resources.ts";
import { buildIndex, groupHits, rankText, searchStatic, workerHits, type OmniHit } from "./omni.ts";
import { drillPath } from "./run.ts";

const json = <T,>(f: string): T => JSON.parse(readFileSync(new URL(`../../public/data/${f}`, import.meta.url), "utf8")) as T;
const substations = json<FeatureCollection>("substations.geojson").features.map((f) => f.properties as SubstationProps);
const lines = json<FeatureCollection>("lines.geojson").features.map((f) => f.properties as LineProps);
const byId = new Map<string, FeatureProps>([...substations, ...lines].map((f) => [f.id, f]));
const data = { substations, lines, byId, searchIndex: json<SearchItem[]>("search-index.json") } as unknown as GridData;

const index = buildIndex({ data });
const layers = catalogueEntries(STATIC_OVERLAY_DEFS);
const search = (q: string, lens: "explore" | "plan" = "explore", on: string[] = ["ss", "ln"]) =>
  groupHits(searchStatic(index, layers, q, { lens, layerOn: (id) => on.includes(id) }));
const groups = (q: string) => search(q).map((s) => s.group);
const first = (q: string): OmniHit => search(q)[0].hits[0];

describe("omnisearch", () => {
  it("ranks exact > prefix > word-prefix > substring", () => {
    expect([rankText("kadapa", "kadapa"), rankText("kadapa town", "kadapa"), rankText("new kadapa", "kada"), rankText("akadapa", "kada"), rankText("x", "y")]).toEqual([0, 1, 2, 3, 99]);
  });

  it("a substation name finds the asset first, and its circle as an Area into Plan", () => {
    const res = search("kadapa");
    expect(res[0].group).toBe("Assets");
    const area = res.find((s) => s.group === "Areas")!.hits[0];
    expect(area.target).toEqual({ t: "area", dim: "circle", value: "Kadapa" });
    expect(area.sub).toMatch(/Circle · \d+ SS — open in Plan/);
  });

  it("an SS code finds its substation (keyword match)", () => {
    const ss = substations.find((s) => s.ssCode)!;
    const hit = search(ss.ssCode!.toLowerCase()).flatMap((s) => s.hits).find((h) => h.key === ss.id);
    expect(hit?.target).toEqual({ t: "select", ref: ss.id });
  });

  it("a layer name puts the Layers group first; the hit says whether it is on", () => {
    expect(groups("towers")[0]).toBe("Layers");
    expect(first("towers").target).toEqual({ t: "layer", id: "towers-400kv" });
    const ss = search("substations", "explore", ["ss"]).find((s) => s.group === "Layers")!.hits.find((h) => h.key === "layer:ss")!;
    expect(ss.sub).toMatch(/on — switch off/);
  });

  it("actions and lenses answer commands", () => {
    expect(first("dark").target).toEqual({ t: "action", id: "base-dark" });
    expect(first("share").target).toEqual({ t: "action", id: "copy-link" });
    expect(first("storm").target).toEqual({ t: "lens", id: "storm" });
    // The data table is a map-lens sheet — not offered in Plan.
    expect(search("data table", "plan").flatMap((s) => s.hits).some((h) => h.key === "action:table")).toBe(false);
  });

  it("an empty box is the command palette: actions + the other lenses", () => {
    const res = search("");
    expect(res.map((s) => s.group).sort()).toEqual(["Actions", "Lenses"]);
    expect(res.find((s) => s.group === "Lenses")!.hits.map((h) => h.target)).not.toContainEqual({ t: "lens", id: "explore" });
  });

  it("worker hits (distribution + places) join their groups; groups cap and de-dupe", () => {
    const net: NetItem = { label: "KADAPA TOWN", kind: "f33", sub: "APSPDCL", lng: 78.8, lat: 14.4, ref: "dl-1", chain: null };
    const place: PlaceItem = { name: "Kadapa", type: "city", district: "YSR", lng: 78.82, lat: 14.47, pop: 300000 };
    const res = groupHits([...searchStatic(index, layers, "kadapa", { lens: "explore", layerOn: () => false }), ...workerHits({ net: [net, net], dtr: [], places: [place] }, "kadapa")]);
    expect(res.find((s) => s.group === "Distribution")!.hits).toHaveLength(1);
    expect(res.find((s) => s.group === "Places")!.hits[0].target).toEqual({ t: "place", item: place });
    for (const s of res) expect(s.hits.length).toBeLessThanOrEqual(10);
  });

  it("an area drill keeps the Plan voltage slicer and replaces the rest of the path", () => {
    expect(drillPath(undefined, "circle", "Kadapa")).toBe("circle:Kadapa");
    expect(drillPath("voltage:400,220~zone:Kadapa~division:X", "circle", "Nellore")).toBe("voltage:400,220~circle:Nellore");
  });
});
