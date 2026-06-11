// Pure parser for the Grid-India (NLDC) daily Power Supply Position report (.xls).
// bytes in → typed rows out; no I/O. Unit-tested against a committed fixture so a
// source-format change is caught by tests, not in production.
import * as XLSX from "xlsx";
import { gate, isoDate, addDays } from "./lib.ts";

export type PspDailyRow = {
  /** Data date (the day the report describes), YYYY-MM-DD. */
  date: string;
  /** "All India", a region code (NR/WR/SR/ER/NER), or a state/UT/entity name. */
  entity: string;
  entity_type: "all-india" | "region" | "state";
  /** Energy met during the day (MU). */
  energy_met_mu: number | null;
  energy_shortage_mu: number | null;
  /** Maximum demand met during the day (MW). */
  max_demand_met_mw: number | null;
  /** Regions: peak shortage (MW). States: shortage during maximum demand (MW). */
  peak_shortage_mw: number | null;
  /** Demand met during evening peak hrs (MW); regional section only. */
  evening_peak_demand_mw: number | null;
};

export interface PspParseResult {
  /** "Date of Reporting" printed on the sheet (the day after the data date). */
  reportingDate: string;
  /** The day the figures describe = reportingDate − 1. */
  dataDate: string;
  rows: PspDailyRow[];
}

const REGIONS = ["NR", "WR", "SR", "ER", "NER"] as const;
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Parse a report cell like "1,904", "0.41", "-" → number | null. */
export function parsePspNumber(raw: unknown): number | null {
  const s = String(raw ?? "").replace(/[,\u00a0*]/g, "").trim();
  if (!s || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse "10-Jun-2026" (or 2-digit year) → UTC-midnight Date. */
export function parseReportDate(raw: string): Date {
  const m = raw.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  gate(m, `unrecognised report date "${raw}"`);
  const month = MONTHS[m[2].toLowerCase()];
  gate(month !== undefined, `unrecognised month in report date "${raw}"`);
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return new Date(Date.UTC(year, month, Number(m[1])));
}

const cellText = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();

/**
 * Parse the MOP_E sheet of an NLDC daily PSP .xls into long-format rows:
 * section A (All-India + regional PSP) and section C (state-wise PSP).
 */
export function parsePspXls(bytes: Uint8Array): PspParseResult {
  const wb = XLSX.read(bytes, { type: "array" });
  const sheet = wb.Sheets["MOP_E"];
  gate(sheet, `MOP_E sheet missing (sheets: ${wb.SheetNames.join(", ")})`);
  const grid: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null });

  // --- Date of Reporting --------------------------------------------------
  let reportingDate: Date | null = null;
  for (const row of grid) {
    if (!row.some((c) => cellText(c).startsWith("Date of Reporting"))) continue;
    const dateCell = row.map(cellText).find((c) => /^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/.test(c));
    gate(dateCell, "found 'Date of Reporting' row but no date cell in it");
    reportingDate = parseReportDate(dateCell);
    break;
  }
  gate(reportingDate, "'Date of Reporting' not found in MOP_E sheet");
  const date = isoDate(addDays(reportingDate, -1));

  // --- Section A: All India + regional ------------------------------------
  const headerIdx = grid.findIndex(
    (row) => row.some((c) => cellText(c) === "NR") && row.some((c) => cellText(c) === "TOTAL"),
  );
  gate(headerIdx >= 0, "regional header row (NR…TOTAL) not found");
  const headerRow = grid[headerIdx].map(cellText);
  const colOf: Record<string, number> = {};
  for (const label of [...REGIONS, "TOTAL"]) {
    const idx = headerRow.indexOf(label);
    gate(idx >= 0, `regional header missing column ${label}`);
    colOf[label] = idx;
  }

  const metricOfLabel = (label: string): keyof PspDailyRow | null => {
    if (label.startsWith("Demand Met during Evening Peak")) return "evening_peak_demand_mw";
    if (label.startsWith("Peak Shortage")) return "peak_shortage_mw";
    if (label.startsWith("Energy Met (MU)")) return "energy_met_mu";
    if (label.startsWith("Energy Shortage (MU)")) return "energy_shortage_mu";
    if (label.startsWith("Maximum Demand Met During the Day")) return "max_demand_met_mw";
    return null;
  };

  const blank = (): Omit<PspDailyRow, "date" | "entity" | "entity_type"> => ({
    energy_met_mu: null,
    energy_shortage_mu: null,
    max_demand_met_mw: null,
    peak_shortage_mw: null,
    evening_peak_demand_mw: null,
  });
  const regional: Record<string, ReturnType<typeof blank>> = {};
  for (const label of [...REGIONS, "TOTAL"]) regional[label] = blank();

  for (let i = headerIdx + 1; i < Math.min(headerIdx + 14, grid.length); i++) {
    const metric = metricOfLabel(cellText(grid[i][0]));
    if (!metric) continue;
    for (const label of [...REGIONS, "TOTAL"]) {
      (regional[label] as Record<string, number | null>)[metric] = parsePspNumber(grid[i][colOf[label]]);
    }
  }

  const rows: PspDailyRow[] = [
    { date, entity: "All India", entity_type: "all-india", ...regional["TOTAL"] },
    ...REGIONS.map((r): PspDailyRow => ({ date, entity: r, entity_type: "region", ...regional[r] })),
  ];

  // --- Section C: state-wise ----------------------------------------------
  const sectionCIdx = grid.findIndex((row) =>
    cellText(row[0]).startsWith("C. Power Supply Position in States"),
  );
  gate(sectionCIdx >= 0, "section C (state-wise PSP) not found");
  const stateHeaderIdx = grid.findIndex(
    (row, i) => i > sectionCIdx && row.some((c) => cellText(c).startsWith("States")),
  );
  gate(stateHeaderIdx >= 0, "state table header row not found");
  const h1 = grid[stateHeaderIdx - 1].map(cellText); // first (merged) header line
  const h2 = grid[stateHeaderIdx].map(cellText); // line containing "States"
  const colMaxDemand = h1.findIndex((c) => c.startsWith("Max.Demand"));
  const colShortage = h1.findIndex((c) => c.startsWith("Shortage during"));
  const colEnergyMet = h1.findIndex((c) => c.startsWith("Energy Met"));
  const colEnergyShort = h2.findIndex((c) => c.startsWith("Shortage (MU)"));
  gate(
    colMaxDemand >= 0 && colShortage >= 0 && colEnergyMet >= 0 && colEnergyShort >= 0,
    "state table columns not found (layout changed?)",
  );

  let blanks = 0;
  for (let i = stateHeaderIdx + 1; i < grid.length; i++) {
    const row = grid[i];
    if (cellText(row[0]).startsWith("D.")) break; // next section
    const name = cellText(row[1]);
    if (!name) {
      if (++blanks >= 2) break;
      continue;
    }
    blanks = 0;
    rows.push({
      date,
      entity: name,
      entity_type: "state",
      energy_met_mu: parsePspNumber(row[colEnergyMet]),
      energy_shortage_mu: parsePspNumber(row[colEnergyShort]),
      max_demand_met_mw: parsePspNumber(row[colMaxDemand]),
      peak_shortage_mw: parsePspNumber(row[colShortage]),
      evening_peak_demand_mw: null,
    });
  }

  gate(rows.filter((r) => r.entity_type === "state").length >= 25, "fewer than 25 state rows parsed");
  return { reportingDate: isoDate(reportingDate), dataDate: date, rows };
}
