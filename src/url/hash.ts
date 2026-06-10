// Typed, versioned URL-hash (de)serializer. Selection is keyed on synthetic feature IDs
// (never names — many substations share a name), so deep links are unambiguous.
import { CIRCUITS, VOLTAGES, type Circuit, type Voltage } from "../data/types.ts";

const VERSION = 1;

export interface HashState {
  selectedId: string | null;
  basemap: "light" | "dark" | "satellite";
  voltages: Voltage[];
  circuits: Circuit[];
  showSubstations: boolean;
  showLines: boolean;
  showGeneration: boolean;
  showPowerGrid: boolean;
  showWeather: boolean;
  tableOpen: boolean;
  /** Regional slice by AP-TRANSCO circle (null = all). */
  circle?: string | null;
  /** Coastal slice by exposure band (cumulative ≤; null = all distances). */
  coastalBand?: 0 | 1 | 2 | 3 | null;
}

export const defaultHashState: HashState = {
  selectedId: null,
  basemap: "light",
  voltages: [...VOLTAGES],
  circuits: [...CIRCUITS],
  showSubstations: true,
  showLines: true,
  showGeneration: false,
  showPowerGrid: false,
  showWeather: false,
  tableOpen: false,
  circle: null,
  coastalBand: null,
};

export function serializeHash(s: HashState): string {
  const p = new URLSearchParams();
  p.set("v", String(VERSION));
  if (s.selectedId) p.set("sel", s.selectedId);
  if (s.basemap !== "light") p.set("base", s.basemap);
  if (s.voltages.length !== VOLTAGES.length) p.set("volt", s.voltages.join(","));
  if (s.circuits.length !== CIRCUITS.length) p.set("circ", s.circuits.join(","));
  const show: string[] = [];
  if (s.showSubstations) show.push("ss");
  if (s.showLines) show.push("ln");
  if (show.length !== 2) p.set("show", show.join(","));
  if (s.showGeneration) p.set("gen", "1");
  if (s.showPowerGrid) p.set("pg", "1");
  if (s.showWeather) p.set("wx", "1");
  if (s.tableOpen) p.set("tbl", "1");
  if (s.circle) p.set("circle", s.circle);
  if (s.coastalBand != null) p.set("coast", String(s.coastalBand)); // band 0 is a real value
  return `#${p.toString()}`;
}

export function parseHash(hash: string): Partial<HashState> {
  const raw = hash.replace(/^#/, "");
  if (!raw) return {};
  const p = new URLSearchParams(raw);
  if (p.get("v") !== String(VERSION)) return {}; // unknown/legacy schema → ignore
  const out: Partial<HashState> = {};

  const sel = p.get("sel");
  if (sel) out.selectedId = sel;

  const base = p.get("base");
  if (base === "dark" || base === "light" || base === "satellite") out.basemap = base;

  const volt = p.get("volt");
  if (volt != null) {
    const list = volt
      .split(",")
      .map(Number)
      .filter((n): n is Voltage => (VOLTAGES as number[]).includes(n));
    out.voltages = list.length ? list : [...VOLTAGES];
  }

  const circ = p.get("circ");
  if (circ != null) {
    const list = circ.split(",").filter((c): c is Circuit => (CIRCUITS as string[]).includes(c));
    out.circuits = list.length ? list : [...CIRCUITS];
  }

  const show = p.get("show");
  if (show != null) {
    out.showSubstations = show.split(",").includes("ss");
    out.showLines = show.split(",").includes("ln");
  }

  out.showGeneration = p.get("gen") === "1";
  out.showPowerGrid = p.get("pg") === "1";
  out.showWeather = p.get("wx") === "1";
  out.tableOpen = p.get("tbl") === "1";

  const circle = p.get("circle");
  if (circle) out.circle = circle;

  const coast = p.get("coast");
  if (coast != null) {
    const n = Number(coast);
    if (n === 0 || n === 1 || n === 2 || n === 3) out.coastalBand = n;
  }
  return out;
}
