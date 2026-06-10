import type { EnergyType, FeatureProps, GridData, LineProps, SubstationProps } from "./types.ts";
import { isGeneration, isLine, isSubstation } from "./types.ts";

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

/** Per-class sub-toggles inside the "Power grid" overlay group. */
export type PgClass = "powergrid" | "railway" | "bulkload";
export const PG_CLASSES: PgClass[] = ["powergrid", "railway", "bulkload"];

/** Sub-toggles inside the live-weather overlay (radar tiles / cyclone tracks). */
export type WxLayer = "radar" | "cyclone";
export const WX_LAYERS: WxLayer[] = ["radar", "cyclone"];

export interface FilterState {
  voltages: Record<number, boolean>;
  circuits: Record<string, boolean>;
  /** Regional slice: when set, only features in this AP-TRANSCO circle are shown (null = all 13). */
  circle: string | null;
  /** Coastal slice: when set, only features within this band (cumulative, ≤) are shown (null = all). */
  coastalBand: 0 | 1 | 2 | 3 | null;
  showSubstations: boolean;
  showLines: boolean;
  /** Generation overlay (lazy): off by default; per-energy-type visibility once loaded. */
  showGeneration: boolean;
  genTypes: Record<EnergyType, boolean>;
  /**
   * "Power grid" overlay group (lazy): master gate, off by default. When enabled it lazy-loads
   * ALL classes (PowerGrid lines+SS, railway SS, bulk-load SS); `pgClasses` then gates each class.
   */
  showPowerGrid: boolean;
  pgClasses: Record<PgClass, boolean>;
  /**
   * Live-weather overlay (lazy): master gate, off by default. When enabled it lazy-fetches all
   * weather sources (Open-Meteo / RainViewer / GDACS); `wxLayers` then gates the map layers.
   */
  showWeather: boolean;
  wxLayers: Record<WxLayer, boolean>;
}

export function passesFilter(f: FeatureProps, filters: FilterState): boolean {
  if (isGeneration(f)) return filters.showGeneration && filters.genTypes[f.energy];
  if (!filters.voltages[f.voltage]) return false;
  if (filters.circle && f.circle !== filters.circle) return false;
  // Cumulative ≤ semantics; features missing the band (shouldn't happen) are excluded.
  if (filters.coastalBand != null && !(f.coastalBand != null && f.coastalBand <= filters.coastalBand))
    return false;
  if (isSubstation(f)) return filters.showSubstations;
  return filters.showLines && filters.circuits[f.circuit];
}
