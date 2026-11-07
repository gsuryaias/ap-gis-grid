// The layer catalogue (Atlas 2.0 phase 3, PR 9): ONE list of every layer switch the map has, for the
// Layers drawer, its search and the map legend. Pure — built from the overlay defs (static DISCOM /
// tower defs + the RTGS catalogue once loaded) plus the built-in layers (core grid, generation, power
// grid, weather). An entry's `id` is its layer token (`lenses/registry.ts`): `ss` / `ln` / `gen` /
// `pg` / `wx` or an overlay id — so on / off, solo and the URL `lyr` key all speak the same ids.
import type { LiveStatus } from "../data/live-status.ts";
import { formatBytes, type OverlayDef } from "../overlays/catalog.ts";

export type CatGroup =
  | "Transmission"
  | "Distribution"
  | "Generation & interfaces"
  | "Weather & hazards"
  | "Boundaries"
  | "Transport"
  | "Environment"
  | "Water";

export const CAT_GROUPS: CatGroup[] = [
  "Transmission",
  "Distribution",
  "Generation & interfaces",
  "Weather & hazards",
  "Boundaries",
  "Transport",
  "Environment",
  "Water",
];

export interface Swatch {
  shape: "point" | "line" | "polygon" | "raster";
  color: string;
  dash?: boolean;
  /** Polygon fill shown (else outline only). */
  fill?: boolean;
}

export interface CatEntry {
  id: string;
  group: CatGroup;
  label: string;
  swatch: Swatch;
  /** Drawn from this zoom (undefined = always). */
  minzoom?: number;
  /** File size (raw bytes, like the RTGS catalogue); 0 = not shown. */
  bytes: number;
  /** Drawn from vector tiles in this build — only what's on screen downloads (size not shown). */
  tiled?: boolean;
  /** Feature count when known (0 = unknown / not shown). */
  count: number;
  source: string;
  vintage: string | null;
  note: string | null;
  /** Extra search words (synonyms, acronyms). */
  keywords: string[];
  /** Supports the opacity slider (catalog overlays + radar). */
  opacity: boolean;
}

/** The layers that are not catalog overlays. */
export const BUILTIN_ENTRIES: CatEntry[] = [
  {
    id: "ln",
    group: "Transmission",
    label: "Transmission lines",
    swatch: { shape: "line", color: "#0072b2" },
    bytes: 3_243_785,
    count: 0,
    source: "AP-TRANSCO enterprise GIS (live)",
    vintage: null,
    note: "400 / 220 / 132 kV, one row per circuit. Always loaded.",
    keywords: ["grid", "core", "circuit", "400", "220", "132", "kv", "transco"],
    opacity: false,
  },
  {
    id: "ss",
    group: "Transmission",
    label: "Substations",
    swatch: { shape: "point", color: "#0072b2" },
    bytes: 198_146,
    count: 0,
    source: "AP-TRANSCO enterprise GIS (live)",
    vintage: null,
    note: "TRANSCO EHT substations. Always loaded.",
    keywords: ["grid", "core", "ss", "eht", "transco"],
    opacity: false,
  },
  {
    id: "gen",
    group: "Generation & interfaces",
    label: "Generation plants",
    swatch: { shape: "point", color: "#e69f00" },
    bytes: 20_241,
    count: 0,
    source: "AP-TRANSCO enterprise GIS — generation layer (live)",
    vintage: null,
    note: "Solar, wind, thermal, gas, hydro — coloured by energy type.",
    keywords: ["power plant", "solar", "wind", "thermal", "hydro", "gas", "energy", "generator"],
    opacity: false,
  },
  {
    id: "pg",
    group: "Generation & interfaces",
    label: "POWERGRID, railway & HT substations",
    swatch: { shape: "point", color: "#e11d48" },
    bytes: 428_009 + 7_159 + 21_936 + 47_549,
    count: 0,
    source: "AP-TRANSCO Gridmap shapefiles",
    vintage: null,
    note: "PGCIL 765 / 400 kV inter-state grid, railway traction and bulk-load HT consumer substations.",
    keywords: ["pgcil", "inter-state", "765", "railway", "traction", "rtss", "bulk", "ht", "other networks"],
    opacity: false,
  },
  {
    id: "wx",
    group: "Weather & hazards",
    label: "Live weather — radar & cyclones",
    swatch: { shape: "raster", color: "#58c4f0" },
    bytes: 0,
    count: 0,
    source: "RainViewer (radar) · GDACS (cyclones) · Open-Meteo",
    vintage: "live",
    note: "Indicative third-party model output — verify against IMD advisories.",
    keywords: ["rain", "radar", "cyclone", "storm", "forecast", "cone", "track", "gdacs"],
    opacity: true,
  },
];

const GROUP_OF: Record<OverlayDef["group"], CatGroup> = {
  Transmission: "Transmission",
  Distribution: "Distribution",
  Boundaries: "Boundaries",
  Transport: "Transport",
  Environment: "Environment",
  Water: "Water",
  Hazards: "Weather & hazards",
};

