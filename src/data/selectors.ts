import type { FeatureProps, GridData, LineProps, SubstationProps } from "./types.ts";
import { isLine, isSubstation } from "./types.ts";

/** Lines connected to a substation, with the snap distance/confidence for this SS. */
export interface ConnectedLine {
  line: LineProps;
  distM: number | null;
  confidence: string | null;
}

export function connectedLines(ss: SubstationProps, data: GridData): ConnectedLine[] {
  return ss.connectedLineIds
    .map((id) => data.byId.get(id))
    .filter((f): f is LineProps => !!f && isLine(f))
    .map((line) => {
      const snap = line.fromSS?.ssId === ss.id ? line.fromSS : line.toSS?.ssId === ss.id ? line.toSS : null;
      return { line, distM: snap?.distM ?? null, confidence: snap?.confidence ?? null };
    })
    .sort((a, b) => b.line.voltage - a.line.voltage || a.line.name.localeCompare(b.line.name));
}

/** Substations a line connects to (geometrically inferred). */
export function connectedSubstations(line: LineProps, data: GridData): SubstationProps[] {
  return line.connectsSS
    .map((id) => data.byId.get(id))
    .filter((f): f is SubstationProps => !!f && isSubstation(f));
}

export interface FilterState {
  voltages: Record<number, boolean>;
  circuits: Record<string, boolean>;
  showSubstations: boolean;
  showLines: boolean;
}

export function passesFilter(f: FeatureProps, filters: FilterState): boolean {
  if (!filters.voltages[f.voltage]) return false;
  if (isSubstation(f)) return filters.showSubstations;
  return filters.showLines && filters.circuits[f.circuit];
}
