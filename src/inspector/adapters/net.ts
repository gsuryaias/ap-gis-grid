// The DISCOM distribution network — 33/11 kV SS, 33 kV feeder runs, 11 kV feeders, transformers
// and section offices. Absorbs the old NetworkTracePanel (attributes + inferred supply path) and
// the DISCOM tap popup (every attribute, the TRANSCO source as a link).
import type { Feature } from "geojson";
import type { ConnectivityIndex } from "../../data/connectivity.ts";
import { NET_KIND_LABEL, type Chain, type NetItem, type NetKind } from "../../data/network-search.ts";
import { DISCOM_NAME, fieldLabel, type DiscomId } from "../../overlays/catalog.ts";
import { NET_LAYER, netKindOf } from "../refs.ts";
import type { Adapter, FieldRow, InspectorCtx, LinkRow, Locate, Section, TraceLevel } from "../types.ts";
import { display, locateGeometry, oneFeature } from "./util.ts";

export interface NetEntity {
  ref: string;
  kind: NetKind;
  /** The overlay layer this asset is drawn on (null for sections). */
  layer: string | null;
  /** Overlay feature, once that layer has loaded. */
  feature: Feature | null;
  /** Search-index item (label, trace chain, DTR attributes), once resolved. */
  item: NetItem | null;
  /** What it feeds: a 33 kV feeder's 33/11 kV SS, a 33/11 kV SS's 11 kV feeders (null = still loading / n/a). */
  down: LinkRow[] | null;
}

