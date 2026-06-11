// Pipeline: Vidyut Pravah (Ministry of Power) AP snapshot → timeseries/vidyut-daily.parquet
//
// vidyutpravah.in is a live dashboard; its "YESTERDAY" figures are the stable
// previous-day values, so one capture per day yields a clean daily series
// (demand met, peak/energy shortage, exchange price for Andhra Pradesh).
// Parsing is the pure, fixture-tested parser in vidyut-parse.ts; the parquet
// merge replaces same-key rows, so re-runs for the same date never duplicate.
import { join } from "node:path";
import {
  TIMESERIES_DIR,
  gate,
  fetchText,
  istToday,
  addDays,
  isoDate,
  upsertParquet,
  writeManifest,
} from "./lib.ts";
import { parseVidyutStateHtml } from "./vidyut-parse.ts";

const PAGE_URL = "https://vidyutpravah.in/state-data/andhra-pradesh";
const PARQUET_FILE = join(TIMESERIES_DIR, "vidyut-daily.parquet");

const SCHEMA: Record<string, string> = {
  date: "DATE",
  state: "VARCHAR",
  demand_met_mw: "DOUBLE",
  peak_shortage_mw: "DOUBLE",
  peak_shortage_pct: "DOUBLE",
  energy_shortage_mu: "DOUBLE",
  energy_shortage_pct: "DOUBLE",
  exchange_price_inr_kwh: "DOUBLE",
};

async function main(): Promise<void> {
  const html = await fetchText(PAGE_URL);
  const row = parseVidyutStateHtml(html);

  gate(row.state === "Andhra Pradesh", `expected Andhra Pradesh page, got "${row.state}"`);
  gate(
    row.demand_met_mw !== null && row.demand_met_mw > 1000,
    `implausible AP demand met (${row.demand_met_mw} MW)`,
  );
  const today = istToday();
  gate(
    row.date >= isoDate(addDays(today, -3)) && row.date <= isoDate(today),
    `snapshot date ${row.date} is not within the last 3 days — page layout may have changed`,
  );

  const result = await upsertParquet({
    file: PARQUET_FILE,
    rows: [{ ...row }],
    schema: SCHEMA,
    keyColumns: ["date", "state"],
  });
  console.log(
    `vidyut-daily: captured ${row.date} (demand met ${row.demand_met_mw} MW) → ${result.total} total rows`,
  );

  writeManifest({
    id: "vidyut-daily",
    schema: SCHEMA,
    source: {
      name: "Vidyut Pravah (Ministry of Power, Government of India) — Andhra Pradesh state snapshot",
      url: PAGE_URL,
    },
    licence:
      "Official public dashboard, Ministry of Power (GoI); informational use only per site disclaimer. Attribution required.",
    attribution: "Data: Vidyut Pravah, Ministry of Power, Government of India",
    cadence: "daily",
    vintage: result.maxKey,
    lastSuccess: new Date().toISOString(),
    paths: ["timeseries/vidyut-daily.parquet"],
  });
}

main().catch((err) => {
  console.error("vidyut-daily pipeline failed:", err);
  process.exit(1);
});
