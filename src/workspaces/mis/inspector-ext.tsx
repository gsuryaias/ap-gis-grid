// Network MIS sections for the Inspector (they replaced the MIS dossier): built from the same
// enriched rows the aggregates use, so the numbers reconcile with the tables above. Added to the
// base TRANSCO SS / line sections by id — `connectivity` and `supply` replace the base ones.
import { formatMva } from "../../lib/capacity.ts";
import { SUPPLY_HINT } from "../../lib/supply-security.ts";
import type { InspectorExtension, Section } from "../../inspector/types.ts";
import {
  AGE_BAND_LABEL,
  cutFocus,
  feedPathFocus,
  isRadial,
  LINE_USEFUL_LIFE_YRS,
  nodeName,
  ROLE_HINT,
  type LineRow,
  type MapFocus,
  type MisModel,
  type SsRow,
} from "./model.ts";
import { RoleText, SupplyText } from "./tables.tsx";
import { nf0, nf1 } from "./ui.tsx";

type FocusFn = (f: MapFocus | null) => void;

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg bg-surface-2 px-2.5 py-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-ink-2">{label}</div>
      <div className="truncate text-sm font-semibold text-ink">{children}</div>
    </div>
  );
}

function SsFacts({ row, circuits }: { row: SsRow; circuits: number }) {
  const s = row.ss;
  return (
    <div className="mt-2 grid grid-cols-2 gap-1.5">
      <Fact label="N-1 role">
        <span title={ROLE_HINT[row.role]}>
          <RoleText role={row.role} />
        </span>
      </Fact>
      <Fact label="Feeds / lines">
        {row.feedDegree} SS · {circuits} ckt
      </Fact>
      <Fact label="33 kV out">{row.feeders ? `${row.feeders} fdr · ${row.discomSsIds.length} SS` : "none traced"}</Fact>
      <Fact label="Coast">{s.coastalKm != null ? `${nf1(s.coastalKm)} km` : "—"}</Fact>
    </div>
  );
}

function SupplyBox({ model, row, lines, onFocus }: { model: MisModel; row: SsRow; lines: LineRow[]; onFocus: FocusFn }) {
  const s = row.supply;
  const feed = feedPathFocus(model, row);
  const islanded = row.cutIslands.map((id) => model.ssById.get(id)).filter((r): r is SsRow => !!r);
  const cut = islanded.length ? { row, islanded, discomSs: 0 } : null;
  const ages = lines.filter((l) => l.age != null).map((l) => l.age!);
  const years = lines.filter((l) => l.year != null).map((l) => l.year!);
  const bridges = lines.filter((l) => l.islanded.length).length;
  const tone =
    s.cls === "radial-sc" ? "border-[#d03b3b]/40 bg-[#d03b3b]/5" : s.cls === "radial-dc" ? "border-[#ec835a]/50 bg-[#ec835a]/5" : "border-line bg-surface-2/60";
  return (
    <div className="mt-2 space-y-1.5">
      <div className={`space-y-1.5 rounded-lg border px-3 py-2 text-xs text-ink ${tone}`}>
        <div className="flex flex-wrap items-center gap-2">
          <b className="font-semibold">Supply security:</b>
          <SupplyText cls={s.cls} />
          {feed && (
            <button type="button" onClick={() => onFocus(feed)} className="ml-auto rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] font-medium hover:bg-surface-2">
              Show feed path on map
            </button>
          )}
        </div>
        {isRadial(row) ? (
          <p className="text-ink-2">
            Fed radially from <b className="text-ink">{nodeName(model, s.headId)}</b> across {s.depth} single corridor
            {s.depth === 1 ? "" : "s"} ({Math.round(s.radialKm)} route-km); the weakest carries{" "}
            <b className="text-ink">
              {s.bottleneck} circuit{s.bottleneck === 1 ? "" : "s"}
            </b>
            . {s.cls === "radial-sc" ? "A single trip on it interrupts supply." : "It survives a circuit trip but not the loss of that tower line."}
            {row.openEnds > 0 && ` ${row.openEnds} line${row.openEnds === 1 ? "" : "s"} here ${row.openEnds === 1 ? "has" : "have"} an unresolved far end — verify; it may be better fed.`}
          </p>
        ) : (
          <p className="text-ink-2">{SUPPLY_HINT[s.cls]}.</p>
        )}
        {cut && (
          <p className="text-ink-2">
            <b className="text-ink">Cut point:</b> a bus outage here islands {islanded.length} substation
            {islanded.length === 1 ? "" : "s"} — {islanded.slice(0, 6).map((r) => r.ss.name).join(", ")}
            {islanded.length > 6 ? "…" : ""}.{" "}
            <button type="button" onClick={() => onFocus(cutFocus(cut, model))} className="font-medium text-accent hover:underline">
              Show on map
            </button>
          </p>
        )}
      </div>
      {years.length > 0 && (
        <p className="text-xs text-ink-2">
          Connected circuits commissioned between <b className="text-ink">{Math.min(...years)}</b> and <b className="text-ink">{Math.max(...years)}</b>
          {ages.some((a) => a >= LINE_USEFUL_LIFE_YRS) && ` — ${ages.filter((a) => a >= LINE_USEFUL_LIFE_YRS).length} past the ${LINE_USEFUL_LIFE_YRS}-yr useful life`}.
          {bridges > 0 && ` ${bridges} of its lines are bridges (single path).`}
        </p>
      )}
    </div>
  );
}

