// Dataset-manifest client for the pipeline outputs on the dedicated `data` branch.
// Consumers bind to manifest ids only — never to raw source URLs (DSS revamp spec §2).
// Everything degrades to null/"missing": a workspace must render stale-not-broken.

const DEFAULT_DATA_REPO = "gsuryaias/ap-gis-grid";
const DEFAULT_DATA_BRANCH = "data";
const DEFAULT_DATA_BRANCH_BASE = `https://raw.githubusercontent.com/${DEFAULT_DATA_REPO}/${DEFAULT_DATA_BRANCH}/`;

/** Raw-content base of the data branch (CORS-clean; pipelines commit here, never to main). */
export const DATA_BRANCH_BASE: string = (() => {
  const override = import.meta.env.VITE_DATA_BRANCH?.trim();
  if (!override) return DEFAULT_DATA_BRANCH_BASE;
  if (override.startsWith("http://") || override.startsWith("https://")) {
    return override.endsWith("/") ? override : `${override}/`;
  }
  // `owner/repo` → that repo's `data` branch (fork deploys).
  if (override.includes("/")) {
    const [owner, repo] = override.split("/", 2);
    return `https://raw.githubusercontent.com/${owner}/${repo}/${DEFAULT_DATA_BRANCH}/`;
  }
  // Branch name only → same default repo, custom branch.
  return `https://raw.githubusercontent.com/${DEFAULT_DATA_REPO}/${override}/`;
})();

export type Cadence = "15min" | "daily" | "weekly" | "monthly" | "annual" | "static" | "one-time";

export interface DatasetSource {
  name: string;
  url: string;
}

export interface DatasetManifest {
  id: string;
  /** Column name → type, as emitted by the pipeline. */
  schema: Record<string, string>;
  source: DatasetSource;
  licence: string;
  attribution: string;
  cadence: Cadence;
  /** Human-readable vintage of the data itself, e.g. "2026-06-10" or "FY 2025-26". */
  vintage: string;
  /** ISO timestamp of the last successful pipeline run. */
  lastSuccess: string;
  /** Output files, relative to DATA_BRANCH_BASE (e.g. "timeseries/psp-daily.parquet"). */
  paths: string[];
  /** Total rows in the emitted dataset (optional; integrity gates use this when present). */
  rowCount?: number;
  /** Open GitHub Issue URL when a labelled pipeline-failure issue exists. */
  pipelineFailureIssueUrl?: string;
}

/** Lower-bound integrity gates per manifest id (mirrors etl.test.ts emitted-data checks). */
export const MANIFEST_GATES: Record<string, { schema: Record<string, string>; minRowCount?: number }> = {
  "psp-daily": {
    schema: {
      date: "DATE",
      entity: "VARCHAR",
      entity_type: "VARCHAR",
      energy_met_mu: "DOUBLE",
      energy_shortage_mu: "DOUBLE",
      max_demand_met_mw: "DOUBLE",
      peak_shortage_mw: "DOUBLE",
      evening_peak_demand_mw: "DOUBLE",
      source_file: "VARCHAR",
    },
    minRowCount: 40,
  },
  "vidyut-daily": {
    schema: {
      date: "DATE",
      state: "VARCHAR",
      demand_met_mw: "DOUBLE",
      peak_shortage_mw: "DOUBLE",
      peak_shortage_pct: "DOUBLE",
      energy_shortage_mu: "DOUBLE",
      energy_shortage_pct: "DOUBLE",
      exchange_price_inr_kwh: "DOUBLE",
    },
    minRowCount: 1,
  },
  "cea-monthly": {
    schema: {
      month: "DATE",
      region_state: "VARCHAR",
      source: "VARCHAR",
      generation_mu: "DOUBLE",
      share_pct: "DOUBLE",
      fy: "VARCHAR",
    },
    minRowCount: 20,
  },
};

/** Fetches `manifests/<id>.json` from the data branch; null on ANY failure — never throws. */
export async function loadManifest(id: string): Promise<DatasetManifest | null> {
  try {
    const res = await fetch(`${DATA_BRANCH_BASE}manifests/${id}.json`);
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    return validateManifest(raw) ? raw : null;
  } catch {
    return null;
  }
}

