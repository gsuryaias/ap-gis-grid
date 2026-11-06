// Omnisearch (Atlas 2.0 phase 3, PR 10) — ONE engine behind the header search and ⌘K. Pure:
//   static hits  — TRANSCO SS + lines, generation plants, POWERGRID / railway / HT substations,
//                  circles / zones / divisions (drill into Plan), layers, actions, lenses —
//                  indexed here on the main thread (small);
//   worker hits  — DISTRIBUTION network (33 / 11 kV, DTR codes) and places — come from the
//                  search worker (`data/search-client.ts`) and are merged in by `mergeHits`.
// Groups are ordered by their best match, so "towers" lists the Layers group first and
// "vijayawada" the substations. What a hit does is data (`OmniTarget`); `search/run.ts` runs it.
import { NET_KIND_LABEL, type NetItem } from "../data/network-search.ts";
import type { SearchHits } from "../data/search-core.ts";
import type { GenerationData, GridData, PlaceItem, PowerGridData, Voltage } from "../data/types.ts";
import { matchesQuery, type CatEntry } from "../layers/catalogue.ts";
import { GLOSSARY } from "../content/glossary.ts";
import { LENSES, type LensId } from "../lenses/registry.ts";

export type OmniGroup = "Assets" | "Distribution" | "Areas" | "Places" | "Layers" | "Glossary" | "Actions" | "Lenses";
export const GROUP_ORDER: OmniGroup[] = ["Assets", "Distribution", "Areas", "Places", "Layers", "Glossary", "Actions", "Lenses"];

export type ActionId =
  | "copy-link"
  | "base-light"
  | "base-dark"
  | "base-satellite"
  | "table"
  | "export-ss"
  | "export-lines"
  | "summary"
  | "weather"
  | "quality"
  | "layers"
  | "clear-filters"
  | "near-me"
  | "glossary"
  | "shortcuts"
  | "about";

export type OmniTarget =
  | { t: "select"; ref: string }
  | { t: "net"; item: NetItem }
  | { t: "place"; item: PlaceItem }
  | { t: "area"; dim: "circle" | "zone" | "division"; value: string }
  | { t: "layer"; id: string }
  | { t: "action"; id: ActionId }
  | { t: "lens"; id: LensId }
  | { t: "glossary"; id: string };

export interface OmniHit {
  key: string;
  group: OmniGroup;
  label: string;
  sub?: string;
  /** Short type tag shown before the label ("SS", "Line", "Plant", "33 kV feeder"…). */
  tag?: string;
  voltage?: Voltage;
  target: OmniTarget;
  /** 0 exact · 1 prefix · 2 word-prefix · 3 substring · 4 keyword (lower = better). */
  rank: number;
}

interface IndexEntry {
  hit: Omit<OmniHit, "rank">;
  /** Lower-cased primary text (ranked 0–3). */
  text: string;
  /** Lower-cased secondary words (a hit there ranks 4). */
  extra: string;
}

export interface ActionDef {
  id: ActionId;
  label: string;
  keywords: string;
  /** Only offered in a map lens (the data table is a map-lens sheet). */
  mapOnly?: boolean;
}

export const ACTIONS: ActionDef[] = [
  { id: "copy-link", label: "Copy link to this view", keywords: "share url permalink" },
  { id: "base-light", label: "Light basemap", keywords: "map style theme day" },
  { id: "base-dark", label: "Dark basemap", keywords: "map style theme night" },
  { id: "base-satellite", label: "Satellite basemap", keywords: "imagery aerial photo" },
  { id: "table", label: "Open the data table", keywords: "list rows browse substations lines", mapOnly: true },
  { id: "export-ss", label: "Export substations (CSV)", keywords: "download csv excel spreadsheet" },
  { id: "export-lines", label: "Export lines (CSV)", keywords: "download csv excel spreadsheet circuits" },
  { id: "summary", label: "Network summary", keywords: "statistics km counts resilience dashboard" },
  { id: "weather", label: "Weather monitor", keywords: "cyclone rain wind forecast storm" },
  { id: "quality", label: "Data quality", keywords: "coverage method sources accuracy" },
  { id: "layers", label: "Open the layers drawer", keywords: "legend overlays basemap opacity" },
  { id: "clear-filters", label: "Clear filters", keywords: "reset voltage circle coast all" },
  { id: "near-me", label: "Substations near me", keywords: "locate gps nearest closest location" },
  { id: "glossary", label: "Glossary", keywords: "terms definitions meaning jargon help" },
  { id: "shortcuts", label: "Keyboard shortcuts", keywords: "keys hotkeys help" },
  { id: "about", label: "About & sources", keywords: "attribution licence credits" },
];

