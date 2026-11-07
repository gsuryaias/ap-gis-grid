// DISCOM 33 kV overlay + TRANSCO→33 kV connectivity, and the DISCOM 11 kV network / DTR search tier
// (Atlas 2.0 phase 4 split of build-data.mts). Pure helpers live in etl-discom / etl-connectivity / etl-network.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Feature, Position } from "geojson";
import { haversineMeters, type Substation } from "./etl-lib.ts";
import { anchorOf, buildEpdclFeeders, buildSpdclFeeders, buildSpdclRoutes, coverageMask, dtrRows, epSsIdIndex, type Chain, type DtrRow, type F11, type SsRef } from "./etl-network.ts";
import type { GroupedFile } from "./net-lib.ts";
import { buildDiscomLines, buildDiscomSubstations, type Discom, type DiscomLineOut, type DiscomSubstation } from "./etl-discom.ts";
import { linkFeederSources, linkServedSubstations, NAME_MATCH_RADIUS_KM, PROXIMITY_KM, SERVES_M, type FeederIn } from "./etl-connectivity.ts";
import { toCsv } from "../src/lib/export.ts";
import { r5n } from "./etl-core.ts";
import { LIVE_DIR, type RawFeat, layerSources, readLayer } from "./etl-sources.ts";

/**
 * DISCOM 33 kV sub-transmission overlay (lazy-loaded) from the live pulls
 * data/raw/live/discom-{spdcl,epdcl,cpdcl}-{ss,lines}.geojson. Skipped (with empty outputs) when no
 * DISCOM layer has been synced yet — the app hides the toggle when the files are empty.
 */
export type DiscomStats = Record<string, { substations: number; lines: number; lineKm: number; linesFrom?: string }>;

