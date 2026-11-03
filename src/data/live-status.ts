import { useEffect, useState } from "react";

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
  discom?: Record<string, { substations: number; lines: number; lineKm: number }>;
}

/**
 * The publisher syncs every 6 h but only pushes on a network change or a daily heartbeat, so the
 * deployed `lastSuccess` can legitimately be up to ~24 h old. Older than this ⇒ flagged stale.
 */
export const STALE_AFTER_HOURS = 36;

export type LiveFreshness = "live" | "stale" | "snapshot";

export function liveFreshness(s: LiveStatus | null, now = Date.now()): LiveFreshness {
  if (!s?.lastSuccess) return "snapshot";
  const ageH = (now - Date.parse(s.lastSuccess)) / 3_600_000;
  return ageH <= STALE_AFTER_HOURS ? "live" : "stale";
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

// ---- module-level cache + background poll ------------------------------------------------------
let cached: LiveStatus | null = null;
let inflight: Promise<LiveStatus | null> | null = null;
const listeners = new Set<() => void>();
const POLL_MS = 15 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

async function fetchStatus(): Promise<LiveStatus | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/live-status.json`, { cache: "no-cache" });
    if (!res.ok) return cached;
    const s = (await res.json()) as LiveStatus;
    cached = s;
    listeners.forEach((l) => l());
    return s;
  } catch {
    return cached;
  }
}

function ensure(): void {
  if (!cached && !inflight) inflight = fetchStatus().finally(() => (inflight = null));
  if (!timer && typeof window !== "undefined") {
    timer = setInterval(() => {
      if (document.visibilityState === "visible") void fetchStatus();
    }, POLL_MS);
  }
}

/** Live-sync status (fetched once, re-polled every 15 min while the tab is visible). */
export function useLiveStatus(): LiveStatus | null {
  const [s, set] = useState<LiveStatus | null>(cached);
  useEffect(() => {
    const l = () => set(cached);
    listeners.add(l);
    ensure();
    l();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return s;
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