/** 0 exact · 1 prefix · 2 word-prefix · 3 substring · 99 no match (`q` lower-cased). */
export function rankText(text: string, q: string): number {
  if (text === q) return 0;
  if (text.startsWith(q)) return 1;
  if (text.split(/[\s\-./(]+/).some((w) => w.startsWith(q))) return 2;
  if (text.includes(q)) return 3;
  return 99;
}

export interface StaticSources {
  data: GridData;
  gen?: GenerationData | null;
  pg?: PowerGridData | null;
}

/**
 * Short command-like labels (layers, actions, lenses): a whole-word hit counts as a prefix hit, so
 * "towers" lists the tower layers above a line whose long name mentions towers.
 */
function rankLabel(label: string, q: string): number {
  const t = label.toLowerCase();
  const r = rankText(t, q);
  return r === 2 && t.split(/[\s\-./(]+/).includes(q) ? 1 : r;
}

const safeValue = (v: string | null | undefined): v is string => !!v && !/[~,:]/.test(v);

/** The asset + area index (rebuilt when the grid / lazy overlay data change). */
export function buildIndex({ data, gen, pg }: StaticSources): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const it of data.searchIndex) {
    const f = data.byId.get(it.id);
    const code = f && "ssCode" in f && f.ssCode ? String(f.ssCode) : "";
    out.push({
      hit: {
        key: it.id,
        group: "Assets",
        label: it.name,
        sub: it.sub ?? undefined,
        tag: it.kind === "substation" ? "SS" : "Line",
        voltage: it.voltage,
        target: { t: "select", ref: it.id },
      },
      text: it.name.toLowerCase(),
      extra: code.toLowerCase(),
    });
  }
  for (const p of gen?.plants ?? []) {
    out.push({
      hit: { key: p.id, group: "Assets", label: p.name, sub: [p.energy, p.capacityMw ? `${p.capacityMw} MW` : null].filter(Boolean).join(" · "), tag: "Plant", target: { t: "select", ref: p.id } },
      text: p.name.toLowerCase(),
      extra: `${p.energy} plant generation`.toLowerCase(),
    });
  }
  if (pg) {
    const pgItems: { id: string; name: string; tag: string; sub: string }[] = [
      ...pg.substations.map((s) => ({ id: s.id, name: s.name, tag: "PGCIL SS", sub: s.voltage ? `${s.voltage} kV · POWERGRID` : "POWERGRID" })),
      ...pg.lines.map((l) => ({ id: l.id, name: l.name, tag: "PGCIL line", sub: l.voltage ? `${l.voltage} kV · POWERGRID` : "POWERGRID" })),
      ...pg.railway.map((s) => ({ id: s.id, name: s.name, tag: "Railway SS", sub: "Railway traction" })),
      ...pg.bulkload.map((s) => ({ id: s.id, name: s.name, tag: "HT SS", sub: "Bulk-load / HT consumer" })),
    ];
    for (const x of pgItems)
      out.push({ hit: { key: x.id, group: "Assets", label: x.name, sub: x.sub, tag: x.tag, target: { t: "select", ref: x.id } }, text: x.name.toLowerCase(), extra: x.tag.toLowerCase() });
  }
  // Areas: circle / zone / division → drill into Plan.
  const areas: Record<"circle" | "zone" | "division", Map<string, number>> = { circle: new Map(), zone: new Map(), division: new Map() };
  for (const s of data.substations) {
    for (const dim of ["circle", "zone", "division"] as const) {
      const v = s[dim];
      if (safeValue(v)) areas[dim].set(v, (areas[dim].get(v) ?? 0) + 1);
    }
  }
  const DIM_LABEL = { circle: "Circle", zone: "Zone", division: "Division" } as const;
  for (const dim of ["circle", "zone", "division"] as const) {
    for (const [v, n] of areas[dim]) {
      out.push({
        hit: { key: `${dim}:${v}`, group: "Areas", label: v, sub: `${DIM_LABEL[dim]} · ${n} SS — open in Plan`, tag: DIM_LABEL[dim], target: { t: "area", dim, value: v } },
        text: v.toLowerCase(),
        extra: dim,
      });
    }
  }
  return out;
}

const LIMITS: Record<OmniGroup, number> = { Assets: 8, Distribution: 10, Areas: 5, Places: 6, Layers: 5, Glossary: 3, Actions: 5, Lenses: 4 };

