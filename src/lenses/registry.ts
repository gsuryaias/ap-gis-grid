// Lens registry (Atlas 2.0 phase 3) — the single place a lens is declared. A lens is a preset over
// the ONE map: which layers it switches on, which side panel it shows and its "Start here" tips. It
// never hides anything — every layer stays reachable in every lens, and switching lens keeps the
// selection and the filters. Pure data (no React), so the URL codec and the store can use it; the
// panels live in `lenses/panels.tsx`.

export type LensId = "explore" | "field" | "plan" | "storm";

/** The layer switches a lens can preset — exactly the URL `lyr` vocabulary (`url/v2.ts`). */
export interface LayerOn {
  showSubstations: boolean;
  showLines: boolean;
  showGeneration: boolean;
  showPowerGrid: boolean;
  showWeather: boolean;
  /** Enabled catalog overlays (DISCOM / towers / RTGS ids), sorted. */
  overlays: string[];
}

export interface LensDef {
  id: LensId;
  label: string;
  /** Who it is for, in a few words (tab tooltip, panel header). */
  audience: string;
  description: string;
  /** `map`: lens panel beside the full map; `split`: a resizable map + analysis column (Plan). */
  layout: "map" | "split";
  /** Layers this lens switches on beyond the core grid (which every lens shows). */
  defaults: { gen?: boolean; pg?: boolean; wx?: boolean; overlays?: string[] };
  /** Desktop lens-panel width (px). */
  panelWidth: number;
  startHere: { title: string; tips: string[] };
}

export const LENSES: LensDef[] = [
  {
    id: "explore",
    label: "Explore",
    audience: "Everyone",
    description: "The reference map of the AP-TRANSCO network: find any asset, see how it connects, browse the data.",
    layout: "map",
    defaults: {},
    panelWidth: 300,
    startHere: {
      title: "Start here",
      tips: [
        "Search any substation, line, 33 / 11 kV feeder, transformer code or place.",
        "Tap the map — everything under your finger is listed; pick one to inspect it.",
        "Voltage, circle and coast filters apply to the map and the data table alike.",
      ],
    },
  },
  {
    id: "field",
    label: "Field",
    audience: "O&M on site",
    description: "Near me, towers and the 33 kV distribution network, and the trace from a transformer up to its TRANSCO substation.",
    layout: "map",
    // 11 kV feeders join once they are tiled (phase 4) — today they are a single 3 MB download.
    defaults: { overlays: ["discom-lines", "discom-ss", "towers-132kv", "towers-220kv", "towers-400kv"] },
    panelWidth: 300,
    startHere: {
      title: "In the field",
      tips: [
        "Near me lists the closest substations with distance and compass bearing.",
        "Search a DTR code or 11 kV feeder to trace it up to its TRANSCO substation.",
        "Towers appear from zoom 9 — tap one for its type and line. Satellite is in the Layers drawer.",
      ],
    },
  },
  {
    id: "plan",
    label: "Plan",
    audience: "Planners & management",
    description: "Network MIS — asset inventory, line age, N-1 exposure, radial feeds and 33 kV downstream load — drill down by circle, zone, division, voltage and more.",
    layout: "split",
    defaults: {},
    panelWidth: 0,
    startHere: {
      title: "Planning view",
      tips: [
        "Click any breakdown row to drill in; every number opens the records behind it.",
        "The map follows your scope — pick a map theme (radial feeds, age, N-1…) in the scope bar.",
        "Every table and drill-down exports to CSV.",
      ],
    },
  },
  {
    id: "storm",
    label: "Storm",
    audience: "Control room",
    description: "Live cyclone tracks, forecast cones and rain radar over the grid, with the substations inside the warning envelope.",
    layout: "map",
    defaults: { wx: true, overlays: ["crz-boundary", "cyclone-shelters"] },
    panelWidth: 360,
    startHere: {
      title: "Storm watch",
      tips: [
        "Rain radar, cyclone tracks and forecast cones are on; substations in the warning envelope (the cone, or the coast near the track) get an amber halo.",
        "The panel follows the exposure down the network: radial pockets and cut points, then the 33/11 kV substations behind them. Print briefing makes a one-page report.",
        "The CRZ line and cyclone shelters are on too — more hazards are in the layer list.",
        "All weather is third-party model output (indicative) — verify against IMD advisories.",
      ],
    },
  },
];

