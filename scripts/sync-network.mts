/**
 * Network sync — pull the DISCOM 11 kV network (feeders, distribution transformers, AB switches)
 * from the AP-TRANSCO enterprise GIS into data/raw/live/net-*.{geojson,json}. See scripts/net-lib.ts
 * for the layer list and the PRIVACY rules (allow-listed fields; HT consumer services never pulled).
 *
 *   npm run sync:network                          # every layer in NET_LAYERS
 *   npm run sync:network -- --only net-epdcl-ab   # a subset
 *
 * Lines → GeoJSON, one feature per text line, sorted (minimal diffs, 5 dp ≈ 1 m).
 * Points → grouped by feeder (net-lib `groupPoints`). Gates: floor + >15% drop ⇒ previous file kept.
 * Writes data/raw/live/net-manifest.json. Exit 3 = GIS unreachable (India-only), 2 = all failed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GIS_BASE, normalizeValue } from "./live-sources.ts";
import { groupPoints, lineDiff, NET_LAYERS, pickFields, serialiseGrouped, type NetLayer, type NetPoint } from "./net-lib.ts";

const OUT_DIR = resolve("data/raw/live");
const MANIFEST = resolve(OUT_DIR, "net-manifest.json");
const UA = "ap-gis-grid-sync/1.0 (+https://github.com/gsuryaias/ap-gis-grid)";
const CONCURRENCY = 6;
const MAX_DROP = 0.15;

async function getJson<T>(url: string, attempt = 1): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
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

type RawFeat = { geometry: { type: string; coordinates: unknown } | null; properties: Record<string, unknown> | null };

const r5 = (c: unknown): unknown =>
  Array.isArray(c) && typeof c[0] === "number" ? (c as number[]).slice(0, 2).map((n) => Math.round(n * 1e5) / 1e5) : (c as unknown[]).map(r5);

async function fetchAll(layer: NetLayer): Promise<Array<{ geometry: { type: string; coordinates: unknown }; props: Record<string, unknown> }>> {
  const base = `${GIS_BASE}/${layer.service}/${layer.layerId}`;
  const info = await getJson<{ maxRecordCount?: number; objectIdField?: string; fields?: Array<{ name: string; type: string }> }>(`${base}?f=json`);
  const oid = info.objectIdField ?? info.fields?.find((f) => f.type === "esriFieldTypeOID")?.name ?? "objectid";
  const dateFields = new Set((info.fields ?? []).filter((f) => f.type === "esriFieldTypeDate").map((f) => f.name.toLowerCase()));
  const page = Math.min(2000, info.maxRecordCount ?? 1000);
  const { count } = await getJson<{ count: number }>(`${base}/query?where=1%3D1&returnCountOnly=true&f=json`);
  const offsets: number[] = [];
  for (let o = 0; o < count; o += page) offsets.push(o);
  const pages: Array<Array<{ geometry: { type: string; coordinates: unknown }; props: Record<string, unknown> }>> = new Array(offsets.length);
  const fields = layer.keep.join(",");
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < offsets.length) {
      const i = next++;
      const q =
        `${base}/query?where=1%3D1&outFields=${encodeURIComponent(fields)}&orderByFields=${encodeURIComponent(oid)}+ASC` +
        `&resultOffset=${offsets[i]}&resultRecordCount=${page}&outSR=4326&geometryPrecision=5&f=geojson`;
      const fc = await getJson<{ features?: RawFeat[] }>(q);
      pages[i] = (fc.features ?? [])
        .filter((f) => f.geometry)
        .map((f) => {
          const picked = pickFields(f.properties ?? {}, layer.keep);
          const props: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(picked)) {
            const nv = normalizeValue(v, dateFields.has(k));
            if (nv != null) props[k] = nv;
          }
          return { geometry: { type: f.geometry!.type, coordinates: r5(f.geometry!.coordinates) }, props };
        });
      if (++done % 20 === 0 || done === offsets.length) process.stdout.write(`\r  ${layer.name}: ${done}/${offsets.length} pages`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write("\n");
  const all = pages.flat();
  if (all.length !== count) console.warn(`  ! ${layer.name}: server count ${count}, received ${all.length}`);
  return all;
}

function serialiseLines(layer: NetLayer, feats: Array<{ geometry: { type: string; coordinates: unknown }; props: Record<string, unknown> }>): string {
  const rows = feats.map((f) => {
    const body = JSON.stringify({ type: "Feature", geometry: f.geometry, properties: f.props });
    const key = layer.keyField && f.props[layer.keyField] != null ? String(f.props[layer.keyField]) : "";
    return { key, h: createHash("sha1").update(body).digest("hex"), body };
  });
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  return `{"type":"FeatureCollection","features":[\n${rows.map((r) => r.body).join(",\n")}\n]}\n`;
}

interface Status {
  label: string;
  url: string;
  status: "ok" | "unchanged" | "rejected" | "error";
  message?: string;
  count: number | null;
  fetchedAt: string | null;
  lastChangedAt: string | null;
  diff?: { added: number; removed: number };
}

async function main(): Promise<void> {
  const oi = process.argv.indexOf("--only");
  const only = oi > 0 ? new Set(process.argv[oi + 1].split(",")) : null;
  const layers = NET_LAYERS.filter((l) => !only || only.has(l.name));
  try {
    await getJson(`${GIS_BASE}?f=json`, 4);
  } catch {
    console.error("Can't reach gis.aptransco.gov.in (India-only network).");
    process.exit(3);
  }
  const now = new Date().toISOString();
  const manifest: { schema: 1; lastRun: string; lastSuccess: string | null; layers: Record<string, Status> } = existsSync(MANIFEST)
    ? JSON.parse(readFileSync(MANIFEST, "utf-8"))
    : { schema: 1, lastRun: now, lastSuccess: null, layers: {} };
  manifest.lastRun = now;
  let failures = 0;
  for (const layer of layers) {
    const path = resolve(OUT_DIR, `${layer.name}.${layer.kind === "lines" ? "geojson" : "json"}`);
    const prevSt = manifest.layers[layer.name];
    const st: Status = {
      label: layer.label,
      url: `${GIS_BASE}/${layer.service}/${layer.layerId}`,
      status: "error",
      count: prevSt?.count ?? null,
      fetchedAt: prevSt?.fetchedAt ?? null,
      lastChangedAt: prevSt?.lastChangedAt ?? null,
    };
    try {
      const feats = await fetchAll(layer);
      if (feats.length < layer.minCount) throw Object.assign(new Error(`only ${feats.length} features (floor ${layer.minCount})`), { gate: true });
      if (prevSt?.count && feats.length < prevSt.count * (1 - MAX_DROP))
        throw Object.assign(new Error(`${feats.length} vs ${prevSt.count} last time (> ${MAX_DROP * 100}% drop)`), { gate: true });
      let text: string;
      if (layer.kind === "lines") text = serialiseLines(layer, feats);
      else {
        const pts: NetPoint[] = feats
          .filter((f) => f.geometry.type === "Point")
          .map((f) => {
            const [lng, lat] = f.geometry.coordinates as number[];
            return { lng, lat, props: f.props };
          });
        // fetchedAt lives in the manifest, not the file — so an unchanged pull is byte-identical.
        text = serialiseGrouped(groupPoints(pts, layer.groupBy!, layer.sortBy, { layer: layer.name, fetchedAt: "" }));
      }
      const prev = existsSync(path) ? readFileSync(path, "utf-8") : null;
      const changed = prev !== text;
      if (changed) {
        writeFileSync(path, text);
        st.lastChangedAt = now;
      }
      const diff = prev != null ? lineDiff(prev, text) : undefined;
      Object.assign(st, { status: changed ? "ok" : "unchanged", count: feats.length, fetchedAt: now, ...(diff ? { diff } : {}) });
      delete st.message;
      console.log(`  ✓ ${layer.name}: ${feats.length.toLocaleString("en-IN")} features${diff ? ` (+${diff.added} / -${diff.removed} rows)` : " (baseline)"}`);
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