/** Static hits for a query (assets, areas, layers, actions, lenses), best first, capped per group. */
export function searchStatic(
  index: IndexEntry[],
  layers: CatEntry[],
  query: string,
  opts: { lens: LensId; layerOn: (id: string) => boolean },
): OmniHit[] {
  const q = query.trim().toLowerCase();
  const out: OmniHit[] = [];
  if (q.length >= 2) {
    for (const e of index) {
      let r = rankText(e.text, q);
      if (r === 99 && e.extra && rankText(e.extra, q) < 99) r = 4;
      if (r < 99) out.push({ ...e.hit, rank: r });
    }
  }
  if (q.length >= 2) {
    for (const l of layers) {
      const r = rankLabel(l.label, q);
      const rank = r < 99 ? r : matchesQuery(l, q) ? 4 : 99;
      if (rank < 99)
        out.push({
          key: `layer:${l.id}`,
          group: "Layers",
          label: l.label,
          sub: `${l.group} · ${opts.layerOn(l.id) ? "on — switch off" : "switch on"}`,
          tag: opts.layerOn(l.id) ? "On" : "Layer",
          target: { t: "layer", id: l.id },
          rank,
        });
    }
  }
  if (q.length >= 2) {
    for (const g of GLOSSARY) {
      const r = Math.min(rankLabel(g.term, q), ...(g.aka ?? []).map((a) => rankLabel(a, q)));
      if (r < 99) out.push({ key: `gl:${g.id}`, group: "Glossary", label: g.term, sub: g.text, tag: "Term", target: { t: "glossary", id: g.id }, rank: r });
    }
  }
  const mapLens = LENSES.find((l) => l.id === opts.lens)?.layout === "map";
  for (const a of ACTIONS) {
    if (a.mapOnly && !mapLens) continue;
    const r = q ? rankLabel(a.label, q) : 5;
    const rank = r < 99 ? r : q && a.keywords.split(" ").some((w) => w.startsWith(q)) ? 4 : 99;
    if (rank < 99) out.push({ key: `action:${a.id}`, group: "Actions", label: a.label, target: { t: "action", id: a.id }, rank });
  }
  for (const l of LENSES) {
    if (l.id === opts.lens) continue;
    const r = q ? rankLabel(`${l.label} lens`, q) : 5;
    const rank = r < 99 ? r : q && rankText(l.audience.toLowerCase(), q) < 99 ? 4 : 99;
    if (rank < 99) out.push({ key: `lens:${l.id}`, group: "Lenses", label: `${l.label} lens`, sub: l.audience, target: { t: "lens", id: l.id }, rank });
  }
  return out;
}

/** Worker hits (distribution network, DTR codes, places) as omni hits. */
export function workerHits(h: SearchHits, query: string): OmniHit[] {
  const q = query.trim().toLowerCase();
  const net = [...h.dtr, ...h.net].map(
    (n): OmniHit => ({
      key: `net:${n.kind}:${n.ref || n.label}:${n.lng}`,
      group: "Distribution",
      label: n.label,
      sub: n.sub,
      tag: NET_KIND_LABEL[n.kind],
      target: { t: "net", item: n },
      rank: rankText(n.label.toLowerCase(), q),
    }),
  );
  const places = h.places.map(
    (p): OmniHit => ({
      key: `place:${p.name}:${p.lng}:${p.lat}`,
      group: "Places",
      label: p.name,
      sub: p.district ? `${p.type} · ${p.district}` : p.type,
      tag: "Place",
      target: { t: "place", item: p },
      rank: rankText(p.name.toLowerCase(), q),
    }),
  );
  return [...net, ...places];
}

export interface OmniSection {
  group: OmniGroup;
  hits: OmniHit[];
}

/**
 * Group, cap and order: within a group by rank (stable, so source order breaks ties — e.g. higher
 * voltage first for assets); groups by their best rank, then the fixed group order.
 */
export function groupHits(hits: OmniHit[]): OmniSection[] {
  const by = new Map<OmniGroup, OmniHit[]>();
  for (const h of hits) (by.get(h.group) ?? by.set(h.group, []).get(h.group)!).push(h);
  const sections: OmniSection[] = [];
  for (const g of GROUP_ORDER) {
    const list = by.get(g);
    if (!list?.length) continue;
    const sorted = list
      .map((h, i) => ({ h, i }))
      .sort((a, b) => a.h.rank - b.h.rank || a.i - b.i)
      .map((x) => x.h);
    const seen = new Set<string>();
    sections.push({ group: g, hits: sorted.filter((h) => !seen.has(h.key) && seen.add(h.key)).slice(0, LIMITS[g]) });
  }
  return sections.sort((a, b) => a.hits[0].rank - b.hits[0].rank || GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
}

/** Notes shown under a group: the coverage caveats a searcher must not miss. */
export const GROUP_NOTE: Partial<Record<OmniGroup, string>> = {
  Distribution: "Inferred from the DISCOMs' open GIS — APSPDCL partial; APCPDCL publishes no 11 kV / transformer data.",
  Places: "GeoNames gazetteer — jumps the map and lists the nearest substations.",
  Areas: "Opens the Network MIS (Plan) scoped to the area.",
};
