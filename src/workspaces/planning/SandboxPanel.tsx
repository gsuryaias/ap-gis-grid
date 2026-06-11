// What-if sandbox — add up to MAX_SANDBOX_LINES hypothetical lines (from SS, to SS,
// voltage, circuit). Endpoints are picked by clicking substations on the embedded map
// (planningMap.sandboxPick in the store); assumed length is the great-circle distance
// between the pair (scenario.ts adds the typical conductor per voltage and expands DC
// into two parallel circuits). Pure local state — owned by PlanningStudio, never persisted.
import { useEffect, useMemo, useState } from "react";
import type { Circuit, GridData, SubstationProps, Voltage } from "../../data/types.ts";
import { VOLTAGES } from "../../data/types.ts";
import { haversineMeters } from "../../lib/geo.ts";
import { useAppStore } from "../../state/store.ts";
import { MAX_SANDBOX_LINES, SANDBOX_CONDUCTOR, type SandboxLine } from "./scenario.ts";
import { Card, fmt1, MiniButton, VoltTag } from "./ui.tsx";

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
  const setSandboxPick = useAppStore((s) => s.setSandboxPick);
  const setPlanningMap = useAppStore((s) => s.setPlanningMap);
  const sandboxPick = useAppStore((s) => s.planningMap.sandboxPick);
  const sandboxPickResult = useAppStore((s) => s.planningMap.sandboxPickResult);

  const [fromSs, setFromSs] = useState<SubstationProps | null>(null);
  const [toSs, setToSs] = useState<SubstationProps | null>(null);
  const [voltage, setVoltage] = useState<Voltage>(220);
  const [circuit, setCircuit] = useState<Circuit>("DC");

  const ssById = useMemo(() => new Map(data.substations.map((s) => [s.id, s])), [data]);

  // Consume map picks from the store (MapPane → completeSandboxPick).
  useEffect(() => {
    if (!sandboxPickResult) return;
    const ss = ssById.get(sandboxPickResult.ssId);
    if (!ss) return;
    if (sandboxPickResult.role === "from") setFromSs(ss);
    else setToSs(ss);
  }, [sandboxPickResult, ssById]);

  // Mirror endpoint ids to the map for highlight markers.
  useEffect(() => {
    setPlanningMap({ sandboxFromId: fromSs?.id ?? null, sandboxToId: toSs?.id ?? null });
  }, [fromSs, toSs, setPlanningMap]);

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
    setPlanningMap({ sandboxFromId: null, sandboxToId: null });
    setSandboxPick(null);
  };

  const clearEndpoint = (which: "from" | "to") => {
    if (which === "from") setFromSs(null);
    else setToSs(null);
    setSandboxPick(null);
  };

  return (
    <Card
      title="What-if sandbox"
      subtitle={`Up to ${MAX_SANDBOX_LINES} hypothetical lines · pick endpoints on the map`}
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
            <EndpointRow
              label="From"
              ss={fromSs}
              picking={sandboxPick === "from"}
              onPick={() => setSandboxPick(sandboxPick === "from" ? null : "from")}
              onClear={() => clearEndpoint("from")}
            />
            <EndpointRow
              label="To"
              ss={toSs}
              picking={sandboxPick === "to"}
              onPick={() => setSandboxPick(sandboxPick === "to" ? null : "to")}
              onClear={() => clearEndpoint("to")}
            />
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
            {sandboxPick && (
              <p className="rounded-lg border border-accent/40 bg-accent/5 px-2 py-1.5 text-[10px] text-ink">
                Click a <span className="font-semibold">substation</span> on the map to set the{" "}
                <span className="font-semibold">{sandboxPick}</span> endpoint.
              </p>
            )}
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

function EndpointRow({
  label,
  ss,
  picking,
  onPick,
  onClear,
}: {
  label: string;
  ss: SubstationProps | null;
  picking: boolean;
  onPick: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5">
      <span className="w-8 shrink-0 text-[10px] font-semibold uppercase text-ink-2">{label}</span>
      {ss ? (
        <div className="min-w-0 flex-1 text-[11px] text-ink">
          <p className="truncate font-medium">{ss.name}</p>
          <p className="flex items-center gap-1 text-[10px] text-ink-2">
            <VoltTag v={ss.voltage} />
            {ss.circle && <span>{ss.circle}</span>}
          </p>
        </div>
      ) : (
        <span className="flex-1 text-[11px] text-ink-2/70">Not picked</span>
      )}
      <button
        type="button"
        onClick={onPick}
        className={`shrink-0 rounded-lg px-2 py-0.5 text-[10px] font-medium ${
          picking
            ? "bg-accent text-white"
            : "border border-line bg-surface-2 text-ink hover:bg-surface-3"
        }`}
      >
        {picking ? "Picking…" : "Pick on map"}
      </button>
      {ss && (
        <button
          type="button"
          onClick={onClear}
          aria-label={`Clear ${label} endpoint`}
          className="shrink-0 rounded px-1 text-sm text-ink-2 hover:text-ink"
        >
          ×
        </button>
      )}
    </div>
  );
}