/** Raw sizes of the static overlays (checked against public/data by catalogue.test.ts). */
export const STATIC_OVERLAY_BYTES: Record<string, number> = {
  "towers-400kv": 1_364_322,
  "towers-220kv": 3_917_400,
  "towers-132kv": 5_164_955,
  "discom-lines": 3_958_199,
  "discom-ss": 1_734_896,
  "discom-11kv-lines": 34_773_910,
};

const KEYWORDS: Record<string, string[]> = {
  "discom-lines": ["33 kv", "feeder", "discom", "apspdcl", "apepdcl", "apcpdcl", "distribution"],
  "discom-ss": ["33/11", "substation", "discom", "distribution"],
  "discom-11kv-lines": ["11 kv", "feeder", "dtr", "transformer", "discom"],
  "towers-400kv": ["tower", "pylon", "structure"],
  "towers-220kv": ["tower", "pylon", "structure"],
  "towers-132kv": ["tower", "pylon", "structure"],
  "crz-boundary": ["coastal regulation zone", "crz"],
  "flood-2024-09-03": ["flood", "inundation", "budameru"],
  "michaung-track": ["cyclone", "storm"],
  "cyclone-shelters": ["cyclone", "shelter", "evacuation"],
  "seismic-zones": ["earthquake"],
  "reserve-forest": ["forest", "row", "right of way"],
  forest: ["row", "right of way"],
  wildlife: ["sanctuary", "national park", "row"],
  "eco-sensitive": ["esz", "row"],
};

export function overlayEntry(def: OverlayDef): CatEntry {
  const swatchColor = def.style.color === "discom" ? "#c2410c" : def.style.color;
  return {
    id: def.id,
    group: GROUP_OF[def.group],
    label: def.label,
    swatch: {
      shape: def.geometry,
      color: swatchColor,
      dash: !!def.style.dash,
      fill: def.geometry === "polygon" && !!def.style.fillOpacity,
    },
    minzoom: def.style.minzoom,
    bytes: def.bytes || STATIC_OVERLAY_BYTES[def.id] || 0,
    count: def.count,
    source: def.source,
    vintage: def.vintage,
    note: def.note,
    keywords: KEYWORDS[def.id] ?? [],
    opacity: true,
  };
}

/** Every entry, in group order (built-ins first within their group, then catalog order). */
export function catalogueEntries(defs: Record<string, OverlayDef>): CatEntry[] {
  const all = [...BUILTIN_ENTRIES, ...Object.values(defs).map(overlayEntry)];
  return CAT_GROUPS.flatMap((g) => all.filter((e) => e.group === g));
}

/** Feature counts the live-sync status knows before a layer is ever loaded. */
export function withLiveCounts(entries: CatEntry[], live: LiveStatus | null | undefined): CatEntry[] {
  if (!live) return entries;
  const sum = (f: (x: { substations: number; lines: number }) => number) => Object.values(live.discom ?? {}).reduce((a, x) => a + f(x), 0);
  const counts: Record<string, number> = {
    "discom-lines": sum((x) => x.lines),
    "discom-ss": sum((x) => x.substations),
    "discom-11kv-lines": (live.network?.APEPDCL?.feeders ?? 0) + (live.network?.APSPDCL?.feeders ?? 0),
    ...Object.fromEntries(Object.entries(live.towers?.layers ?? {}).map(([id, t]) => [id, t.towers])),
  };
  return entries.map((e) => (counts[e.id] ? { ...e, count: counts[e.id] } : e));
}

/** Mark the entries this build draws from vector tiles (`public/tiles/index.json`). */
export function withTiles(entries: CatEntry[], tiled: Record<string, unknown> | null | undefined): CatEntry[] {
  if (!tiled || !Object.keys(tiled).length) return entries;
  return entries.map((e) => (tiled[e.id] ? { ...e, tiled: true } : e));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9/]+/g, " ").trim();

/** Every query word must appear in the label, group, keywords or source. */
export function matchesQuery(e: CatEntry, q: string): boolean {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length) return true;
  const hay = norm([e.label, e.group, e.source, ...e.keywords].join(" "));
  return words.every((w) => hay.includes(w));
}

/** Is the entry drawn at this zoom? */
export const inZoom = (e: Pick<CatEntry, "minzoom">, zoom: number | null | undefined): boolean =>
  e.minzoom == null || zoom == null || zoom >= e.minzoom;

/** "1,234 · 3.9 MB · from z9 · 2023" — the catalogue row's meta line. */
export function entryMeta(e: CatEntry): string {
  return [
    e.count ? e.count.toLocaleString("en-IN") : null,
    e.tiled ? "tiled" : formatBytes(e.bytes),
    e.minzoom != null && e.minzoom > 6 ? `from zoom ${e.minzoom}` : null,
    e.vintage && e.vintage !== "live" ? e.vintage : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
