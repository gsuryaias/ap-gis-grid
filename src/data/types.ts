import type { FeatureCollection } from "geojson";

export type Voltage = 400 | 220 | 132;
export type Circuit = "SC" | "DC";
export type Confidence = "high" | "medium" | "low";
export type EnergyType = "Solar" | "Wind" | "Thermal" | "Gas" | "Hydro" | "Other";

export const VOLTAGES: Voltage[] = [400, 220, 132];
export const CIRCUITS: Circuit[] = ["SC", "DC"];
/** Legend/display order for the generation energy mix. */
export const ENERGY_TYPES: EnergyType[] = ["Thermal", "Gas", "Hydro", "Solar", "Wind", "Other"];

export interface SnapRef {
  ssId: string;
  distM: number;
  confidence: Confidence;
}

export interface SubstationProps {
  id: string;
  kind: "substation";
  name: string;
  descriptiveName: string | null;
  ssCode: string | null;
  voltage: Voltage;
  circle: string | null;
  circleInferred: boolean;
  doc: string | null;
  lng: number;
  lat: number;
  connectedLineIds: string[];
  connectedLineCount: number;
  /** Operating zone (authoritative, from the Gridmap SS layer). Optional (added in the shapefile migration). */
  zone?: string | null;
  /** Operating division (authoritative, from the Gridmap SS layer). Optional. */
  division?: string | null;
  // ---- Optional fields added in the coastal-exposure milestone ----
  /** Indicative straight-line distance to the Bay-of-Bengal coast (Natural Earth coastline), km, 1 dp. */
  coastalKm?: number;
  /** Coastal-exposure band: 0 = <10 km, 1 = 10–25, 2 = 25–50, 3 = inland (≥50 km). */
  coastalBand?: 0 | 1 | 2 | 3;
}

export interface LineProps {
  id: string;
  kind: "line";
  name: string;
  voltage: Voltage;
  circuit: Circuit;
  lengthKm: number | null;
  ckm: number | null;
  circle: string | null;
  connectsSS: string[];
  endpointLabels: [string, string] | null;
  fromSS: SnapRef | null;
  toSS: SnapRef | null;
  circuitAmbiguous: boolean;
  voltageMismatch: boolean;
  // ---- Optional fields added in the Gridmap shapefile migration ----
  /** Raw source `circuit_ty` cell ("SC" | "DC" | "DC/SC" | "MC" …). */
  circuitType?: string | null;
  /** Conductor type (e.g. "Twin Moose"). */
  conductor?: string | null;
  /** Commissioning date as "Mon YYYY", or null. */
  commissioned?: string | null;
  /** Display-only non-TRANSCO endpoints (Generation/Railway/PowerGrid/HT consumer); not clickable. */
  externalEndpoints?: { name: string; category: string }[];
  // ---- Optional fields added in the coastal-exposure milestone ----
  /** Indicative straight-line distance to the Bay-of-Bengal coast (Natural Earth coastline), km, 1 dp — the MINIMUM over the line's vertices. */
  coastalKm?: number;
  /** Coastal-exposure band: 0 = <10 km, 1 = 10–25, 2 = 25–50, 3 = inland (≥50 km). */
  coastalBand?: 0 | 1 | 2 | 3;
}

/**
 * A generation plant. Lives in a separate, lazy-loaded overlay (`generation.geojson`) — not part
 * of the initial transmission payload. `voltage` is the interconnection voltage (reuses the grid
 * palette); `energy` drives the energy-mix colouring/legend.
 */
export interface GenerationProps {
  id: string;
  kind: "generation";
  name: string;
  descriptiveName: string | null;
  ssCode: string | null;
  energy: EnergyType;
  voltage: Voltage;
  circle: string | null;
  doc: string | null;
  capacityMw: number | null;
  lng: number;
  lat: number;
}

/**
 * A POWERGRID (PGCIL) national inter-state grid line. Lives in a separate, lazy-loaded overlay
 * (`powergrid-lines.geojson`). Voltages include 765 kV, so `voltage` is a plain number — NOT the
 * AP-TRANSCO 400|220|132 union. Connectivity to the AP-TRANSCO grid is not modelled.
 */
export interface PowerGridLineProps {
  id: string;
  kind: "pg-line";
  name: string;
  voltage: number;
  service: string | null;
  lengthKm: number | null;
}

/** A POWERGRID (PGCIL) substation (lazy overlay; `voltage` is a plain number, incl. 765 kV). */
export interface PowerGridSubstationProps {
  id: string;
  kind: "pg-substation";
  name: string;
  fullName: string | null;
  voltage: number;
  lng: number;
  lat: number;
}

/**
 * A railway-traction substation (RTSS). Rides inside the same lazy "Power grid" overlay group as
 * the PowerGrid features. `voltage` is a plain number (mostly 132/220 kV; 0 when the source value
 * is unparseable). A load off the AP-TRANSCO grid — connectivity is indicative, not modelled.
 */
export interface RailwaySubstationProps {
  id: string;
  kind: "rail-substation";
  name: string;
  displayName: string | null;
  voltage: number;
  connectedSs: string | null;
  mva: number | null;
  circle: string | null;
  district: string | null;
  lng: number;
  lat: number;
}

