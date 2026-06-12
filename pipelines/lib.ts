// Shared helpers for the data pipelines (fetch → parse → validate → append/emit).
// Mirrors the ETL conventions: pure logic kept testable, hard `assert`-style validation
// gates that fail the run loudly, and outputs written to the git-ignored data-branch/
// working dir (published to the dedicated `data` branch by CI, never to main).
import { mkdirSync, writeFileSync, existsSync, renameSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tls from "node:tls";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import { DuckDBInstance } from "@duckdb/node-api";

/** Path to intermediate CAs for Indian gov hosts that serve incomplete TLS chains. */
export const EXTRA_CA_PATH = join(dirname(fileURLToPath(import.meta.url)), "certs", "extra-cas.pem");

/** System trust store + `extra-cas.pem` (comment lines stripped — Linux OpenSSL rejects them). */
export function mergedCaBundle(): string[] | undefined {
  if (!existsSync(EXTRA_CA_PATH)) return undefined;
  const extra = readFileSync(EXTRA_CA_PATH, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("#") && line.trim().length > 0)
    .join("\n");
  if (!extra.includes("BEGIN CERTIFICATE")) return undefined;
  const cas: string[] = [];
  if (typeof tls.getCACertificates === "function") {
    for (const buf of tls.getCACertificates("default")) cas.push(buf.toString());
  }
  cas.push(extra);
  return cas;
}

const tlsDispatcher = (() => {
  const ca = mergedCaBundle();
  return ca ? new Agent({ connect: { ca } }) : undefined;
})();

/** Root of the pipeline working dir (synced onto the `data` branch by CI). */
export const DATA_DIR = resolve(process.cwd(), "data-branch");
export const TIMESERIES_DIR = join(DATA_DIR, "timeseries");
export const MANIFESTS_DIR = join(DATA_DIR, "manifests");

/** Hard validation gate, same style as the ETL's asserts: fail the whole run loudly. */
export function gate(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[validation gate] ${message}`);
}

// ---------------------------------------------------------------------------
// Fetch helpers (retry + timeout; all sources are keyless public endpoints)
// ---------------------------------------------------------------------------

export interface FetchOptions {
  retries?: number;
  timeoutMs?: number;
  init?: RequestInit;
}

/** fetch() with timeout (AbortSignal) and exponential-backoff retries on network/5xx errors. */
export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<Response> {
  const { retries = 3, timeoutMs = 60_000, init } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2_000 * 2 ** (attempt - 1)));
    try {
      const req: UndiciRequestInit = {
        ...(init as UndiciRequestInit | undefined),
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: tlsDispatcher,
      };
      const res = await undiciFetch(url, req);
      if (res.status >= 500) {
        lastError = new Error(`HTTP ${res.status} for ${url}`);
        continue; // retry server errors
      }
      return res as unknown as Response;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`fetch failed after ${retries + 1} attempts: ${url} — ${String(lastError)}`);
}

export async function fetchBytes(url: string, opts: FetchOptions = {}): Promise<Uint8Array> {
  const res = await fetchWithRetry(url, opts);
  gate(res.ok, `HTTP ${res.status} downloading ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const res = await fetchWithRetry(url, opts);
  gate(res.ok, `HTTP ${res.status} fetching ${url}`);
  return await res.text();
}

/** POST a JSON body, return the parsed JSON response (used by the Grid-India listing API). */
export async function postJson<T>(url: string, body: unknown, opts: FetchOptions = {}): Promise<T> {
  const res = await fetchWithRetry(url, {
    ...opts,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...opts.init,
    },
  });
  gate(res.ok, `HTTP ${res.status} from ${url}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// IST date helpers (all sources publish on an India-time daily cadence)
// ---------------------------------------------------------------------------

const IST_OFFSET_MS = 5.5 * 3_600_000;

/** Current date in IST as a UTC-midnight Date (safe for date-only arithmetic). */
export function istToday(now = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Format a UTC-midnight Date as YYYY-MM-DD. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Indian fiscal year label for a date, e.g. 2026-06-09 → "2026-27" (FY runs Apr–Mar). */
export function fiscalYear(date: Date): string {
  const y = date.getUTCFullYear();
  const startYear = date.getUTCMonth() + 1 >= 4 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Manifest writer (the consumer-facing dataset contract, per the DSS design spec)
// ---------------------------------------------------------------------------

/** Aligned with `DatasetManifest` in `src/data/manifests.ts` (the consumer contract). */
export interface Manifest {
  id: string;
  /** Column name → DuckDB type, exactly the schema of the emitted parquet. */
  schema: Record<string, string>;
  source: { name: string; url: string };
  licence: string;
  attribution: string;
  cadence: "15min" | "daily" | "weekly" | "monthly" | "annual" | "static" | "one-time";
  /** Latest data date present in the dataset (YYYY-MM-DD). */
  vintage: string;
  /** ISO timestamp of the last successful pipeline run. */
  lastSuccess: string;
  /** Paths relative to the data branch root. */
  paths: string[];
  /** Total rows after the merge (optional; enables client-side integrity gates). */
  rowCount?: number;
  /** Open GitHub Issue URL when a labelled pipeline-failure issue exists. */
  pipelineFailureIssueUrl?: string;
}

export function writeManifest(manifest: Manifest): string {
  mkdirSync(MANIFESTS_DIR, { recursive: true });
  const file = join(MANIFESTS_DIR, `${manifest.id}.json`);
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  return file;
}

// ---------------------------------------------------------------------------
// Parquet upsert via DuckDB SQL (idempotent merge on key columns)
// ---------------------------------------------------------------------------

export interface UpsertResult {
  /** Rows in the incoming batch. */
  incoming: number;
  /** Total rows in the parquet after the merge. */
  total: number;
  /** Max value of the first key column (the vintage for date-keyed series). */
  maxKey: string;
}

/**
 * Merge `rows` into a parquet file: incoming rows replace any existing rows with the
 * same key (so re-running for the same date never duplicates), everything else is kept.
 * The whole merge is done in DuckDB SQL and the file is atomically replaced.
 */
export async function upsertParquet(opts: {
  file: string;
  rows: Record<string, unknown>[];
  /** Column name → DuckDB type (also documents the schema in the manifest). */
  schema: Record<string, string>;
  keyColumns: string[];
  orderBy?: string[];
}): Promise<UpsertResult> {
  const { file, rows, schema, keyColumns, orderBy = keyColumns } = opts;
  gate(rows.length > 0, "upsertParquet called with an empty batch");
  for (const key of keyColumns) gate(key in schema, `key column ${key} missing from schema`);

  mkdirSync(dirname(file), { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const jsonFile = join(tmpdir(), `pipeline-rows-${stamp}.json`);
  const outFile = `${file}.tmp-${stamp}.parquet`;
  writeFileSync(jsonFile, JSON.stringify(rows));

  const sqlStr = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const columnSpec = Object.entries(schema)
    .map(([name, type]) => `${sqlStr(name)}: ${sqlStr(type)}`)
    .join(", ");
  const colList = Object.keys(schema).map((c) => `"${c}"`).join(", ");
  const keyMatch = keyColumns.map((k) => `old."${k}" = i."${k}"`).join(" AND ");
  const orderList = orderBy.map((c) => `"${c}"`).join(", ");

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    await conn.run(
      `CREATE TABLE incoming AS SELECT ${colList} FROM read_json(${sqlStr(jsonFile)}, format = 'array', columns = {${columnSpec}});`,
    );
    if (existsSync(file)) {
      await conn.run(
        `CREATE TABLE merged AS
           SELECT ${colList} FROM incoming
           UNION ALL
           SELECT ${colList} FROM read_parquet(${sqlStr(file)}) old
           WHERE NOT EXISTS (SELECT 1 FROM incoming i WHERE ${keyMatch});`,
      );
    } else {
      await conn.run(`CREATE TABLE merged AS SELECT ${colList} FROM incoming;`);
    }
    await conn.run(
      `COPY (SELECT * FROM merged ORDER BY ${orderList}) TO ${sqlStr(outFile)} (FORMAT PARQUET);`,
    );
    const stats = await conn.runAndReadAll(
      `SELECT count(*)::VARCHAR AS total, max("${keyColumns[0]}")::VARCHAR AS max_key FROM merged;`,
    );
    const [total, maxKey] = stats.getRows()[0] as [string, string];
    renameSync(outFile, file);
    return { incoming: rows.length, total: Number(total), maxKey };
  } finally {
    conn.closeSync();
    instance.closeSync();
    rmSync(jsonFile, { force: true });
    rmSync(outFile, { force: true });
  }
}

/** Distinct values of one column in an existing parquet (empty if the file doesn't exist). */
export async function parquetDistinct(file: string, column: string): Promise<string[]> {
  if (!existsSync(file)) return [];
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    const sqlFile = `'${file.replaceAll("'", "''")}'`;
    const reader = await conn.runAndReadAll(
      `SELECT DISTINCT "${column}"::VARCHAR AS v FROM read_parquet(${sqlFile}) ORDER BY v;`,
    );
    return reader.getRows().map((r) => String(r[0]));
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}
