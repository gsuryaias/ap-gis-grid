// What-if sandbox — add up to MAX_SANDBOX_LINES hypothetical lines (from SS, to SS,
// voltage, circuit). Endpoints are picked via a searchable dropdown over the real
// substations; assumed length is the great-circle distance between the pair (scenario.ts
// adds the typical conductor per voltage and expands DC into two parallel circuits).
// Pure local state — owned by PlanningStudio, never persisted.
import { useMemo, useState } from "react";
import type { Circuit, GridData, SubstationProps, Voltage } from "../../data/types.ts";
import { VOLTAGES } from "../../data/types.ts";
import { haversineMeters } from "../../lib/geo.ts";
import { MAX_SANDBOX_LINES, SANDBOX_CONDUCTOR, type SandboxLine } from "./scenario.ts";
import { Card, fmt1, MiniButton, VoltTag } from "./ui.tsx";

/** Searchable substation picker: plain filtered dropdown over data.substations. */
function SsPicker({
  data,
  value,
  onChange,
  placeholder,
}: {
  data: GridData;
  value: SubstationProps | null;
  onChange: (ss: SubstationProps | null) => void;
  placeholder: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    return data.substations
      .filter((s) => s.name.toLowerCase().includes(needle) || (s.ssCode ?? "").toLowerCase().includes(needle))
      .slice(0, 10);
  }, [data, query]);

  return (
    <div className="relative">
      <input
        type="text"
        value={value ? value.name : query}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(null);
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        className="w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-ink placeholder:text-ink-2/60"
      />
      {value && (
        <button
          aria-label="Clear"
          onMouseDown={(e) => {
            e.preventDefault();
            onChange(null);
            setQuery("");
          }}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1 text-xs text-ink-2 hover:text-ink"
        >
          ×
        </button>
      )}
      {open && !value && matches.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-[var(--shadow-panel)]">
          {matches.map((s) => (
            <li key={s.id}>
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(s);
                  setQuery("");
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-[11px] text-ink hover:bg-surface-2"
              >
                <span className="truncate">{s.name}</span>
                <span className="flex shrink-0 items-center gap-1.5 text-ink-2">
                  <VoltTag v={s.voltage} />
                  {s.circle && <span className="text-[10px]">{s.circle}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SandboxPanel({
  data,
  sandbox,
  onAdd,
  onRemove,
  onClearAll,
}: {
  data: GridData;
  sandbox: readonly SandboxLine[];
  onAdd: (line: SandboxLine) => void;
  onRemove: (index: number) => void;
  onClearAll: () => void;
}) {
  const [fromSs, setFromSs] = useState<SubstationProps | null>(null);
  const [toSs, setToSs] = useState<SubstationProps | null>(null);
  const [voltage, setVoltage] = useState<Voltage>(220);
  const [circuit, setCircuit] = useState<Circuit>("DC");

  const ssById = useMemo(() => new Map(data.substations.map((s) => [s.id, s])), [data]);

  const previewKm =
    fromSs && toSs && fromSs.id !== toSs.id
      ? haversineMeters([fromSs.lng, fromSs.lat], [toSs.lng, toSs.lat]) / 1000
      : null;
  const canAdd = previewKm !== null && sandbox.length < MAX_SANDBOX_LINES;

  const add = () => {
    if (!fromSs || !toSs || !canAdd) return;
    onAdd({ fromId: fromSs.id, toId: toSs.id, voltage, circuit });
    setFromSs(null);
    setToSs(null);
  };

  return (
    <Card
      title="What-if sandbox"
      subtitle={`Up to ${MAX_SANDBOX_LINES} hypothetical lines`}
      right={
        sandbox.length > 0 ? <MiniButton onClick={onClearAll}>Clear all</MiniButton> : undefined
      }
    >
      <div className="space-y-2.5 px-4 py-3">
        {sandbox.length > 0 && (
          <ul className="space-y-1.5">
            {sandbox.map((sb, i) => {
              const from = ssById.get(sb.fromId);
              const to = ssById.get(sb.toId);
              const km =
                from && to ? haversineMeters([from.lng, from.lat], [to.lng, to.lat]) / 1000 : null;
              return (
                <li
                  key={`${sb.fromId}-${sb.toId}-${i}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-2/60 px-2 py-1.5"
                >
                  <div className="min-w-0 text-[11px] text-ink">
                    <p className="truncate font-medium">
                      {from?.name ?? sb.fromId} – {to?.name ?? sb.toId}
                    </p>
                    <p className="text-[10px] text-ink-2">
                      <VoltTag v={sb.voltage} /> · {sb.circuit} · {SANDBOX_CONDUCTOR[sb.voltage]}
                      {km !== null && <> · ≈ {fmt1(km)} km</>}
                    </p>
                  </div>
                  <button
                    onClick={() => onRemove(i)}
                    aria-label={`Remove what-if line ${i + 1}`}
                    className="shrink-0 rounded px-1.5 text-sm text-ink-2 hover:text-ink"
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {sandbox.length < MAX_SANDBOX_LINES ? (
          <div className="space-y-1.5">
            <SsPicker data={data} value={fromSs} onChange={setFromSs} placeholder="From substation…" />
            <SsPicker data={data} value={toSs} onChange={setToSs} placeholder="To substation…" />
            <div className="flex items-center gap-1.5">
              <select
                value={voltage}
                onChange={(e) => setVoltage(Number(e.target.value) as Voltage)}
                aria-label="What-if line voltage"
                className="flex-1 rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink"
              >
                {VOLTAGES.map((v) => (
                  <option key={v} value={v}>
                    {v} kV
                  </option>
                ))}
              </select>
              <select
                value={circuit}
                onChange={(e) => setCircuit(e.target.value as Circuit)}
                aria-label="What-if line circuit"
                className="flex-1 rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink"
              >
                <option value="SC">Single circuit</option>
                <option value="DC">Double circuit</option>
              </select>
              <button
                onClick={add}
                disabled={!canAdd}
                className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Add
              </button>
            </div>
            {previewKm !== null && (
              <p className="text-[10px] text-ink-2">
                Assumed length ≈ {fmt1(previewKm)} km (great-circle; real routes run longer) ·
                conductor {SANDBOX_CONDUCTOR[voltage]}
                {circuit === "DC" && " · modelled as two parallel circuits"}
              </p>
            )}
            {fromSs && toSs && fromSs.id === toSs.id && (
              <p className="text-[10px] text-red-700 dark:text-red-400">
                Pick two different substations.
              </p>
            )}
          </div>
        ) : (
          <p className="text-[10px] text-ink-2">Sandbox full — remove a line to add another.</p>
        )}

        <p className="border-t border-line pt-2 text-[10px] leading-snug text-ink-2/90">
          What-if lines rebuild the network in the worker; the delta view compares the horizon
          scenario with and without them. Hypothetical only — nothing is saved.
        </p>
      </div>
    </Card>
  );
}
