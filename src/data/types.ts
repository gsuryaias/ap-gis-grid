import type { FeatureCollection } from "geojson";

export type Voltage = 400 | 220 | 132;
export type Circuit = "SC" | "DC";
export type Confidence = "high" | "medium" | "low";

export const VOLTAGES: Voltage[] = [400, 220, 132];
export const CIRCUITS: Circuit[] = ["SC", "DC"];

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
  connectsSS: string[];
  endpointLabels: [string, string] | null;
  fromSS: SnapRef | null;
  toSS: SnapRef | null;
  circuitAmbiguous: boolean;
  voltageMismatch: boolean;
}

export type FeatureProps = SubstationProps | LineProps;

export interface VoltageStat {
  substations: number;
  lines: number;
  lengthKm: number;
}

export interface Meta {
  generatedAt: string;
  source: string;
  counts: { substations: number; lines: number };
  byVoltage: Record<string, VoltageStat>;
  totalLengthKm: number;
  bounds: [[number, number], [number, number]];
  snapThresholdM: number;
}

export interface DataQuality {
  generatedAt: string;
  substationSchemas: Record<string, number>;
  unknownSchemaSamples: string[];
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