const CADENCE_SET = new Set<Cadence>(["15min", "daily", "weekly", "monthly", "annual", "static", "one-time"]);

export function isDatasetSource(v: unknown): v is DatasetSource {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as DatasetSource).name === "string" &&
    (v as DatasetSource).name.length > 0 &&
    typeof (v as DatasetSource).url === "string" &&
    (v as DatasetSource).url.length > 0
  );
}

/** Runtime schema check for a fetched or fixture manifest. */
export function validateManifest(m: unknown): m is DatasetManifest {
  if (!m || typeof m !== "object") return false;
  const o = m as DatasetManifest;
  if (typeof o.id !== "string" || o.id.length === 0) return false;
  if (!o.schema || typeof o.schema !== "object" || Array.isArray(o.schema)) return false;
  for (const [col, type] of Object.entries(o.schema)) {
    if (typeof col !== "string" || col.length === 0 || typeof type !== "string" || type.length === 0) return false;
  }
  if (!isDatasetSource(o.source)) return false;
  if (typeof o.licence !== "string" || o.licence.length === 0) return false;
  if (typeof o.attribution !== "string" || o.attribution.length === 0) return false;
  if (!CADENCE_SET.has(o.cadence)) return false;
  if (typeof o.vintage !== "string" || o.vintage.length === 0) return false;
  if (typeof o.lastSuccess !== "string" || o.lastSuccess.length === 0) return false;
  if (!Array.isArray(o.paths) || o.paths.length === 0 || !o.paths.every((p) => typeof p === "string" && p.length > 0)) {
    return false;
  }
  if (o.rowCount !== undefined && (!Number.isFinite(o.rowCount) || o.rowCount < 0)) return false;
  if (
    o.pipelineFailureIssueUrl !== undefined &&
    (typeof o.pipelineFailureIssueUrl !== "string" || !o.pipelineFailureIssueUrl.startsWith("http"))
  ) {
    return false;
  }
  return true;
}

/** CI gate: manifest matches the registered schema and optional row-count lower bound. */
export function gateManifest(m: DatasetManifest): void {
  const gate = MANIFEST_GATES[m.id];
  if (!gate) return;
  for (const [col, type] of Object.entries(gate.schema)) {
    if (m.schema[col] !== type) {
      throw new Error(`[manifest gate] ${m.id}: expected schema ${col}:${type}, got ${m.schema[col] ?? "missing"}`);
    }
  }
  if (gate.minRowCount !== undefined && m.rowCount !== undefined && m.rowCount < gate.minRowCount) {
    throw new Error(`[manifest gate] ${m.id}: rowCount ${m.rowCount} < ${gate.minRowCount}`);
  }
}

export function sourceName(m: DatasetManifest | null): string {
  return m?.source.name ?? "—";
}

const CADENCE_MS: Record<Cadence, number> = {
  "15min": 15 * 60_000,
  daily: 86_400_000,
  weekly: 7 * 86_400_000,
  // Generous month/year lengths so a normal publication lag never trips the badge.
  monthly: 31 * 86_400_000,
  annual: 366 * 86_400_000,
  static: Number.POSITIVE_INFINITY,
  "one-time": Number.POSITIVE_INFINITY,
};

/**
 * Freshness of a dataset at `now` (ms epoch): stale once `now − lastSuccess` exceeds twice the
 * refresh cadence; "static"/"one-time" datasets never go stale; a null manifest or an unparseable
 * `lastSuccess` is "missing".
 */
export function staleness(m: DatasetManifest | null, now: number): "fresh" | "stale" | "missing" {
  if (!m) return "missing";
  if (m.cadence === "static" || m.cadence === "one-time") return "fresh";
  const t = Date.parse(m.lastSuccess);
  if (!Number.isFinite(t)) return "missing";
  return now - t > 2 * CADENCE_MS[m.cadence] ? "stale" : "fresh";
}
