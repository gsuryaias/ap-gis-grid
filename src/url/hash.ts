// Typed, versioned URL-hash (de)serializer. Selection is keyed on synthetic feature IDs
// (never names — many substations share a name), so deep links are unambiguous.
import { CIRCUITS, VOLTAGES, type Circuit, type Voltage } from "../data/types.ts";
import { isWorkspaceId, type WorkspaceId } from "../workspaces/registry.ts";

const VERSION = 1;

export type MapLayout = "open" | "collapsed" | "atlas-only";

/** Sensible default for the split-map pane when no `map=` deep link is present. */
export function defaultMapLayout(): MapLayout {
  if (typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches) return "collapsed";
  return "open";
}

export interface HashState {
  /** Active workspace (`w` key; absent or unknown = atlas). */
  workspace: WorkspaceId;
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
  /** Split-layout map pane (`map=` key; `atlas-only` when the Atlas workspace is active). */
  mapLayout: MapLayout;
  /** MIS workspace: group-by dimension (`by=`). */
  misBy?: string | null;
  /** MIS workspace: drill path, "dim:value~dim:value" (`mf=`). */
  misFilters?: string | null;
  /** MIS workspace: thematic tab (`tab=`). */
  misTab?: string | null;
  /** MIS workspace: map theme (`theme=`). */
  misTheme?: string | null;
}

// Loose shape checks only — the MIS workspace validates values against its own vocabularies.
const TOKEN = /^[a-z0-9-]{1,24}$/;

export const defaultHashState: HashState = {
  workspace: "atlas",
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
  mapLayout: "open",
};

export function serializeHash(s: HashState): string {
  const p = new URLSearchParams();
  p.set("v", String(VERSION));
  if (s.workspace !== "atlas") p.set("w", s.workspace);
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
  if (s.workspace !== "atlas" && s.mapLayout !== defaultMapLayout()) p.set("map", s.mapLayout);
  if (s.workspace === "mis") {
    if (s.misBy && s.misBy !== "circle") p.set("by", s.misBy);
    if (s.misFilters) p.set("mf", s.misFilters);
    if (s.misTab && s.misTab !== "age") p.set("tab", s.misTab);
    if (s.misTheme && s.misTheme !== "voltage") p.set("theme", s.misTheme);
  }
  return `#${p.toString()}`;
}

export function parseHash(hash: string): Partial<HashState> {
  const raw = hash.replace(/^#/, "");
  if (!raw) return {};
  const p = new URLSearchParams(raw);
  if (p.get("v") !== String(VERSION)) return {}; // unknown/legacy schema → ignore
  const out: Partial<HashState> = {};

  // Absent or unknown `w` resolves to the Atlas, so every pre-shell deep link keeps working.
  const w = p.get("w");
  out.workspace = isWorkspaceId(w) ? w : "atlas";

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

  const map = p.get("map");
  if (map === "open" || map === "collapsed" || map === "atlas-only") out.mapLayout = map;

  if (out.workspace === "mis") {
    const by = p.get("by");
    out.misBy = by && TOKEN.test(by) ? by : null;
    const mf = p.get("mf");
    out.misFilters = mf && mf.length <= 400 ? mf : null;
    const tab = p.get("tab");
    out.misTab = tab && TOKEN.test(tab) ? tab : null;
    const theme = p.get("theme");
    out.misTheme = theme && TOKEN.test(theme) ? theme : null;
  }

  return out;
}
