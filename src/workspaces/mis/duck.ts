// In-browser SQL engine for the MIS workspace — DuckDB-WASM as a lazy singleton.
// The wasm bundle + worker come from the jsDelivr CDN (the standard static-site pattern:
// worker via a same-origin Blob shim, no vite config changes), and the two pipeline parquet
// files are registered by their raw data-branch URLs so queries read over HTTP.
// Everything is reached through `query<T>(sql)`; a failed init resets so a retry can succeed.
// Loaded ONLY inside the MIS chunk — the dynamic import below is what keeps duckdb-wasm out
// of the Atlas entry bundle.
import { DATA_BRANCH_BASE } from "../../data/manifests.ts";

type Duck = typeof import("@duckdb/duckdb-wasm");
type AsyncConnection = Awaited<ReturnType<import("@duckdb/duckdb-wasm").AsyncDuckDB["connect"]>>;

/** Registered file name (usable directly in SQL `FROM '…'`) → data-branch path. */
const PARQUET_FILES: Record<string, string> = {
  "psp-daily.parquet": "timeseries/psp-daily.parquet",
  "vidyut-daily.parquet": "timeseries/vidyut-daily.parquet",
  "cea-monthly.parquet": "timeseries/cea-monthly.parquet",
};

let connPromise: Promise<AsyncConnection> | null = null;

async function init(): Promise<AsyncConnection> {
  const duckdb: Duck = await import("@duckdb/duckdb-wasm");
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  // The CDN worker script is cross-origin; wrap it in a same-origin Blob that importScripts it.
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }),
  );
  const worker = new Worker(workerUrl);
  try {
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    // castBigIntToDouble: arrow BIGINT (count(*) etc.) arrives as plain JS numbers.
    await db.open({ path: ":memory:", query: { castBigIntToDouble: true } });
    for (const [name, path] of Object.entries(PARQUET_FILES)) {
      await db.registerFileURL(name, DATA_BRANCH_BASE + path, duckdb.DuckDBDataProtocol.HTTP, false);
    }
    return await db.connect();
  } catch (e) {
    worker.terminate();
    throw e;
  } finally {
    URL.revokeObjectURL(workerUrl);
  }
}

/**
 * Run one SQL statement and return plain row objects. Initialises the engine on first call;
 * if init fails the singleton resets, so the caller's retry re-attempts a full init.
 */
export async function query<T>(sql: string): Promise<T[]> {
  if (!connPromise) connPromise = init();
  let conn: AsyncConnection;
  try {
    conn = await connPromise;
  } catch (e) {
    connPromise = null;
    throw e;
  }
  const table = await conn.query(sql);
  return table.toArray().map((row) => row.toJSON() as T);
}
