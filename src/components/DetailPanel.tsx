import { connectedLines, connectedSubstations } from "../data/selectors.ts";
import { isLine, isSubstation, type GridData, type LineProps, type SubstationProps } from "../data/types.ts";
import { formatDist, formatKm } from "../lib/format.ts";
import { useAppStore } from "../state/store.ts";
import { CIRCUIT_LABEL } from "../theme/palette.ts";
import { CloseIcon, LineIcon, SubstationIcon, TargetIcon, WarnIcon } from "./icons.tsx";
import { VoltageBadge, VoltageDot } from "./VoltageBadge.tsx";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="shrink-0 text-ink-2">{label}</span>
      <span className="text-right font-medium text-ink">{value}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-2">{children}</div>;
}

function ConnectionRow({
  name,
  voltage,
  meta,
  onClick,
  icon,
}: {
  name: string;
  voltage: 400 | 220 | 132;
  meta?: string;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2"
    >
      <VoltageDot voltage={voltage} />
      <span className="shrink-0 text-ink-2">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-ink">{name}</span>
      {meta && <span className="shrink-0 text-xs text-ink-2">{meta}</span>}
    </button>
  );
}

function SubstationDetail({ ss, data }: { ss: SubstationProps; data: GridData }) {
  const select = useAppStore((s) => s.select);
  const lines = connectedLines(ss, data);
  return (
    <>
      <Field label="Substation code" value={ss.ssCode} />
      <Field label="Full name" value={ss.descriptiveName} />
      <Field label="Circle" value={ss.circle ? `${ss.circle}${ss.circleInferred ? " (inferred)" : ""}` : null} />
      <Field label="Commissioned" value={ss.doc} />
      <Field label="Coordinates" value={`${ss.lat.toFixed(5)}, ${ss.lng.toFixed(5)}`} />

      <SectionTitle>
        Connected lines · {lines.length}
        <span className="ml-1 font-normal normal-case text-ink-2">(spatially inferred)</span>
      </SectionTitle>
      {lines.length === 0 ? (
        <p className="px-2 py-1 text-sm text-ink-2">No lines snapped within {data.meta.snapThresholdM} m.</p>
      ) : (
        <div className="-mx-1">
          {lines.map(({ line }) => (
            <ConnectionRow
              key={line.id}
              name={line.name}
              voltage={line.voltage}
              meta={`${line.circuit} · ${formatKm(line.lengthKm)}`}
              icon={<LineIcon width={14} height={14} />}
              onClick={() => select(line.id, { fly: true })}
            />
          ))}
        </div>
      )}
    </>
  );
}

function LineDetail({ line, data }: { line: LineProps; data: GridData }) {
  const select = useAppStore((s) => s.select);
  const subs = connectedSubstations(line, data);
  const [from, to] = line.endpointLabels ?? [null, null];
  return (
    <>
      <Field label="Voltage" value={`${line.voltage} kV`} />
      <Field label="Circuit" value={CIRCUIT_LABEL[line.circuit]} />
      <Field label="Route length" value={formatKm(line.lengthKm)} />
      <Field
        label="Circuit-km"
        value={line.ckm != null ? `${formatKm(line.ckm)}${line.circuit === "DC" ? " (2× route)" : ""}` : undefined}
      />
      <Field label="Circle" value={line.circle} />
      {(from || to) && <Field label="Route (from name)" value={`${from ?? "?"} → ${to ?? "?"}`} />}

      {(line.circuitAmbiguous || line.voltageMismatch) && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-100/70 px-2.5 py-2 text-xs text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
          <WarnIcon width={14} height={14} className="mt-0.5 shrink-0" />
          <span>
            {line.circuitAmbiguous && "Name suggests a mixed SC/DC circuit. "}
            {line.voltageMismatch && "Name voltage differs from its folder. "}
            Classified by source folder.
          </span>
        </div>
      )}

      <SectionTitle>
        Connected substations · {subs.length}
        <span className="ml-1 font-normal normal-case text-ink-2">(spatially inferred)</span>
      </SectionTitle>
      {subs.length === 0 ? (
        <p className="px-2 py-1 text-sm text-ink-2">Endpoints are external (no substation within {data.meta.snapThresholdM} m).</p>
      ) : (
        <div className="-mx-1">
          {subs.map((ss) => {
            const snap = line.fromSS?.ssId === ss.id ? line.fromSS : line.toSS;
            return (
              <ConnectionRow
                key={ss.id}
                name={ss.name}
                voltage={ss.voltage}
                meta={formatDist(snap?.distM ?? null)}
                icon={<SubstationIcon width={14} height={14} />}
                onClick={() => select(ss.id, { fly: true })}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

export function DetailPanel({ data }: { data: GridData }) {
  const selectedId = useAppStore((s) => s.selectedId);
  const history = useAppStore((s) => s.history);
  const select = useAppStore((s) => s.select);
  const back = useAppStore((s) => s.back);
  const flyTo = useAppStore((s) => s.select);
  const feature = selectedId ? data.byId.get(selectedId) : null;
  if (!feature) return null;

  const prev = history.length ? data.byId.get(history[history.length - 1]) : null;

  return (
    <aside
      className="pointer-events-auto flex max-h-full w-[340px] max-w-[92vw] flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface/96 shadow-[var(--shadow-panel)] backdrop-blur"
      aria-label="Feature details"
    >
      {prev && (
        <button
          onClick={back}
          className="flex items-center gap-1.5 border-b border-line bg-surface-2/60 px-4 py-1.5 text-left text-xs font-medium text-ink-2 hover:text-ink"
        >
          <span aria-hidden className="text-sm leading-none">←</span>
          <span className="truncate">Back to {prev.name}</span>
        </button>
      )}
      <header className="flex items-start gap-2 border-b border-line px-4 py-3">
        <span className="mt-0.5 text-ink-2">
          {isSubstation(feature) ? <SubstationIcon /> : <LineIcon />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <VoltageBadge voltage={feature.voltage} small />
            <span className="text-[11px] uppercase tracking-wide text-ink-2">
              {isSubstation(feature) ? "Substation" : `${feature.circuit} line`}
            </span>
          </div>
          <h2 className="text-[15px] font-semibold leading-snug text-ink">{feature.name}</h2>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            onClick={() => flyTo(feature.id, { fly: true })}
            aria-label="Center on map"
            className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <TargetIcon width={16} height={16} />
          </button>
          <button
            onClick={() => select(null)}
            aria-label="Close details"
            className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <CloseIcon width={16} height={16} />
          </button>
        </div>
      </header>

      <div className="overflow-auto px-4 py-2">
        {isSubstation(feature) ? (
          <SubstationDetail ss={feature} data={data} />
        ) : isLine(feature) ? (
          <LineDetail line={feature} data={data} />
        ) : null}
      </div>
    </aside>
  );
}
