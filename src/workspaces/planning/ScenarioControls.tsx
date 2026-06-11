// Scenario controls — demand growth (per-circle CAGR + horizon year) and the generation
// assumption. All state is local React state owned by PlanningStudio (transient by design:
// no store slice, no hash key — scenarios are working hypotheses, not shareable app state).
import {
  BASE_DEMAND_MW,
  BASE_YEAR,
  CAGR_MAX_PCT,
  CAGR_MIN_PCT,
  HORIZON_MAX_YEAR,
} from "./scenario.ts";
import { Card, fmtInt } from "./ui.tsx";

export type GenMode = "slack" | "generators";

const YEARS = Array.from({ length: HORIZON_MAX_YEAR - BASE_YEAR + 1 }, (_, i) => BASE_YEAR + i);

export function ScenarioControls({
  circles,
  cagrByCircle,
  onCagrChange,
  onSetAll,
  horizonYear,
  onHorizonChange,
  genMode,
  onGenModeChange,
  generatorCount,
}: {
  circles: readonly string[];
  cagrByCircle: Record<string, number>;
  onCagrChange: (circle: string, pct: number) => void;
  onSetAll: (pct: number) => void;
  horizonYear: number;
  onHorizonChange: (year: number) => void;
  genMode: GenMode;
  onGenModeChange: (m: GenMode) => void;
  generatorCount: number;
}) {
  const values = circles.map((c) => cagrByCircle[c] ?? 0);
  const allEqual = values.every((v) => v === values[0]);
  const masterValue = allEqual ? values[0] : values.reduce((a, b) => a + b, 0) / (values.length || 1);

  return (
    <Card title="Demand-growth scenario" subtitle={`Horizon ${horizonYear} · base ${BASE_YEAR}`}>
      <div className="space-y-3 px-4 py-3">
        <label className="flex items-center justify-between gap-2 text-xs text-ink">
          <span className="font-medium">Horizon year</span>
          <select
            value={horizonYear}
            onChange={(e) => onHorizonChange(Number(e.target.value))}
            className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink"
          >
            {YEARS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>

        <div>
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-ink">All circles</span>
            <span className="tabular-nums text-ink-2">
              {allEqual ? `${masterValue.toFixed(1)} %/yr` : `~${masterValue.toFixed(1)} %/yr (mixed)`}
            </span>
          </div>
          <input
            type="range"
            min={CAGR_MIN_PCT}
            max={CAGR_MAX_PCT}
            step={0.5}
            value={masterValue}
            onChange={(e) => onSetAll(Number(e.target.value))}
            aria-label="Demand CAGR, all circles"
            className="mt-1 w-full accent-[var(--color-accent)]"
          />
        </div>

        <div className="space-y-1.5 border-t border-line pt-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-2">Per-circle CAGR (%/yr)</p>
          {circles.map((c) => (
            <label key={c} className="flex items-center gap-2 text-[11px] text-ink">
              <span className="w-[88px] shrink-0 truncate" title={c}>
                {c}
              </span>
              <input
                type="range"
                min={CAGR_MIN_PCT}
                max={CAGR_MAX_PCT}
                step={0.5}
                value={cagrByCircle[c] ?? 0}
                onChange={(e) => onCagrChange(c, Number(e.target.value))}
                aria-label={`Demand CAGR, ${c}`}
                className="min-w-0 flex-1 accent-[var(--color-accent)]"
              />
              <span className="w-8 shrink-0 text-right tabular-nums text-ink-2">
                {(cagrByCircle[c] ?? 0).toFixed(1)}
              </span>
            </label>
          ))}
        </div>

        <div className="border-t border-line pt-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-2">Generation assumption</p>
          <div className="mt-1.5 grid grid-cols-1 gap-1 rounded-lg border border-line bg-surface-2/70 p-0.5">
            <button
              onClick={() => onGenModeChange("generators")}
              aria-pressed={genMode === "generators"}
              className={`rounded-md px-2 py-1 text-left text-[11px] font-medium transition-colors ${
                genMode === "generators" ? "bg-accent text-white" : "text-ink-2 hover:bg-surface-3 hover:text-ink"
              }`}
            >
              Spread over generation-connected SS ({fmtInt(generatorCount)})
            </button>
            <button
              onClick={() => onGenModeChange("slack")}
              aria-pressed={genMode === "slack"}
              className={`rounded-md px-2 py-1 text-left text-[11px] font-medium transition-colors ${
                genMode === "slack" ? "bg-accent text-white" : "text-ink-2 hover:bg-surface-3 hover:text-ink"
              }`}
            >
              Balance everything at the slack bus
            </button>
          </div>
        </div>

        <p className="border-t border-line pt-2.5 text-[10px] leading-snug text-ink-2/90">
          Screening assumptions: an indicative {fmtInt(BASE_DEMAND_MW)} MW statewide base demand is
          spread <em>uniformly</em> over the load substations, grown per circle to the horizon.
          “Generator” substations are merely those with an inferred external <em>Generation</em>{" "}
          endpoint — no capacity or merit-order data exists, so generation is spread evenly over
          them. Crude by design; it sets a defensible base case, not a dispatch.
        </p>
      </div>
    </Card>
  );
}