export const LENS_BY_ID = Object.fromEntries(LENSES.map((l) => [l.id, l])) as Record<LensId, LensDef>;

export const DEFAULT_LENS: LensId = "explore";

export function isLensId(v: unknown): v is LensId {
  return v === "explore" || v === "field" || v === "plan" || v === "storm";
}

// ---- layer tokens --------------------------------------------------------------------------------
// One token per switch: `ss` / `ln` (core grid), `gen` / `pg` / `wx`, and overlay ids.

const FLAG_TOKENS: [keyof Omit<LayerOn, "overlays">, string][] = [
  ["showGeneration", "gen"],
  ["showPowerGrid", "pg"],
  ["showWeather", "wx"],
  ["showSubstations", "ss"],
  ["showLines", "ln"],
];
const FLAG_SET = new Set(FLAG_TOKENS.map(([, t]) => t));

/** The tokens that are on. */
export function layerTokens(l: LayerOn): Set<string> {
  const out = new Set<string>(l.overlays);
  for (const [k, t] of FLAG_TOKENS) if (l[k]) out.add(t);
  return out;
}

export function fromTokens(on: Set<string>): LayerOn {
  const l = { overlays: [...on].filter((t) => !FLAG_SET.has(t)).sort() } as LayerOn;
  for (const [k, t] of FLAG_TOKENS) l[k] = on.has(t);
  return l;
}

/** What a lens shows by default: the core grid plus its own presets. */
export function lensDefaultTokens(id: LensId): Set<string> {
  const d = LENS_BY_ID[id].defaults;
  return new Set(["ss", "ln", ...(d.gen ? ["gen"] : []), ...(d.pg ? ["pg"] : []), ...(d.wx ? ["wx"] : []), ...(d.overlays ?? [])]);
}

export const lensDefaults = (id: LensId): LayerOn => fromTokens(lensDefaultTokens(id));

/**
 * Switching lens: the old lens's own defaults go off (unless the new lens wants them too), the new
 * lens's defaults come on, and anything the user added by hand stays.
 */
export function switchLensLayers(cur: LayerOn, from: LensId, to: LensId): LayerOn {
  if (from === to) return cur;
  const on = layerTokens(cur);
  const want = lensDefaultTokens(to);
  for (const t of lensDefaultTokens(from)) if (!want.has(t)) on.delete(t);
  for (const t of want) on.add(t);
  return fromTokens(on);
}

/** Overlays that are on only because the lens presets them — not a viewer's own choice to remember. */
export function lensOnlyOverlays(id: LensId): Set<string> {
  return new Set(LENS_BY_ID[id].defaults.overlays ?? []);
}

/**
 * The URL `lyr` value: what differs from the lens defaults — `token` = on although the lens doesn't
 * preset it, `-token` = a lens default switched off. `ref` maps an overlay id to its URL token
 * (RTGS layers are written `ref:<id>`). Empty string = exactly the lens defaults.
 */
export function encodeLayerDiff(l: LayerOn, lens: LensId, ref: (id: string) => string = (id) => id): string {
  const on = layerTokens(l);
  const def = lensDefaultTokens(lens);
  const tok = (t: string) => (FLAG_SET.has(t) ? t : ref(t));
  const order = (ts: string[]) => [
    ...["gen", "pg", "wx"].filter((t) => ts.includes(t)),
    ...ts.filter((t) => !FLAG_SET.has(t)).sort(),
    ...["ss", "ln"].filter((t) => ts.includes(t)),
  ];
  const plus = order([...on].filter((t) => !def.has(t))).map(tok);
  const minus = order([...def].filter((t) => !on.has(t))).map((t) => `-${tok(t)}`);
  return [...plus, ...minus].join(",");
}

/** Inverse of {@link encodeLayerDiff}; `norm` validates / un-prefixes an overlay token (null = drop). */
export function decodeLayerDiff(lyr: string, lens: LensId, norm: (t: string) => string | null = (t) => t): LayerOn {
  const on = lensDefaultTokens(lens);
  for (const raw of lyr.split(",").filter(Boolean)) {
    const off = raw.startsWith("-");
    const body = off ? raw.slice(1) : raw;
    const t = FLAG_SET.has(body) ? body : norm(body);
    if (!t) continue;
    if (off) on.delete(t);
    else on.add(t);
  }
  return fromTokens(on);
}
