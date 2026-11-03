/**
 * DISCOM 11 kV network (feeders, distribution transformers, AB switches) — layer config + pure
 * storage helpers (no I/O; unit-tested in net.test.ts). Runner: scripts/sync-network.mts.
 *
 * PRIVACY (owner decision, 2026-11-03 — the site is public):
 *  - HT consumer services are NEVER imported, from any DISCOM (APEPDCL's HT layer carries the
 *    consumer's name, address and meter number).
 *  - Every layer is read through an ALLOW-LIST (`keep`), never a drop-list, so a column the GIS
 *    adds later can't leak. Not kept, deliberately: `dtr_loc_name` (frequently a private person's
 *    name — "KURRI SURIBABU LAND"), `ht_scno` (HT service no.), `remarks`, surveyor device ids
 *    (`ime_no`), employee ids (`created_by`, `*_user`) and audit dates.
 */

export type NetKind = "lines" | "points";

export interface NetLayer {
  name: string;
  discom: "APEPDCL" | "APSPDCL";
  label: string;
  kind: NetKind;
  service: string;
  layerId: number;
  minCount: number;
  /** Attribute allow-list (source field names). */
  keep: string[];
  /** Points: group rows by this field (shared attributes stored once per group). */
  groupBy?: string;
  /** Points: order within a group. */
  sortBy?: string;
  /** Lines: stable sort key field (falls back to geometry). */
  keyField?: string;
}

const EP = "Epdcl_11KV/Epdcl_11KV/MapServer";
const SP = "SPDCL/SPDCL_Network_11KV/MapServer";
const EP_HIER = ["circle_name", "division_name", "sub_division_name", "section_name", "sub_station_name", "sub_station_id", "feeder_id", "feeder_name"];

export const NET_LAYERS: NetLayer[] = [
  {
    name: "net-epdcl-11kv", discom: "APEPDCL", label: "APEPDCL 11 kV feeders", kind: "lines", service: EP, layerId: 3, minCount: 3000,
    keep: [...EP_HIER, "length_km", "pole_count"], keyField: "feeder_id",
  },
  {
    name: "net-epdcl-dtr", discom: "APEPDCL", label: "APEPDCL distribution transformers", kind: "points", service: EP, layerId: 1, minCount: 200000,
    keep: [...EP_HIER, "pole_no", "dtr_code", "dtr_capacity", "dtr_phase", "dtr_make", "dtr_structure", "no_lt_ckt", "type_of_load", "dtr_location_type", "record_status"],
    groupBy: "feeder_id", sortBy: "pole_no",
  },
  {
    name: "net-epdcl-ab", discom: "APEPDCL", label: "APEPDCL AB switches", kind: "points", service: EP, layerId: 2, minCount: 15000,
    keep: [...EP_HIER, "pole_no", "no_abswitchs", "pole_structure", "record_status"],
    groupBy: "feeder_id", sortBy: "pole_no",
  },
  {
    name: "net-spdcl-11kv", discom: "APSPDCL", label: "APSPDCL 11 kV lines", kind: "lines", service: SP, layerId: 3, minCount: 28000,
    keep: ["feeder_name", "feeder_code", "substation", "mandal", "section_", "subdivision", "division", "circle", "conductor_size"],
  },
  {
    name: "net-spdcl-dtr", discom: "APSPDCL", label: "APSPDCL distribution transformers", kind: "points", service: SP, layerId: 1, minCount: 100000,
    keep: ["feeder_name", "feeder_code", "dtr_capacity", "no_of_lt_feeders", "serial_number", "make", "date_of_commission", "mounting_type", "phase"],
    groupBy: "feeder_name", sortBy: "serial_number",
  },
];

