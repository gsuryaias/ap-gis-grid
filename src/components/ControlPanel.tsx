import { useState } from "react";
import { VOLTAGES, type GridData, type Voltage } from "../data/types.ts";
import { useAppStore } from "../state/store.ts";
import { VOLTAGE_COLOR } from "../theme/palette.ts";
import { ChevronDown, LayersIcon, SunIcon, MoonIcon, SatelliteIcon } from "./icons.tsx";
import type { Basemap } from "../state/store.ts";

function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-accent" : "bg-line"
      }`}
    >
      {/* Inline transform avoids Tailwind v4's arbitrary translate-x/left collision. */}
      <span
        className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
        style={{ transform: checked ? "translateX(18px)" : "translateX(2px)" }}
      />
    </button>
  );
}

function Row({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <div
      className="flex items-center justify-between gap-3 py-1.5 text-sm"
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      {children}
    </div>
  );
}

export function ControlPanel({ data }: { data: GridData }) {
  const [open, setOpen] = useState(true);
  const filters = useAppStore((s) => s.filters);
  const basemap = useAppStore((s) => s.basemap);
  const { toggleVoltage, toggleCircuit, toggleShow, setBasemap } = useAppStore.getState();

  return (
    <section className="w-[260px] overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface/95 shadow-[var(--shadow-panel)] backdrop-blur">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3.5 py-2.5 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-ink">
          <LayersIcon width={16} height={16} className="text-ink-2" /> Layers & legend
        </span>
        <ChevronDown width={16} height={16} className={`text-ink-2 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>

      {open && (
        <div className="border-t border-line px-3.5 pb-3 pt-1">
          {/* Voltage levels */}
          <div className="py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Voltage</div>
          {VOLTAGES.map((v: Voltage) => {
            const stat = data.meta.byVoltage[v];
            return (
              <Row key={v}>
                <span className="flex items-center gap-2">
                  <span className="h-[4px] w-5 rounded-full" style={{ backgroundColor: VOLTAGE_COLOR[v] }} />
                  <span className="font-medium text-ink">{v} kV</span>
                  <span className="text-xs text-ink-2">
                    {stat ? `${stat.substations} SS · ${stat.lines} ln` : ""}
                  </span>
                </span>
                <Switch checked={filters.voltages[v]} onChange={() => toggleVoltage(v)} label={`Toggle ${v} kV`} />
              </Row>
            );
          })}

          {/* Feature types */}
          <div className="mt-2 border-t border-line pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-2">
            Show
          </div>
          <Row>
            <span className="flex items-center gap-2 text-ink">
              <svg width="22" height="10" aria-hidden>
                <circle cx="5" cy="5" r="3.5" fill="#64748b" stroke="#fff" strokeWidth="1.5" />
              </svg>
              Substations
            </span>
            <Switch checked={filters.showSubstations} onChange={() => toggleShow("showSubstations")} label="Toggle substations" />
          </Row>
          <Row>
            <span className="flex items-center gap-2 text-ink">
              <svg width="22" height="10" aria-hidden>
                <line x1="1" y1="5" x2="21" y2="5" stroke="#64748b" strokeWidth="2.5" />
              </svg>
              Lines
            </span>
            <Switch checked={filters.showLines} onChange={() => toggleShow("showLines")} label="Toggle lines" />
          </Row>

          <div className="ml-1 mt-0.5 border-l border-line pl-3">
            <Row>
              <span className="flex items-center gap-2 text-ink-2">
                <svg width="22" height="10" aria-hidden>
                  <line x1="1" y1="5" x2="21" y2="5" stroke="#64748b" strokeWidth="2.5" />
                </svg>
                Single circuit
              </span>
              <Switch checked={filters.circuits.SC} onChange={() => toggleCircuit("SC")} label="Toggle single-circuit" />
            </Row>
            <Row>
              <span className="flex items-center gap-2 text-ink-2">
                <svg width="22" height="10" aria-hidden>
                  <line x1="1" y1="5" x2="21" y2="5" stroke="#64748b" strokeWidth="2.5" strokeDasharray="4 3" />
                </svg>
                Double circuit
              </span>
              <Switch checked={filters.circuits.DC} onChange={() => toggleCircuit("DC")} label="Toggle double-circuit" />
            </Row>
          </div>

          {/* Basemap */}
          <div className="mt-2 border-t border-line pt-2">
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { id: "light", icon: SunIcon, label: "Light" },
                  { id: "dark", icon: MoonIcon, label: "Dark" },
                  { id: "satellite", icon: SatelliteIcon, label: "Satellite" },
                ] as const
              ).map(({ id, icon: Icon, label }) => (
                <button
                  key={id}
                  onClick={() => setBasemap(id as Basemap)}
                  aria-pressed={basemap === id}
                  className={`flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[11px] font-medium ${
                    basemap === id ? "border-accent bg-surface-3 text-ink" : "border-line text-ink-2 hover:bg-surface-2"
                  }`}
                >
                  <Icon width={15} height={15} />
                  <span className="leading-none">{label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
