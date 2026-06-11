import { FreshnessBadge } from "./FreshnessBadge.tsx";
import type { DatasetManifest } from "../data/manifests.ts";

/** Provenance footer for a workspace metric (DSS spec §1 — metric, source, vintage, method, limitation). */
export function MethodCard({
  metric,
  source,
  method,
  limitation,
  manifest,
  vintage,
}: {
  metric: string;
  source: string;
  method: string;
  limitation: string;
  /** When set, vintage row uses FreshnessBadge from the manifest. */
  manifest?: DatasetManifest | null;
  /** Plain vintage label when no manifest is available. */
  vintage?: string;
}) {
  return (
    <section className="rounded-[var(--radius-panel)] border border-line bg-surface-2/80 p-4">
      <dl className="space-y-1.5 text-[11px] leading-relaxed text-ink-2">
        <div>
          <dt className="inline font-semibold text-ink">Metric: </dt>
          <dd className="inline">{metric}</dd>
        </div>
        <div>
          <dt className="inline font-semibold text-ink">Source: </dt>
          <dd className="inline">{source}</dd>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <dt className="font-semibold text-ink">Vintage: </dt>
          <dd className="inline-flex items-center gap-1.5">
            {manifest ? <FreshnessBadge manifest={manifest} /> : vintage ? <span>{vintage}</span> : <span>—</span>}
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold text-ink">Method: </dt>
          <dd className="inline">{method}</dd>
        </div>
        <div>
          <dt className="inline font-semibold text-ink">Limitation: </dt>
          <dd className="inline">{limitation}</dd>
        </div>
      </dl>
    </section>
  );
}