export async function buildDiscom(outDir: string, transco: Substation[]): Promise<{ stats: DiscomStats; connectivity: unknown }> {
  const sources: Array<{ discom: Discom; stem: string }> = [
    { discom: "APSPDCL", stem: "discom-spdcl" },
    { discom: "APEPDCL", stem: "discom-epdcl" },
    { discom: "APCPDCL", stem: "discom-cpdcl" },
  ];
  const allSs: DiscomSubstation[] = [];
  const allLines: DiscomLineOut[] = [];
  const stats: DiscomStats = {};
  for (const { discom, stem } of sources) {
    const ssPath = resolve(LIVE_DIR, `${stem}-ss.geojson`);
    const lnPath = resolve(LIVE_DIR, `${stem}-lines.geojson`);
    // APCPDCL's feeders aren't on the open GIS — they come from a committed one-off export
    // (scripts/import-apcpdcl.mts) unless a live layer is ever configured.
    const staticLines = discom === "APCPDCL" ? resolve("data/raw/discom/apcpdcl-33kv-feeders.geojson") : null;
    const lineSrc = existsSync(lnPath) ? "live" : staticLines && existsSync(staticLines) ? "static" : null;
    if (!existsSync(ssPath) && !lineSrc) continue;
    const ss = existsSync(ssPath) ? buildDiscomSubstations(discom, await readLayer(`${stem}-ss`)) : [];
    const ln =
      lineSrc === "live"
        ? buildDiscomLines(discom, await readLayer(`${stem}-lines`))
        : lineSrc === "static"
          ? buildDiscomLines(discom, (JSON.parse(readFileSync(staticLines!, "utf-8")) as { features: RawFeat[] }).features)
          : [];
    if (lineSrc === "static") layerSources[`${stem}-lines`] = "snapshot";
    allSs.push(...ss);
    allLines.push(...ln);
    stats[discom] = {
      substations: ss.length,
      lines: ln.length,
      lineKm: Math.round(ln.reduce((a, l) => a + l.props.lengthKm, 0)),
      ...(lineSrc === "static"
        ? { linesFrom: `${discom} GIS export, ${(JSON.parse(readFileSync(staticLines!, "utf-8")) as { vintage?: string }).vintage ?? "undated"}` }
        : {}),
    };
    console.log(`[etl] DISCOM ${discom}: ${ss.length} 33/11 kV SS, ${ln.length} 33 kV line runs (${stats[discom].lineKm} km)`);
  }

  // ---- TRANSCO → 33 kV feeder → 33/11 kV SS connectivity (inferred; see etl-connectivity.ts) ----
  const feedersIn: FeederIn[] = allLines.map((l) => ({
    id: l.props.id,
    discom: l.props.discom,
    name: l.props.name,
    division: l.props.division,
    sourceSs: l.props.sourceSs,
    parts: l.parts,
  }));
  const tNodes = transco.map((t) => ({ id: t.id, name: t.name, descriptiveName: t.descriptiveName, voltage: t.voltage, lng: t.lng, lat: t.lat }));
  const src = linkFeederSources(tNodes, feedersIn);
  const serves = linkServedSubstations(feedersIn, allSs);
  const tById = new Map(transco.map((t) => [t.id, t]));
  const ssById = new Map(allSs.map((s) => [s.id, s]));
  const tLabel = (t: Substation) => `${t.voltage} kV ${t.name}`;

  // Inverse maps: 33/11 kV SS → feeders / TRANSCO sources; TRANSCO SS → feeders.
  const ssFeeders = new Map<string, string[]>();
  const ssSources = new Map<string, Set<string>>();
  const byTransco = new Map<string, string[]>();
  for (const l of allLines) {
    const id = l.props.id;
    const link = src.get(id);
    if (link) (byTransco.get(link.transcoSsId) ?? byTransco.set(link.transcoSsId, []).get(link.transcoSsId)!).push(id);
    for (const sid of serves.get(id) ?? []) {
      (ssFeeders.get(sid) ?? ssFeeders.set(sid, []).get(sid)!).push(id);
      if (link) (ssSources.get(sid) ?? ssSources.set(sid, new Set()).get(sid)!).add(link.transcoSsId);
    }
  }
  const lineById = new Map(allLines.map((l) => [l.props.id, l]));
  const feederLabel = (id: string) => lineById.get(id)?.props.name ?? "Unnamed 33 kV line";

  // Null attributes are dropped from the emitted overlay (the app reads every field as optional).
  const compact = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)));
  // Nearest TRANSCO SS for every 33/11 kV SS — a reference even where no feeder is mapped (APSPDCL).
  const nearestT = (lng: number, lat: number) => {
    let best: Substation | null = null;
    let bd = Infinity;
    for (const t of transco) {
      if (Math.abs(t.lng - lng) > 0.6 || Math.abs(t.lat - lat) > 0.6) continue;
      const d = haversineMeters([lng, lat], [t.lng, t.lat]);
      if (d < bd) { bd = d; best = t; }
    }
    return best ? { label: tLabel(best), km: Math.round(bd / 100) / 10 } : null;
  };
  const ssFeats: Feature[] = allSs.map((s) => ({
    type: "Feature",
    id: s.id,
    geometry: { type: "Point", coordinates: [s.lng, s.lat] },
    properties: compact({
      ...s,
      transcoSs: [...(ssSources.get(s.id) ?? [])].map((t) => tLabel(tById.get(t)!)).join("; ") || null,
      feeders: [...new Set((ssFeeders.get(s.id) ?? []).map(feederLabel))].slice(0, 8).join("; ") || null,
      nearestTranscoSs: ((n) => (n ? `${n.label} (${n.km} km)` : null))(nearestT(s.lng, s.lat)),
    }),
  }));
  const lineFeats: Feature[] = allLines.map((l) => {
    const link = src.get(l.props.id);
    const served = serves.get(l.props.id) ?? [];
    return {
      type: "Feature",
      id: l.props.id,
      geometry: l.parts.length === 1 ? { type: "LineString", coordinates: l.parts[0] } : { type: "MultiLineString", coordinates: l.parts },
      properties: compact({
        ...l.props,
        transcoSsId: link?.transcoSsId ?? null,
        transcoSs: link ? tLabel(tById.get(link.transcoSsId)!) : null,
        linkMethod: link?.method ?? null,
        servesSsCount: served.length || null,
        servesSs: served.slice(0, 12).map((id) => ssById.get(id)!.name).join("; ") || null,
      }),
    };
  });
  writeFileSync(resolve(outDir, "discom-ss.geojson"), JSON.stringify({ type: "FeatureCollection", features: ssFeats }));
  writeFileSync(resolve(outDir, "discom-lines.geojson"), JSON.stringify({ type: "FeatureCollection", features: lineFeats }));

  // Compact per-TRANSCO-SS index for the detail panel (lazy-loaded): feeders as tuples
  // [id, name, discom, km, method, servedSsIds[]] + a 33/11 kV SS lookup [name, discom, lng, lat].
  const bySs: Record<string, unknown[]> = {};
  for (const [tid, fids] of byTransco) {
    bySs[tid] = fids
      .map((id) => {
        const p = lineById.get(id)!.props;
        return [id, p.name, p.discom, p.lengthKm, src.get(id)!.method, serves.get(id) ?? []];
      })
      .sort((a, b) => String(a[1] ?? "~").localeCompare(String(b[1] ?? "~")));
  }
  const ssLookup = Object.fromEntries(allSs.map((s) => [s.id, [s.name, s.discom, s.lng, s.lat]]));
  const methods = { name: 0, proximity: 0, "feeder-group": 0 } as Record<string, number>;
  for (const l of src.values()) methods[l.method]++;
  const servedSsCount = ssFeeders.size;
  const ssWithSource = ssSources.size;
  const connectivity = {
    method:
      `Feeder→TRANSCO: recorded source-SS name matched within ${NAME_MATCH_RADIUS_KM} km, else a feeder end within ` +
      `${PROXIMITY_KM} km of a TRANSCO SS, else inherited from another run of the same feeder. Feeder→33/11 kV SS: ` +
      `same-DISCOM SS within ${SERVES_M} m of the route. Inferred — not a single-line diagram.`,
    feeders: allLines.length,
    feedersLinked: src.size,
    byMethod: methods,
    byDiscom: Object.fromEntries(
      Object.keys(stats).map((d) => {
        const ls = allLines.filter((l) => l.props.discom === d);
        const ssd = allSs.filter((s) => s.discom === d);
        return [d, {
          feeders: ls.length,
          feedersLinked: ls.filter((l) => src.has(l.props.id)).length,
          kmLinked: Math.round(ls.filter((l) => src.has(l.props.id)).reduce((a, l) => a + l.props.lengthKm, 0)),
          kmTotal: Math.round(ls.reduce((a, l) => a + l.props.lengthKm, 0)),
          substations: ssd.length,
          substationsOnFeeder: ssd.filter((s) => ssFeeders.has(s.id)).length,
          substationsTracedToTransco: ssd.filter((s) => ssSources.has(s.id)).length,
        }];
      }),
    ),
    transcoSsWithFeeders: byTransco.size,
    discomSsOnFeeder: servedSsCount,
    discomSsTracedToTransco: ssWithSource,
  };
  writeFileSync(
    resolve(outDir, "transco-33kv.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), method: connectivity.method, bySs, ss: ssLookup }),
  );

  // Statewide download: one row per 33 kV feeder run (linked first, by TRANSCO SS), unlinked at the end.
  const rows = allLines
    .map((l) => {
      const link = src.get(l.props.id);
      const t = link ? tById.get(link.transcoSsId)! : null;
      const served = (serves.get(l.props.id) ?? []).map((id) => ssById.get(id)!.name);
      return [
        t?.name ?? "", t?.ssCode ?? "", t?.voltage ?? "", t?.circle ?? "",
        l.props.discom, l.props.name ?? "Unnamed 33 kV line", l.props.id, l.props.division ?? "", l.props.lengthKm,
        link?.method ?? "unlinked", served.length, served.join("; "),
      ];
    })
    .sort((a, b) => (a[0] === "" ? 1 : 0) - (b[0] === "" ? 1 : 0) || String(a[0]).localeCompare(String(b[0])) || String(a[5]).localeCompare(String(b[5])));
  writeFileSync(
    resolve(outDir, "transco-33kv-connectivity.csv"),
    "\uFEFF" +
      toCsv(
        ["TRANSCO substation", "TRANSCO SS code", "TRANSCO kV", "TRANSCO circle", "DISCOM", "33 kV feeder", "Feeder id", "DISCOM division", "Feeder km", "Link method", "33/11 kV SS served", "33/11 kV substations"],
        rows,
      ),
  );
  console.log(
    `[etl] connectivity: ${src.size}/${allLines.length} feeder runs linked to ${byTransco.size} TRANSCO SS ` +
      `(name ${methods.name}, proximity ${methods.proximity}, group ${methods["feeder-group"]}); ` +
      `${servedSsCount}/${allSs.length} 33/11 kV SS on a feeder, ${ssWithSource} traced to TRANSCO`,
  );
  return { stats, connectivity };
}

