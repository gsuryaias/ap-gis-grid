/**
 * Live data sources — the AP-TRANSCO enterprise GIS (ArcGIS Enterprise 11.x REST API at
 * gis.aptransco.gov.in, hosted in the AP State Data Centre). This is the same server the Google-Earth
 * KMZ NetworkLinks (`…/MapServer/KmlServer?LayerIDs=…`) point at; we read the REST `query` endpoint
 * instead, which returns clean GeoJSON with full attribute names.
 *
 * Pure config + helpers (no I/O) so it is unit-testable. The runner is `scripts/sync-live.mts`.
 */

export const GIS_BASE = "https://gis.aptransco.gov.in/server/rest/services";

export type LiveGroup = "transco" | "discom";

export interface LiveLayer {
  /** Output file stem: data/raw/live/<name>.geojson. Transco names mirror data/raw/gridmap/<name>.shp. */
  name: string;
  group: LiveGroup;
  /** Owning utility, for the UI + manifest. */
  owner: "APTRANSCO" | "APSPDCL" | "APEPDCL" | "APCPDCL";
  label: string;
  /** Service path under GIS_BASE, e.g. "AP_Grid_Map/gridmapkml/MapServer". */
  service: string;
  layerId: number;
  /**
   * Rename attribute keys to their first 10 characters — the dBASE field-name limit the committed
   * shapefile snapshots were exported with — so the existing ETL reads live and snapshot data
   * through one code path (`circuit_type`→`circuit_ty`, `date_of_commissioning`→`date_of_co`, …).
   */
  truncateKeys: boolean;
  /** Hard floor: fewer features than this ⇒ the pull is rejected and the previous file kept. */
  minCount: number;
  /** Layer needs an ArcGIS token (AP_GIS_TOKEN / AP_GIS_USERNAME+PASSWORD). Skipped without one. */
  requiresToken?: boolean;
  /** Stable identity for change detection, first non-empty wins (falls back to geometry hash). */
  keyFields: string[];
}

const GRID = "AP_Grid_Map/gridmapkml/MapServer";

export const LIVE_LAYERS: LiveLayer[] = [
  // ---- AP-TRANSCO transmission grid (core network + facility overlays) --------------------------
  { name: "aptransco-ss", group: "transco", owner: "APTRANSCO", label: "TRANSCO substations", service: GRID, layerId: 0, truncateKeys: true, minCount: 300, keyFields: ["sap_ss_id", "ss_name"] },
  { name: "lines-400kv", group: "transco", owner: "APTRANSCO", label: "400 kV lines", service: GRID, layerId: 12, truncateKeys: true, minCount: 40, keyFields: ["globalid", "line_name"] },
  { name: "lines-220kv", group: "transco", owner: "APTRANSCO", label: "220 kV lines", service: GRID, layerId: 13, truncateKeys: true, minCount: 250, keyFields: ["globalid", "line_name"] },
  { name: "lines-132kv", group: "transco", owner: "APTRANSCO", label: "132 kV lines", service: GRID, layerId: 14, truncateKeys: true, minCount: 500, keyFields: ["globalid", "line_name"] },
  { name: "generation-ss", group: "transco", owner: "APTRANSCO", label: "Generating stations", service: GRID, layerId: 16, truncateKeys: true, minCount: 40, keyFields: ["name", "name_of_th"] },
  { name: "powergrid-ss", group: "transco", owner: "APTRANSCO", label: "POWERGRID substations", service: GRID, layerId: 8, truncateKeys: true, minCount: 20, keyFields: ["globalid", "name"] },
  { name: "powergrid-lines", group: "transco", owner: "APTRANSCO", label: "POWERGRID lines", service: GRID, layerId: 9, truncateKeys: true, minCount: 40, keyFields: ["globalid", "name_of_th"] },
  { name: "railway-ss", group: "transco", owner: "APTRANSCO", label: "Railway traction SS", service: GRID, layerId: 15, truncateKeys: true, minCount: 40, keyFields: ["name", "ht_sc_no"] },
  { name: "bulkload-ss", group: "transco", owner: "APTRANSCO", label: "Bulk-load / HT SS", service: GRID, layerId: 10, truncateKeys: true, minCount: 100, keyFields: ["name", "ht_sc_no"] },

  // ---- DISCOM 33 kV sub-transmission networks ---------------------------------------------------
  { name: "discom-spdcl-ss", group: "discom", owner: "APSPDCL", label: "APSPDCL 33/11 kV substations", service: "SPDCL/SPDCL_Network_33KV/MapServer", layerId: 5, truncateKeys: false, minCount: 1000, keyFields: ["ss_sap_code", "ss_name"] },
  { name: "discom-spdcl-lines", group: "discom", owner: "APSPDCL", label: "APSPDCL 33 kV lines", service: "SPDCL/SPDCL_Network_33KV/MapServer", layerId: 0, truncateKeys: false, minCount: 5000, keyFields: [] },
  { name: "discom-epdcl-ss", group: "discom", owner: "APEPDCL", label: "APEPDCL 33/11 kV substations", service: "EPDCL/Substations/MapServer", layerId: 0, truncateKeys: false, minCount: 700, keyFields: ["globalid", "ssid"] },
  { name: "discom-epdcl-lines", group: "discom", owner: "APEPDCL", label: "APEPDCL 33 kV feeders", service: "EPDCL/EPDCL_33KV_LINE/MapServer", layerId: 1, truncateKeys: false, minCount: 300, keyFields: ["feeder_code_33kv", "feeder_name_33kv"] },
  // APCPDCL publishes its network under the token-protected `APCPDCL` folder. Its layer ids aren't
  // discoverable without credentials — run `npm run sync:live -- --discover APCPDCL` with a token
  // and add the 33 kV substation + line layers here (requiresToken: true).
];

