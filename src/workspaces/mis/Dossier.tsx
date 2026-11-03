// Network MIS — the last drill level: a dossier for the selected substation or line, built from
// the same enriched rows the aggregates use (so its numbers reconcile with the tables above).
import { DiscomDownstream } from "../../components/DiscomDownstream.tsx";
import { CloseIcon } from "../../components/icons.tsx";
import { VoltageBadge } from "../../components/VoltageBadge.tsx";
import { useAppStore } from "../../state/store.ts";
import { formatMva } from "../../lib/capacity.ts";
import { AGE_BAND_LABEL, LINE_USEFUL_LIFE_YRS, ROLE_HINT, type LineRow, type MisModel, type SsRow } from "./model.ts";
import { RoleText } from "./tables.tsx";
import { nf0, nf1 } from "./ui.tsx";

const pick = (id: string) => useAppStore.getState().select(id, { fly: true });

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg bg-surface-2 px-2.5 py-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-ink-2">{label}</div>
      <div className="truncate text-sm font-semibold text-ink">{children}</div>
    </div>
  );
}

function Shell({ kicker, title, onClose, children }: { kicker: React.ReactNode; title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-accent/40 bg-surface shadow-[var(--shadow-panel)]" aria-label={`${title} dossier`}>
      <header className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-2">{kicker}</div>
          <h3 className="mt-0.5 truncate text-base font-semibold text-ink" title={title}>
            {title}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dossier"
          className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink"
        >
          <CloseIcon width={16} height={16} />
        </button>
      </header>
      <div className="space-y-3 px-4 py-3">{children}</div>
    </section>
  );
}

