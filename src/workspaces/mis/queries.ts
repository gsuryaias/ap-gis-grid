// Typed SQL for the MIS dashboards. Dates are cast to ISO strings and counts to INT in SQL so
// every value crossing the Arrow boundary is a plain string/number/null. The SQL constants are
// exported (not inlined) so they can be smoke-tested against the real parquet with node DuckDB.
import { query } from "./duck.ts";

export interface PspRow {
  d: string;
  entity: string;
  entity_type: "all-india" | "region" | "state" | string;
  energy_met_mu: number | null;
  energy_shortage_mu: number | null;
  max_demand_met_mw: number | null;
  peak_shortage_mw: number | null;
  evening_peak_demand_mw: number | null;
}

export interface PspEntity {
  entity: string;
  entity_type: string;
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

/** Canonical comparison entities (PSP spells them exactly like this). */
export const ENTITY_AP = "Andhra Pradesh";
export const ENTITY_SR = "SR";
export const ENTITY_AI = "All India";

/** Default peer states for benchmark / overlay pickers. */
export const PEER_STATES = ["Tamil Nadu", "Karnataka", "Telangana", "Maharashtra", "Gujarat"] as const;

export const PSP_ENTITIES_SQL = `
  SELECT DISTINCT entity, entity_type
  FROM 'psp-daily.parquet'
  ORDER BY entity_type, entity
`;

export const PSP_SERIES_SQL = `
  SELECT strftime(date, '%Y-%m-%d') AS d, entity, entity_type,
         energy_met_mu, energy_shortage_mu, max_demand_met_mw,
         peak_shortage_mw, evening_peak_demand_mw
  FROM 'psp-daily.parquet'
  ORDER BY date
`;

export const PSP_DAY_SQL = `
  SELECT strftime(date, '%Y-%m-%d') AS d, entity, entity_type,
         energy_met_mu, energy_shortage_mu, max_demand_met_mw,
         peak_shortage_mw, evening_peak_demand_mw
  FROM 'psp-daily.parquet'
  WHERE strftime(date, '%Y-%m-%d') = ?
  ORDER BY entity_type, entity
`;

export const PSP_COVERAGE_SQL = `
  SELECT strftime(min(date), '%Y-%m-%d') AS min_d, strftime(max(date), '%Y-%m-%d') AS max_d,
         count(*)::INT AS n
  FROM 'psp-daily.parquet'
`;

export const VIDYUT_SERIES_SQL = `
  SELECT strftime(date, '%Y-%m-%d') AS d,
         demand_met_mw, peak_shortage_mw, energy_shortage_mu, exchange_price_inr_kwh
  FROM 'vidyut-daily.parquet'
  ORDER BY date
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
  entities: PspEntity[];
  coverage: Coverage;
}

export interface VidyutData {
  rows: VidyutRow[];
  latest: VidyutRow | null;
  coverage: Coverage;
}

export interface CeaRow {
  month: string;
  region_state: string;
  source: string;
  generation_mu: number | null;
  share_pct: number | null;
  fy: string | null;
}

export interface CeaData {
  rows: CeaRow[];
  coverage: Coverage;
  /** Latest month with AP rows (YYYY-MM-01). */
  latestApMonth: string | null;
}

export const CEA_SERIES_SQL = `
  SELECT strftime(month, '%Y-%m-%d') AS month, region_state, source,
         generation_mu, share_pct, fy
  FROM 'cea-monthly.parquet'
  ORDER BY month, region_state, source
`;

export const CEA_AP_LATEST_SQL = `
  SELECT strftime(month, '%Y-%m-%d') AS month, region_state, source,
         generation_mu, share_pct, fy
  FROM 'cea-monthly.parquet'
  WHERE region_state = 'Andhra Pradesh'
    AND month = (SELECT max(month) FROM 'cea-monthly.parquet' WHERE region_state = 'Andhra Pradesh')
  ORDER BY source
`;

export const CEA_COVERAGE_SQL = `
  SELECT strftime(min(month), '%Y-%m-%d') AS min_d, strftime(max(month), '%Y-%m-%d') AS max_d,
         count(*)::INT AS n
  FROM 'cea-monthly.parquet'
`;

export async function loadPspEntities(): Promise<PspEntity[]> {
  return query<PspEntity>(PSP_ENTITIES_SQL);
}

export async function loadPspDay(date: string): Promise<PspRow[]> {
  // DuckDB-WASM parameterised queries are awkward over HTTP; inline the ISO date (validated).
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const sql = PSP_DAY_SQL.replace("?", `'${date}'`);
  return query<PspRow>(sql);
}

export async function loadPspData(): Promise<PspData> {
  const [rows, entities, cov] = await Promise.all([
    query<PspRow>(PSP_SERIES_SQL),
    query<PspEntity>(PSP_ENTITIES_SQL),
    query<Coverage>(PSP_COVERAGE_SQL),
  ]);
  return { rows, entities, coverage: cov[0] ?? { min_d: null, max_d: null, n: 0 } };
}

export async function loadVidyutData(): Promise<VidyutData> {
  const [rows, cov] = await Promise.all([
    query<VidyutRow>(VIDYUT_SERIES_SQL),
    query<Coverage>(VIDYUT_COVERAGE_SQL),
  ]);
  return {
    rows,
    latest: rows.length > 0 ? rows[rows.length - 1]! : null,
    coverage: cov[0] ?? { min_d: null, max_d: null, n: 0 },
  };
}

export async function loadCeaData(): Promise<CeaData> {
  const [rows, cov, latestAp] = await Promise.all([
    query<CeaRow>(CEA_SERIES_SQL),
    query<Coverage>(CEA_COVERAGE_SQL),
    query<CeaRow>(CEA_AP_LATEST_SQL),
  ]);
  return {
    rows,
    coverage: cov[0] ?? { min_d: null, max_d: null, n: 0 },
    latestApMonth: latestAp[0]?.month ?? null,
  };
}