/** dBASE-style key truncation (first 10 chars); first key wins on a collision. */
export function truncateKeys(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    const t = k.slice(0, 10);
    if (!(t in out)) out[t] = v;
  }
  return out;
}

/** Normalise one attribute value: trim strings, epoch-ms date fields → ISO strings. */
export function normalizeValue(v: unknown, isDate: boolean): unknown {
  if (v == null) return null;
  if (isDate && typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? null : s;
  }
  return v;
}

/** Stable identity of a feature for change detection. */
export function featureKey(props: Record<string, unknown>, keyFields: string[], geomHash: string): string {
  for (const k of keyFields) {
    const v = props[k];
    if (v != null && String(v).trim() !== "" && String(v) !== "<Null>" && String(v) !== "0") return `${k}:${String(v).trim()}`;
  }
  return `g:${geomHash}`;
}

export interface LayerDiff {
  added: string[];
  removed: string[];
  modified: string[];
}

/** Diff two key→contentHash maps. Duplicate keys are disambiguated by the caller (#n suffix). */
export function diffKeyed(prev: Map<string, string>, next: Map<string, string>): LayerDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [k, h] of next) {
    const p = prev.get(k);
    if (p == null) added.push(k);
    else if (p !== h) modified.push(k);
  }
  for (const k of prev.keys()) if (!next.has(k)) removed.push(k);
  return { added, removed, modified };
}

/**
 * Acceptance gate for a fresh pull. Rejects an empty/short pull (server hiccup, layer emptied by an
 * editor mid-session) so a bad sync can never wipe the published network.
 */
export function gatePull(count: number, minCount: number, prevCount: number | null, maxDropPct = 15): string | null {
  if (count < minCount) return `only ${count} features (< floor ${minCount})`;
  if (prevCount != null && prevCount > 0) {
    const dropPct = ((prevCount - count) / prevCount) * 100;
    if (dropPct > maxDropPct) return `count fell ${prevCount} → ${count} (−${dropPct.toFixed(1)}% > ${maxDropPct}% guard)`;
  }
  return null;
}
