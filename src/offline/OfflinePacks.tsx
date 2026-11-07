// Field lens: "Save circle for offline" (Atlas 2.0 phase 4 PR 14) — pick a circle, download its pack
// with progress + size, see saved packs (up to date / update available), update or delete them.
import { useEffect, useMemo, useState } from "react";
import { useResource } from "../data/resources.ts";
import { haversineMeters } from "../lib/geo.ts";
import { formatBytes as fmtMb } from "../overlays/catalog.ts";

const formatBytes = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : fmtMb(n));
import { useAppStore } from "../state/store.ts";
import { circleBBox } from "./plan.ts";
import { DownloadIcon, TrashIcon } from "../components/icons.tsx";
import {
  cancelPack,
  deletePack,
  dismissPackJob,
  offlinePacks,
  useOfflineSupported,
  packBytes,
  sharedBytes,
  planUrls,
  savePack,
  staleCount,
  usePackJob,
  type PackRecord,
} from "./packs.ts";

const btn = "inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50";

function useEnabledOverlays(): string[] {
  const enabled = useAppStore((s) => s.layers.enabled);
  return useMemo(() => Object.keys(enabled).filter((k) => enabled[k]).sort(), [enabled]);
}

/** The circle to offer first: the filtered one, else the circle of the substation nearest the map centre. */
function useDefaultCircle(): string | null {
  const data = useAppStore((s) => s.data);
  const circle = useAppStore((s) => s.filters.circle);
  const camera = useAppStore((s) => s.camera);
  return useMemo(() => {
    if (circle) return circle;
    if (!data) return null;
    if (camera) {
      let best: { d: number; c: string } | null = null;
      for (const s of data.substations) {
        if (!s.circle) continue;
        const d = haversineMeters([camera.lng, camera.lat], [s.lng, s.lat]);
        if (!best || d < best.d) best = { d, c: s.circle };
      }
      if (best) return best.c;
    }
    return data.meta.circles[0] ?? null;
  }, [data, circle, camera]);
}

