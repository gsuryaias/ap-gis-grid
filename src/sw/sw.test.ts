// Service-worker policy + the bounded LRU cache (Atlas 2.0 phase 4 PR 13), and the data-version contract.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BoundedCache, OPAQUE_BYTES, type CacheLike, type CacheStorageLike } from "./bounded-cache.ts";
import { cachesToDelete, evictionPlan, LIMITS, route, tooBigToCache } from "./policy.ts";
import { isStaleVersion, versionKey, versionQuery } from "../data/data-version.ts";
import { computeDataVersions, versionedFiles } from "../../scripts/data-versions.ts";

const SCOPE = "https://x.github.io/ap-gis-grid/";
const get = (p: string, extra: { mode?: string; range?: boolean; method?: string } = {}) =>
  route({ url: p.startsWith("http") ? p : SCOPE + p, method: extra.method ?? "GET", mode: extra.mode, range: extra.range }, SCOPE);

describe("routing", () => {
  it("navigations are network-first with a timeout, then the cached shell", () => {
    expect(get("?e2e", { mode: "navigate" })).toEqual({ strategy: "network-first", cache: "shell", timeoutMs: 4000 });
  });

  it("hashed assets are cache-first", () => {
    expect(get("assets/index-abc.js")).toEqual({ strategy: "cache-first", cache: "assets" });
  });

  it("versioned data is cache-first; unversioned data (live-status) network-first", () => {
    expect(get("data/lines.geojson?v=ab12")).toEqual({ strategy: "cache-first", cache: "data" });
    expect(get("tiles/index.json?v=ab12")).toEqual({ strategy: "cache-first", cache: "data" });
    expect(get("data/live-status.json")).toEqual({ strategy: "network-first", cache: "data" });
    expect(get("tiles/index.json")).toEqual({ strategy: "network-first", cache: "data" });
  });

  it("vector tiles and sidecars go to the tile cache", () => {
    expect(get("tiles/discom-ss/9/370/230.pbf?v=1")).toEqual({ strategy: "cache-first", cache: "vtiles" });
    expect(get("tiles/discom-ss/rows/3.json?v=1")).toEqual({ strategy: "cache-first", cache: "vtiles" });
  });

  it("basemaps are stale-while-revalidate; live APIs, non-GET and Range requests are left alone", () => {
    expect(get("https://tiles.basemaps.cartocdn.com/vectortiles/carto.streets/v1/9/370/230.mvt")?.cache).toBe("basemap");
    expect(get("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/9/230/370")?.cache).toBe("basemap");
    expect(get("https://api.open-meteo.com/v1/forecast?x=1")).toBeNull();
    expect(get("https://evil-arcgisonline.com/x")).toBeNull();
    expect(get("data/lines.geojson?v=1", { method: "POST" })).toBeNull();
    expect(get("data/lines.geojson?v=1", { range: true })).toBeNull();
    expect(get("tiles/discom-ss/9/370/230.pbf?v=1", { range: true })).toBeNull();
  });

  it("other in-scope files fall back to the network-first shell cache", () => {
    expect(get("manifest.webmanifest")).toEqual({ strategy: "network-first", cache: "shell" });
  });
});

describe("eviction", () => {
  const lim = { maxEntries: 10, maxBytes: 1000 };
  const es = (n: number, bytes = 10) => Array.from({ length: n }, (_, i) => ({ url: `u${i}`, bytes, t: 100 + ((i * 7) % n) }));

  it("does nothing within budget", () => {
    expect(evictionPlan(es(10), lim)).toEqual([]);
  });

  it("drops the least recently used down to 90 % of the count budget", () => {
    const entries = es(12);
    const drop = evictionPlan(entries, lim);
    expect(drop).toHaveLength(3); // 12 → 9
    const oldest = [...entries].sort((a, b) => a.t - b.t).slice(0, 3).map((e) => e.url);
    expect(drop).toEqual(oldest);
  });

  it("enforces the byte budget too", () => {
    const drop = evictionPlan(es(5, 300), lim); // 1500 B > 1000 B → ≤ 900 B = 3 entries
    expect(drop).toHaveLength(2);
  });

  it("never caches a response bigger than a third of the budget", () => {
    expect(tooBigToCache(LIMITS.data.maxBytes / 3 + 1, LIMITS.data)).toBe(true);
    expect(tooBigToCache(5_000_000, LIMITS.data)).toBe(false);
  });
});

