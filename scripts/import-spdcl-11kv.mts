/**
 * One-off import of APSPDCL's full 11 kV HT network from its internal-GeoServer pole survey export
 * (one KML per circle, `circle_<name>_HT_points.kml`, ~3 M points). Not on the open AP-TRANSCO GIS, so
 * `npm run sync:network` can't refresh it. Re-run when APSPDCL supplies a newer export:
 *
 *   npx tsx scripts/import-spdcl-11kv.mts [path/to/SPDCL_HT_KML_Files]
 *   npm run build:data
 *
 * Every surveyed point (11 kV pole, DTR-and-pole, VCB, HT/LT pole) records `back_link_point` — the
 * pole it hangs off. Child → parent spans within one feeder are chained into ROUTES, one feature per
 * (circle, division, 33/11 kV SS, feeder). Owner decision (2026-11-03, public site — same policy as
 * APCPDCL): publish ONLY route geometry + feeder / SS / section hierarchy + counts. Individual pole,
 * DTR and VCB points, their ids, survey ids and back-links are never written.
 *
 * A circle whose export is truncated (GeoServer died mid-download: no closing </kml>, or a trailing
 * ServiceException) is SKIPPED and listed in index.json; the ETL keeps the open-GIS 11 kV spans there.
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { homedir } from "node:os";
import type { Position } from "geojson";
import { haversineKm, simplifyLine } from "./etl-discom.ts";
import { chainTree, isTruncated } from "./spdcl-lib.ts";

const dir = resolve(process.argv[2] ?? `${homedir()}/Library/CloudStorage/GoogleDrive-gsuryaias@gmail.com/My Drive/Transco/maps/SPDCL_HT_KML_Files`);
if (!existsSync(dir)) {
  console.error(`[spdcl-11kv] not found: ${dir}`);
  process.exit(1);
}
const outDir = resolve("data/raw/discom/spdcl-11kv");

/** Route simplification: ~5 m — keeps the pole-accurate shape, drops collinear poles. 5 dp ≈ 1 m. */
const TOL = 0.00005;
/** A recorded back-link longer than this is a data-entry error, not a span. */
const MAX_SPAN_KM = 1;
/** Points closer than this to their parent are the same pole (duplicate capture). */
const MERGE_KM = 0.005;
const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
const PAIR = /atr-name">([^<]*)<\/span>:<\/strong> <span class="atr-value">([^<]*)<\/span>/g;
const DESC = /<description>([\s\S]*?)<\/description>/;
const COORD = /<coordinates>\s*([^<]+?)\s*<\/coordinates>/;

interface Pt {
  parent: string;
  key: string;
  type: string;
  section: string;
  subdiv: string;
  x: number;
  y: number;
}
interface Group {
  feeder: string;
  ss: string;
  division: string;
  circle: string;
  poles: number;
  dtrPoles: number;
  vcbs: number;
  section: Map<string, number>;
  subdiv: Map<string, number>;
  edges: Array<[Pt, Pt]>; // [parent, child] after duplicate-capture contraction
  km: number;
}

const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const mode = (m: Map<string, number>) => [...m.entries()].filter(([k]) => k).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

async function readCircle(path: string): Promise<{ pts: Map<string, Pt>; groups: Map<string, Group>; skippedPts: number }> {
  const pts = new Map<string, Pt>();
  const groups = new Map<string, Group>();
  let skippedPts = 0;
  let buf = "";
  const handle = (block: string) => {
    const d = DESC.exec(block);
    const c = COORD.exec(block);
    if (!d || !c || !block.includes("</Point>")) return void skippedPts++;
    const a: Record<string, string> = {};
    for (const m of unescapeXml(d[1]).matchAll(PAIR)) a[m[1]] = norm(m[2]);
    const [x, y] = c[1].split(",").map(Number);
    if (!a.name || !Number.isFinite(x) || !Number.isFinite(y)) return void skippedPts++;
    const feeder = a.feeder_name ?? "";
    const key = [a.Circle, a.Division, a["Sub Station"], feeder].map((s) => (s ?? "").toLowerCase()).join("|");
    let g = groups.get(key);
    if (!g) {
      groups.set(key, (g = { feeder, ss: a["Sub Station"] ?? "", division: a.Division ?? "", circle: a.Circle ?? "", poles: 0, dtrPoles: 0, vcbs: 0, section: new Map(), subdiv: new Map(), edges: [], km: 0 }));
    }
    g.poles++;
    if (/dtr/i.test(a.point_type ?? "")) g.dtrPoles++;
    if (/^vcb$/i.test(a.point_type ?? "")) g.vcbs++;
    g.section.set(a.Section ?? "", (g.section.get(a.Section ?? "") ?? 0) + 1);
    g.subdiv.set(a["Sub Division"] ?? "", (g.subdiv.get(a["Sub Division"] ?? "") ?? 0) + 1);
    pts.set(a.name, { parent: a.back_link_point ?? "", key, type: a.point_type ?? "", section: a.Section ?? "", subdiv: a["Sub Division"] ?? "", x, y });
  };
  for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 16 << 20 })) {
    buf += chunk;
    const parts = buf.split("</Placemark>");
    buf = parts.pop()!;
    for (const p of parts) {
      const i = p.indexOf("<Placemark");
      if (i >= 0) handle(p.slice(i));
    }
  }
  return { pts, groups, skippedPts };
}

