// The search engine against the real emitted public/data (the same code runs in the worker).
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { LIMITS, rank, SearchEngine } from "./search-core.ts";

const fetched: string[] = [];
const engine = new SearchEngine(async <T,>(file: string) => {
  fetched.push(file);
  return JSON.parse(await readFile(new URL(`../../public/data/${file}`, import.meta.url), "utf8")) as T;
});

describe("rank", () => {
  it("orders exact < prefix < word-prefix < substring", () => {
    expect(rank("Kadapa", "kadapa")).toBe(0);
    expect(rank("Kadapa Town", "kada")).toBe(1);
    expect(rank("New Kadapa", "kada")).toBe(2);
    expect(rank("Nkadapa", "kada")).toBe(3);
    expect(rank("Ongole", "kada")).toBe(99);
  });
});

describe("SearchEngine (real data)", () => {
  it("returns nothing before tiers load and for 1-char queries", async () => {
    const fresh = new SearchEngine(async () => {
      throw new Error("must not fetch");
    });
    expect(await fresh.search("tirupati")).toEqual({ places: [], net: [], dtr: [] });
    expect(await engine.search("t")).toEqual({ places: [], net: [], dtr: [] });
  });

  it("loads each tier once", async () => {
    const [a, b] = await Promise.all([engine.loadPlaces(), engine.loadPlaces()]);
    expect(a).toBeGreaterThan(25_000);
    expect(b).toBe(a);
    expect(await engine.loadNetwork()).toBeGreaterThan(1000);
    expect(fetched.filter((f) => f === "places.json")).toHaveLength(1);
  });

  it("ranks places by match, then population (the city beats its namesake villages)", async () => {
    const { places } = await engine.search("Tirupati");
    expect(places.length).toBeGreaterThan(0);
    expect(places.length).toBeLessThanOrEqual(LIMITS.places);
    expect(places[0].name).toBe("Tirupati");
    expect(places[0].pop).toBeGreaterThan(100_000);
  });

  it("finds distribution-network assets with their trace chain", async () => {
    const { net } = await engine.search("Arasavalli");
    expect(net.some((n) => n.kind === "f11")).toBe(true);
    const f11 = net.find((n) => n.kind === "f11")!;
    expect(f11.ref).toMatch(/^f11-/);
    expect(await engine.byRef(f11.ref)).toEqual(f11);
    expect(await engine.byRef("no-such-ref")).toBeNull();
  });

  it("fetches only the matching DTR shard for a code-like query", async () => {
    const before = fetched.length;
    const { dtr } = await engine.search("03440010903");
    expect(fetched.slice(before)).toEqual(["net-dtr-ep-0344.json"]);
    expect(dtr.length).toBeGreaterThan(0);
    expect(dtr.length).toBeLessThanOrEqual(LIMITS.dtr);
    expect(dtr[0].label.startsWith("03440010903")).toBe(true);
    expect(dtr[0].dtr?.discom).toBe("APEPDCL");
    // cached on the second query
    await engine.search("034400109033");
    expect(fetched.slice(before)).toEqual(["net-dtr-ep-0344.json"]);
  });

  it("a non-code query never touches DTR shards", async () => {
    const before = fetched.length;
    await engine.search("Vijayawada");
    expect(fetched.length).toBe(before);
  });
});
