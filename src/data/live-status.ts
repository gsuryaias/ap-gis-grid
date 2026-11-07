import { dataUrl, defineResource, fetchJson, useResource } from "./resources.ts";

/** public/data/live-status.json — emitted by build-data from the live-sync manifest + changelog. */
export interface LiveLayerStatus {
  label: string;
  owner: string;
  group: "transco" | "discom";
  url: string;
  status: "ok" | "unchanged" | "rejected" | "error" | "skipped";
  message?: string;
  count: number | null;
  fetchedAt: string | null;
  lastChangedAt: string | null;
}

export interface LiveChange {
  at: string;
  layers: Array<{
    name: string;
    label: string;
    owner: string;
    before: number;
    after: number;
    added: number;
    removed: number;
    modified: number;
    samples: { added: string[]; removed: string[]; modified: string[] };
  }>;
}

export interface LiveStatus {
  generatedAt: string;
  source: string | null;
  lastRun: string | null;
  lastSuccess: string | null;
  layers: Record<string, LiveLayerStatus>;
  layerSources: Record<string, "live" | "snapshot">;
  changes: LiveChange[];
  discom?: Record<string, { substations: number; lines: number; lineKm: number; linesFrom?: string }>;
  network?: Record<"APEPDCL" | "APSPDCL", { feeders: number; km: number; feedersLinkedToSs: number; dtrs: number; dtrsSearchable: number; abSwitches: number;
    /** APSPDCL only: pole-survey route import (scripts/import-spdcl-11kv.mts) — export date, circles, skipped circles. */
    routesFrom?: string; routeCircles?: number; routeCirclesSkipped?: string[] }> & {
    searchItems: number;
  };
  towers?: {
    lastSuccess: string | null;
    layers: Record<string, { voltage: number; towers: number; lines: number; matchedLines: number; matchedTowers: number; fetchedAt: string; lastChangedAt: string | null }>;
  };
  connectivity?: {
    method: string;
    feeders: number;
    feedersLinked: number;
    transcoSsWithFeeders: number;
    discomSsTracedToTransco: number;
    byDiscom: Record<
      string,
      { feeders: number; feedersLinked: number; kmLinked: number; kmTotal: number; substations: number; substationsTracedToTransco: number }
    >;
  };
}

/**
 * Updates are run manually (`npm run update`), so "fresh" is generous: data synced within this
 * window shows a green dot, older shows amber (still correct — just not recently re-checked).
 */
export const STALE_AFTER_DAYS = 7;

export type LiveFreshness = "live" | "stale" | "snapshot";

export function liveFreshness(s: LiveStatus | null, now = Date.now()): LiveFreshness {
  if (!s?.lastSuccess) return "snapshot";
  const ageDays = (now - Date.parse(s.lastSuccess)) / 86_400_000;
  return ageDays <= STALE_AFTER_DAYS ? "live" : "stale";
}

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d} days ago` : new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

// ---- one resource, re-polled every 15 min while subscribed + visible -------------------------
/** `no-cache` → revalidate with the server every time (the SW also serves it network-first). */
export const liveStatus = defineResource<LiveStatus>("live-status", {
  load: (_p, signal) => fetchJson<LiveStatus>(dataUrl("live-status.json"), signal, { cache: "no-cache" }),
  refreshMs: 15 * 60 * 1000,
});

/** Live-sync status (fetched once, re-polled every 15 min while the tab is visible). */
export function useLiveStatus(): LiveStatus | null {
  return useResource(liveStatus).data ?? null;
}

/**
 * True when the deployed network data is newer than what this page has on screen — either a sync
 * deployed while the tab was open, or the service worker served a cached (stale) copy. Compares
 * the build time of the loaded network (`meta.generatedAt`) with the latest live-status build.
 */
export function useNewerDataAvailable(loadedGeneratedAt: string | null | undefined): boolean {
  const s = useLiveStatus();
  if (!s || !loadedGeneratedAt) return false;
  return Date.parse(s.generatedAt) - Date.parse(loadedGeneratedAt) > 10 * 60 * 1000;
}
