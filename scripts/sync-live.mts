/**
 * Live sync — pull the AP-TRANSCO + DISCOM network layers from the AP-TRANSCO enterprise GIS
 * (ArcGIS REST, gis.aptransco.gov.in) into data/raw/live/*.geojson, with change detection.
 *
 *   npm run sync:live                       # pull every layer in LIVE_LAYERS
 *   npm run sync:live -- --only lines-132kv # pull a subset (comma-separated names)
 *   npm run sync:live -- --dry-run          # fetch + diff, write nothing
 *   npm run sync:live -- --discover APCPDCL # list services/layers in a folder (needs a token if secured)
 *
 * Optional auth (for token-protected folders such as APCPDCL): AP_GIS_TOKEN, or
 * AP_GIS_USERNAME + AP_GIS_PASSWORD (a short-lived token is generated per run).
 *
 * Outputs (all committed, so git history doubles as the network's audit trail):
 *   data/raw/live/<name>.geojson   one feature per line, sorted by stable key → minimal git diffs
 *   data/raw/live/manifest.json    per-layer status / counts / hash / last change
 *   data/raw/live/changelog.json   newest-first list of runs that changed something (capped)
 *
 * Safety: a pull that is empty, below the layer floor, or drops >15% vs the last good pull is
 * REJECTED and the previous file kept (see gatePull). Exit code 2 only if every layer failed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  diffKeyed,
  featureKey,
  gatePull,
  GIS_BASE,
  LIVE_LAYERS,
  normalizeValue,
  truncateKeys,
  type LayerDiff,
  type LiveLayer,
} from "./live-sources.ts";

const OUT_DIR = resolve("data/raw/live");
const MANIFEST = resolve(OUT_DIR, "manifest.json");
const CHANGELOG = resolve(OUT_DIR, "changelog.json");
const PAGE = 1000;
const CHANGELOG_MAX = 200;
const UA = "ap-gis-grid-sync/1.0 (+https://github.com/gsuryaias/ap-gis-grid)";

type Feature = { type: "Feature"; geometry: GeoJSON.Geometry | null; properties: Record<string, unknown> };

interface LayerStatus {
  label: string;
  owner: string;
  group: string;
  url: string;
  status: "ok" | "unchanged" | "rejected" | "error" | "skipped";
  message?: string;
  count: number | null;
  fetchedAt: string | null;
  lastChangedAt: string | null;
  sha256: string | null;
  diff?: { added: number; removed: number; modified: number };
}

interface Manifest {
  schema: 1;
  source: string;
  lastRun: string;
  lastSuccess: string | null;
  layers: Record<string, LayerStatus>;
}

interface ChangeEntry {
  at: string;
  layers: Array<{
    name: string;
    label: string;
    owner: string;
    before: number;
    after: number;
    added: number;
    removed: number;
    modified: number;
    samples: { added: string[]; removed: string[]; modified: string[] };
  }>;
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------
async function getJson<T>(url: string, attempt = 1): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${redact(url)}`);
    const body = (await res.json()) as T & { error?: { code: number; message: string } };
    if (body && typeof body === "object" && "error" in body && body.error) {
      throw new Error(`ArcGIS error ${body.error.code}: ${body.error.message} (${redact(url)})`);
    }
    return body;
  } catch (e) {
    if (attempt < 4 && !String(e).includes("Token Required") && !String(e).includes("ArcGIS error 4")) {
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      return getJson<T>(url, attempt + 1);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const redact = (u: string) => u.replace(/token=[^&]+/, "token=***");

let token: string | null = process.env.AP_GIS_TOKEN?.trim() || null;

async function ensureToken(): Promise<string | null> {
  if (token) return token;
  const user = process.env.AP_GIS_USERNAME;
  const pass = process.env.AP_GIS_PASSWORD;
  if (!user || !pass) return null;
  const info = await getJson<{ authInfo?: { tokenServicesUrl?: string } }>(
    `${GIS_BASE.replace(/\/services$/, "")}/info?f=json`,
  );
  const tokenUrl = info.authInfo?.tokenServicesUrl;
  if (!tokenUrl) throw new Error("server did not advertise a tokenServicesUrl");
  const body = new URLSearchParams({ username: user, password: pass, client: "requestip", expiration: "60", f: "json" });
  const res = await fetch(tokenUrl, { method: "POST", body, headers: { "User-Agent": UA } });
  const j = (await res.json()) as { token?: string; error?: { message: string } };
  if (!j.token) throw new Error(`token generation failed: ${j.error?.message ?? res.status}`);
  token = j.token;
  return token;
}

const withToken = (url: string, tok: string | null) => (tok ? `${url}&token=${encodeURIComponent(tok)}` : url);

// ---------------------------------------------------------------------------------------------
// Fetch one layer
// ---------------------------------------------------------------------------------------------
interface LayerInfo {
  objectIdField?: string;
  fields?: Array<{ name: string; type: string }>;
  maxRecordCount?: number;
}

function roundGeom(g: GeoJSON.Geometry | null): GeoJSON.Geometry | null {
  if (!g) return null;
  const r = (c: unknown): unknown =>
    Array.isArray(c) && typeof c[0] === "number" ? (c as number[]).slice(0, 2).map((n) => Math.round(n * 1e6) / 1e6) : (c as unknown[]).map(r);
  if (g.type === "GeometryCollection") return g;
  return { ...g, coordinates: r((g as { coordinates: unknown }).coordinates) } as GeoJSON.Geometry;
}

const DROP_FIELD = /^(objectid(_\d+)?|fid|orig_fid|shape|st_(length|area)\(shape\)|shape_(length|area|_len|_are)|shape__(length|area))$/i;

async function fetchLayer(layer: LiveLayer, tok: string | null): Promise<Feature[]> {
  const base = `${GIS_BASE}/${layer.service}/${layer.layerId}`;
  const info = await getJson<LayerInfo>(withToken(`${base}?f=json`, tok));
  const oid = info.objectIdField ?? info.fields?.find((f) => f.type === "esriFieldTypeOID")?.name ?? "objectid";
  const dateFields = new Set((info.fields ?? []).filter((f) => f.type === "esriFieldTypeDate").map((f) => f.name));
  const page = Math.min(PAGE, info.maxRecordCount ?? PAGE);

  const { count } = await getJson<{ count: number }>(withToken(`${base}/query?where=1%3D1&returnCountOnly=true&f=json`, tok));
  const feats: Feature[] = [];
  for (let offset = 0; offset < count; offset += page) {
    const q =
      `${base}/query?where=1%3D1&outFields=*&orderByFields=${encodeURIComponent(oid)}+ASC` +
      `&resultOffset=${offset}&resultRecordCount=${page}&outSR=4326&geometryPrecision=6&f=geojson`;
    const fc = await getJson<{ features?: Array<{ geometry: GeoJSON.Geometry | null; properties: Record<string, unknown> | null }> }>(
      withToken(q, tok),
    );
    const got = fc.features ?? [];
    if (got.length === 0) break; // server returned short — stop; the count gate below catches it
    for (const f of got) {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(f.properties ?? {})) {
        if (DROP_FIELD.test(k)) continue;
        props[k] = normalizeValue(v, dateFields.has(k));
      }
      feats.push({ type: "Feature", geometry: roundGeom(f.geometry), properties: layer.truncateKeys ? truncateKeys(props) : props });
    }
  }
  if (feats.length !== count) console.warn(`  ! ${layer.name}: server count ${count}, received ${feats.length}`);
  return feats;
}

// ---------------------------------------------------------------------------------------------
// Keys, hashing, serialisation
// ---------------------------------------------------------------------------------------------
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function displayName(p: Record<string, unknown>): string {
  for (const k of ["ss_name", "line_name", "sub_station_name", "feeder_name_33kv", "feeder_name", "name_of_th", "name", "ssid"]) {
    const v = p[k];
    if (typeof v === "string" && v.trim() && v !== "<Null>") return v.trim();
  }
  return "(unnamed)";
}

/** Assign each feature a unique stable key (duplicates get #2, #3… in content order). */
function keyed(features: Feature[], keyFields: string[]): Array<{ key: string; hash: string; f: Feature }> {
  const rows = features.map((f) => {
    const body = JSON.stringify([f.properties, f.geometry]);
    const hash = sha(body).slice(0, 16);
    const gh = sha(JSON.stringify(f.geometry)).slice(0, 12);
    return { base: featureKey(f.properties, keyFields, gh), hash, f };
  });
  rows.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const n = (seen.get(r.base) ?? 0) + 1;
    seen.set(r.base, n);
    return { key: n === 1 ? r.base : `${r.base}#${n}`, hash: r.hash, f: r.f };
  });
}

