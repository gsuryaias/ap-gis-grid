import type { GridData } from "../data/types.ts";
import { useAppStore } from "../state/store.ts";
import { CloseIcon } from "./icons.tsx";

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2 px-3.5 py-3">
      <div className="text-2xl font-semibold text-ink">{value}</div>
      <div className="text-xs font-medium text-ink-2">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-2/80">{hint}</div>}
    </div>
  );
}

export function DataQualityView({ data }: { data: GridData }) {
  const open = useAppStore((s) => s.qualityOpen);
  const toggle = useAppStore((s) => s.toggleQuality);
  if (!open) return null;
  const q = data.quality;

  return (
    <div
      className="absolute inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={() => toggle(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Data quality report"
    >
      <div
        className="max-h-full w-[640px] max-w-full overflow-auto rounded-[var(--radius-panel)] border border-line bg-surface p-5 shadow-[var(--shadow-panel)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-ink">Data quality & coverage</h2>
            <p className="text-sm text-ink-2">
              Built from {data.meta.source}. Generated {new Date(q.generatedAt).toLocaleString()}.
            </p>
          </div>
          <button onClick={() => toggle(false)} aria-label="Close" className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink">
            <CloseIcon />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          <Stat label="Substations" value={data.meta.counts.substations} hint={q.droppedDuplicates.length ? `${q.droppedDuplicates.length} dup removed` : undefined} />
          <Stat label="Lines" value={data.meta.counts.lines} />
          <Stat label="Network length" value={`${Math.round(data.meta.totalLengthKm).toLocaleString("en-IN")} km`} />
          <Stat label="Lines · both ends linked" value={`${q.adjacency.pctBoth}%`} hint={`${q.adjacency.linesBothEndpoints} of ${data.meta.counts.lines}`} />
          <Stat label="Lines · ≥1 end linked" value={`${q.adjacency.pctAtLeastOne}%`} hint="rest are external nodes" />
          <Stat label="Circuit-ambiguous names" value={q.circuitAmbiguousLines.count} hint="folder is authoritative" />
        </div>

        <details className="mt-4 rounded-xl border border-line">
          <summary className="cursor-pointer px-3.5 py-2.5 text-sm font-medium text-ink">How connections are inferred</summary>
          <div className="border-t border-line px-3.5 py-3 text-sm text-ink-2">
            Substation↔line links use <strong className="text-ink">{q.adjacency.method}</strong>: each line's end
            vertex is matched to the nearest substation. {q.adjacency.pctBoth}% of lines link at both ends; the
            remaining endpoints are genuine external nodes (railway traction, generating stations, industrial loads
            or out-of-state substations) that have no point in the dataset. Connections are shown as
            <em> inferred</em>, never authoritative.
          </div>
        </details>

        {q.adjacency.unmatchedSamples.length > 0 && (
          <details className="mt-2 rounded-xl border border-line">
            <summary className="cursor-pointer px-3.5 py-2.5 text-sm font-medium text-ink">
              Lines with an external endpoint (sample)
            </summary>
            <ul className="border-t border-line px-3.5 py-2 text-sm text-ink-2">
              {q.adjacency.unmatchedSamples.map((s) => (
                <li key={s.id} className="py-0.5">{s.name}</li>
              ))}
            </ul>
          </details>
        )}

        {q.coordWarnings.length > 0 && (
          <details className="mt-2 rounded-xl border border-line">
            <summary className="cursor-pointer px-3.5 py-2.5 text-sm font-medium text-ink">
              Coordinate review ({q.coordWarnings.length})
            </summary>
            <ul className="border-t border-line px-3.5 py-2 text-sm text-ink-2">
              {q.coordWarnings.map((w) => (
                <li key={w.id} className="py-0.5">{w.name} — {w.lat}, {w.lng}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
