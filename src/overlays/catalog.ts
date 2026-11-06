/**
 * Overlay catalog — the DISCOM 33 / 11 kV network and transmission towers (live-synced) + RTGS
 * reference layers (boundaries, transport, environment, water, hazards). The store facade is
 * `store.ts`, the map defs `map/registry/overlays.ts`, the UI the Layers drawer (`layers/`).
 * Everything is lazy — a layer's GeoJSON is fetched only when first switched on.
 */

export type OverlayGeometry = "polygon" | "line" | "point";
export type OverlayGroup = "Transmission" | "Distribution" | "Boundaries" | "Transport" | "Environment" | "Water" | "Hazards";

/** Shape of public/data/ref/catalog.json entries (written by scripts/build-ref-layers.mts). */
export interface RefCatalogEntry {
  id: string;
  group: Exclude<OverlayGroup, "Distribution" | "Transmission">;
  label: string;
  geometry: OverlayGeometry;
  file: string;
  count: number;
  bytes: number;
  labelField: string | null;
  fields: string[];
  source: string;
  vintage: string | null;
  note: string | null;
}

export interface OverlayStyle {
  color: string;
  /** Polygon fill opacity; 0 / undefined → outline only (boundaries — keeps the map clickable). */
  fillOpacity?: number;
  width?: number;
  dash?: number[];
  radius?: number;
  minzoom?: number;
  labelMinzoom?: number;
  /** Draw ABOVE the grid lines (just beneath substations) — towers sit on the lines. */
  aboveGrid?: boolean;
}

export interface OverlayDef extends Omit<RefCatalogEntry, "group"> {
  group: OverlayGroup;
  style: OverlayStyle;
  /** Non-GeoJSON payload decoded client-side (towers ship grouped by line). */
  format?: "towers";
}

/** Transmission towers — one lazy layer per voltage (towers-<kv>.json, see overlays/towers.ts). */
export const TOWER_VOLTAGES = [400, 220, 132] as const;
export const TOWER_DEFS: OverlayDef[] = TOWER_VOLTAGES.map((kv) => ({
  id: `towers-${kv}kv`,
  group: "Transmission",
  label: `${kv} kV towers`,
  geometry: "point",
  file: `towers-${kv}kv.json`,
  count: 0,
  bytes: 0,
  labelField: "no",
  fields: [],
  source: "AP-TRANSCO enterprise GIS — tower layers (live)",
  vintage: null,
  note: null,
  format: "towers",
  style: {
    color: kv === 400 ? "#d55e00" : kv === 220 ? "#0072b2" : "#009e73",
    radius: kv === 400 ? 3.4 : 3,
    minzoom: kv === 400 ? 8 : 9,
    labelMinzoom: 14,
    aboveGrid: true,
  },
}));

export const DISCOMS = ["APSPDCL", "APEPDCL", "APCPDCL"] as const;
export type DiscomId = (typeof DISCOMS)[number];

export const DISCOM_COLOR: Record<DiscomId, string> = {
  APSPDCL: "#c2410c", // orange-700
  APEPDCL: "#7e22ce", // purple-700
  APCPDCL: "#be185d", // pink-700
};

export const DISCOM_NAME: Record<DiscomId, string> = {
  APSPDCL: "Southern Power Distribution Co.",
  APEPDCL: "Eastern Power Distribution Co.",
  APCPDCL: "Central Power Distribution Co.",
};

/** The two DISCOM overlay layers (data-driven colour by `discom`; sub-filtered per DISCOM). */
export const DISCOM_DEFS: OverlayDef[] = [
  {
    id: "discom-lines",
    group: "Distribution",
    label: "33 kV lines",
    geometry: "line",
    file: "discom-lines.geojson",
    count: 0,
    bytes: 0,
    labelField: "name",
    fields: [],
    source: "AP-TRANSCO enterprise GIS — DISCOM layers (live)",
    vintage: null,
    note: null,
    style: { color: "discom", width: 1.1, minzoom: 6 },
  },
  {
    id: "discom-ss",
    group: "Distribution",
    label: "33/11 kV substations",
    geometry: "point",
    file: "discom-ss.geojson",
    count: 0,
    bytes: 0,
    labelField: "name",
    fields: [],
    source: "AP-TRANSCO enterprise GIS — DISCOM layers (live)",
    vintage: null,
    note: null,
    style: { color: "discom", radius: 3.2, minzoom: 6, labelMinzoom: 11 },
  },
];

/** DISCOM 11 kV feeders (live; APEPDCL full, APSPDCL partial, APCPDCL not on the open GIS). */
export const DISCOM11_DEF: OverlayDef = {
  id: "discom-11kv-lines",
  group: "Distribution",
  label: "11 kV feeders",
  geometry: "line",
  file: "discom-11kv-lines.geojson",
  count: 0,
  bytes: 20_100_000, // raw size, like the ref catalog (≈3.1 MB gz on the wire); whole file is parsed — tiling is Atlas 2.0 phase 4
  labelField: "name",
  fields: [],
  source: "AP-TRANSCO enterprise GIS — DISCOM 11 kV layers (live)",
  vintage: null,
  note: null,
  style: { color: "discom", width: 0.7, dash: [3, 1.5], minzoom: 10, labelMinzoom: 13 },
};

