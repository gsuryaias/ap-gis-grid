// Pipeline: Vidyut Pravah AP 15-min exchange block → timeseries/vidyut-blocks.parquet
//
// Captures the live CURRENT demand and exchange price for the active 15-min block
// shown on the state dashboard. Parsing is the pure, fixture-tested parser in
// vidyut-parse.ts; the parquet merge replaces same-key rows, so re-runs for the
// same block never duplicate.
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
import { parseVidyutBlockHtml } from "./vidyut-parse.ts";

const PAGE_URL = "https://vidyutpravah.in/state-data/andhra-pradesh";
const PARQUET_FILE = join(TIMESERIES_DIR, "vidyut-blocks.parquet");

const SCHEMA: Record<string, string> = {
  date: "DATE",
  state: "VARCHAR",
  block_start: "VARCHAR",
  block_end: "VARCHAR",
  demand_mw: "DOUBLE",
  exchange_price: "DOUBLE",
};

async function main(): Promise<void> {
  const html = await fetchText(PAGE_URL);
  const row = parseVidyutBlockHtml(html);

  gate(row.state === "Andhra Pradesh", `expected Andhra Pradesh page, got "${row.state}"`);
  gate(row.demand_mw !== null && row.demand_mw > 500, `implausible AP block demand (${row.demand_mw} MW)`);
  const today = istToday();
  gate(
    row.date >= isoDate(addDays(today, -1)) && row.date <= isoDate(today),
    `block date ${row.date} is not today or yesterday — page layout may have changed`,
  );

  const result = await upsertParquet({
    file: PARQUET_FILE,
    rows: [{ ...row }],
    schema: SCHEMA,
    keyColumns: ["date", "state", "block_start"],
    orderBy: ["date", "block_start"],
  });
  console.log(
    `vidyut-blocks: captured ${row.date} ${row.block_start}–${row.block_end} (demand ${row.demand_mw} MW) → ${result.total} total rows`,
  );

  writeManifest({
    id: "vidyut-blocks",
    schema: SCHEMA,
    source: {
      name: "Vidyut Pravah (Ministry of Power) — Andhra Pradesh 15-min exchange block snapshot",
      url: PAGE_URL,
    },
    licence:
      "Official public dashboard, Ministry of Power (GoI); informational use only per site disclaimer. Attribution required.",
    attribution: "Data: Vidyut Pravah, Ministry of Power, Government of India",
    cadence: "daily",
    vintage: row.date,
    lastSuccess: new Date().toISOString(),
    paths: ["timeseries/vidyut-blocks.parquet"],
  });
}

main().catch((err) => {
  console.error("vidyut-blocks pipeline failed:", err);
  process.exit(1);
});
