// Pure parsers for CEA monthly generation / energy-mix data.
// Supports the public JSON APIs (power_generation.php, renewable_energy.php) and
// HTML table extracts from the monthly OPM report (fixture-tested).
import { parse as parseHtml } from "node-html-parser";
import { gate } from "./lib.ts";

/** Canonical fuel / source labels aligned with the generation overlay energy types. */
export type CeaSource = "thermal" | "hydro" | "nuclear" | "solar" | "wind" | "gas" | "other";

export type CeaMonthlyRow = {
  /** First day of the calendar month (YYYY-MM-DD). */
  month: string;
  region_state: string;
  source: CeaSource;
  /** Generation in million units (MU), consistent with PSP / Vidyut series. */
  generation_mu: number;
  /** Share of total generation within the same month + region (0–100). */
  share_pct: number;
  /** Indian fiscal year label, e.g. "2024-2025". */
  fy: string;
};

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Parse "Apr-2024", "Apr-24" → ISO month key YYYY-MM-01. */
export function parseCeaMonthLabel(raw: string): string {
  const m = raw.trim().match(/^([A-Za-z]{3})-(\d{2,4})$/);
  gate(m, `unrecognised CEA month label "${raw}"`);
  const month = MONTHS[m[1].toLowerCase()];
  gate(month !== undefined, `unrecognised month "${m[1]}" in "${raw}"`);
  let year = Number(m[2]);
  if (m[2].length === 2) year += year >= 70 ? 1900 : 2000;
  return `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

/** Parse dashboard / table numbers: "1,078.07", "580.95", "-" → number | null. */
export function parseCeaNumber(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/,/g, "").replace(/\u00a0/g, " ").trim();
  if (!cleaned || cleaned === "-" || cleaned === "—") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Map CEA mode / column labels to canonical sources. */
export function normalizeCeaSource(raw: string): CeaSource {
  const key = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if (key === "thermal") return "thermal";
  if (key === "hydro" || key === "small_hydel" || key.includes("bhutan")) return "hydro";
  if (key === "nuclear") return "nuclear";
  if (key === "solar") return "solar";
  if (key === "wind") return "wind";
  if (key === "gas") return "gas";
  return "other";
}

/** Billion units (BU) from power_generation.php → MU. */
export function buToMu(bu: number): number {
  return bu * 1000;
}

type PowerGenRecord = {
  Month: string;
  fy: string;
  mode: string;
  Region_State: string;
  bus: string;
};

type RenewableRecord = {
  Month: string;
  fy: string;
  State: string;
  wind?: string;
  solar?: string;
  biomass?: string;
  bagasse?: string;
  small_hydel?: string;
  others?: string;
};

/** FY-keyed payload from https://cea.nic.in/api/power_generation.php (values in BU). */
export function parseCeaPowerGenerationJson(
  data: Record<string, PowerGenRecord[]>,
): CeaMonthlyRow[] {
  gate(data && typeof data === "object", "power_generation payload is not an object");
  const rows: CeaMonthlyRow[] = [];
  for (const records of Object.values(data)) {
    gate(Array.isArray(records), "power_generation FY bucket is not an array");
    for (const rec of records) {
      const mu = parseCeaNumber(rec.bus);
      if (mu == null) continue;
      rows.push({
        month: parseCeaMonthLabel(rec.Month),
        region_state: rec.Region_State.trim(),
        source: normalizeCeaSource(rec.mode),
        generation_mu: buToMu(mu),
        share_pct: 0,
        fy: rec.fy,
      });
    }
  }
  return withShares(rows);
}

const RES_FIELDS: { field: keyof RenewableRecord; source: CeaSource }[] = [
  { field: "wind", source: "wind" },
  { field: "solar", source: "solar" },
  { field: "small_hydel", source: "hydro" },
  { field: "biomass", source: "other" },
  { field: "bagasse", source: "other" },
  { field: "others", source: "other" },
];

/** FY-keyed payload from https://cea.nic.in/api/renewable_energy.php (values in MU). */
export function parseCeaRenewableJson(
  data: Record<string, RenewableRecord[]>,
  states: string[] | null = null,
): CeaMonthlyRow[] {
  gate(data && typeof data === "object", "renewable_energy payload is not an object");
  const allow = states ? new Set(states) : null;
  const rows: CeaMonthlyRow[] = [];
  for (const records of Object.values(data)) {
    gate(Array.isArray(records), "renewable_energy FY bucket is not an array");
    for (const rec of records) {
      const state = rec.State.trim();
      if (allow && !allow.has(state)) continue;
      for (const { field, source } of RES_FIELDS) {
        const mu = parseCeaNumber(rec[field] as string | undefined);
        if (mu == null || mu === 0) continue;
        rows.push({
          month: parseCeaMonthLabel(rec.Month),
          region_state: state,
          source,
          generation_mu: mu,
          share_pct: 0,
          fy: rec.fy,
        });
      }
    }
  }
  return withShares(rows);
}

const HTML_COLUMNS: { header: RegExp; source: CeaSource }[] = [
  { header: /^thermal/i, source: "thermal" },
  { header: /^hydro/i, source: "hydro" },
  { header: /^nuclear/i, source: "nuclear" },
  { header: /^solar/i, source: "solar" },
  { header: /^wind/i, source: "wind" },
  { header: /^gas/i, source: "gas" },
  { header: /^other/i, source: "other" },
];

/**
 * Parse a simplified CEA monthly generation HTML table (OPM report layout).
 * Expects a table with Month, State/Region, and fuel columns in MU.
 */
export function parseCeaMonthlyHtml(html: string): CeaMonthlyRow[] {
  gate(html.includes("cea-monthly-generation") || /monthly generation report/i.test(html),
    "CEA monthly generation table marker not found");
  const root = parseHtml(html);
  const table = root.querySelector("#cea-monthly-generation") ?? root.querySelector("table.report-table") ?? root.querySelector("table");
  gate(table, "no <table> found in CEA monthly HTML");

  const headerCells =
    table.querySelectorAll("thead tr th").length > 0
      ? table.querySelectorAll("thead tr th")
      : table.querySelector("tr")?.querySelectorAll("th, td") ?? [];
  gate(headerCells.length >= 3, "CEA monthly table header row not found");

  const headers = headerCells.map((c) => c.text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim());
  const monthIdx = headers.findIndex((h) => /^month/i.test(h));
  const regionIdx = headers.findIndex((h) => /state|region/i.test(h));
  gate(monthIdx >= 0 && regionIdx >= 0, "Month / State columns not found in CEA table");

  const colMap: { idx: number; source: CeaSource }[] = [];
  for (let i = 0; i < headers.length; i++) {
    if (i === monthIdx || i === regionIdx) continue;
    const match = HTML_COLUMNS.find((c) => c.header.test(headers[i]!));
    if (match) colMap.push({ idx: i, source: match.source });
  }
  gate(colMap.length >= 3, "expected at least 3 fuel columns in CEA monthly table");

  const bodyRows = table.querySelectorAll("tbody tr");
  gate(bodyRows.length > 0, "CEA monthly table has no data rows");

  const rows: CeaMonthlyRow[] = [];
  for (const tr of bodyRows) {
    const cells = tr.querySelectorAll("td").map((c) => c.text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim());
    if (cells.length < headers.length) continue;
    const monthLabel = cells[monthIdx]!;
    const region = cells[regionIdx]!;
    const month = parseCeaMonthLabel(monthLabel);
    const fy = fiscalYearFromMonth(month);
    for (const { idx, source } of colMap) {
      const mu = parseCeaNumber(cells[idx]);
      if (mu == null || mu === 0) continue;
      rows.push({ month, region_state: region, source, generation_mu: mu, share_pct: 0, fy });
    }
  }
  gate(rows.length > 0, "CEA monthly HTML table produced no generation rows");
  return withShares(rows);
}

/** Merge rows; later rows replace same (month, region_state, source) keys. */
export function mergeCeaRows(...groups: CeaMonthlyRow[][]): CeaMonthlyRow[] {
  const byKey = new Map<string, CeaMonthlyRow>();
  for (const group of groups) {
    for (const row of group) {
      byKey.set(`${row.month}|${row.region_state}|${row.source}`, row);
    }
  }
  return withShares([...byKey.values()]);
}

/** Compute within-month region shares (0–100, two decimal places). */
export function withShares(rows: CeaMonthlyRow[]): CeaMonthlyRow[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.month}|${r.region_state}`;
    totals.set(k, (totals.get(k) ?? 0) + r.generation_mu);
  }
  return rows.map((r) => {
    const total = totals.get(`${r.month}|${r.region_state}`) ?? 0;
    const share_pct = total > 0 ? Math.round((r.generation_mu / total) * 10_000) / 100 : 0;
    return { ...r, share_pct };
  });
}

function fiscalYearFromMonth(isoMonth: string): string {
  const [y, m] = isoMonth.split("-").map(Number);
  const startYear = m >= 4 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}
