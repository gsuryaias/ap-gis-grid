// The global filter bar: voltage, circle and coast chips. One filter model (`filters` in the store)
// — the map, the data table and every count read it.
import { useId } from "react";
import { VOLTAGES, type GridData, type Voltage } from "../data/types.ts";
import { sliceActive } from "../data/selectors.ts";
import { useFilters } from "../state/hooks.ts";
import { VOLTAGE_COLOR } from "../theme/palette.ts";

const chip = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors";
const COAST: { v: 0 | 1 | 2; label: string }[] = [
  { v: 0, label: "< 10 km" },
  { v: 1, label: "< 25 km" },
  { v: 2, label: "< 50 km" },
];

export function FilterChips({ data }: { data: GridData }) {
  const { filters, toggleVoltage, setRegionCircle, setCoastalBand, resetFilters } = useFilters();
  const id = useId();
  const select = (active: boolean) =>
    `${chip} appearance-none pr-6 bg-[length:10px] bg-[right_8px_center] bg-no-repeat outline-none focus-visible:ring-2 focus-visible:ring-accent ${
      active ? "border-accent bg-accent/10 text-ink" : "border-line bg-surface/95 text-ink-2 hover:text-ink"
    }`;
  const caret = {
    backgroundImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='3'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
  };
  return (
    <div role="group" aria-label="Filters" className="flex items-center gap-1.5">
      {VOLTAGES.map((v: Voltage) => {
        const on = filters.voltages[v];
        return (
          <button
            key={v}
            type="button"
            onClick={() => toggleVoltage(v)}
            aria-pressed={on}
            title={on ? `Hide ${v} kV` : `Show ${v} kV`}
            className={`${chip} ${on ? "border-line bg-surface/95 text-ink" : "border-dashed border-line bg-surface/70 text-ink-2 line-through"}`}
          >
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: on ? VOLTAGE_COLOR[v] : "transparent", boxShadow: `inset 0 0 0 1.5px ${VOLTAGE_COLOR[v]}` }} />
            {v}
          </button>
        );
      })}
      <label htmlFor={`${id}-circle`} className="sr-only">
        Filter by AP-TRANSCO circle
      </label>
      <select
        id={`${id}-circle`}
        value={filters.circle ?? ""}
        onChange={(e) => setRegionCircle(e.target.value || null)}
        className={select(!!filters.circle)}
        style={caret}
      >
        <option value="">All circles</option>
        {data.meta.circles.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-coast`} className="sr-only">
        Filter by distance to the coastline
      </label>
      <select
        id={`${id}-coast`}
        value={filters.coastalBand ?? ""}
        onChange={(e) => setCoastalBand(e.target.value === "" ? null : (Number(e.target.value) as 0 | 1 | 2))}
        className={select(filters.coastalBand != null)}
        style={caret}
      >
        <option value="">Coast: any</option>
        {COAST.map((c) => (
          <option key={c.v} value={c.v}>
            Coast {c.label}
          </option>
        ))}
      </select>
      {sliceActive(filters) && (
        <button type="button" onClick={resetFilters} className="shrink-0 px-1 text-xs font-medium text-accent hover:underline">
          Clear
        </button>
      )}
    </div>
  );
}
