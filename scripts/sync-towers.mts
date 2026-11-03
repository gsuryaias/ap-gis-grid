/**
 * Tower sync — pull the AP-TRANSCO transmission tower layers (400 / 220 / 132 kV, ~114k points)
 * from the AP-TRANSCO enterprise GIS into data/raw/live/towers-<kv>.json (grouped by line; see
 * scripts/towers-lib.ts), with change detection and the same safety gates as sync-live.
 *
 *   npm run sync:towers                        # all three layers
 *   npm run sync:towers -- --only towers-400kv # a subset
 *
 * Writes data/raw/live/towers-manifest.json (per-layer status / count / last change). India-only
 * network, like sync-live: exit 3 when the server is unreachable, 2 when every layer failed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GIS_BASE, normalizeValue } from "./live-sources.ts";
import {
  diffTowers,
  DROP_TOWER_FIELD,
  groupTowers,
  serialiseTowers,
  TOWER_LAYERS,
  TOWER_SERVICE,
  towerKeys,
  ungroupTowers,
  type TowerLayer,
  type TowerPoint,
  type TowersFile,
} from "./towers-lib.ts";

const OUT_DIR = resolve("data/raw/live");
const MANIFEST = resolve(OUT_DIR, "towers-manifest.json");
const UA = "ap-gis-grid-sync/1.0 (+https://github.com/gsuryaias/ap-gis-grid)";
const CONCURRENCY = 4;
const MAX_DROP = 0.15;

interface LayerStatus {
  label: string;
  url: string;
  status: "ok" | "unchanged" | "rejected" | "error";
  message?: string;
  count: number | null;
  lines: number | null;
  fetchedAt: string | null;
  lastChangedAt: string | null;
  diff?: { added: number; removed: number; modified: number };
}
interface Manifest {
  schema: 1;
  lastRun: string;
  lastSuccess: string | null;
  layers: Record<string, LayerStatus>;
}

async function getJson<T>(url: string, attempt = 1): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const body = (await res.json()) as T & { error?: { code: number; message: string } };
    if (body && typeof body === "object" && "error" in body && body.error) throw new Error(`ArcGIS error ${body.error.code}: ${body.error.message}`);
    return body;
  } catch (e) {
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      return getJson<T>(url, attempt + 1);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

interface LayerInfo {
  maxRecordCount?: number;
  fields?: Array<{ name: string; type: string }>;
}

async function fetchTowers(layer: TowerLayer): Promise<TowerPoint[]> {
  const base = `${GIS_BASE}/${TOWER_SERVICE}/${layer.layerId}`;
  const info = await getJson<LayerInfo>(`${base}?f=json`);
  const dateFields = new Set((info.fields ?? []).filter((f) => f.type === "esriFieldTypeDate").map((f) => f.name));
  const page = Math.min(2000, info.maxRecordCount ?? 1000);
  const { count } = await getJson<{ count: number }>(`${base}/query?where=1%3D1&returnCountOnly=true&f=json`);
  const offsets: number[] = [];
  for (let o = 0; o < count; o += page) offsets.push(o);
  const pages: TowerPoint[][] = new Array(offsets.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < offsets.length) {
      const i = next++;
      const q =
        `${base}/query?where=1%3D1&outFields=*&orderByFields=objectid+ASC&resultOffset=${offsets[i]}` +
        `&resultRecordCount=${page}&outSR=4326&geometryPrecision=6&f=geojson`;
      const fc = await getJson<{ features?: Array<{ geometry: { coordinates: number[] } | null; properties: Record<string, unknown> | null }> }>(q);
      pages[i] = (fc.features ?? [])
        .filter((f) => f.geometry?.coordinates?.length === 2)
        .map((f) => {
          const props: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(f.properties ?? {})) {
            if (DROP_TOWER_FIELD.test(k)) continue;
            const nv = normalizeValue(v, dateFields.has(k));
            if (nv != null) props[k] = nv;
          }
          const [lng, lat] = f.geometry!.coordinates;
          return { lng: Math.round(lng * 1e6) / 1e6, lat: Math.round(lat * 1e6) / 1e6, props };
        });
      done++;
      if (done % 10 === 0 || done === offsets.length) process.stdout.write(`\r  ${layer.name}: ${done}/${offsets.length} pages`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write("\n");
  const pts = pages.flat();
  if (pts.length !== count) console.warn(`  ! ${layer.name}: server count ${count}, received ${pts.length}`);
  return pts;
}

async function main(): Promise<void> {
  const onlyArg = process.argv.indexOf("--only");
  const only = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(",")) : null;
  const layers = TOWER_LAYERS.filter((l) => !only || only.has(l.name));

  try {
    await getJson(`${GIS_BASE}/${TOWER_SERVICE}?f=json`, 4);
  } catch {
    console.error("Can't reach gis.aptransco.gov.in (India-only network).");
    process.exit(3);
  }

  const now = new Date().toISOString();
  const manifest: Manifest = existsSync(MANIFEST)
    ? (JSON.parse(readFileSync(MANIFEST, "utf-8")) as Manifest)
    : { schema: 1, lastRun: now, lastSuccess: null, layers: {} };
  manifest.lastRun = now;
  let failures = 0;

  for (const layer of layers) {
    const path = resolve(OUT_DIR, `${layer.name}.json`);
    const prevStatus = manifest.layers[layer.name];
    const st: LayerStatus = {
      label: `${layer.voltage} kV towers`,
      url: `${GIS_BASE}/${TOWER_SERVICE}/${layer.layerId}`,
      status: "error",
      count: prevStatus?.count ?? null,
      lines: prevStatus?.lines ?? null,
      fetchedAt: prevStatus?.fetchedAt ?? null,
      lastChangedAt: prevStatus?.lastChangedAt ?? null,
    };
    try {
      const pts = await fetchTowers(layer);
      const prev = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as TowersFile) : null;
      if (pts.length < layer.minCount) throw Object.assign(new Error(`only ${pts.length} towers (floor ${layer.minCount})`), { gate: true });
      if (prev && pts.length < prev.count * (1 - MAX_DROP))
        throw Object.assign(new Error(`${pts.length} towers vs ${prev.count} last time (> ${MAX_DROP * 100}% drop)`), { gate: true });
      const file = groupTowers(pts, { layer: layer.name, voltage: layer.voltage, fetchedAt: now });
      const diff = prev ? diffTowers(towerKeys(ungroupTowers(prev)), towerKeys(pts)) : null;
      const changed = !prev || !!(diff && diff.added + diff.removed + diff.modified);
      if (changed) {
        writeFileSync(path, serialiseTowers(file));
        st.lastChangedAt = prev ? now : (st.lastChangedAt ?? now);
      }
      Object.assign(st, { status: changed ? "ok" : "unchanged", count: pts.length, lines: file.lines.length, fetchedAt: now, ...(diff ? { diff } : {}) });
      console.log(
        `  ✓ ${layer.name}: ${pts.length} towers on ${file.lines.length} lines` +
          (diff ? ` (+${diff.added} / -${diff.removed} / ~${diff.modified})` : " (baseline)"),
      );
    } catch (e) {
      failures++;
      st.status = (e as { gate?: boolean }).gate ? "rejected" : "error";
      st.message = e instanceof Error ? e.message : String(e);
      console.error(`  ✗ ${layer.name}: ${st.message} — previous file kept`);
    }
    manifest.layers[layer.name] = st;
  }
  if (failures < layers.length) manifest.lastSuccess = now;
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  if (failures === layers.length) process.exit(2);
}

void main();