/**
 * DISCOM 11 kV network (scripts/sync-network.mts → data/raw/live/net-*) → the lazy 11 kV overlay,
 * DTR search shards and the network search tier with upstream trace chains. Reads the 33 kV
 * outputs buildDiscom just wrote (discom-ss / discom-lines / transco-33kv). See etl-network.ts.
 */
export function buildNetwork(outDir: string, transco: Substation[]) {
  const live = (f: string) => resolve(LIVE_DIR, f);
  const readJson = <T,>(path: string): T | null => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as T) : null);
  type Fc = { features: Array<{ geometry: { type: string; coordinates: unknown } | null; properties: Record<string, unknown> }> };
  const epLines = readJson<Fc>(live("net-epdcl-11kv.geojson"));
  const spLines = readJson<Fc>(live("net-spdcl-11kv.geojson"));
  if (!epLines && !spLines) {
    console.log("[etl] network: not synced yet (npm run sync:network) — skipped");
    return null;
  }
  const ssFc = readJson<Fc>(resolve(outDir, "discom-ss.geojson"))!;
  const f33Fc = readJson<Fc>(resolve(outDir, "discom-lines.geojson"))!;
  const idx = readJson<{ bySs: Record<string, Array<[string, string | null, string, number, string, string[]]>> }>(resolve(outDir, "transco-33kv.json"))!;
  const ss: SsRef[] = ssFc.features.map((f) => {
    const p = f.properties;
    return { id: String(p.id), discom: String(p.discom), name: String(p.name), lng: Number(p.lng), lat: Number(p.lat) };
  });
  const ssById = new Map(ss.map((s) => [s.id, s]));
  const tLabel = new Map(transco.map((t) => [t.id, `${t.voltage} kV ${t.name}`]));
  const f33Name = new Map(f33Fc.features.map((f) => [String(f.properties.id), (f.properties.name as string | undefined) ?? "Unnamed 33 kV line"]));

  // 33/11 kV SS → (TRANSCO SS, 33 kV feeder) from the inferred 33 kV connectivity.
  const up = new Map<string, { tId: string; f33Id: string }>();
  for (const [tId, feeders] of Object.entries(idx.bySs)) for (const fd of feeders) for (const sid of fd[5]) if (!up.has(sid)) up.set(sid, { tId, f33Id: fd[0] });
  const chains: Chain[] = [];
  const chainIdx = new Map<string, number>();
  const chain = (c: Chain): number => {
    const k = JSON.stringify(c);
    let i = chainIdx.get(k);
    if (i == null) chainIdx.set(k, (i = chains.push(c) - 1));
    return i;
  };
  const ssChain = (ssId: string | null, fallbackName: string | null): number => {
    const s = ssId ? ssById.get(ssId) : null;
    const u = ssId ? up.get(ssId) : null;
    return chain([s?.id ?? null, s?.name ?? fallbackName, u?.f33Id ?? null, u ? (f33Name.get(u.f33Id) ?? null) : null, u?.tId ?? null, u ? (tLabel.get(u.tId) ?? null) : null]);
  };

  const TOL = 0.00015; // ≈ 15 m — 11 kV is only legible from ~z10, where this is sub-pixel
  const ep = epLines ? buildEpdclFeeders(epLines.features, epSsIdIndex(ss), TOL) : [];
  // APSPDCL: full pole-survey routes (scripts/import-spdcl-11kv.mts) where imported; the open-GIS spans
  // only where the import has no coverage (a skipped/truncated circle). IDs re-numbered over both.
  const spSs = ss.filter((s) => s.discom === "APSPDCL");
  const spImport = readSpdclImport();
  const spRoutes = spImport ? buildSpdclRoutes(spImport.features, spSs, TOL) : [];
  let spFallback: F11[] = [];
  let spSpansDropped = 0;
  if (spLines) {
    const covered = spRoutes.length ? coverageMask(spImport!.features.map((f) => partsOfGeom(f.geometry))) : () => false;
    const keep = spLines.features.filter((f) => {
      const parts = partsOfGeom(f.geometry);
      const p = parts[0];
      const hit = p?.length ? covered(p[Math.floor(p.length / 2)]) : false;
      if (hit) spSpansDropped++;
      return !hit;
    });
    spFallback = buildSpdclFeeders(keep, spSs, TOL);
  }
  const sp: F11[] = [...spRoutes, ...spFallback].map((f, i) => ({ ...f, id: `f11-sp-${String(i).padStart(5, "0")}` }));
  if (spImport) console.log(`[etl] network: APSPDCL import ${spRoutes.length} feeders (${Object.keys(spImport.index.circles).length} circles${Object.keys(spImport.index.skipped).length ? `, skipped ${Object.keys(spImport.index.skipped).join(",")}` : ""}); open-GIS spans kept ${spLines ? spLines.features.length - spSpansDropped : 0}, dropped ${spSpansDropped} as covered`);
  const feeders: F11[] = [...ep, ...sp];

  // ---- DTRs + AB switches → per-feeder counts, search shards ----
  const epByCode = new Map(ep.filter((f) => f.code).map((f) => [f.code!, f]));
  const spByName = new Map<string, F11[]>();
  for (const f of sp) {
    const k = f.name.toLowerCase();
    (spByName.get(k) ?? spByName.set(k, []).get(k)!).push(f);
  }
  const counts = new Map<string, { dtrs: number; kva: number; abs: number }>();
  const bump = (id: string, k: "dtrs" | "abs", kva = 0) => {
    const c = counts.get(id) ?? { dtrs: 0, kva: 0, abs: 0 };
    c[k]++;
    c.kva += kva;
    counts.set(id, c);
  };
  const epDtrFile = readJson<GroupedFile>(live("net-epdcl-dtr.json"));
  const spDtrFile = readJson<GroupedFile>(live("net-spdcl-dtr.json"));
  const abFile = readJson<GroupedFile>(live("net-epdcl-ab.json"));
  const epDtr = epDtrFile ? dtrRows(epDtrFile, "dtr_code") : [];
  const spDtr = spDtrFile ? dtrRows(spDtrFile, "serial_number") : [];
  const dtrFeeder = new Map<DtrRow, F11 | null>();
  for (const d of epDtr) dtrFeeder.set(d, epByCode.get(d.feederKey) ?? null);
  for (const d of spDtr) {
    const cands = spByName.get((feederLabelLc(d.feederKey)) ?? "") ?? [];
    let best: F11 | null = null;
    let bestD = Infinity;
    for (const f of cands) {
      const a = anchorOf(f.parts);
      const dd = (a[0] - d.lng) ** 2 + (a[1] - d.lat) ** 2;
      if (dd < bestD) [best, bestD] = [f, dd];
    }
    dtrFeeder.set(d, best);
  }
  for (const [d, f] of dtrFeeder) if (f) bump(f.id, "dtrs", d.kva ?? 0);
  if (abFile) for (const r of abFile.rows) {
    const f = epByCode.get(abFile.groups[r[0] as number].key);
    if (f) bump(f.id, "abs");
  }

  // ---- 11 kV overlay ----
  const lineFeats = feeders.map((f) => {
    const c = counts.get(f.id);
    const ch = chains[ssChain(f.ssId, f.ssName)];
    const props = Object.fromEntries(
      Object.entries({
        id: f.id, kind: "discom11-line", discom: f.discom, name: f.name, code: f.code,
        ss: f.ssId ? ch[1] : f.ssName, ssId: f.ssId, linkMethod: f.linkMethod,
        transcoSs: ch[5], transcoSsId: ch[4],
        section: f.section, subdivision: f.subdivision, division: f.division, circle: f.circle,
        lengthKm: f.lengthKm, poles: f.poles, dtrs: c?.dtrs || null, dtrKva: c?.kva ? Math.round(c.kva) : null, abSwitches: c?.abs || null,
      }).filter(([, v]) => v != null),
    );
    return { type: "Feature", id: f.id, geometry: f.parts.length === 1 ? { type: "LineString", coordinates: f.parts[0] } : { type: "MultiLineString", coordinates: f.parts }, properties: props };
  });
  writeFileSync(resolve(outDir, "discom-11kv-lines.geojson"), JSON.stringify({ type: "FeatureCollection", features: lineFeats }));

  // ---- DTR search shards ----
  const shardOut = new Map<string, { feeders: unknown[][]; fIdx: Map<string, number>; rows: unknown[][] }>();
  const DTR_COLS = ["dtr_capacity", "dtr_phase", "dtr_structure", "type_of_load", "pole_no", "dtr_make", "record_status", "phase", "make", "mounting_type", "no_of_lt_feeders"];
  const addDtr = (shard: string, d: DtrRow, discom: string) => {
    if (!d.code) return;
    let s = shardOut.get(shard);
    if (!s) shardOut.set(shard, (s = { feeders: [], fIdx: new Map(), rows: [] }));
    const f = dtrFeeder.get(d) ?? null;
    const fk = f?.id ?? `?${d.feederKey}`;
    let fi = s.fIdx.get(fk);
    if (fi == null) {
      fi = s.feeders.push([f?.id ?? null, f?.name ?? (d.feederKey || null), f ? ssChain(f.ssId, f.ssName) : -1, discom]) - 1;
      s.fIdx.set(fk, fi);
    }
    const row: unknown[] = [d.code, d.lng, d.lat, fi];
    for (const c of DTR_COLS) row.push(d.attrs[c] ?? null);
    while (row.length > 4 && row[row.length - 1] == null) row.pop();
    s.rows.push(row);
  };
  // Shard keys = the first 4 characters of the DTR code / serial (APEPDCL codes lead with circle +
  // division digits) — a typed code fetches exactly one small shard.
  const shardKey = (prefix: string, code: string) => `${prefix}-${code.slice(0, 4).toLowerCase().replace(/[^a-z0-9]/g, "_") || "xxxx"}`;
  for (const d of epDtr) addDtr(shardKey("ep", d.code), d, "APEPDCL");
  for (const d of spDtr) addDtr(`sp-${d.code.slice(0, 2).toLowerCase().replace(/[^a-z0-9]/g, "_") || "xx"}`, d, "APSPDCL");
  const shards: Record<string, number> = {};
  for (const [k, s] of shardOut) {
    // Dictionary-encode the repetitive attribute columns ("100 KVA", "POLE MOUNTED", "ACTIVE" …).
    const dicts = DTR_COLS.map((_, ci) => [...new Set(s.rows.map((r) => r[4 + ci]).filter((v) => v != null).map(String))].sort());
    const di = dicts.map((d) => new Map(d.map((v, j) => [v, j])));
    const rows = s.rows.map((r) => r.map((v, i) => (i >= 4 && v != null ? di[i - 4].get(String(v)) : v)));
    writeFileSync(resolve(outDir, `net-dtr-${k}.json`), JSON.stringify({ cols: DTR_COLS, dicts, feeders: s.feeders, rows }));
    shards[k] = s.rows.length;
  }

  // ---- Network search tier ----
  type Item = [string, string, string, number, number, string, number];
  const items: Item[] = [];
  for (const f of ss) {
    if (/^unnamed/i.test(f.name)) continue;
    items.push([f.name, "ss33", `${f.discom} · 33/11 kV substation`, f.lng, f.lat, f.id, ssChain(f.id, f.name)]);
  }
  for (const f of f33Fc.features) {
    const p = f.properties;
    if (!p.name) continue;
    const parts = (f.geometry?.type === "LineString" ? [f.geometry.coordinates] : (f.geometry?.coordinates as Position[][])) as Position[][];
    const [lng, lat] = anchorOf(parts);
    const tId = (p.transcoSsId as string | undefined) ?? null;
    items.push([String(p.name), "f33", `${p.discom} · 33 kV feeder${p.transcoSs ? ` from ${p.transcoSs}` : ""}`, lng, lat, String(p.id),
      chain([null, null, String(p.id), String(p.name), tId, tId ? (tLabel.get(tId) ?? null) : null])]);
  }
  const sections = new Map<string, { n: number; lng: number; lat: number; discom: string; label: string; sub: string }>();
  for (const f of feeders) {
    const [lng, lat] = anchorOf(f.parts);
    if (!/^unnamed/i.test(f.name))
      items.push([f.name, "f11", `${f.discom} · 11 kV${f.ssId || f.ssName ? ` from ${chains[ssChain(f.ssId, f.ssName)][1] ?? f.ssName} SS` : ""}${f.section ? ` · ${f.section}` : ""}`, lng, lat, f.id, ssChain(f.ssId, f.ssName)]);
    if (f.section) {
      const k = `${f.discom}|${f.section}|${f.division ?? ""}`;
      const s = sections.get(k) ?? { n: 0, lng: 0, lat: 0, discom: f.discom, label: `${f.section} section`, sub: `${f.discom} · ${[f.subdivision, f.division].filter(Boolean).join(", ")}` };
      s.n++;
      s.lng += lng;
      s.lat += lat;
      sections.set(k, s);
    }
  }
  for (const s of sections.values()) items.push([s.label, "sec", s.sub, r5n(s.lng / s.n), r5n(s.lat / s.n), "", -1]);
  writeFileSync(resolve(outDir, "search-network.json"), JSON.stringify({ generatedAt: new Date().toISOString(), shards, chains, items }));

  const summary: Record<string, unknown> = {};
  for (const discom of ["APEPDCL", "APSPDCL"]) {
    const fs = feeders.filter((f) => f.discom === discom);
    summary[discom] = {
      feeders: fs.length,
      km: Math.round(fs.reduce((a, f) => a + f.lengthKm, 0)),
      feedersLinkedToSs: fs.filter((f) => f.ssId).length,
      dtrs: discom === "APEPDCL" ? epDtr.length : spDtr.length,
      dtrsSearchable: discom === "APEPDCL" ? epDtr.filter((d) => d.code).length : spDtr.filter((d) => d.code).length,
      abSwitches: discom === "APEPDCL" ? (abFile?.count ?? 0) : 0,
      ...(discom === "APSPDCL" && spImport
        ? { routesFrom: spImport.index.vintage, routeCircles: Object.keys(spImport.index.circles).length, routeCirclesSkipped: Object.keys(spImport.index.skipped) }
        : {}),
    };
  }
  console.log(`[etl] network: ${ep.length} APEPDCL + ${sp.length} APSPDCL 11 kV runs; ${epDtr.length + spDtr.length} DTRs; ${items.length} search items; ${chains.length} chains; shards ${Object.keys(shards).join(",")}`);
  return { ...summary, searchItems: items.length };
}

