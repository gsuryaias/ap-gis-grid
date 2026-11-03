// Transmission towers overlay — decoding + popup for public/data/towers-<kv>.json (written by the
// ETL from `npm run sync:towers`; shape documented in scripts/towers-lib.ts). Towers are stored
// grouped by line with dictionary-encoded columns, so map features carry only an index + the
// fields the cartography needs; the popup re-assembles every attribute from the decoded file.
import type { FeatureCollection } from "geojson";

export interface WebTowersFile {
  generatedAt: string;
  voltage: number;
  count: number;
  cols: string[];
  dicts: Array<string[] | null>;
  lines: Array<{ name: string; lineId: string | null; attrs: Record<string, unknown> }>;
  towers: unknown[][];
}

const files = new Map<string, WebTowersFile>();

/** CP/SP spellings in the source ("Cp", "CPP", "Sp") → canonical; Boom / Gantry kept. */
export function canonicalCpSp(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  const u = s.toUpperCase();
  if (u.startsWith("CP")) return "CP";
  if (u.startsWith("SP")) return "SP";
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : null;
}

function cell(f: WebTowersFile, row: unknown[], i: number): unknown {
  const v = row[3 + i];
  if (v == null) return f.lines[row[0] as number].attrs[f.cols[i]] ?? null;
  const d = f.dicts[i];
  return d && typeof v === "number" ? d[v] : v;
}

/** Every attribute of tower `index` (line-level values filled in). */
export function towerAttributes(defId: string, index: number): { line: WebTowersFile["lines"][number]; props: Record<string, unknown> } | null {
  const f = files.get(defId);
  const row = f?.towers[index];
  if (!f || !row) return null;
  const line = f.lines[row[0] as number];
  const props: Record<string, unknown> = { ...line.attrs };
  f.cols.forEach((c, i) => {
    const v = cell(f, row, i);
    if (v != null) props[c] = v;
  });
  return { line, props };
}

/** Decode a web towers file into a lean point FeatureCollection (and keep it for popups). */
export function decodeTowers(defId: string, f: WebTowersFile): FeatureCollection {
  files.set(defId, f);
  const noCol = f.cols.indexOf("tower_number");
  const cpCol = f.cols.indexOf("cp_sp");
  const typeCol = f.cols.indexOf("tower_type");
  return {
    type: "FeatureCollection",
    features: f.towers.map((row, i) => ({
      type: "Feature",
      id: i,
      geometry: { type: "Point", coordinates: [row[1] as number, row[2] as number] },
      properties: {
        i,
        no: noCol >= 0 ? (cell(f, row, noCol) ?? null) : null,
        cp: canonicalCpSp(cpCol >= 0 ? cell(f, row, cpCol) : null),
        type: typeCol >= 0 ? (cell(f, row, typeCol) ?? null) : null,
        lineId: f.lines[row[0] as number].lineId,
      },
    })),
  };
}

const LABEL: Record<string, string> = {
  tower_number: "Tower no.",
  tower_type: "Tower type",
  cp_sp: "CP / SP",
  tower_ckts_conductor: "Structure · circuits · conductor",
  tower_ckt_type: "Tower circuit type",
  circuit_type: "Line circuit type",
  conductor_type: "Conductor",
  no_of_conductors_per_phase: "Conductors / phase",
  date_of_commissioning: "Commissioned",
  relay_setting_length_in_km: "Relay-setting length (km)",
  span: "Span",
  span_km: "Span (km)",
  voltage: "Voltage",
  circle: "Circle",
  zone: "Zone",
  division: "Division",
  subdivision: "Sub-division",
};
const ORDER = Object.keys(LABEL);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const nice = (k: string) => LABEL[k] ?? k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

function fmt(k: string, v: unknown): string {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    // Source dates are IST midnights stored as UTC (…T18:30Z) — show the IST calendar date.
    return new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
  }
  if (k === "cp_sp") return `${v}${canonicalCpSp(v) === "CP" ? " (cut / angle point)" : canonicalCpSp(v) === "SP" ? " (suspension)" : ""}`;
  if (typeof v === "number") return v.toLocaleString("en-IN", { maximumFractionDigits: 3 });
  return String(v);
}

/** Popup HTML for a tower — every attribute the source carries (empty fields omitted). */
export function towerPopupHtml(defId: string, index: number, label: string): string {
  const a = towerAttributes(defId, index);
  if (!a) return "";
  const { line, props } = a;
  const keys = Object.keys(props).sort((x, y) => {
    const ix = ORDER.indexOf(x);
    const iy = ORDER.indexOf(y);
    return (ix < 0 ? 999 : ix) - (iy < 0 ? 999 : iy) || x.localeCompare(y);
  });
  const rows = keys
    // span / span_km are almost never filled — the source stores 0 for "not recorded".
    .filter((k) => k !== "line_name" && !((k === "span" || k === "span_km") && !props[k]))
    .map((k) => `<tr><th>${esc(nice(k))}</th><td>${esc(fmt(k, props[k]))}</td></tr>`)
    .join("");
  const lineCell = line.lineId
    ? `<button type="button" class="ov-link" data-select="${esc(line.lineId)}">${esc(line.name)}</button>`
    : esc(line.name);
  return (
    `<div class="ov-popup"><div class="ov-popup-kicker">Transmission · ${esc(label)}</div>` +
    `<div class="ov-popup-title">Tower ${esc(String(props.tower_number ?? "—"))}</div>` +
    `<table><tr><th>Line</th><td>${lineCell}</td></tr>${rows}</table>` +
    `<div class="ov-popup-src">AP-TRANSCO enterprise GIS — tower layers (live). Tower type / CP-SP as recorded; in “DA+3” the letters are the design type and +n is usually the body extension in metres (indicative).</div></div>`
  );
}
