/**
 * AP-TRANSCO transmission towers — pure helpers (no I/O; unit-tested in towers.test.ts).
 *
 * The GIS has ~114k tower points (layers 2/3/4 of AP_Grid_Map/gridmapkml). As one GeoJSON feature
 * per tower that is ~40 MB, and almost every attribute repeats along a line (circle, division,
 * commissioning, conductor …). So towers are stored GROUPED BY LINE:
 *
 *   raw   data/raw/live/towers-<kv>.json   lossless: per-line shared attrs once + one row per tower
 *   web   public/data/towers-<kv>.json     same shape, low-cardinality columns dictionary-encoded,
 *                                          each line matched to its core `lines.geojson` id
 *
 * A field is "shared" for a line when every tower on that line carries the same non-null value;
 * decoding takes the tower's own value, else the line's — so the round trip is exact.
 */

export interface TowerLayer {
  name: string;
  voltage: 400 | 220 | 132;
  layerId: number;
  /** Hard floor: fewer towers than this ⇒ the pull is rejected and the previous file kept. */
  minCount: number;
}

export const TOWER_SERVICE = "AP_Grid_Map/gridmapkml/MapServer";

export const TOWER_LAYERS: TowerLayer[] = [
  { name: "towers-400kv", voltage: 400, layerId: 2, minCount: 14000 },
  { name: "towers-220kv", voltage: 220, layerId: 3, minCount: 40000 },
  { name: "towers-132kv", voltage: 132, layerId: 4, minCount: 48000 },
];

/** Never stored: ids / geometry duplicates / a redundant concatenation of two other fields. */
export const DROP_TOWER_FIELD = /^(objectid|globalid|latitude|longitude|linename_sd_merge|shape)$/i;

/** Placeholder line for towers the source left without a line name (not written back on decode). */
export const NO_LINE = "(no line name)";

export interface TowerPoint {
  lng: number;
  lat: number;
  props: Record<string, unknown>;
}

export interface TowersFile {
  schema: 1;
  layer: string;
  voltage: number;
  fetchedAt: string;
  count: number;
  /** Per-tower columns (after lineIdx, lng, lat). */
  cols: string[];
  lines: Array<{ line_name: string; attrs: Record<string, unknown> }>;
  /** [lineIdx, lng, lat, ...values in `cols` order] — null = "take the line's value / none". */
  towers: unknown[][];
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Natural compare so "T-9" sorts before "T-10". */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);
}

export function groupTowers(points: TowerPoint[], meta: { layer: string; voltage: number; fetchedAt: string }): TowersFile {
  const byLine = new Map<string, TowerPoint[]>();
  for (const p of points) {
    const name = String(p.props.line_name ?? "").trim() || NO_LINE;
    let g = byLine.get(name);
    if (!g) byLine.set(name, (g = []));
    g.push(p);
  }
  const lineNames = [...byLine.keys()].sort(naturalCompare);
  const lines: TowersFile["lines"] = [];
  const sharedKeys: Set<string>[] = [];
  const colSet = new Set<string>();
  for (const name of lineNames) {
    const g = byLine.get(name)!;
    const keys = new Set<string>();
    for (const t of g) for (const [k, v] of Object.entries(t.props)) if (v != null && k !== "line_name") keys.add(k);
    const attrs: Record<string, unknown> = {};
    const shared = new Set<string>();
    for (const k of [...keys].sort()) {
      const v0 = g[0].props[k];
      if (v0 != null && g.every((t) => same(t.props[k], v0))) {
        attrs[k] = v0;
        shared.add(k);
      } else colSet.add(k);
    }
    lines.push({ line_name: name, attrs });
    sharedKeys.push(shared);
  }
  // tower_number first (most-read), then the rest alphabetically.
  const cols = [...colSet].sort((a, b) => (a === "tower_number" ? -1 : b === "tower_number" ? 1 : a.localeCompare(b)));
  const towers: unknown[][] = [];
  lineNames.forEach((name, li) => {
    const g = [...byLine.get(name)!].sort(
      (a, b) => naturalCompare(String(a.props.tower_number ?? ""), String(b.props.tower_number ?? "")) || a.lng - b.lng || a.lat - b.lat,
    );
    for (const t of g) {
      const row: unknown[] = [li, t.lng, t.lat];
      for (const c of cols) row.push(sharedKeys[li].has(c) ? null : (t.props[c] ?? null));
      // Trim trailing nulls — most towers only fill the first few columns.
      while (row.length > 3 && row[row.length - 1] == null) row.pop();
      towers.push(row);
    }
  });
  return { schema: 1, ...meta, count: towers.length, cols, lines, towers };
}

/** Inverse of groupTowers: every tower with its full attribute set (line_name included). */
export function ungroupTowers(file: Pick<TowersFile, "cols" | "lines" | "towers">): TowerPoint[] {
  return file.towers.map((row) => {
    const line = file.lines[row[0] as number];
    const props: Record<string, unknown> = { ...(line.line_name === NO_LINE ? {} : { line_name: line.line_name }), ...line.attrs };
    file.cols.forEach((c, i) => {
      const v = row[3 + i];
      if (v != null) props[c] = v;
    });
    return { lng: row[1] as number, lat: row[2] as number, props };
  });
}

