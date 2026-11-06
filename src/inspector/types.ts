// The unified Inspector (Atlas 2.0 phase 2). One panel for every selectable thing — TRANSCO SS /
// lines, plants, power-grid classes, DISCOM 33/11 kV SS + feeders, 11 kV feeders, transformers,
// towers and RTGS reference features. Each kind is an ADAPTER that turns a selection ref into a
// header + a list of SECTIONS. Sections are plain data (fields / links / trace / callout / note),
// so they are unit-testable; `custom` is the escape hatch for live widgets (downstream 33 kV
// network, tower summary, spot weather, MIS supply box).
import type { ReactNode } from "react";
import type { FeatureCollection } from "geojson";
import type { MethodId } from "../content/methods.ts";
import type { NetItem } from "../data/network-search.ts";
import type { GenerationData, GridData, PowerGridData, Voltage } from "../data/types.ts";
import type { WeatherData } from "../data/weather.ts";
import type { OverlayDef } from "../overlays/catalog.ts";
import type { OverlayFocus } from "../state/types.ts";
import type { RefKind } from "./refs.ts";

export type SectionId =
  | "overview"
  | "risk"
  | "weather"
  | "supply"
  | "connectivity"
  | "trace"
  | "downstream"
  | "towers"
  | "provenance"
  | (string & {});

export type Tone = "warn" | "bad" | "info";

export interface FieldRow {
  label: string;
  value: string;
  /** Second line under the value (muted). */
  sub?: string;
  /** Explanation behind an ⓘ popover (works on touch). */
  hint?: string;
  /** A derived figure: an "Indicative" chip opens its method card. */
  method?: MethodId;
  tone?: Tone;
  /** Makes the value a link that selects this ref. */
  ref?: string;
}

export interface LinkRow {
  ref: string;
  label: string;
  meta?: string;
  voltage?: Voltage;
  icon?: "line" | "ss";
  /** Small red marker (e.g. a bridge line). */
  flag?: string;
}

export interface TraceLevel {
  label: string;
  name: string | null;
  ref?: string | null;
  here?: boolean;
}

export interface Action {
  label: string;
  run: () => void;
}

interface Base {
  id: SectionId;
  title?: string;
  /** Muted aside after the title, e.g. "(spatially inferred)". */
  aside?: string;
  /** The section is derived: an "Indicative" chip by its title opens the method card. */
  method?: MethodId;
}

export type Section =
  | (Base & { kind: "fields"; rows: FieldRow[] })
  | (Base & { kind: "links"; items: LinkRow[]; empty?: string })
  | (Base & { kind: "trace"; levels: TraceLevel[] })
  | (Base & { kind: "callout"; tone: Tone; text: string; action?: Action })
  | (Base & { kind: "note"; text: string })
  | (Base & { kind: "custom"; render: () => ReactNode });

export type Badge = { voltage: Voltage } | { text: string; color: string };

export interface Header {
  kicker: string;
  title: string;
  /** One muted line under the title. */
  sub?: string;
  badge?: Badge;
  icon: "ss" | "line" | "plant" | "tower" | "point" | "area";
}

/** Where the camera should go for an entity. */
export type Locate = { center: [number, number]; zoom: number } | { bounds: [[number, number], [number, number]]; maxZoom: number };

/** Everything an adapter may read — already loaded; adapters never fetch. */
export interface InspectorCtx {
  data: GridData;
  gen?: GenerationData;
  pg?: PowerGridData;
  weather?: WeatherData;
  /** Loaded overlay features by overlay id (undefined while loading / off). */
  overlay: (id: string) => FeatureCollection | undefined;
  overlayDef: (id: string) => OverlayDef | undefined;
  /** The distribution-network search item for this ref, once resolved (net refs only). */
  netItem?: NetItem | null;
  year: number;
}

/** What an adapter needs loaded before it can resolve a ref. */
export interface Needs {
  /** An overlay layer's features (also switched on so the feature is visible). */
  overlay?: string | null;
  /** The distribution-network search item (trace chain) — resolved in the search worker. */
  net?: boolean;
  /** The generation / power-grid overlay data (a deep-linked plant works without the layer on). */
  gen?: boolean;
  pg?: boolean;
}

export interface Adapter<E = unknown> {
  kind: RefKind;
  needs?: (ref: string) => Needs;
  /** null = not (yet) resolvable with what `ctx` holds. */
  resolve: (ref: string, ctx: InspectorCtx) => E | null;
  header: (e: E, ctx: InspectorCtx) => Header;
  sections: (e: E, ctx: InspectorCtx) => Section[];
  locate?: (e: E, ctx: InspectorCtx) => Locate | null;
  /** Amber highlight on the DISCOM overlays while this entity is inspected. */
  focus?: (e: E, ctx: InspectorCtx) => OverlayFocus | null;
  /** The feature as GeoJSON (download button). */
  geojson?: (e: E, ctx: InspectorCtx) => FeatureCollection | null;
  /** Offer the connection spotlight (core grid only). */
  spotlight?: boolean;
}

/** A resolved selection, ready to render. */
export interface Inspected {
  ref: string;
  kind: RefKind;
  entity: unknown;
  header: Header;
  sections: Section[];
  locate: Locate | null;
  focus: OverlayFocus | null;
  geojson: (() => FeatureCollection | null) | null;
  spotlight: boolean;
}

/** Workspace-specific sections: a section with an existing id replaces it, others follow the overview. */
export type InspectorExtension = (ins: Inspected) => Section[];