const partsOfGeom = (g: { type: string; coordinates: unknown } | null): Position[][] =>
  !g ? [] : g.type === "LineString" ? [g.coordinates as Position[]] : g.type === "MultiLineString" ? (g.coordinates as Position[][]) : [];
type SpdclIndex = { source: string; vintage: string; circles: Record<string, { feeders: number; km: number; points: number }>; skipped: Record<string, string> };
/** Committed APSPDCL pole-survey routes (data/raw/discom/spdcl-11kv/<circle>.geojson + index.json), or null. */
function readSpdclImport(): { index: SpdclIndex; features: Array<{ geometry: { type: string; coordinates: unknown } | null; properties: Record<string, unknown> }> } | null {
  const dir = resolve("data/raw/discom/spdcl-11kv");
  if (!existsSync(resolve(dir, "index.json"))) return null;
  const index = JSON.parse(readFileSync(resolve(dir, "index.json"), "utf-8")) as SpdclIndex;
  const features = Object.keys(index.circles).sort().flatMap((c) => JSON.parse(readFileSync(resolve(dir, `${c}.geojson`), "utf-8")).features);
  return { index, features };
}

/** APSPDCL DTR feeder names are raw ("WW FEEDER"); compare like the 11 kV run labels. */
export function feederLabelLc(raw: string): string | null {
  const s = raw.replace(/^(11\s*k\.?\s*v\.?\s*)+/i, "").replace(/\s+/g, " ").trim();
  return s ? `11kv ${s.toLowerCase()}` : null;
}