/** A bulk-load / HT-consumer substation (lazy "Power grid" overlay group; `voltage` is a plain number). */
export interface BulkLoadSubstationProps {
  id: string;
  kind: "bulk-substation";
  name: string;
  voltage: number;
  ssType: string | null;
  connectedSs: string | null;
  mva: number | null;
  circle: string | null;
  district: string | null;
  lng: number;
  lat: number;
}

export type PowerGridProps =
  | PowerGridLineProps
  | PowerGridSubstationProps
  | RailwaySubstationProps
  | BulkLoadSubstationProps;

export type FeatureProps = SubstationProps | LineProps | GenerationProps;
/** Any selectable feature across the grid + lazy overlays. */
export type AnyFeature = FeatureProps | PowerGridProps;

export interface GroupStat {
  substations: number;
  lines: number;
  lengthKm: number;
  circuitKm: number;
}

export interface Meta {
  generatedAt: string;
  source: string;
  counts: { substations: number; lines: number };
  byVoltage: Record<string, GroupStat>;
  byCircle: Record<string, GroupStat>;
  matrix: Record<string, Record<string, GroupStat>>;
  circles: string[];
  totalLengthKm: number;
  totalCircuitKm: number;
  bounds: [[number, number], [number, number]];
  snapThresholdM: number;
}

export interface DataQuality {
  generatedAt: string;
  substationSchemas: Record<string, number>;
  unknownSchemaSamples: string[];
  inferredCircles: number;
  adjacency: {
    method: string;
    linesBothEndpoints: number;
    linesOneEndpoint: number;
    linesNoEndpoint: number;
    pctBoth: number;
    pctAtLeastOne: number;
    linesWithExternalEndpoint: number;
    /** Lines whose BOTH ends connect to something — a TRANSCO SS or a non-TRANSCO facility. */
    linesBothEndsResolved: number;
    pctBothEndsResolved: number;
    linesTranscoPlusExternal: number;
    linesBothExternal: number;
    linesUnresolvedEnd: number;
    /** External endpoint count by facility category (Generation / Railway / PowerGrid / HT consumer). */
    externalEndpointsByCategory: Record<string, number>;
    unmatchedSamples: Array<{ id: string; name: string; endpoints: [string, string] | null }>;
  };
  circuitAmbiguousLines: { count: number; samples: string[] };
  voltageMismatchLines: { count: number; samples: string[] };
  droppedDuplicates: Array<{ name: string; lng: number; lat: number; keptId: string }>;
  coordWarnings: Array<{ id: string; name: string; lng: number; lat: number }>;
}

export interface SearchItem {
  id: string;
  kind: "substation" | "line";
  name: string;
  voltage: Voltage;
  sub: string | null;
}

/**
 * A gazetteer place (GeoNames AP extract, CC BY 4.0). Lazy search-only data — fetched on first
 * use of the search box, never a map layer or selectable feature; choosing one just flies the
 * map there (and anchors the nearest-substation readout).
 */
export interface PlaceItem {
  name: string;
  /** Friendly type tag ("village" | "town" | "city" | "district" | "mandal" | "water" | …). */
  type: string;
  district: string | null;
  lng: number;
  lat: number;
  /** Population (0 when GeoNames has none) — used only to rank search results. */
  pop: number;
}

/** Wire shape of places.json — compact tuples keep the ~33k-row payload small. */
export interface PlacesFile {
  generatedAt: string;
  source: string;
  count: number;
  places: [name: string, type: string, district: string, lng: number, lat: number, pop: number][];
}

export interface GridData {
  substations: SubstationProps[];
  lines: LineProps[];
  substationsFc: FeatureCollection;
  linesFc: FeatureCollection;
  byId: Map<string, FeatureProps>;
  meta: Meta;
  quality: DataQuality;
  searchIndex: SearchItem[];
}

export function isSubstation(f: AnyFeature): f is SubstationProps {
  return f.kind === "substation";
}
export function isLine(f: AnyFeature): f is LineProps {
  return f.kind === "line";
}
export function isGeneration(f: AnyFeature): f is GenerationProps {
  return f.kind === "generation";
}
export function isPowerGridLine(f: AnyFeature): f is PowerGridLineProps {
  return f.kind === "pg-line";
}
export function isPowerGridSubstation(f: AnyFeature): f is PowerGridSubstationProps {
  return f.kind === "pg-substation";
}
export function isRailwaySubstation(f: AnyFeature): f is RailwaySubstationProps {
  return f.kind === "rail-substation";
}
export function isBulkLoadSubstation(f: AnyFeature): f is BulkLoadSubstationProps {
  return f.kind === "bulk-substation";
}

/** Lazy-loaded generation overlay (fetched on first enable, then cached). */
export interface GenerationData {
  plants: GenerationProps[];
  fc: FeatureCollection;
  byId: Map<string, GenerationProps>;
}

/**
 * Lazy-loaded "Power grid" overlay group (fetched on first enable, then cached). Carries THREE
 * classes — POWERGRID (PGCIL) lines+substations, railway-traction substations, and bulk-load /
 * HT-consumer substations — all in one `byId` map; per-class visibility is gated in the store.
 */
export interface PowerGridData {
  lines: PowerGridLineProps[];
  substations: PowerGridSubstationProps[];
  railway: RailwaySubstationProps[];
  bulkload: BulkLoadSubstationProps[];
  linesFc: FeatureCollection;
  substationsFc: FeatureCollection;
  railwayFc: FeatureCollection;
  bulkloadFc: FeatureCollection;
  byId: Map<string, PowerGridProps>;
}
