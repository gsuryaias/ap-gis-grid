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

export type FeatureProps = SubstationProps | LineProps | GenerationProps;

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

export function isSubstation(f: FeatureProps): f is SubstationProps {
  return f.kind === "substation";
}
export function isLine(f: FeatureProps): f is LineProps {
  return f.kind === "line";
}
export function isGeneration(f: FeatureProps): f is GenerationProps {
  return f.kind === "generation";
}

/** Lazy-loaded generation overlay (fetched on first enable, then cached). */
export interface GenerationData {
  plants: GenerationProps[];
  fc: FeatureCollection;
  byId: Map<string, GenerationProps>;
}
