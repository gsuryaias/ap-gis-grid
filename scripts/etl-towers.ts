// Transmission towers → towers-<kv>.json + per-line summaries (Atlas 2.0 phase 4 split of build-data.mts).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildWebTowers, normLineName, TOWER_LAYERS, type LineTowerStats, type TowersFile } from "./towers-lib.ts";
import { LIVE_DIR } from "./etl-sources.ts";

/**
 * Transmission towers (data/raw/live/towers-<kv>.json from `npm run sync:towers`, grouped by line)
 * → public/data/towers-<kv>.json (dictionary-encoded, each line matched to its core line id by
 * normalised name) + a per-line summary (count, CP/SP, top tower types) folded into lines.geojson.
 */
export function buildTowers(outDir: string, lines: Array<{ id: string; name: string }>) {
  const idsByName = new Map<string, string[]>();
  for (const l of lines) {
    const k = normLineName(l.name);
    const a = idsByName.get(k);
    if (a) a.push(l.id);
    else idsByName.set(k, [l.id]);
  }
  const manifestPath = resolve(LIVE_DIR, "towers-manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf-8")) : null;
  const stats = new Map<string, LineTowerStats>();
  const summary: Record<string, unknown> = { lastSuccess: manifest?.lastSuccess ?? null, layers: {} };
  for (const layer of TOWER_LAYERS) {
    const path = resolve(LIVE_DIR, `${layer.name}.json`);
    if (!existsSync(path)) {
      console.log(`[etl] ${layer.name}: not synced yet (npm run sync:towers) — skipped`);
      continue;
    }
    const raw = JSON.parse(readFileSync(path, "utf-8")) as TowersFile;
    const out = buildWebTowers(raw, idsByName, new Date().toISOString());
    for (const [id, st] of out.stats) stats.set(id, st);
    writeFileSync(resolve(outDir, `${layer.name}.json`), JSON.stringify(out.web));
    (summary.layers as Record<string, unknown>)[layer.name] = {
      voltage: layer.voltage,
      towers: raw.count,
      lines: raw.lines.length,
      matchedLines: out.matchedLines,
      matchedTowers: out.matchedTowers,
      fetchedAt: raw.fetchedAt,
      lastChangedAt: manifest?.layers?.[layer.name]?.lastChangedAt ?? null,
    };
    console.log(
      `[etl] ${layer.name}: ${raw.count} towers on ${raw.lines.length} lines → ${out.matchedLines} lines / ` +
        `${out.matchedTowers} towers matched to core lines`,
    );
  }
  return { stats, summary };
}
