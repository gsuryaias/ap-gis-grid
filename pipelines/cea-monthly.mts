// Pipeline: CEA monthly generation / energy-mix → timeseries/cea-monthly.parquet
//
// Sources (public, keyless JSON APIs documented at cea.nic.in):
//   - power_generation.php — All-India monthly generation by mode (values in BU)
//   - renewable_energy.php — state-wise RES breakdown (values in MU; AP + peers)
// Parsing is fixture-tested in cea-parse.ts; parquet merge is idempotent on
// (month, region_state, source).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TIMESERIES_DIR,
  gate,
  fetchText,
  upsertParquet,
  writeManifest,
} from "./lib.ts";
import {
  mergeCeaRows,
  parseCeaMonthlyHtml,
  parseCeaPowerGenerationJson,
  parseCeaRenewableJson,
  type CeaMonthlyRow,
} from "./cea-parse.ts";

const POWER_GEN_URL = "https://cea.nic.in/api/power_generation.php";
const RENEWABLE_URL = "https://cea.nic.in/api/renewable_energy.php";
const PARQUET_FILE = join(TIMESERIES_DIR, "cea-monthly.parquet");

/** Andhra Pradesh + national benchmark (DSS spec). */
const TARGET_REGIONS = ["Andhra Pradesh", "All India"];

const SCHEMA: Record<string, string> = {
  month: "DATE",
  region_state: "VARCHAR",
  source: "VARCHAR",
  generation_mu: "DOUBLE",
  share_pct: "DOUBLE",
  fy: "VARCHAR",
};

async function main(): Promise<void> {
  const [powerJson, renewableJson] = await Promise.all([
    fetchText(POWER_GEN_URL),
    fetchText(RENEWABLE_URL),
  ]);

  const powerRows = parseCeaPowerGenerationJson(
    JSON.parse(powerJson) as Parameters<typeof parseCeaPowerGenerationJson>[0],
  );
  const renewableRows = parseCeaRenewableJson(
    JSON.parse(renewableJson) as Parameters<typeof parseCeaRenewableJson>[0],
    TARGET_REGIONS,
  );

  const rows = mergeCeaRows(powerRows, renewableRows);

  gate(rows.length >= 20, `too few CEA rows after merge (${rows.length})`);

  const apRows = rows.filter((r) => r.region_state === "Andhra Pradesh");
  const aiRows = rows.filter((r) => r.region_state === "All India");
  gate(aiRows.length >= 12, `expected All India monthly mix rows, got ${aiRows.length}`);
  gate(apRows.length >= 4, `expected Andhra Pradesh RES rows, got ${apRows.length}`);

  const latestMonth = rows.map((r) => r.month).sort().at(-1)!;
  gate(/^\d{4}-\d{2}-01$/.test(latestMonth), `invalid latest month ${latestMonth}`);

  const apLatest = apRows.filter((r) => r.month === latestMonth);
  const apResMu = apLatest
    .filter((r) => r.source === "solar" || r.source === "wind")
    .reduce((s, r) => s + r.generation_mu, 0);
  gate(apResMu > 100, `implausible AP RES total for ${latestMonth} (${apResMu} MU)`);

  const result = await upsertParquet({
    file: PARQUET_FILE,
    rows: rows.map(toRecord),
    schema: SCHEMA,
    keyColumns: ["month", "region_state", "source"],
    orderBy: ["month", "region_state", "source"],
  });

  console.log(
    `cea-monthly: merged ${rows.length} rows (latest ${latestMonth}, AP RES ${Math.round(apResMu)} MU) → ${result.total} total`,
  );

  writeManifest({
    id: "cea-monthly",
    schema: SCHEMA,
    source: {
      name: "Central Electricity Authority (CEA) — monthly generation & renewable energy dashboards",
      url: POWER_GEN_URL,
    },
    licence:
      "Official public data, Government of India (CEA); informational use only. Attribution required.",
    attribution: "Data: Central Electricity Authority (CEA), Government of India",
    cadence: "monthly",
    vintage: latestMonth,
    lastSuccess: new Date().toISOString(),
    paths: ["timeseries/cea-monthly.parquet"],
    rowCount: result.total,
  });
}

function toRecord(row: CeaMonthlyRow): Record<string, unknown> {
  return {
    month: row.month,
    region_state: row.region_state,
    source: row.source,
    generation_mu: row.generation_mu,
    share_pct: row.share_pct,
    fy: row.fy,
  };
}

/** Local dry-run: `tsx pipelines/cea-monthly.mts --fixture` (no network). */
async function fixtureDryRun(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const power = JSON.parse(readFileSync(join(here, "fixtures/cea-power-generation-2024-2025.json"), "utf8"));
  const renewable = JSON.parse(readFileSync(join(here, "fixtures/cea-renewable-ap-2024-2025.json"), "utf8"));
  const html = readFileSync(join(here, "fixtures/cea-monthly-report-table.html"), "utf8");
  const rows = mergeCeaRows(
    parseCeaPowerGenerationJson(power),
    parseCeaMonthlyHtml(html),
    parseCeaRenewableJson(renewable, ["Andhra Pradesh"]),
  );
  console.log(`fixture dry-run: ${rows.length} rows, latest ${rows.map((r) => r.month).sort().at(-1)}`);
}

if (process.argv.includes("--fixture")) {
  fixtureDryRun().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error("cea-monthly pipeline failed:", err);
    process.exit(1);
  });
}
