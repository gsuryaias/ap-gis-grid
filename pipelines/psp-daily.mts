// Pipeline: Grid-India (NLDC) daily Power Supply Position → timeseries/psp-daily.parquet
//
// Discovery is via Grid-India's own public listing API (the CDN filenames carry a random
// suffix, so URLs cannot be guessed):
//   POST https://webapi.grid-india.in/api/v1/file  { _source, _type, _fileDate (FY), _month }
// then each report is downloaded from https://webcdn.grid-india.in/<FilePath> (.xls) and
// parsed by the pure, fixture-tested parser in psp-parse.ts. Re-runs are idempotent:
// already-ingested dates are skipped, and the parquet merge replaces same-key rows.
import { join } from "node:path";
import {
  TIMESERIES_DIR,
  gate,
  postJson,
  fetchBytes,
  istToday,
  addDays,
  isoDate,
  fiscalYear,
  upsertParquet,
  parquetDistinct,
  writeManifest,
} from "./lib.ts";
import { parsePspXls, type PspDailyRow } from "./psp-parse.ts";

const LISTING_API = "https://webapi.grid-india.in/api/v1/file";
const CDN_BASE = "https://webcdn.grid-india.in/";
const PARQUET_FILE = join(TIMESERIES_DIR, "psp-daily.parquet");
const MAX_BACKFILL_FILES = 40;

const SCHEMA: Record<string, string> = {
  date: "DATE",
  entity: "VARCHAR",
  entity_type: "VARCHAR",
  energy_met_mu: "DOUBLE",
  energy_shortage_mu: "DOUBLE",
  max_demand_met_mw: "DOUBLE",
  peak_shortage_mw: "DOUBLE",
  evening_peak_demand_mw: "DOUBLE",
  source_file: "VARCHAR",
};

interface ListingEntry {
  Title_: string;
  FilePath: string;
  MimeType: string;
}

/** (fiscal year, month) pairs covering today and ~5 weeks back — the listing is per FY+month. */
function candidatePeriods(): { fy: string; month: string }[] {
  const seen = new Set<string>();
  const periods: { fy: string; month: string }[] = [];
  for (const daysBack of [0, 35]) {
    const d = addDays(istToday(), -daysBack);
    const fy = fiscalYear(d);
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    if (!seen.has(`${fy}/${month}`)) {
      seen.add(`${fy}/${month}`);
      periods.push({ fy, month });
    }
  }
  return periods;
}

/** Data date encoded in a report title like "09.06.26_NLDC_PSP" → "2026-06-09". */
function dateFromTitle(title: string): string | null {
  const m = title.trim().match(/^(\d{2})\.(\d{2})\.(\d{2})_NLDC_PSP$/);
  return m ? `20${m[3]}-${m[2]}-${m[1]}` : null;
}

async function main(): Promise<void> {
  // 1. Discover available reports for the current + previous month.
  const available = new Map<string, string>(); // data date → CDN file path
  for (const { fy, month } of candidatePeriods()) {
    const res = await postJson<{ retData: ListingEntry[] | null }>(LISTING_API, {
      _source: "GRDW",
      _type: "DAILY_PSP_REPORT",
      _fileDate: fy,
      _month: month,
    });
    for (const entry of res.retData ?? []) {
      const date = dateFromTitle(entry.Title_);
      if (date && entry.FilePath.toLowerCase().endsWith(".xls")) available.set(date, entry.FilePath);
    }
  }
  gate(available.size > 0, "Grid-India listing API returned no daily PSP .xls reports");

  // 2. Skip dates already in the parquet (idempotent re-runs).
  const existing = new Set(await parquetDistinct(PARQUET_FILE, "date"));
  const pending = [...available.entries()]
    .filter(([date]) => !existing.has(date))
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, MAX_BACKFILL_FILES);

  // 3. Download + parse + validate each new report.
  const batch: (PspDailyRow & { source_file: string })[] = [];
  for (const [date, filePath] of pending) {
    const url = CDN_BASE + filePath;
    console.log(`  fetching ${date} ← ${url}`);
    const parsed = parsePspXls(await fetchBytes(url));
    gate(
      parsed.dataDate === date,
      `date mismatch: listing says ${date}, sheet says ${parsed.dataDate} (${filePath})`,
    );
    const byEntity = new Map(parsed.rows.map((r) => [r.entity, r]));
    for (const required of ["All India", "SR", "Andhra Pradesh"]) {
      const row = byEntity.get(required);
      gate(row, `required entity "${required}" missing from ${filePath}`);
      gate(
        row.energy_met_mu !== null && row.max_demand_met_mw !== null,
        `entity "${required}" has null energy/peak figures in ${filePath}`,
      );
    }
    const allIndia = byEntity.get("All India")!;
    gate(
      allIndia.energy_met_mu! > 1000,
      `implausible All-India energy met (${allIndia.energy_met_mu} MU) in ${filePath}`,
    );
    batch.push(...parsed.rows.map((r) => ({ ...r, source_file: filePath })));
  }

  // 4. Merge into the parquet + write the manifest.
  let vintage: string;
  let total: number;
  if (batch.length > 0) {
    const result = await upsertParquet({
      file: PARQUET_FILE,
      rows: batch,
      schema: SCHEMA,
      keyColumns: ["date", "entity"],
      orderBy: ["date", "entity_type", "entity"],
    });
    vintage = result.maxKey;
    total = result.total;
    console.log(`psp-daily: ingested ${pending.length} report(s), ${result.incoming} rows → ${total} total`);
  } else {
    const dates = await parquetDistinct(PARQUET_FILE, "date");
    gate(dates.length > 0, "no new reports and no existing parquet — nothing ingested");
    vintage = dates[dates.length - 1];
    total = -1;
    console.log(`psp-daily: up to date (vintage ${vintage}), nothing new to ingest`);
  }
  // Stale-data guard: the newest available report must be recent (publisher lags ~1 day).
  gate(
    vintage >= isoDate(addDays(istToday(), -7)),
    `latest available PSP report (${vintage}) is more than 7 days old — source may have moved`,
  );

  writeManifest({
    id: "psp-daily",
    schema: SCHEMA,
    source: {
      name: "Grid-India (Grid Controller of India, NLDC) — Daily Power Supply Position report",
      url: "https://grid-india.in/en/reports/daily-psp-report",
    },
    licence:
      "Official public report published under IEGC 2023 Art. 38(1); © Grid-India. Informational reuse with attribution; not for commercial redistribution.",
    attribution: "Data: Grid Controller of India Ltd (Grid-India), National Load Despatch Centre",
    cadence: "daily",
    vintage,
    lastSuccess: new Date().toISOString(),
    paths: ["timeseries/psp-daily.parquet"],
  });
}

main().catch((err) => {
  console.error("psp-daily pipeline failed:", err);
  process.exit(1);
});
