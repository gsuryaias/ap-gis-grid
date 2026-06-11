// Dataset-manifest client for the pipeline outputs on the dedicated `data` branch.
// Consumers bind to manifest ids only — never to raw source URLs (DSS revamp spec §2).
// Everything degrades to null/"missing": a workspace must render stale-not-broken.

/** Raw-content base of the `data` branch (CORS-clean; pipelines commit here, never to main). */
export const DATA_BRANCH_BASE = "https://raw.githubusercontent.com/gsuryaias/ap-gis-grid/data/";

export type Cadence = "daily" | "monthly" | "annual" | "static";

export interface DatasetManifest {
  id: string;
  /** Column name → type, as emitted by the pipeline. */
  schema: Record<string, string>;
  source: string;
  licence: string;
  attribution: string;
  cadence: Cadence;
  /** Human-readable vintage of the data itself, e.g. "2026-06-10" or "FY 2025-26". */
  vintage: string;
  /** ISO timestamp of the last successful pipeline run. */
  lastSuccess: string;
  /** Output files, relative to DATA_BRANCH_BASE (e.g. "timeseries/psp-daily.parquet"). */
  paths: string[];
}

/** Fetches `manifests/<id>.json` from the data branch; null on ANY failure — never throws. */
export async function loadManifest(id: string): Promise<DatasetManifest | null> {
  try {
    const res = await fetch(`${DATA_BRANCH_BASE}manifests/${id}.json`);
    if (!res.ok) return null;
    return (await res.json()) as DatasetManifest;
  } catch {
    return null;
  }
}

const CADENCE_MS: Record<Cadence, number> = {
  daily: 86_400_000,
  // Generous month/year lengths so a normal publication lag never trips the badge.
  monthly: 31 * 86_400_000,
  annual: 366 * 86_400_000,
  static: Number.POSITIVE_INFINITY,
};

/**
 * Freshness of a dataset at `now` (ms epoch): stale once `now − lastSuccess` exceeds twice the
 * refresh cadence; "static" datasets never go stale; a null manifest or an unparseable
 * `lastSuccess` is "missing".
 */
export function staleness(m: DatasetManifest | null, now: number): "fresh" | "stale" | "missing" {
  if (!m) return "missing";
  if (m.cadence === "static") return "fresh";
  const t = Date.parse(m.lastSuccess);
  if (!Number.isFinite(t)) return "missing";
  return now - t > 2 * CADENCE_MS[m.cadence] ? "stale" : "fresh";
}
