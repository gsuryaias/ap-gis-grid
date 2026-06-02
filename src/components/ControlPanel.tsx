import { useMemo, useState } from "react";
import { ENERGY_TYPES, VOLTAGES, type EnergyType, type GridData, type Voltage } from "../data/types.ts";
import type { PgClass } from "../data/selectors.ts";
import { useAppStore } from "../state/store.ts";
import {
  BULKLOAD_COLOR,
  ENERGY_COLOR,
  ENERGY_LABEL,
  POWERGRID_COLOR,
  RAILWAY_COLOR,
  VOLTAGE_COLOR,
} from "../theme/palette.ts";
import { BoltIcon, ChevronDown, LayersIcon, SunIcon, MoonIcon, SatelliteIcon, TowerIcon } from "./icons.tsx";
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

function GenerationSection() {
  const filters = useAppStore((s) => s.filters);
  const genStatus = useAppStore((s) => s.genStatus);
  const genError = useAppStore((s) => s.genError);
  const generation = useAppStore((s) => s.generation);
  const { toggleGeneration, toggleGenType } = useAppStore.getState();

  // Per-energy-type plant counts (only once the overlay has loaded).
  const counts = useMemo(() => {
    const c = Object.fromEntries(ENERGY_TYPES.map((t) => [t, 0])) as Record<EnergyType, number>;
    for (const p of generation?.plants ?? []) c[p.energy]++;
    return c;
  }, [generation]);

  return (
    <div className="mt-2 border-t border-line pt-1.5">
      <Row>
        <span className="flex items-center gap-2 text-ink">
          <BoltIcon width={15} height={15} className="text-ink-2" />
          Generation plants
        </span>
        <Switch
          checked={filters.showGeneration}
          onChange={() => toggleGeneration()}
          label="Toggle generation plants"
        />
      </Row>

      {filters.showGeneration && (
        <div className="ml-1 mt-0.5 border-l border-line pl-3">
          {genStatus === "loading" && (
            <p className="flex items-center gap-2 py-1 text-xs text-ink-2">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-accent" />
              Loading plants…
            </p>
          )}
          {genStatus === "error" && (
            <p className="py-1 text-xs text-red-600 dark:text-red-400">Couldn’t load plants. {genError}</p>
          )}
          {genStatus === "ready" &&
            ENERGY_TYPES.filter((t) => counts[t] > 0).map((t) => (
              <Row key={t}>
                <span className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full ring-1 ring-white/70" style={{ backgroundColor: ENERGY_COLOR[t] }} />
                  <span className="font-medium text-ink">{ENERGY_LABEL[t]}</span>
                  <span className="text-xs text-ink-2">{counts[t]}</span>
                </span>
                <Switch checked={filters.genTypes[t]} onChange={() => toggleGenType(t)} label={`Toggle ${t}`} />
              </Row>
            ))}
        </div>
      )}
    </div>
  );
}

function PowerGridSection() {
  const filters = useAppStore((s) => s.filters);
  const pgStatus = useAppStore((s) => s.pgStatus);
  const pgError = useAppStore((s) => s.pgError);
  const powergrid = useAppStore((s) => s.powergrid);
  const { togglePowerGrid, togglePgClass } = useAppStore.getState();

  // Per-class sub-toggle rows (rendered once the group has loaded).
  const classes: Array<{ key: PgClass; color: string; label: string; count: string }> = powergrid
    ? [
        {
          key: "powergrid",
          color: POWERGRID_COLOR,
          label: "POWERGRID (PGCIL)",
          count: `${powergrid.lines.length} ln · ${powergrid.substations.length} ss`,
        },
        { key: "railway", color: RAILWAY_COLOR, label: "Railway traction SS", count: String(powergrid.railway.length) },
        { key: "bulkload", color: BULKLOAD_COLOR, label: "Bulk-load / HT SS", count: String(powergrid.bulkload.length) },
      ]
    : [];

  return (
    <div className="mt-2 border-t border-line pt-1.5">
      <Row>
        <span className="flex items-center gap-2 text-ink">
          <TowerIcon width={15} height={15} className="text-ink-2" />
          Other networks
        </span>
        <Switch
          checked={filters.showPowerGrid}
          onChange={() => togglePowerGrid()}
          label="Toggle other networks overlay"
        />
      </Row>

      {filters.showPowerGrid && (
        <div className="ml-1 mt-0.5 border-l border-line pl-3">
          {pgStatus === "loading" && (
            <p className="flex items-center gap-2 py-1 text-xs text-ink-2">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-accent" />
              Loading networks…
            </p>
          )}
          {pgStatus === "error" && (
            <p className="py-1 text-xs text-red-600 dark:text-red-400">Couldn’t load networks. {pgError}</p>
          )}
          {pgStatus === "ready" && powergrid && (
            <>
              {classes.map((c) => (
                <Row key={c.key}>
                  <span className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full ring-1 ring-white/70" style={{ backgroundColor: c.color }} />
                    <span className="font-medium text-ink">{c.label}</span>
                    <span className="text-xs text-ink-2">{c.count}</span>
                  </span>
                  <Switch
                    checked={filters.pgClasses[c.key]}
                    onChange={() => togglePgClass(c.key)}
                    label={`Toggle ${c.label}`}
                  />
                </Row>
              ))}
              <p className="mt-0.5 text-[11px] leading-snug text-ink-2">POWERGRID 765/400 kV · railway &amp; HT connections</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ControlPanel({ data }: { data: GridData }) {
  const [open, setOpen] = useState(true);
  const filters = useAppStore((s) => s.filters);
  const basemap = useAppStore((s) => s.basemap);
  const { toggleVoltage, toggleCircuit, toggleShow, setBasemap, setRegionCircle } = useAppStore.getState();
  const regionStat = filters.circle ? data.meta.byCircle[filters.circle] : null;

  return (
    <section className="pointer-events-auto flex min-h-0 w-full flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface/95 shadow-[var(--shadow-panel)] backdrop-blur">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full shrink-0 items-center justify-between px-3.5 py-2.5 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-ink">
          <LayersIcon width={16} height={16} className="text-ink-2" /> Layers & legend
        </span>
        <ChevronDown width={16} height={16} className={`text-ink-2 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>

      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-line px-3.5 pb-3 pt-1">
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

          {/* Region (circle) slice */}
          <div className="mt-2 border-t border-line pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-2">
            Region
          </div>
          <Row>
            <span className="text-ink">Circle</span>
            <select
              value={filters.circle ?? ""}
              onChange={(e) => setRegionCircle(e.target.value || null)}
              aria-label="Filter by AP-TRANSCO circle"
              className="max-w-[150px] rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-accent"
            >
              <option value="">All circles</option>
              {data.meta.circles.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Row>
          {regionStat && (
            <p className="-mt-0.5 pb-0.5 text-[11px] text-ink-2">
              {regionStat.substations} SS · {regionStat.lines} lines · {Math.round(regionStat.lengthKm).toLocaleString("en-IN")} km
            </p>
          )}

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

          {/* Generation overlay (lazy-loaded on first enable) */}
          <GenerationSection />

          {/* POWERGRID (PGCIL) overlay (lazy-loaded on first enable) */}
          <PowerGridSection />

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
