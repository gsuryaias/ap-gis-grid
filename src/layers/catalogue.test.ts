// Layer catalogue invariants: one entry per layer token, real file sizes, search, zoom ranges.
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LENSES, lensDefaultTokens } from "../lenses/registry.ts";
import { refDef, type RefCatalogEntry } from "../overlays/catalog.ts";
import { STATIC_OVERLAY_DEFS } from "../overlays/resources.ts";
import type { LiveStatus } from "../data/live-status.ts";
import { BUILTIN_ENTRIES, CAT_GROUPS, catalogueEntries, entryMeta, inZoom, matchesQuery, STATIC_OVERLAY_BYTES, withLiveCounts } from "./catalogue.ts";

const dataFile = (f: string) => new URL(`../../public/data/${f}`, import.meta.url);
const ref = JSON.parse(readFileSync(dataFile("ref/catalog.json"), "utf8")) as RefCatalogEntry[];
const defs = { ...STATIC_OVERLAY_DEFS, ...Object.fromEntries(ref.map((e) => [e.id, refDef(e)])) };
const all = catalogueEntries(defs);

describe("layer catalogue", () => {
  it("has one entry per layer token, grouped in group order", () => {
    const ids = all.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["ss", "ln", "gen", "pg", "wx", ...Object.keys(defs)]));
    const groupIdx = all.map((e) => CAT_GROUPS.indexOf(e.group));
    expect(groupIdx.every((g, i) => g >= 0 && (i === 0 || g >= groupIdx[i - 1]))).toBe(true);
  });

  it("covers every lens default (so the drawer can show / remove it)", () => {
    const ids = new Set(all.map((e) => e.id));
    for (const l of LENSES) for (const t of lensDefaultTokens(l.id)) expect(ids.has(t), `${l.id}: ${t}`).toBe(true);
  });

  it("hand-entered sizes match the files on disk (±25%)", () => {
    const files: Record<string, string> = Object.fromEntries(Object.keys(STATIC_OVERLAY_BYTES).map((id) => [id, defs[id].file]));
    for (const [id, f] of Object.entries(files)) {
      const real = statSync(dataFile(f)).size;
      expect(Math.abs(STATIC_OVERLAY_BYTES[id] - real) / real, id).toBeLessThan(0.25);
    }
    const builtin: Record<string, string[]> = {
      ln: ["lines.geojson"],
      ss: ["substations.geojson"],
      gen: ["generation.geojson"],
      pg: ["powergrid-lines.geojson", "powergrid-ss.geojson", "railway-ss.geojson", "bulkload-ss.geojson"],
    };
    for (const [id, fs] of Object.entries(builtin)) {
      const real = fs.reduce((a, f) => a + statSync(dataFile(f)).size, 0);
      const e = BUILTIN_ENTRIES.find((x) => x.id === id)!;
      expect(Math.abs(e.bytes - real) / real, id).toBeLessThan(0.25);
    }
  });

  it("search matches labels, groups and synonyms; every word must hit", () => {
    const hits = (q: string) => all.filter((e) => matchesQuery(e, q)).map((e) => e.id);
    expect(hits("towers")).toEqual(["towers-400kv", "towers-220kv", "towers-132kv"]);
    expect(hits("flood")).toContain("flood-2024-09-03");
    expect(hits("pgcil")).toEqual(["pg"]);
    expect(hits("11 kv feeder")).toEqual(["discom-11kv-lines"]);
    expect(hits("")).toHaveLength(all.length);
    expect(hits("zzz nothing")).toEqual([]);
  });

  it("zoom range + meta line", () => {
    const towers = all.find((e) => e.id === "towers-132kv")!;
    expect(inZoom(towers, 8)).toBe(false);
    expect(inZoom(towers, 9)).toBe(true);
    expect(inZoom(towers, null)).toBe(true);
    expect(entryMeta(towers)).toBe("5.2 MB · from zoom 9");
    expect(entryMeta(all.find((e) => e.id === "districts")!)).toMatch(/^26 · \d+ KB · \d{4}$/);
  });

  it("live-sync counts fill the static overlays before they are loaded", () => {
    const live = JSON.parse(readFileSync(dataFile("live-status.json"), "utf8")) as LiveStatus;
    const withCounts = withLiveCounts(all, live);
    const count = (id: string) => withCounts.find((e) => e.id === id)!.count;
    for (const id of ["towers-400kv", "towers-220kv", "towers-132kv", "discom-lines", "discom-ss", "discom-11kv-lines"]) expect(count(id), id).toBeGreaterThan(100);
    expect(withLiveCounts(all, null)).toBe(all);
  });
});