export function OfflinePacks() {
  const data = useAppStore((s) => s.data);
  const basemap = useAppStore((s) => s.basemap);
  const enabled = useEnabledOverlays();
  const fallback = useDefaultCircle();
  const [picked, setPicked] = useState<string | null>(null);
  const circle = picked ?? fallback;
  const job = usePackJob();
  const packs = useResource(offlinePacks, "");
  const [error, setError] = useState<string | null>(null);
  const supported = useOfflineSupported();
  const circles = useMemo(() => (data ? data.meta.circles.filter((c) => circleBBox(data.substations, c)) : []), [data]);

  // Up-to-date check: each saved pack against what it would download now.
  const [stale, setStale] = useState<Record<string, number>>({});
  const saved = useMemo(() => Object.values(packs.data?.packs ?? {}).sort((a, b) => a.circle.localeCompare(b.circle)), [packs.data]);
  useEffect(() => {
    if (!data || !saved.length) return;
    let live = true;
    Promise.all(saved.map(async (p) => [p.circle, staleCount(p, await planUrls(data, p.circle, basemap, enabled))] as const))
      .then((rows) => live && setStale(Object.fromEntries(rows)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [data, saved, basemap, enabled]);

  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  useEffect(() => {
    navigator.storage
      ?.estimate?.()
      .then((e) => setUsage({ usage: e.usage ?? 0, quota: e.quota ?? 0 }))
      .catch(() => undefined);
  }, [packs.data, job?.state]);

  if (!data) return null;
  const running = job?.state === "running";

  const save = async (c: string) => {
    setError(null);
    try {
      await savePack(await planUrls(data, c, basemap, enabled), c);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {!supported ? (
        <p className="px-1 text-[11px] leading-snug text-ink-2">
          Offline packs need the installed site: open the published app once while online (they are not available in the dev server).
        </p>
      ) : (
        <div className="flex items-center gap-1.5">
          <label htmlFor="offline-circle" className="sr-only">
            Circle to save for offline use
          </label>
          <select
            id="offline-circle"
            value={circle ?? ""}
            onChange={(e) => setPicked(e.target.value)}
            disabled={running}
            className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-sm text-ink"
          >
            {circles.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!circle || running}
            onClick={() => circle && save(circle)}
            className={`${btn} border-accent bg-accent text-on-accent hover:opacity-90`}
          >
            <DownloadIcon width={14} height={14} />
            Save for offline
          </button>
        </div>
      )}

      {job && <JobStatus job={job} />}
      {error && (
        <p role="alert" className="px-1 text-[11px] font-medium text-ink">
          Couldn't save: {error}
        </p>
      )}

      {saved.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Saved offline packs">
          {saved.map((p) => (
            <PackRow key={p.circle} rec={p} bytes={packBytes(packs.data!, p)} stale={stale[p.circle]} busy={running} onUpdate={() => save(p.circle)} />
          ))}
        </ul>
      )}
      {saved.length > 0 && packs.data && (
        <p className="px-1 text-[11px] text-ink-2">Statewide files shared by every pack: {formatBytes(sharedBytes(packs.data)) || "0 KB"}.</p>
      )}

      <p className="px-1 text-[11px] leading-snug text-ink-2">
        A pack holds the circle's grid, towers, 33 kV and 11 kV networks and highways, rail and mandals for context, plus
        search and the Inspector's details. The first pack also stores the statewide files (≈ 46 MB on the device); each
        further circle adds 3–12 MB of tiles. Basemap streets show offline only where you've already looked, and transformer-code search needs a
        connection.
        {usage && usage.quota > 0 && ` Storage in use: ${formatBytes(usage.usage) || "0 KB"} of ${formatBytes(usage.quota)}.`}
      </p>
    </div>
  );
}

function JobStatus({ job }: { job: NonNullable<ReturnType<typeof usePackJob>> }) {
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  if (job.state === "running")
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface-2 p-2">
        <div className="flex items-center gap-2 text-xs text-ink">
          <span className="flex-1">
            Saving {job.circle}… {job.done.toLocaleString("en-IN")} / {job.total.toLocaleString("en-IN")} files
            {job.bytes > 0 && ` · ${formatBytes(job.bytes)}`}
          </span>
          <button type="button" onClick={cancelPack} className={`${btn} border-line text-ink hover:bg-surface-3`}>
            Cancel
          </button>
        </div>
        <div role="progressbar" aria-label={`Saving ${job.circle} for offline`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  const text =
    job.state === "done"
      ? `${job.circle} saved for offline${job.bytes ? ` · ${formatBytes(job.bytes)} downloaded` : " · already up to date"}${job.failed ? ` · ${job.failed} files failed — update to retry` : ""}.`
      : job.state === "cancelled"
        ? `Saving ${job.circle} was cancelled — what was downloaded is kept; save again to finish.`
        : `Saving ${job.circle} failed: ${job.error ?? "unknown error"}.`;
  return (
    <p role="status" className="flex items-start gap-2 rounded-lg border border-line bg-surface-2 p-2 text-xs text-ink">
      <span className="flex-1">{text}</span>
      <button type="button" onClick={dismissPackJob} className="text-ink-2 underline hover:text-ink">
        Dismiss
      </button>
    </p>
  );
}

function PackRow({ rec, bytes, stale, busy, onUpdate }: { rec: PackRecord; bytes: number; stale?: number; busy: boolean; onUpdate: () => void }) {
  const when = new Date(rec.savedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const behind = (stale ?? 0) > 0 || rec.failed > 0;
  return (
    <li className="flex items-center gap-2 rounded-lg border border-line px-2 py-1.5 text-xs">
      <span className="min-w-0 flex-1">
        <span className="font-medium text-ink">{rec.circle}</span>
        <span className="block text-[11px] text-ink-2">
          {formatBytes(bytes) || "0 KB"} of tiles · saved {when} ·{" "}
          {stale == null ? "checking…" : behind ? `update available (${(stale + rec.failed).toLocaleString("en-IN")} files)` : "up to date"}
        </span>
      </span>
      {behind && (
        <button type="button" disabled={busy} onClick={onUpdate} className={`${btn} border-line text-ink hover:bg-surface-2`}>
          Update
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void deletePack(rec.circle)}
        aria-label={`Delete the ${rec.circle} offline pack`}
        className={`${btn} border-line text-ink-2 hover:bg-surface-2 hover:text-ink`}
      >
        <TrashIcon width={14} height={14} />
      </button>
    </li>
  );
}
