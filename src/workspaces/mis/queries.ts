// Typed SQL for the MIS dashboards. Dates are cast to ISO strings and counts to INT in SQL so
// every value crossing the Arrow boundary is a plain string/number/null. The SQL constants are
// exported (not inlined) so they can be smoke-tested against the real parquet with node DuckDB.
import { query } from "./duck.ts";

export interface PspRow {
  d: string;
  entity: string;
  energy_met_mu: number | null;
  energy_shortage_mu: number | null;
  max_demand_met_mw: number | null;
  peak_shortage_mw: number | null;
}

export interface Coverage {
  min_d: string | null;
  max_d: string | null;
  n: number;
}

export interface VidyutRow {
  d: string;
  demand_met_mw: number | null;
  peak_shortage_mw: number | null;
  energy_shortage_mu: number | null;
  exchange_price_inr_kwh: number | null;
}

/** The three entities the dashboards compare. PSP spells them exactly like this. */
export const ENTITY_AP = "Andhra Pradesh";
export const ENTITY_SR = "SR";
export const ENTITY_AI = "All India";

export const PSP_SERIES_SQL = `
  SELECT strftime(date, '%Y-%m-%d') AS d, entity,
         energy_met_mu, energy_shortage_mu, max_demand_met_mw, peak_shortage_mw
  FROM 'psp-daily.parquet'
  WHERE entity IN ('${ENTITY_AP}', '${ENTITY_SR}', '${ENTITY_AI}')
  ORDER BY date
`;

export const PSP_COVERAGE_SQL = `
  SELECT strftime(min(date), '%Y-%m-%d') AS min_d, strftime(max(date), '%Y-%m-%d') AS max_d,
         count(*)::INT AS n
  FROM 'psp-daily.parquet'
`;

export const VIDYUT_LATEST_SQL = `
  SELECT strftime(date, '%Y-%m-%d') AS d,
         demand_met_mw, peak_shortage_mw, energy_shortage_mu, exchange_price_inr_kwh
  FROM 'vidyut-daily.parquet'
  ORDER BY date DESC
  LIMIT 1
`;

export const VIDYUT_COVERAGE_SQL = `
  SELECT strftime(min(date), '%Y-%m-%d') AS min_d, strftime(max(date), '%Y-%m-%d') AS max_d,
         count(*)::INT AS n
  FROM 'vidyut-daily.parquet'
`;

export interface PspData {
  rows: PspRow[];
  coverage: Coverage;
}

export interface VidyutData {
  latest: VidyutRow | null;
  coverage: Coverage;
}

export async function loadPspData(): Promise<PspData> {
  const [rows, cov] = await Promise.all([query<PspRow>(PSP_SERIES_SQL), query<Coverage>(PSP_COVERAGE_SQL)]);
  return { rows, coverage: cov[0] ?? { min_d: null, max_d: null, n: 0 } };
}

export async function loadVidyutData(): Promise<VidyutData> {
  const [rows, cov] = await Promise.all([query<VidyutRow>(VIDYUT_LATEST_SQL), query<Coverage>(VIDYUT_COVERAGE_SQL)]);
  return { latest: rows[0] ?? null, coverage: cov[0] ?? { min_d: null, max_d: null, n: 0 } };
}