export function SsDossier({ model, row, onClose }: { model: MisModel; row: SsRow; onClose: () => void }) {
  const s = row.ss;
  const lines = s.connectedLineIds
    .map((id) => model.lineById.get(id))
    .filter((r): r is LineRow => !!r)
    .sort((a, b) => b.voltage - a.voltage || b.ckm - a.ckm);
  const neighbours = new Map<string, SsRow>();
  for (const l of lines) for (const id of l.line.connectsSS) if (id !== row.id) {
    const n = model.ssById.get(id);
    if (n) neighbours.set(id, n);
  }
  const bridges = lines.filter((l) => l.islanded.length);
  const ages = lines.filter((l) => l.age != null).map((l) => l.age!);
  const years = lines.filter((l) => l.year != null).map((l) => l.year!);

  return (
    <Shell
      onClose={onClose}
      title={s.name}
      kicker={
        <>
          <VoltageBadge voltage={row.voltage} small />
          <span>{[s.ssCode, row.zone && `${row.zone} zone`, row.circle && `${row.circle} circle`, row.division && `${row.division} division`].filter(Boolean).join(" · ")}</span>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <Fact label="N-1 role">
          <span title={ROLE_HINT[row.role]}>
            <RoleText role={row.role} />
          </span>
        </Fact>
        <Fact label="Feeds / lines">
          {row.feedDegree} SS · {lines.length} ckt
        </Fact>
        <Fact label="33 kV out">
          {row.feeders ? `${row.feeders} fdr · ${row.discomSsIds.length} SS` : "none traced"}
        </Fact>
        <Fact label="Coast">{s.coastalKm != null ? `${nf1(s.coastalKm)} km` : "—"}</Fact>
      </div>
      {years.length > 0 && (
        <p className="text-xs text-ink-2">
          Connected circuits commissioned between <b className="text-ink">{Math.min(...years)}</b> and{" "}
          <b className="text-ink">{Math.max(...years)}</b>
          {ages.some((a) => a >= LINE_USEFUL_LIFE_YRS) && ` — ${ages.filter((a) => a >= LINE_USEFUL_LIFE_YRS).length} past the ${LINE_USEFUL_LIFE_YRS}-yr useful life`}.
          {bridges.length > 0 && ` ${bridges.length} of its lines are bridges (single path).`}
        </p>
      )}

      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Connected circuits</div>
        <ul className="max-h-56 divide-y divide-line/70 overflow-y-auto rounded-lg border border-line text-xs">
          {lines.map((l) => {
            const other = l.line.connectsSS.find((id) => id !== row.id);
            const o = other ? model.ssById.get(other) : null;
            return (
              <li key={l.id}>
                <button type="button" onClick={() => pick(l.id)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-surface-2">
                  <VoltageBadge voltage={l.voltage} small />
                  <span className="min-w-0 flex-1 truncate text-ink" title={l.line.name}>
                    {o ? `→ ${o.ss.name}` : l.line.externalEndpoints?.[0] ? `→ ${l.line.externalEndpoints[0].name} (${l.line.externalEndpoints[0].category})` : l.line.name}
                  </span>
                  <span className="shrink-0 tabular-nums text-ink-2">{nf1(l.ckm)} ckm</span>
                  <span className="w-10 shrink-0 text-right tabular-nums text-ink-2">{l.year ?? "—"}</span>
                  {l.islanded.length > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-[#d03b3b]" title="Bridge line" />}
                </button>
              </li>
            );
          })}
          {!lines.length && <li className="px-2.5 py-2 text-ink-2">No line snapped to this substation.</li>}
        </ul>
      </div>

      {neighbours.size > 0 && (
        <div className="flex flex-wrap gap-1">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Neighbours</span>
          {[...neighbours.values()].map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => pick(n.id)}
              className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink hover:bg-surface-2"
            >
              {n.voltage} · {n.ss.name}
            </button>
          ))}
        </div>
      )}

      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-2">33 kV network (DISCOM, inferred)</div>
        <div className="rounded-lg border border-line py-1.5">
          <DiscomDownstream ss={s} />
        </div>
      </div>
    </Shell>
  );
}

export function LineDossier({ model, row, onClose }: { model: MisModel; row: LineRow; onClose: () => void }) {
  const l = row.line;
  const ends = l.connectsSS.map((id) => model.ssById.get(id)).filter((r): r is SsRow => !!r);
  const islanded = row.islanded.map((id) => model.ssById.get(id)).filter((r): r is SsRow => !!r);
  const downstream = new Set(islanded.flatMap((r) => r.discomSsIds)).size;
  return (
    <Shell
      onClose={onClose}
      title={l.name}
      kicker={
        <>
          <VoltageBadge voltage={row.voltage} small />
          <span>{[l.circuitType ?? l.circuit, row.circle && `${row.circle} circle`, row.division && `${row.division} division`].filter(Boolean).join(" · ")}</span>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <Fact label="Circuit-km">
          {nf1(row.ckm)} ({row.circuits} ckt)
        </Fact>
        <Fact label="Conductor">{l.conductor ?? "—"}</Fact>
        <Fact label="Indicative rating">{formatMva(row.mva)}</Fact>
        <Fact label="Commissioned">
          {l.commissioned ?? "—"}
          {row.age != null && <span className="font-normal text-ink-2"> · {row.age} y</span>}
        </Fact>
      </div>
      <p className="text-xs text-ink-2">
        Age band: <b className="text-ink">{AGE_BAND_LABEL[row.ageBand]}</b>. Route share {nf1(row.routeKm)} km of a{" "}
        {nf1(l.lengthKm ?? 0)} km line{row.circuits === 1 && l.circuit === "DC" ? " (one circuit of a double-circuit tower line)" : ""}.
      </p>
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Ends</span>
        {ends.map((n) => (
          <button key={n.id} type="button" onClick={() => pick(n.id)} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink hover:bg-surface-2">
            {n.voltage} · {n.ss.name}
          </button>
        ))}
        {(l.externalEndpoints ?? []).map((e) => (
          <span key={e.name} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2">
            {e.name} ({e.category})
          </span>
        ))}
      </div>
      {islanded.length > 0 ? (
        <div className="rounded-lg border border-[#d03b3b]/40 bg-[#d03b3b]/5 px-3 py-2 text-xs text-ink">
          <b>Bridge line (inferred N-1).</b> Its outage would island {islanded.length} TRANSCO substation
          {islanded.length === 1 ? "" : "s"} — {islanded.map((r) => r.ss.name).join(", ")}
          {downstream > 0 && ` — and the ${nf0(downstream)} 33/11 kV substations they feed`}.
        </div>
      ) : (
        <p className="text-xs text-ink-2">Not a bridge: every substation it touches has another inferred path.</p>
      )}
    </Shell>
  );
}