/** Per-layer cartography for the RTGS reference layers (unknown ids fall back to a group default). */
const REF_STYLE: Record<string, OverlayStyle> = {
  districts: { color: "#334155", width: 1.8, labelMinzoom: 6.5 },
  mandals: { color: "#64748b", width: 0.7, minzoom: 7.5, labelMinzoom: 10 },
  "revenue-divisions": { color: "#475569", width: 1.2, dash: [4, 2], labelMinzoom: 8 },
  assembly: { color: "#6d28d9", width: 1, dash: [3, 2], labelMinzoom: 9 },
  parliament: { color: "#9333ea", width: 1.6, labelMinzoom: 7.5 },
  municipal: { color: "#d97706", fillOpacity: 0.14, width: 0.8, labelMinzoom: 10 },
  "district-hq": { color: "#0f172a", radius: 4.5, labelMinzoom: 6.5 },
  "mandal-hq": { color: "#475569", radius: 2.6, minzoom: 8.5, labelMinzoom: 10.5 },
  "national-highways": { color: "#dc2626", width: 2 },
  "state-highways": { color: "#ea580c", width: 1.2, minzoom: 6.5 },
  railways: { color: "#1f2937", width: 1.4, dash: [3, 2] },
  "railway-stations": { color: "#374151", radius: 3, minzoom: 9, labelMinzoom: 11 },
  airports: { color: "#0284c7", radius: 6, labelMinzoom: 6 },
  seaports: { color: "#0e7490", radius: 6, labelMinzoom: 6 },
  "reserve-forest": { color: "#15803d", fillOpacity: 0.24, width: 0.5, labelMinzoom: 11 },
  forest: { color: "#166534", fillOpacity: 0.18, width: 0.5, labelMinzoom: 11 },
  wildlife: { color: "#4d7c0f", fillOpacity: 0.26, width: 1.2, labelMinzoom: 8 },
  "eco-sensitive": { color: "#65a30d", fillOpacity: 0.14, width: 1.2, dash: [2, 2], labelMinzoom: 8 },
  "crz-boundary": { color: "#0e7490", width: 1.2, dash: [2, 2] },
  mining: { color: "#a16207", radius: 2.6, minzoom: 7.5 },
  rivers: { color: "#0ea5e9", fillOpacity: 0.5, width: 0.4 },
  reservoirs: { color: "#0369a1", fillOpacity: 0.5, width: 0.4, labelMinzoom: 10 },
  canals: { color: "#38bdf8", width: 1, minzoom: 7 },
  "seismic-zones": { color: "#e11d48", fillOpacity: 0.08, width: 1.2, labelMinzoom: 6 },
  "cyclone-shelters": { color: "#db2777", radius: 3.5, minzoom: 7, labelMinzoom: 11 },
  "flood-2024-09-03": { color: "#1d4ed8", fillOpacity: 0.5, width: 0.4 },
  "michaung-track": { color: "#9f1239", width: 2.4, dash: [4, 2] },
};

const GROUP_DEFAULT: Record<OverlayGroup, string> = {
  Transmission: "#334155",
  Distribution: "#c2410c",
  Boundaries: "#475569",
  Transport: "#b91c1c",
  Environment: "#15803d",
  Water: "#0284c7",
  Hazards: "#be123c",
};

export const GROUP_ORDER: OverlayGroup[] = ["Boundaries", "Transport", "Environment", "Water", "Hazards"];

export function refDef(e: RefCatalogEntry): OverlayDef {
  const style = REF_STYLE[e.id] ?? {
    color: GROUP_DEFAULT[e.group] ?? "#475569",
    fillOpacity: e.geometry === "polygon" ? 0.15 : undefined,
    width: 1,
    radius: 3,
  };
  return { ...e, style };
}

/** "revenueDivision" → "Revenue division"; "areaSqKm" → "Area (km²)". */
export function fieldLabel(k: string): string {
  const special: Record<string, string> = {
    areaSqKm: "Area (km²)",
    extentHa: "Extent (ha)",
    lengthKm: "Length (km)",
    feedersIn: "Incoming feeders",
    feedersOut: "Outgoing feeders",
    ssType: "Type",
    urbanRural: "Urban / rural",
    discom: "DISCOM",
    code: "Code",
    transcoSs: "TRANSCO source (inferred)",
    linkMethod: "Linked by",
    sourceSs: "Recorded source SS",
    servesSsCount: "33/11 kV SS served",
    servesSs: "Serves",
    feeders: "On 33 kV feeder(s)",
    nearestTranscoSs: "Nearest TRANSCO SS",
    spans: "Spans / poles",
    ss: "33/11 kV SS",
    dtrs: "Distribution transformers",
    dtrKva: "Transformer capacity (kVA)",
    abSwitches: "AB switches",
    poles: "Poles",
    subdivision: "Sub-division",
  };
  if (special[k]) return special[k];
  const s = k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatBytes(n: number): string {
  if (!n) return "";
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`;
}