/** The 33/11 kV substations a 33 kV feeder serves (the connectivity index — the TRANSCO SS view's source). */
export function servedBy33(ref: string, transcoSsId: string | undefined, conn: Pick<ConnectivityIndex, "bySs" | "ss">): LinkRow[] {
  const tuples = (transcoSsId && conn.bySs[transcoSsId]) || Object.values(conn.bySs).flat();
  const t = tuples.find((x) => x[0] === ref) ?? Object.values(conn.bySs).flat().find((x) => x[0] === ref);
  return (t?.[5] ?? [])
    .map((id): LinkRow => ({ ref: id, label: conn.ss[id]?.[0] ?? id, meta: conn.ss[id]?.[1], icon: "ss" }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function downOf(kind: NetKind, ref: string, feature: Feature | null, ctx: Pick<InspectorCtx, "conn" | "netBelow">): LinkRow[] | null {
  if (kind === "f33") return ctx.conn ? servedBy33(ref, feature?.properties?.transcoSsId as string | undefined, ctx.conn) : null;
  if (kind === "ss33") return ctx.netBelow ? ctx.netBelow.map((i) => ({ ref: i.ref, label: i.label, meta: i.sub.split(" · ").at(-1), icon: "line" as const })) : null;
  return null;
}

export const LINK_LABEL: Record<string, string> = {
  recorded: "recorded SS id",
  name: "recorded source SS (name match)",
  proximity: "feeder end at the SS (≤ 1.5 km, inferred)",
  "feeder-group": "another run of the same feeder",
};

const SKIP = new Set(["name", "id", "kind", "lng", "lat", "transcoSsId", "ssId"]);
// Connectivity first — it's what ties the DISCOM network to the TRANSCO grid.
const PRIORITY = ["discom", "code", "transcoSs", "linkMethod", "sourceSs", "ss", "feeders", "nearestTranscoSs", "servesSsCount", "servesSs"];
const rank = (k: string) => (PRIORITY.includes(k) ? PRIORITY.indexOf(k) : PRIORITY.length);

/** Every attribute of an overlay feature, connectivity first; the TRANSCO source links back to the grid. */
export function propertyRows(p: Record<string, unknown>, limit = 24): FieldRow[] {
  return Object.entries(p)
    .filter(([k]) => !SKIP.has(k))
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .flatMap(([k, v]): FieldRow[] => {
      const value =
        k === "discom" ? `${v} — ${DISCOM_NAME[v as DiscomId] ?? ""}`.replace(/ — $/, "") : k === "linkMethod" ? (LINK_LABEL[String(v)] ?? display(k, v)) : display(k, v);
      if (value == null) return [];
      const ref = k === "transcoSs" && typeof p.transcoSsId === "string" ? p.transcoSsId : k === "ss" && typeof p.ssId === "string" ? p.ssId : undefined;
      return [{ label: fieldLabel(k), value, ref }];
    })
    .slice(0, limit);
}

function chainOf(e: NetEntity): Chain | null {
  if (e.item?.chain) return e.item.chain;
  const p = e.feature?.properties;
  if (!p) return null;
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : null);
  return [s("ssId"), s("ss"), null, null, s("transcoSsId"), s("transcoSs")];
}

/** Inferred supply path TRANSCO SS → 33 kV feeder → 33/11 kV SS → 11 kV feeder → transformer. */
export function traceLevels(e: NetEntity): TraceLevel[] {
  if (e.kind === "sec") return [];
  const c = chainOf(e);
  const name = e.item?.label ?? (e.feature?.properties?.name as string | undefined) ?? null;
  const levels: TraceLevel[] = [
    { label: "TRANSCO substation", name: c?.[5] ?? null, ref: c?.[4] ?? null },
    { label: "33 kV feeder", name: e.kind === "f33" ? (c?.[3] ?? name) : (c?.[3] ?? null), ref: e.kind === "f33" ? null : (c?.[2] ?? null), here: e.kind === "f33" },
    { label: "33/11 kV substation", name: e.kind === "ss33" ? (c?.[1] ?? name) : (c?.[1] ?? null), ref: e.kind === "ss33" ? null : (c?.[0] ?? null), here: e.kind === "ss33" },
  ];
  const n = (x: number, one: string, many: string) => `${x.toLocaleString("en-IN")} ${x === 1 ? one : many}`;
  if (e.kind === "f33") {
    const out = levels.slice(0, 2);
    if (e.down) out.push({ label: "33/11 kV substations", name: e.down.length ? n(e.down.length, "served", "served") : null, below: true });
    return out;
  }
  if (e.kind === "ss33") {
    if (e.down) levels.push({ label: "11 kV feeders", name: e.down.length ? n(e.down.length, "feeder", "feeders") : null, below: true });
    return levels;
  }
  if (e.kind === "f11") {
    levels.push({ label: "11 kV feeder", name, here: true });
    const p = e.feature?.properties;
    const dtrs = typeof p?.dtrs === "number" ? p.dtrs : null;
    const kva = typeof p?.dtrKva === "number" ? p.dtrKva : null;
    if (e.feature) levels.push({ label: "Transformers", name: dtrs ? `${n(dtrs, "transformer", "transformers")}${kva ? ` · ${kva.toLocaleString("en-IN")} kVA` : ""}` : null, below: true });
  }
  if (e.kind === "dtr") {
    levels.push({ label: "11 kV feeder", name: e.item?.dtr?.feederName ?? null, ref: e.item?.dtr?.feederId ?? null });
    levels.push({ label: "Transformer", name, here: true });
  }
  return levels;
}

const ZOOM: Record<NetKind, number> = { ss33: 14, f33: 13, f11: 13, dtr: 16.5, sec: 12 };

export const netAdapter: Adapter<NetEntity> = {
  kind: "net",
  // Its own feature row (a sidecar shard when tiled) — never the whole layer. Transformers and
  // sections have no feature: the search item carries them (the 11 kV layer is shown for context).
  needs: (ref) => {
    const k = netKindOf(ref);
    return {
      layer: k ? NET_LAYER[k] : null,
      ...(k && k !== "dtr" && k !== "sec" ? { row: true } : {}),
      net: true,
      ...(k === "ss33" ? { below: true } : {}),
      ...(k === "f33" ? { conn: true } : {}),
    };
  },
  resolve: (ref, ctx) => {
    const kind = netKindOf(ref);
    if (!kind) return null;
    const layer = NET_LAYER[kind];
    const feature = (layer && kind !== "dtr" ? ctx.row : null) ?? null;
    const item = ctx.netItem ?? null;
    if (!feature && !item) return null;
    return { ref, kind, layer, feature, item, down: downOf(kind, ref, feature, ctx) };
  },
  header: (e) => {
    const p = e.feature?.properties ?? {};
    const discom = (p.discom as string | undefined) ?? e.item?.dtr?.discom;
    return {
      kicker: [NET_KIND_LABEL[e.kind], discom].filter(Boolean).join(" · "),
      title: e.item?.label ?? (p.name as string | undefined) ?? `Unnamed ${NET_KIND_LABEL[e.kind]}`,
      sub: e.item?.sub,
      icon: e.kind === "f33" || e.kind === "f11" ? "line" : e.kind === "sec" ? "area" : "point",
    };
  },
  sections: (e) => {
    const rows: FieldRow[] = e.item?.dtr
      ? Object.entries(e.item.dtr.attrs).map(([k, v]) => ({ label: k, value: String(v) }))
      : e.feature?.properties
        ? propertyRows(e.feature.properties)
        : [];
    const levels = traceLevels(e);
    return [
      { id: "overview", kind: "fields", rows },
      ...(levels.length ? [{ id: "trace", kind: "trace" as const, title: "Supply path", method: "trace" as const, levels }] : []),
      ...downSection(e),
      {
        id: "provenance",
        kind: "note",
        text:
          "Links are inferred from the DISCOM GIS (recorded ids / names, else geometry). Coverage is partial: APEPDCL is complete, " +
          "APSPDCL 11 kV routes from its pole survey (Kadapa partial), APCPDCL 11 kV not published. HT consumer services and individual poles are deliberately not shown.",
      },
    ];
  },
  locate: (e): Locate | null => {
    const fromFeature = locateGeometry(e.feature?.geometry, ZOOM[e.kind], ZOOM[e.kind]);
    if (fromFeature) return fromFeature;
    return e.item ? { center: [e.item.lng, e.item.lat], zoom: ZOOM[e.kind] } : null;
  },
  focus: (e) => {
    const p = e.feature?.properties;
    const pt: [number, number] | null =
      e.kind === "dtr" || e.kind === "ss33"
        ? e.item
          ? [e.item.lng, e.item.lat]
          : typeof p?.lng === "number" && typeof p?.lat === "number"
            ? [p.lng, p.lat]
            : null
        : null;
    return {
      lines: e.kind === "f33" ? [e.ref] : [],
      // What it feeds lights up with it: a 33 kV feeder's substations, a substation's 11 kV feeders.
      ss: e.kind === "ss33" ? [e.ref] : e.kind === "f33" ? (e.down ?? []).map((d) => d.ref) : [],
      lines11:
        e.kind === "f11" ? [e.ref] : e.kind === "dtr" && e.item?.dtr?.feederId ? [e.item.dtr.feederId] : e.kind === "ss33" ? (e.down ?? []).map((d) => d.ref) : [],
      point: pt,
    };
  },
  geojson: (e) => oneFeature(e.feature ?? undefined),
};

/** "Feeds" — the next level down, as links (also lit amber on the map while inspected). */
function downSection(e: NetEntity): Section[] {
  if (e.kind !== "f33" && e.kind !== "ss33") return [];
  const title = e.kind === "f33" ? "Feeds · 33/11 kV substations" : "Feeds · 11 kV feeders";
  if (!e.down) return [{ id: "downstream", kind: "note", text: "Loading what it feeds…" }];
  return [
    {
      id: "downstream",
      kind: "links",
      title: e.down.length ? `${title} · ${e.down.length.toLocaleString("en-IN")}` : title,
      aside: "(highlighted on the map)",
      items: e.down,
      empty: e.kind === "f33" ? "No 33/11 kV substation is traced on this feeder." : "No 11 kV feeder is traced to this substation (APCPDCL publishes none).",
    },
  ];
}
