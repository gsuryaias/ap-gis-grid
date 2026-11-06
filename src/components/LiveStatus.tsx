import { useState } from "react";
import { Dialog } from "./Dialog.tsx";
import { liveFreshness, timeAgo, useLiveStatus, type LiveStatus } from "../data/live-status.ts";

const DOT: Record<string, string> = {
  live: "bg-emerald-500",
  stale: "bg-amber-500",
  snapshot: "bg-slate-400",
};

/** Header pill: "Synced · 2 h ago". Opens the sync status + change-log sheet. */
export function LiveStatusBadge() {
  const s = useLiveStatus();
  const [open, setOpen] = useState(false);
  const f = liveFreshness(s);
  const label = f === "snapshot" ? "Snapshot" : "Synced";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={s?.lastSuccess ? `Last synced from the AP-TRANSCO GIS: ${new Date(s.lastSuccess).toLocaleString("en-IN")}` : "Network data source"}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-2/70 px-2 py-1 text-[11px] font-medium text-ink hover:bg-surface-3"
      >
        <span className={`h-2 w-2 rounded-full ${DOT[f]}`} />
        {label}
        {s?.lastSuccess && <span className="text-ink-2">· {timeAgo(s.lastSuccess)}</span>}
      </button>
      {open && <LiveStatusSheet status={s} onClose={() => setOpen(false)} />}
    </>
  );
}

const STATUS_STYLE: Record<string, string> = {
  ok: "text-emerald-700 dark:text-emerald-300",
  unchanged: "text-ink-2",
  rejected: "text-amber-700 dark:text-amber-300",
  error: "text-red-600 dark:text-red-400",
  skipped: "text-ink-2",
};

function LiveStatusSheet({ status, onClose }: { status: LiveStatus | null; onClose: () => void }) {
  const layers = Object.entries(status?.layers ?? {});
  return (
    <Dialog
      label="Network data sync status"
      onClose={onClose}
      sheet
      className="flex max-h-[88dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-[var(--shadow-panel)] sm:rounded-2xl"
    >
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h2 className="text-sm font-bold text-ink">Network data sync</h2>
            <p className="mt-0.5 text-xs text-ink-2">
              Pulled from the AP-TRANSCO enterprise GIS{" "}
              {status?.source && <span className="break-all">({new URL(status.source).host})</span>}. Last successful sync{" "}
              <b className="text-ink">{timeAgo(status?.lastSuccess ?? null)}</b>
              {status?.lastSuccess && <> · {new Date(status.lastSuccess).toLocaleString("en-IN")}</>}.
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-ink-2 hover:bg-surface-2" aria-label="Close">
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          {!status && <p className="text-sm text-ink-2">Sync status unavailable — showing the bundled network snapshot.</p>}
          {layers.length > 0 && (
            <div tabIndex={0} className="-mx-1 overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-xs">
                <thead className="text-[10.5px] uppercase tracking-wide text-ink-2">
                  <tr>
                    <th className="px-1 py-1 font-semibold">Layer</th>
                    <th className="px-1 py-1 font-semibold">Owner</th>
                    <th className="px-1 py-1 text-right font-semibold">Features</th>
                    <th className="px-1 py-1 font-semibold">Last change</th>
                    <th className="px-1 py-1 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {layers.map(([k, l]) => (
                    <tr key={k} className="border-t border-line">
                      <td className="px-1 py-1.5 text-ink">{l.label}</td>
                      <td className="px-1 py-1.5 text-ink-2">{l.owner}</td>
                      <td className="px-1 py-1.5 text-right tabular-nums text-ink">{l.count?.toLocaleString("en-IN") ?? "—"}</td>
                      <td className="px-1 py-1.5 text-ink-2">{timeAgo(l.lastChangedAt)}</td>
                      <td className={`px-1 py-1.5 ${STATUS_STYLE[l.status] ?? ""}`} title={l.message}>
                        {l.status === "unchanged" ? "up to date" : l.status === "ok" ? "updated" : l.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-2">Recent changes</h3>
          {!status?.changes.length && (
            <p className="mt-1 text-xs text-ink-2">No network changes detected since sync began. Changes made in the source GIS appear here after the next update.</p>
          )}
          <ol className="mt-1 space-y-2">
            {status?.changes.map((c) => (
              <li key={c.at} className="rounded-lg border border-line p-2">
                <div className="text-[11px] font-semibold text-ink">{new Date(c.at).toLocaleString("en-IN")}</div>
                <ul className="mt-1 space-y-1">
                  {c.layers.map((l) => (
                    <li key={l.name} className="text-xs text-ink">
                      <span className="font-medium">{l.label}</span>{" "}
                      <span className="text-ink-2">
                        ({l.before.toLocaleString("en-IN")} → {l.after.toLocaleString("en-IN")})
                      </span>{" "}
                      {l.added > 0 && <span className="text-emerald-700 dark:text-emerald-300">+{l.added} </span>}
                      {l.removed > 0 && <span className="text-red-600 dark:text-red-400">−{l.removed} </span>}
                      {l.modified > 0 && <span className="text-amber-700 dark:text-amber-300">~{l.modified} edited</span>}
                      {(l.samples.added.length > 0 || l.samples.removed.length > 0) && (
                        <div className="mt-0.5 text-[11px] leading-snug text-ink-2">
                          {l.samples.added.length > 0 && <>New: {l.samples.added.slice(0, 6).join(", ")}{l.added > 6 ? "…" : ""}. </>}
                          {l.samples.removed.length > 0 && <>Removed: {l.samples.removed.slice(0, 6).join(", ")}{l.removed > 6 ? "…" : ""}.</>}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </div>
    </Dialog>
  );
}