describe("activate clean-up", () => {
  it("keeps the current build, the LRU caches and the previous build's assets", () => {
    const keys = ["shell-v1", "assets-v1", "data-v1", "tiles-v1", "vtiles-v1", "assets-aaa", "shell-aaa", "data", "vtiles", "basemap", "sw-meta", "assets-bbb", "shell-bbb"];
    expect(cachesToDelete(keys, "bbb")).toEqual(["shell-v1", "assets-v1", "data-v1", "tiles-v1", "vtiles-v1", "shell-aaa"]);
    expect(cachesToDelete(["assets-bbb", "shell-bbb"], "bbb")).toEqual([]);
  });
});

describe("data versions", () => {
  const V = { "data/lines.geojson": "aa11", "data/net-dtr-*": "dd44", "tiles/index.json": "tt99" };

  it("versions data URLs, groups the DTR shards, never live-status", () => {
    expect(versionKey("data/net-dtr-ep-0022.json")).toBe("data/net-dtr-*");
    expect(versionQuery("data/lines.geojson", V)).toBe("?v=aa11");
    expect(versionQuery("data/net-dtr-sp-12.json", V)).toBe("?v=dd44");
    expect(versionQuery("data/live-status.json", { "data/live-status.json": "x" })).toBe("");
    expect(versionQuery("data/unknown.json", V)).toBe("");
    expect(versionQuery("data/lines.geojson", {})).toBe("");
  });

  it("knows which cached versions a build has superseded", () => {
    expect(isStaleVersion(`${SCOPE}data/lines.geojson?v=aa11`, SCOPE, V)).toBe(false);
    expect(isStaleVersion(`${SCOPE}data/lines.geojson?v=old`, SCOPE, V)).toBe(true);
    expect(isStaleVersion(`${SCOPE}data/net-dtr-ep-0022.json?v=dd44`, SCOPE, V)).toBe(false);
    expect(isStaleVersion(`${SCOPE}data/live-status.json`, SCOPE, V)).toBe(false); // unversioned: kept
    expect(isStaleVersion("https://elsewhere/data/lines.geojson?v=old", SCOPE, V)).toBe(false);
  });

  const dir = mkdtempSync(path.join(tmpdir(), "apgg-dv-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("hashes data/** + tiles/index.json by content, live-status excluded", () => {
    mkdirSync(path.join(dir, "data/ref"), { recursive: true });
    mkdirSync(path.join(dir, "tiles"), { recursive: true });
    writeFileSync(path.join(dir, "data/lines.geojson"), "A");
    writeFileSync(path.join(dir, "data/live-status.json"), "{}");
    writeFileSync(path.join(dir, "data/net-dtr-ep-0001.json"), "1");
    writeFileSync(path.join(dir, "data/net-dtr-ep-0002.json"), "2");
    writeFileSync(path.join(dir, "data/ref/mandals.geojson"), "M");
    writeFileSync(path.join(dir, "tiles/index.json"), "{}");
    expect(versionedFiles(dir)).toEqual(["data/lines.geojson", "data/net-dtr-ep-0001.json", "data/net-dtr-ep-0002.json", "data/ref/mandals.geojson", "tiles/index.json"]);
    const v1 = computeDataVersions(dir);
    expect(Object.keys(v1).sort()).toEqual(["data/lines.geojson", "data/net-dtr-*", "data/ref/mandals.geojson", "tiles/index.json"]);
    expect(v1["data/lines.geojson"]).toMatch(/^[0-9a-f]{10}$/);

    writeFileSync(path.join(dir, "data/net-dtr-ep-0002.json"), "22");
    writeFileSync(path.join(dir, "data/live-status.json"), '{"x":1}');
    const v2 = computeDataVersions(dir);
    expect(v2["data/net-dtr-*"]).not.toBe(v1["data/net-dtr-*"]); // any shard changes the group
    expect(v2["data/lines.geojson"]).toBe(v1["data/lines.geojson"]); // untouched files keep their URL
  });
});

// In-memory Cache API (bodies stored as bytes; match by full URL like the real one).
class FakeCache implements CacheLike {
  readonly m = new Map<string, { body: ArrayBuffer; init: ResponseInit }>();
  private key = (r: RequestInfo | URL) => (typeof r === "string" ? r : r instanceof URL ? r.href : r.url);
  async match(r: RequestInfo | URL) {
    const e = this.m.get(this.key(r));
    return e ? new Response(e.body.slice(0), e.init) : undefined;
  }
  async put(r: RequestInfo | URL, res: Response) {
    this.m.set(this.key(r), { body: await res.arrayBuffer(), init: { status: res.status, headers: res.headers } });
  }
  async delete(r: RequestInfo | URL) {
    return this.m.delete(this.key(r));
  }
  async keys() {
    return [...this.m.keys()].map((u) => new Request(u));
  }
}
class FakeStorage implements CacheStorageLike {
  readonly caches = new Map<string, FakeCache>();
  async open(name: string) {
    let c = this.caches.get(name);
    if (!c) this.caches.set(name, (c = new FakeCache()));
    return c;
  }
}

describe("BoundedCache", () => {
  const body = (n: number) => new Response(new Uint8Array(n));
  const url = (i: number) => `${SCOPE}tiles/x/${i}.pbf?v=1`;
  const make = (storage: FakeStorage, clock: { t: number }, limits = { maxEntries: 5, maxBytes: 10_000 }) =>
    new BoundedCache(storage, "vtiles", limits, { metaCache: "sw-meta", metaKey: `${SCOPE}__sw/lru/vtiles`, now: () => clock.t, saveDelayMs: 0 });

  it("evicts the least recently used entry, counting a read as a use", async () => {
    const storage = new FakeStorage();
    const clock = { t: 1 };
    const c = make(storage, clock);
    for (let i = 0; i < 5; i++) {
      clock.t++;
      await c.put(url(i), body(100));
    }
    clock.t++;
    expect(await c.match(url(0))).toBeDefined(); // 0 is now the most recent
    await c.idle();
    await new Promise((r) => setTimeout(r, 5)); // let the touch land
    clock.t++;
    await c.put(url(5), body(100)); // 6 > 5 → trim to ≤ 4.5: drops 1 and 2
    const left = [...(await storage.open("vtiles")).m.keys()];
    expect(left).toEqual([url(0), url(3), url(4), url(5)]);
    expect(await c.usage()).toEqual({ entries: 4, bytes: 400 });
  });

  it("trims by bytes and refuses responses over a third of the budget", async () => {
    const storage = new FakeStorage();
    const clock = { t: 1 };
    const c = make(storage, clock, { maxEntries: 100, maxBytes: 1000 });
    await c.put(url(0), body(300));
    await c.put(url(1), body(300));
    await c.put(url(2), body(334)); // > 1000/3 → served, never cached
    expect((await storage.open("vtiles")).m.size).toBe(2);
    await c.put(url(3), body(300)); // 900 B — within budget
    clock.t++;
    await c.put(url(4), body(300)); // 1200 B → trimmed to ≤ 900 B: the oldest goes
    expect([...(await storage.open("vtiles")).m.keys()]).toEqual([url(1), url(3), url(4)]);
  });

  it("persists its index and rebuilds it after a restart, unknown entries first to go", async () => {
    const storage = new FakeStorage();
    const clock = { t: 10 };
    const a = make(storage, clock);
    await a.put(url(0), body(100));
    clock.t++;
    await a.put(url(1), body(200));
    await a.idle();
    // An entry the index never heard of (the worker died before saving).
    await (await storage.open("vtiles")).put(url(9), body(50));

    const b = make(storage, clock); // a fresh worker
    expect(await b.usage()).toEqual({ entries: 3, bytes: 350 });
    for (let i = 2; i < 5; i++) {
      clock.t++;
      await b.put(url(i), body(10));
    }
    // 6 entries > 5 → drop the oldest two: the unknown one (t = 0), then url(0).
    expect([...(await storage.open("vtiles")).m.keys()].sort()).toEqual([url(1), url(2), url(3), url(4)].sort());
  });

  it("purges by URL and counts opaque responses at a nominal size", async () => {
    const storage = new FakeStorage();
    const c = make(storage, { t: 1 }, { maxEntries: 10, maxBytes: 10_000_000 });
    await c.put(`${SCOPE}data/a.json?v=old`, body(10));
    await c.put(`${SCOPE}data/b.json?v=new`, body(10));
    expect(await c.purge((u) => u.includes("v=old"))).toBe(1);
    expect(await c.usage()).toEqual({ entries: 1, bytes: 10 });
    const opaque = { type: "opaque", clone: () => opaque } as unknown as Response;
    const { responseBytes } = await import("./bounded-cache.ts");
    expect(await responseBytes(opaque)).toBe(OPAQUE_BYTES);
  });
});