function ssSections(model: MisModel, row: SsRow, onFocus: FocusFn): Section[] {
  const lines = row.ss.connectedLineIds
    .map((id) => model.lineById.get(id))
    .filter((r): r is LineRow => !!r)
    .sort((a, b) => b.voltage - a.voltage || b.ckm - a.ckm);
  return [
    { id: "mis-facts", kind: "custom", render: () => <SsFacts row={row} circuits={lines.length} /> },
    { id: "supply", kind: "custom", render: () => <SupplyBox model={model} row={row} lines={lines} onFocus={onFocus} /> },
    {
      id: "connectivity",
      kind: "links",
      title: `Connected circuits · ${lines.length}`,
      aside: "(spatially inferred)",
      empty: "No line snapped to this substation.",
      items: lines.map((l) => {
        const other = l.line.connectsSS.find((id) => id !== row.id);
        const o = other ? model.ssById.get(other) : null;
        const ext = l.line.externalEndpoints?.[0];
        return {
          ref: l.id,
          label: o ? `→ ${o.ss.name}` : ext ? `→ ${ext.name} (${ext.category})` : l.line.name,
          meta: `${nf1(l.ckm)} ckm · ${l.year ?? "—"}`,
          voltage: l.voltage,
          flag: l.islanded.length ? "Bridge line" : undefined,
        };
      }),
    },
  ];
}

function lineSections(model: MisModel, row: LineRow, onFocus: FocusFn): Section[] {
  const l = row.line;
  const corridorKey = model.sec.corridorOfLine.get(row.id);
  const corridor = corridorKey ? model.sec.corridors.get(corridorKey) : undefined;
  const beyond = corridor?.bridge ? model.ss.filter((r) => r.supply.path.includes(corridor.key)) : [];
  const islanded = row.islanded.map((id) => model.ssById.get(id)).filter((r): r is SsRow => !!r);
  const downstream = new Set(islanded.flatMap((r) => r.discomSsIds)).size;
  const age: Section = {
    id: "mis-age",
    kind: "note",
    text:
      `Age band: ${AGE_BAND_LABEL[row.ageBand]}. Indicative rating ${formatMva(row.mva)}. Route share ${nf1(row.routeKm)} km of a ` +
      `${nf1(l.lengthKm ?? 0)} km line${row.circuits === 1 && l.circuit === "DC" ? " (one circuit of a double-circuit tower line)" : ""}.`,
  };
  const supply: Section = islanded.length
    ? {
        id: "supply",
        kind: "callout",
        tone: "bad",
        text:
          `Bridge line (inferred N-1). Its outage would island ${islanded.length} TRANSCO substation${islanded.length === 1 ? "" : "s"} — ` +
          `${islanded.map((r) => r.ss.name).join(", ")}${downstream > 0 ? ` — and the ${nf0(downstream)} 33/11 kV substations they feed` : ""}.`,
      }
    : corridor?.bridge && beyond.length
      ? {
          id: "supply",
          kind: "callout",
          tone: "warn",
          text:
            `Single corridor (inferred). A circuit trip is covered by the parallel circuit${corridor.circuits > 2 ? "s" : ""}, but losing this corridor ` +
            `(${corridor.circuits} circuits — e.g. a tower failure) islands ${beyond.length} substation${beyond.length === 1 ? "" : "s"} — ` +
            `${beyond.slice(0, 6).map((r) => r.ss.name).join(", ")}${beyond.length > 6 ? "…" : ""}.`,
          action: {
            label: "Show on map",
            run: () =>
              onFocus({
                key: `corridor:${corridor.key}`,
                label: `Beyond corridor ${l.name}`,
                ssIds: beyond.map((r) => r.id),
                lineIds: model.lines.filter((x) => x.line.connectsSS.some((id) => beyond.some((b) => b.id === id))).map((x) => x.id),
              }),
          },
        }
      : {
          id: "supply",
          kind: "note",
          text: "Not a bridge: every substation it touches has another inferred path, and its corridor has an alternative.",
        };
  return [age, supply];
}

/** The MIS view of a TRANSCO SS / line: N-1 role, supply security, circuits with ages, corridor risk. */
export function misInspector(model: MisModel, onFocus: FocusFn): InspectorExtension {
  return (ins) => {
    if (ins.kind === "core-ss") {
      const row = model.ssById.get(ins.ref);
      return row ? ssSections(model, row, onFocus) : [];
    }
    if (ins.kind === "core-line") {
      const row = model.lineById.get(ins.ref);
      return row ? lineSections(model, row, onFocus) : [];
    }
    return [];
  };
}
