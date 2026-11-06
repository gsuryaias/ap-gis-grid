// Selection refs — the one string key for "the feature the Inspector shows" (store `selectedId`,
// URL `sel=`). Pure. Core, generation and power-grid ids are bare (as in every v1 deep link), so
// are the DISCOM overlay ids (their prefixes are unique); everything without a stable id of its own
// gets a typed prefix:
//   s-…  l-…            core TRANSCO substation / line
//   g-…                 generation plant
//   pl-… ps-… rs-… bs-… POWERGRID line / SS, railway traction SS, bulk-load / HT SS
//   ds-… dl-… f11-…     DISCOM 33/11 kV SS, 33 kV feeder run, 11 kV feeder
//   dtr:<code>          distribution transformer (by its DTR code / serial)
//   sec:<label>         DISCOM section office
//   tw:<kv>:<index>     transmission tower (index into towers-<kv>kv.json — stable per data build)
//   ref:<layer>:<index> RTGS reference-layer feature (index into its GeoJSON)
import type { NetItem, NetKind } from "../data/network-search.ts";

export type RefKind =
  | "core-ss"
  | "core-line"
  | "plant"
  | "pg-line"
  | "pg-ss"
  | "rail-ss"
  | "bulk-ss"
  | "net"
  | "tower"
  | "ref";

const PREFIX: Array<[string, RefKind]> = [
  ["s-", "core-ss"],
  ["l-", "core-line"],
  ["g-", "plant"],
  ["pl-", "pg-line"],
  ["ps-", "pg-ss"],
  ["rs-", "rail-ss"],
  ["bs-", "bulk-ss"],
  ["ds-", "net"],
  ["dl-", "net"],
  ["f11-", "net"],
  ["dtr:", "net"],
  ["sec:", "net"],
  ["tw:", "tower"],
  ["ref:", "ref"],
];

export function refKind(ref: string): RefKind | null {
  for (const [p, k] of PREFIX) if (ref.startsWith(p) && ref.length > p.length) return k;
  return null;
}

/** Distribution-network kind of a `net` ref. */
export function netKindOf(ref: string): NetKind | null {
  if (ref.startsWith("ds-")) return "ss33";
  if (ref.startsWith("dl-")) return "f33";
  if (ref.startsWith("f11-")) return "f11";
  if (ref.startsWith("dtr:")) return "dtr";
  if (ref.startsWith("sec:")) return "sec";
  return null;
}

/** The overlay layer a distribution-network kind is drawn on (sections have none). */
export const NET_LAYER: Record<NetKind, string | null> = {
  ss33: "discom-ss",
  f33: "discom-lines",
  f11: "discom-11kv-lines",
  dtr: "discom-11kv-lines",
  sec: null,
};

/** The ref of a network search item (DTRs and sections have no overlay feature id). */
export function netRef(item: Pick<NetItem, "kind" | "ref" | "label">): string {
  if (item.ref) return item.ref;
  return item.kind === "dtr" ? `dtr:${item.label}` : `sec:${item.label}`;
}

export const towerRef = (layerId: string, index: number): string => `tw:${layerId.replace(/^towers-|kv$/g, "")}:${index}`;

export function parseTowerRef(ref: string): { layer: string; index: number } | null {
  const m = /^tw:(\d+):(\d+)$/.exec(ref);
  return m ? { layer: `towers-${m[1]}kv`, index: Number(m[2]) } : null;
}

export const refFeatureRef = (layerId: string, index: number): string => `ref:${layerId}:${index}`;

export function parseRefFeature(ref: string): { layer: string; index: number } | null {
  const m = /^ref:([a-z0-9-]+):(\d+)$/.exec(ref);
  return m ? { layer: m[1], index: Number(m[2]) } : null;
}

/** Shape check for refs arriving from a URL (anything else is ignored, not selected). */
export const isValidRef = (ref: string): boolean =>
  ref.length <= 160 && refKind(ref) != null && !/[<>"]/.test(ref) && (ref.startsWith("sec:") || !/\s/.test(ref));