const files = readdirSync(dir).filter((f) => /^circle_.+_HT_points\.kml$/i.test(f)).sort();
if (!files.length) {
  console.error(`[spdcl-11kv] no circle_*_HT_points.kml in ${dir}`);
  process.exit(1);
}
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const index: { source: string; vintage: string; circles: Record<string, unknown>; skipped: Record<string, string> } = {
  source: "APSPDCL HT pole survey (internal GeoServer KML export)",
  vintage: "",
  circles: {},
  skipped: {},
};
let vintage = "";
for (const f of files) {
  const path = resolve(dir, f);
  const circle = /^circle_(.+)_HT_points\.kml$/i.exec(f)![1].toLowerCase();
  const v = statSync(path).mtime.toISOString().slice(0, 10);
  if (v > vintage) vintage = v;
  if (isTruncated(path)) {
    index.skipped[circle] = "export truncated (GeoServer error mid-download) — re-export; open-GIS spans used meanwhile";
    console.warn(`[spdcl-11kv] ${circle}: export TRUNCATED — skipped`);
    continue;
  }
  const { pts, groups, skippedPts } = await readCircle(path);
  let spans = 0;
  let orphan = 0;
  let cross = 0;
  let long = 0;
  // Duplicate captures (a DTR / second fix recorded a metre or two from its pole) hang off the pole as
  // micro-spans that would break every chain into stubs: contract any point within MERGE_KM of its
  // parent onto the parent's node.
  const rep = new Map<Pt, Pt>();
  const repOf = (p: Pt): Pt => {
    const path: Pt[] = [];
    let cur = p;
    for (;;) {
      const known = rep.get(cur);
      if (known) { cur = known; break; }
      const q = cur.parent ? pts.get(cur.parent) : undefined;
      if (!q || q.key !== cur.key || path.includes(q) || haversineKm([cur.x, cur.y], [q.x, q.y]) >= MERGE_KM) break;
      path.push(cur);
      cur = q;
    }
    for (const x of path) rep.set(x, cur);
    if (!rep.has(cur)) rep.set(cur, cur);
    return cur;
  };
  for (const p of pts.values()) {
    const q0 = p.parent ? pts.get(p.parent) : undefined;
    if (!q0) { if (p.parent) orphan++; continue; }
    if (q0.key !== p.key) { cross++; continue; }
    const [a, q] = [repOf(p), repOf(q0)];
    if (a === q) continue;
    const seg: Position[] = [[q.x, q.y], [a.x, a.y]];
    const km = haversineKm(seg[0], seg[1]);
    if (km > MAX_SPAN_KM) { long++; continue; }
    const g = groups.get(p.key)!;
    g.edges.push([q, a]);
    g.km += km;
    spans++;
  }
  const feats: string[] = [];
  let km = 0;
  for (const g of [...groups.values()].sort((a, b) => a.division.localeCompare(b.division) || a.ss.localeCompare(b.ss) || a.feeder.localeCompare(b.feeder))) {
    if (!g.edges.length) continue;
    const parts = chainTree(g.edges)
      .map((p) => simplifyLine(p, TOL).map((c): Position => [r5(c[0]), r5(c[1])]))
      .filter((p) => p.length >= 2);
    if (!parts.length) continue;
    km += g.km;
    const props = {
      feeder: g.feeder || null,
      substation: g.ss || null,
      section: mode(g.section),
      subdivision: mode(g.subdiv),
      division: g.division || null,
      circle: g.circle || null,
      poles: g.poles,
      dtrPoles: g.dtrPoles,
      vcbs: g.vcbs,
      km: Math.round(g.km * 100) / 100,
    };
    const geometry = parts.length === 1 ? { type: "LineString", coordinates: parts[0] } : { type: "MultiLineString", coordinates: parts };
    feats.push(JSON.stringify({ type: "Feature", geometry, properties: props }));
  }
  const out = resolve(outDir, `${circle}.geojson`);
  writeFileSync(out, `{"type":"FeatureCollection","circle":"${circle}","vintage":"${v}","features":[\n${feats.join(",\n")}\n]}\n`);
  index.circles[circle] = { vintage: v, points: pts.size, feeders: feats.length, km: Math.round(km), spans, orphanLinks: orphan, crossFeederLinks: cross, overlongLinks: long, unreadablePoints: skippedPts };
  console.log(`[spdcl-11kv] ${circle}: ${pts.size} points → ${spans} spans → ${feats.length} feeders, ${Math.round(km)} km (orphan ${orphan}, cross-feeder ${cross}, >1 km ${long}) → ${basename(out)}`);
}
index.vintage = vintage;
writeFileSync(resolve(outDir, "index.json"), JSON.stringify(index, null, 1) + "\n");
console.log(`[spdcl-11kv] done → ${outDir}`);
