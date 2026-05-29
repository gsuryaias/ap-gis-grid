// Typed, versioned URL-hash (de)serializer. Selection is keyed on synthetic feature IDs
// (never names — many substations share a name), so deep links are unambiguous.
import { CIRCUITS, VOLTAGES, type Circuit, type Voltage } from "../data/types.ts";

const VERSION = 1;

export interface HashState {
  selectedId: string | null;
  basemap: "light" | "dark";
  voltages: Voltage[];
  circuits: Circuit[];
  showSubstations: boolean;
  showLines: boolean;
  tableOpen: boolean;
}

export const defaultHashState: HashState = {
  selectedId: null,
  basemap: "light",
  voltages: [...VOLTAGES],
  circuits: [...CIRCUITS],
  showSubstations: true,
  showLines: true,
  tableOpen: false,
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
  if (s.tableOpen) p.set("tbl", "1");
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
  if (base === "dark" || base === "light") out.basemap = base;

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

  out.tableOpen = p.get("tbl") === "1";
  return out;
}