function serialise(rows: Array<{ f: Feature }>): string {
  return `{"type":"FeatureCollection","features":[\n${rows.map((r) => JSON.stringify(r.f)).join(",\n")}\n]}\n`;
}

function readPrevious(path: string, keyFields: string[]): { map: Map<string, string>; names: Map<string, string>; count: number } | null {
  if (!existsSync(path)) return null;
  try {
    const fc = JSON.parse(readFileSync(path, "utf-8")) as { features: Feature[] };
    const rows = keyed(fc.features, keyFields);
    return {
      map: new Map(rows.map((r) => [r.key, r.hash])),
      names: new Map(rows.map((r) => [r.key, displayName(r.f.properties)])),
      count: fc.features.length,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
async function discover(folder: string): Promise<void> {
  const tok = await ensureToken();
  const cat = await getJson<{ services?: Array<{ name: string; type: string }> }>(withToken(`${GIS_BASE}/${folder}?f=json`, tok));
  for (const s of cat.services ?? []) {
    if (s.type !== "MapServer" && s.type !== "FeatureServer") continue;
    const l = await getJson<{ layers?: Array<{ id: number; name: string; geometryType?: string }> }>(
      withToken(`${GIS_BASE}/${s.name}/${s.type}/layers?f=json`, tok),
    );
    for (const layer of l.layers ?? []) console.log(`${s.name}/${s.type}  #${layer.id}  ${layer.name}  ${layer.geometryType ?? ""}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const di = args.indexOf("--discover");
  if (di >= 0) return discover(args[di + 1] ?? "");
  const dryRun = args.includes("--dry-run");
  const oi = args.indexOf("--only");
  const only = oi >= 0 ? new Set((args[oi + 1] ?? "").split(",")) : null;

  mkdirSync(OUT_DIR, { recursive: true });
  const prevManifest: Manifest | null = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf-8")) : null;
  const now = new Date().toISOString();
  const manifest: Manifest = {
    schema: 1,
    source: GIS_BASE,
    lastRun: now,
    lastSuccess: prevManifest?.lastSuccess ?? null,
    layers: { ...(prevManifest?.layers ?? {}) },
  };
  const change: ChangeEntry = { at: now, layers: [] };

  // Fail fast if the GIS is unreachable. The AP State Data Centre firewall drops traffic from
  // outside India (e.g. GitHub-hosted runners) — without this, every layer would burn its retries.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    const res = await fetch(`${GIS_BASE}?f=json`, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`[sync] ${GIS_BASE} unreachable (${(e as Error).message}) — the server only accepts connections from within India. Nothing changed.`);
    process.exit(3);
  }

  let tok: string | null = null;
  try {
    tok = await ensureToken();
  } catch (e) {
    console.warn(`[sync] token unavailable: ${(e as Error).message}`);
  }

  let attempted = 0;
  let failed = 0;
  for (const layer of LIVE_LAYERS) {
    if (only && !only.has(layer.name)) continue;
    const url = `${GIS_BASE}/${layer.service}/${layer.layerId}`;
    const prevStatus = manifest.layers[layer.name];
    const base: LayerStatus = {
      label: layer.label,
      owner: layer.owner,
      group: layer.group,
      url,
      status: "error",
      count: prevStatus?.count ?? null,
      fetchedAt: prevStatus?.fetchedAt ?? null,
      lastChangedAt: prevStatus?.lastChangedAt ?? null,
      sha256: prevStatus?.sha256 ?? null,
    };
    if (layer.requiresToken && !tok) {
      manifest.layers[layer.name] = { ...base, status: "skipped", message: "requires AP_GIS_TOKEN" };
      console.log(`[sync] ${layer.name}: skipped (needs token)`);
      continue;
    }
    attempted++;
    const path = resolve(OUT_DIR, `${layer.name}.geojson`);
    const t0 = Date.now();
    try {
      const feats = await fetchLayer(layer, tok);
      const prev = readPrevious(path, layer.keyFields);
      const reject = gatePull(feats.length, layer.minCount, prev?.count ?? null);
      if (reject) {
        failed++;
        manifest.layers[layer.name] = { ...base, status: "rejected", message: reject };
        console.warn(`[sync] ${layer.name}: REJECTED — ${reject}; keeping previous file`);
        continue;
      }
      const rows = keyed(feats, layer.keyFields);
      const text = serialise(rows);
      const hash = sha(text);
      const next = new Map(rows.map((r) => [r.key, r.hash]));
      const nextNames = new Map(rows.map((r) => [r.key, displayName(r.f.properties)]));
      const d: LayerDiff = prev ? diffKeyed(prev.map, next) : { added: [...next.keys()], removed: [], modified: [] };
      const changed = hash !== base.sha256 || !existsSync(path);
      const nameOf = (k: string) => nextNames.get(k) ?? prev?.names.get(k) ?? k;
      // The first pull of a layer is its baseline, not a "change".
      if (prev && changed && (d.added.length || d.removed.length || d.modified.length)) {
        change.layers.push({
          name: layer.name,
          label: layer.label,
          owner: layer.owner,
          before: prev?.count ?? 0,
          after: feats.length,
          added: d.added.length,
          removed: d.removed.length,
          modified: d.modified.length,
          samples: {
            added: d.added.slice(0, 15).map(nameOf),
            removed: d.removed.slice(0, 15).map((k) => prev?.names.get(k) ?? k),
            modified: d.modified.slice(0, 15).map(nameOf),
          },
        });
      }
      if (!dryRun && changed) writeFileSync(path, text);
      manifest.layers[layer.name] = {
        ...base,
        status: changed ? "ok" : "unchanged",
        count: feats.length,
        fetchedAt: now,
        lastChangedAt: changed ? now : base.lastChangedAt,
        sha256: hash,
        diff: { added: d.added.length, removed: d.removed.length, modified: d.modified.length },
      };
      console.log(
        `[sync] ${layer.name}: ${feats.length} features in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
          (changed ? ` — +${d.added.length} −${d.removed.length} ~${d.modified.length}` : " — unchanged"),
      );
    } catch (e) {
      failed++;
      manifest.layers[layer.name] = { ...base, status: "error", message: (e as Error).message.slice(0, 300) };
      console.error(`[sync] ${layer.name}: ERROR — ${(e as Error).message}`);
    }
  }

  if (attempted > 0 && failed < attempted) manifest.lastSuccess = now;
  if (!dryRun) {
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
    if (change.layers.length) {
      const log: ChangeEntry[] = existsSync(CHANGELOG) ? JSON.parse(readFileSync(CHANGELOG, "utf-8")) : [];
      log.unshift(change);
      writeFileSync(CHANGELOG, JSON.stringify(log.slice(0, CHANGELOG_MAX), null, 2) + "\n");
    }
  }
  const summary = change.layers.map((l) => `${l.name} +${l.added}/−${l.removed}/~${l.modified}`).join(", ");
  console.log(`[sync] done: ${attempted - failed}/${attempted} layers OK${summary ? ` | changes: ${summary}` : " | no changes"}`);
  if (attempted > 0 && failed === attempted) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