/** One line per row so git diffs stay minimal. */
export function serialiseTowers(f: TowersFile): string {
  const head = JSON.stringify({ schema: f.schema, layer: f.layer, voltage: f.voltage, fetchedAt: f.fetchedAt, count: f.count, cols: f.cols });
  return (
    `${head.slice(0, -1)},"lines":[\n${f.lines.map((l) => JSON.stringify(l)).join(",\n")}\n],` +
    `"towers":[\n${f.towers.map((t) => JSON.stringify(t)).join(",\n")}\n]}\n`
  );
}

/** Stable per-tower identity + content hash input, for change detection between pulls. */
export function towerKeys(points: TowerPoint[]): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  const rows = points
    .map((p) => {
      const sorted = Object.fromEntries(Object.entries(p.props).filter(([, v]) => v != null).sort(([a], [b]) => a.localeCompare(b)));
      return { base: `${p.props.line_name ?? ""}|${p.props.tower_number ?? ""}`, body: JSON.stringify([sorted, p.lng, p.lat]) };
    })
    .sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : a.body < b.body ? -1 : a.body > b.body ? 1 : 0));
  for (const r of rows) {
    const n = (seen.get(r.base) ?? 0) + 1;
    seen.set(r.base, n);
    out.set(n === 1 ? r.base : `${r.base}#${n}`, r.body);
  }
  return out;
}

export function diffTowers(prev: Map<string, string>, next: Map<string, string>): { added: number; removed: number; modified: number } {
  let added = 0;
  let modified = 0;
  for (const [k, v] of next) {
    const p = prev.get(k);
    if (p == null) added++;
    else if (p !== v) modified++;
  }
  let removed = 0;
  for (const k of prev.keys()) if (!next.has(k)) removed++;
  return { added, removed, modified };
}

// ---------------------------------------------------------------------------------------------
// Web output

/** Line-name normalisation for matching tower rows to core lines (whitespace + case only). */
export const normLineName = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export interface WebTowersFile {
  generatedAt: string;
  voltage: number;
  count: number;
  /** Columns after [lineIdx, lng, lat]. */
  cols: string[];
  /** Per column: dictionary of values when dictionary-encoded (row holds the index), else null. */
  dicts: Array<string[] | null>;
  lines: Array<{ name: string; lineId: string | null; attrs: Record<string, unknown> }>;
  towers: unknown[][];
}

export interface LineTowerStats {
  n: number;
  cp: number;
  sp: number;
  /** Top tower types by count, e.g. [["P+0", 120], ["S+0", 14]]. */
  types: Array<[string, number]>;
}

/** CP/SP spellings in the source ("Cp", "CPP", "Sp") → canonical; Boom / Gantry kept as-is. */
export function canonicalCpSp(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  const u = s.toUpperCase();
  if (u.startsWith("CP")) return "CP";
  if (u.startsWith("SP")) return "SP";
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : null;
}

export function buildWebTowers(
  raw: TowersFile,
  lineIdsByName: Map<string, string[]>,
  generatedAt: string,
): { web: WebTowersFile; stats: Map<string, LineTowerStats>; matchedLines: number; matchedTowers: number } {
  const ci = (c: string) => raw.cols.indexOf(c);
  const cpCol = ci("cp_sp");
  const typeCol = ci("tower_type");
  const lines = raw.lines.map((l) => ({
    name: l.line_name,
    lineId: lineIdsByName.get(normLineName(l.line_name))?.[0] ?? null,
    attrs: l.attrs,
  }));
  // Dictionary-encode low-cardinality string columns (types, CP/SP, configuration …).
  const dicts: Array<string[] | null> = raw.cols.map((_, i) => {
    const vals = new Set<string>();
    for (const t of raw.towers) {
      const v = t[3 + i];
      if (v == null) continue;
      if (typeof v !== "string") return null;
      vals.add(v);
      if (vals.size > 5000) return null;
    }
    return vals.size ? [...vals].sort() : null;
  });
  const index = dicts.map((d) => (d ? new Map(d.map((v, j) => [v, j])) : null));
  const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
  const towers = raw.towers.map((t) => {
    const row: unknown[] = [t[0], r5(t[1] as number), r5(t[2] as number)];
    for (let i = 3; i < t.length; i++) {
      const v = t[i];
      const m = index[i - 3];
      row.push(v != null && m ? m.get(v as string) : v);
    }
    return row;
  });

  const stats = new Map<string, LineTowerStats>();
  let matchedTowers = 0;
  const value = (t: unknown[], col: number, li: number, key: string) => (col >= 0 ? t[3 + col] : undefined) ?? raw.lines[li].attrs[key];
  raw.towers.forEach((t) => {
    const li = t[0] as number;
    const ids = lineIdsByName.get(normLineName(raw.lines[li].line_name));
    if (!ids) return;
    matchedTowers++;
    const cp = canonicalCpSp(value(t, cpCol, li, "cp_sp"));
    const type = value(t, typeCol, li, "tower_type");
    for (const id of ids) {
      let s = stats.get(id);
      if (!s) stats.set(id, (s = { n: 0, cp: 0, sp: 0, types: [] }));
      s.n++;
      if (cp === "CP") s.cp++;
      else if (cp === "SP") s.sp++;
      if (type != null) {
        const e = s.types.find((x) => x[0] === String(type));
        if (e) e[1]++;
        else s.types.push([String(type), 1]);
      }
    }
  });
  for (const s of stats.values()) s.types = s.types.sort((a, b) => b[1] - a[1]).slice(0, 8);

  return {
    web: { generatedAt, voltage: raw.voltage, count: raw.count, cols: raw.cols, dicts, lines, towers },
    stats,
    matchedLines: lines.filter((l) => l.lineId).length,
    matchedTowers,
  };
}
