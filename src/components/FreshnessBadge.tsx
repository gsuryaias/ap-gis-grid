import { staleness, type DatasetManifest } from "../data/manifests.ts";

/**
 * Dataset-vintage pill for views derived from pipeline data (DSS revamp spec §1):
 * "as of <vintage>" when fresh, amber "stale" when lastSuccess exceeds 2× the cadence,
 * grey "no data" when the manifest is missing. Wave-2 workspaces reuse this as-is.
 */
export function FreshnessBadge({ manifest, now = Date.now() }: { manifest: DatasetManifest | null; now?: number }) {
  const state = staleness(manifest, now);
  if (state === "missing") {
    return (
      <span className="inline-flex items-center rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-ink-2">
        no data
      </span>
    );
  }
  if (state === "stale") {
    const issueUrl = manifest!.pipelineFailureIssueUrl;
    return (
      <span
        title={`Last successful update: ${manifest!.lastSuccess}`}
        className="inline-flex items-center gap-1 rounded-full bg-amber-100/70 px-2 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-500/15 dark:text-amber-200"
      >
        stale · as of {manifest!.vintage}
        {issueUrl ? (
          <>
            {" · "}
            <a
              href={issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-amber-700/50 hover:decoration-amber-900 dark:decoration-amber-200/50"
            >
              pipeline issue
            </a>
          </>
        ) : null}
      </span>
    );
  }
  return (
    <span
      title={`Last successful update: ${manifest!.lastSuccess}`}
      className="inline-flex items-center rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-ink-2"
    >
      as of {manifest!.vintage}
    </span>
  );
}