/** Keep only allow-listed attributes (case-insensitive source names), dropping nulls. */
export function pickFields(props: Record<string, unknown>, keep: readonly string[]): Record<string, unknown> {
  const want = new Set(keep.map((k) => k.toLowerCase()));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    const lk = k.toLowerCase();
    if (!want.has(lk) || v == null) continue;
    out[lk] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Grouped point storage (same idea as towers-lib, generic group/sort field)

export interface NetPoint {
  lng: number;
  lat: number;
  props: Record<string, unknown>;
}

export interface GroupedFile {
  schema: 1;
  layer: string;
  fetchedAt: string;
  count: number;
  groupBy: string;
  cols: string[];
  groups: Array<{ key: string; attrs: Record<string, unknown> }>;
  /** [groupIdx, lng, lat, ...cols] — null = "take the group's value / none". */
  rows: unknown[][];
}

export const NO_GROUP = "(none)";
const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export function groupPoints(points: NetPoint[], groupBy: string, sortBy: string | undefined, meta: { layer: string; fetchedAt: string }): GroupedFile {
  const groups = new Map<string, NetPoint[]>();
  for (const p of points) {
    const k = p.props[groupBy] == null ? NO_GROUP : String(p.props[groupBy]).trim() || NO_GROUP;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(p);
  }
  const keys = [...groups.keys()].sort(natural);
  const shared: Set<string>[] = [];
  const out: GroupedFile["groups"] = [];
  const colSet = new Set<string>();
  for (const k of keys) {
    const g = groups.get(k)!;
    const fields = new Set<string>();
    for (const p of g) for (const [f, v] of Object.entries(p.props)) if (v != null && f !== groupBy) fields.add(f);
    const attrs: Record<string, unknown> = {};
    const sh = new Set<string>();
    for (const f of [...fields].sort()) {
      const v0 = g[0].props[f];
      if (v0 != null && g.every((p) => same(p.props[f], v0))) {
        attrs[f] = v0;
        sh.add(f);
      } else colSet.add(f);
    }
    out.push({ key: k, attrs });
    shared.push(sh);
  }
  const cols = [...colSet].sort((a, b) => (a === sortBy ? -1 : b === sortBy ? 1 : a.localeCompare(b)));
  const rows: unknown[][] = [];
  keys.forEach((k, gi) => {
    const g = [...groups.get(k)!].sort(
      (a, b) => natural(String(a.props[sortBy ?? ""] ?? ""), String(b.props[sortBy ?? ""] ?? "")) || a.lng - b.lng || a.lat - b.lat,
    );
    for (const p of g) {
      const row: unknown[] = [gi, p.lng, p.lat];
      for (const c of cols) row.push(shared[gi].has(c) ? null : (p.props[c] ?? null));
      while (row.length > 3 && row[row.length - 1] == null) row.pop();
      rows.push(row);
    }
  });
  return { schema: 1, ...meta, count: rows.length, groupBy, cols, groups: out, rows };
}

export function ungroupPoints(f: Pick<GroupedFile, "groupBy" | "cols" | "groups" | "rows">): NetPoint[] {
  return f.rows.map((row) => {
    const g = f.groups[row[0] as number];
    const props: Record<string, unknown> = { ...(g.key === NO_GROUP ? {} : { [f.groupBy]: g.key }), ...g.attrs };
    f.cols.forEach((c, i) => {
      const v = row[3 + i];
      if (v != null) props[c] = v;
    });
    return { lng: row[1] as number, lat: row[2] as number, props };
  });
}

export function serialiseGrouped(f: GroupedFile): string {
  const head = JSON.stringify({ schema: f.schema, layer: f.layer, fetchedAt: f.fetchedAt, count: f.count, groupBy: f.groupBy, cols: f.cols });
  return (
    `${head.slice(0, -1)},"groups":[\n${f.groups.map((g) => JSON.stringify(g)).join(",\n")}\n],` +
    `"rows":[\n${f.rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`
  );
}

/** Line-oriented diff of two serialised files (a changed row counts as one removed + one added). */
export function lineDiff(prev: string | null, next: string): { added: number; removed: number } {
  if (prev == null) return { added: next.split("\n").length, removed: 0 };
  const a = new Map<string, number>();
  for (const l of prev.split("\n")) a.set(l, (a.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of next.split("\n")) {
    const n = a.get(l) ?? 0;
    if (n > 0) a.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of a.values()) removed += n;
  return { added, removed };
}
