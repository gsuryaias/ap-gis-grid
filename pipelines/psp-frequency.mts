// Pipeline: Grid-India daily PSP section B (frequency profile) → timeseries/psp-frequency.parquet
//
// Shares the same Grid-India listing + CDN fetch as psp-daily.mts; frequency rows are parsed
// from section B of the MOP_E sheet and net transnational exchange (daily mean MW) is attached
// to the All-India row from the TimeSeries sheet. Re-runs are idempotent.
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
import { parsePspXls, type PspFrequencyRow } from "./psp-parse.ts";

const LISTING_API = "https://webapi.grid-india.in/api/v1/file";
const CDN_BASE = "https://webcdn.grid-india.in/";
const PARQUET_FILE = join(TIMESERIES_DIR, "psp-frequency.parquet");
const MAX_BACKFILL_FILES = 40;

const SCHEMA: Record<string, string> = {
  date: "DATE",
  entity: "VARCHAR",
  entity_type: "VARCHAR",
  fvi: "DOUBLE",
  pct_lt_49_7: "DOUBLE",
  pct_49_7_49_8: "DOUBLE",
  pct_49_8_49_9: "DOUBLE",
  pct_lt_49_9: "DOUBLE",
  pct_49_9_50_05: "DOUBLE",
  pct_gt_50_05: "DOUBLE",
  interchange_mw: "DOUBLE",
  source_file: "VARCHAR",
};

interface ListingEntry {
  Title_: string;
  FilePath: string;
  MimeType: string;
}

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

function dateFromTitle(title: string): string | null {
  const m = title.trim().match(/^(\d{2})\.(\d{2})\.(\d{2})_NLDC_PSP$/);
  return m ? `20${m[3]}-${m[2]}-${m[1]}` : null;
}

async function main(): Promise<void> {
  const available = new Map<string, string>();
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

  const existing = new Set(await parquetDistinct(PARQUET_FILE, "date"));
  const pending = [...available.entries()]
    .filter(([date]) => !existing.has(date))
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, MAX_BACKFILL_FILES);

  const batch: (PspFrequencyRow & { source_file: string })[] = [];
  for (const [date, filePath] of pending) {
    const url = CDN_BASE + filePath;
    console.log(`  fetching frequency ${date} ← ${url}`);
    const parsed = parsePspXls(await fetchBytes(url));
    gate(
      parsed.dataDate === date,
      `date mismatch: listing says ${date}, sheet says ${parsed.dataDate} (${filePath})`,
    );
    const allIndia = parsed.frequencyRows.find((r) => r.entity === "All India");
    gate(allIndia, `All India frequency row missing from ${filePath}`);
    gate(
      allIndia.pct_49_9_50_05 !== null && allIndia.pct_49_9_50_05 > 0,
      `implausible compliance band (${allIndia.pct_49_9_50_05}%) in ${filePath}`,
    );
    batch.push(...parsed.frequencyRows.map((r) => ({ ...r, source_file: filePath })));
  }

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
    console.log(
      `psp-frequency: ingested ${pending.length} report(s), ${result.incoming} rows → ${total} total`,
    );
  } else {
    const dates = await parquetDistinct(PARQUET_FILE, "date");
    gate(dates.length > 0, "no new reports and no existing parquet — nothing ingested");
    vintage = dates[dates.length - 1];
    total = -1;
    console.log(`psp-frequency: up to date (vintage ${vintage}), nothing new to ingest`);
  }
  gate(
    vintage >= isoDate(addDays(istToday(), -7)),
    `latest available PSP frequency report (${vintage}) is more than 7 days old — source may have moved`,
  );

  writeManifest({
    id: "psp-frequency",
    schema: SCHEMA,
    source: {
      name: "Grid-India (NLDC) — Daily PSP report, section B frequency profile + TimeSeries net exchange",
      url: "https://grid-india.in/en/reports/daily-psp-report",
    },
    licence:
      "Official public report published under IEGC 2023 Art. 38(1); © Grid-India. Informational reuse with attribution; not for commercial redistribution.",
    attribution: "Data: Grid Controller of India Ltd (Grid-India), National Load Despatch Centre",
    cadence: "daily",
    vintage,
    lastSuccess: new Date().toISOString(),
    paths: ["timeseries/psp-frequency.parquet"],
  });
}

main().catch((err) => {
  console.error("psp-frequency pipeline failed:", err);
  process.exit(1);
});
