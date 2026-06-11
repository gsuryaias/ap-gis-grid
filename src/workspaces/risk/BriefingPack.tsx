// Print-styled briefing pack — the artefact to take into a meeting (DSS spec §4). Rendered
// through a portal onto <body> so the @media print rules can hide the app (#root) and print
// just this sheet. Always light-on-white regardless of the app theme, for print fidelity.
import { useMemo } from "react";
import { createPortal } from "react-dom";
import { COASTAL_BAND_LABEL } from "../../lib/risk.ts";
import { windLabel, type RiskRow, type ScenarioDef } from "./model.ts";

const PRINT_CSS = `
@media print {
  #root { display: none !important; }
  #risk-briefing { position: static !important; inset: auto !important; overflow: visible !important; }
  #risk-briefing .briefing-sheet { box-shadow: none !important; border: 0 !important; margin: 0 !important; max-width: none !important; }
}
`;

function fmtStamp(ts: number): string {
  return new Date(ts).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function MiniTable({ title, rows, value }: { title: string; rows: RiskRow[]; value: (r: RiskRow) => string }) {
  return (
    <div className="min-w-0 flex-1">
      <h3 className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-1 text-xs text-slate-500">None under this scenario.</p>
      ) : (
        <table className="mt-1 w-full border-collapse text-xs">
          <tbody>
            {rows.map((r) => (
              <tr key={r.ss.id} className="border-b border-slate-200 last:border-0">
                <td className="py-0.5 pr-2 text-slate-900">{r.ss.name}</td>
                <td className="whitespace-nowrap py-0.5 pr-2 text-right tabular-nums text-slate-500">{r.ss.voltage} kV</td>
                <td className="whitespace-nowrap py-0.5 text-right tabular-nums text-slate-700">{value(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function BriefingPack({
  scenario,
  rows,
  networkVintage,
  weatherFetchedAt,
  liveEventNames,
  onClose,
}: {
  scenario: ScenarioDef;
  /** Full register under the active scenario, already sorted by composite desc. */
  rows: RiskRow[];
  networkVintage: string;
  weatherFetchedAt: number | null;
  liveEventNames: string[];
  onClose: () => void;
}) {
  const top25 = rows.slice(0, 25);
  const topWind = useMemo(
    () => [...rows].sort((a, b) => (b.windVb ?? 0) - (a.windVb ?? 0) || b.hazard - a.hazard).slice(0, 5),
    [rows],
  );
  const topCoastal = useMemo(
    () =>
      rows
        .filter((r) => r.ss.coastalKm != null)
        .sort((a, b) => a.ss.coastalKm! - b.ss.coastalKm!)
        .slice(0, 5),
    [rows],
  );
  const topCyclone = useMemo(() => rows.filter((r) => r.inCone).slice(0, 5), [rows]);

  return createPortal(
    <div id="risk-briefing" className="fixed inset-0 z-[100] overflow-auto bg-slate-700/60 p-4 backdrop-blur-sm">
      <style>{PRINT_CSS}</style>
      <div className="briefing-sheet mx-auto my-4 max-w-[820px] rounded-xl border border-slate-300 bg-white p-8 text-slate-900 shadow-2xl">
        {/* Screen-only actions */}
        <div className="mb-5 flex items-center justify-end gap-2 print:hidden">
          <button
            onClick={() => window.print()}
            className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            Print / save PDF
          </button>
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Close
          </button>
        </div>

        <header className="border-b-2 border-slate-900 pb-3">
          <h1 className="text-xl font-bold">AP-TRANSCO grid — risk briefing (indicative screening)</h1>
          <p className="mt-1 text-sm text-slate-600">
            Scenario: <span className="font-semibold text-slate-900">{scenario.label}</span>
            {liveEventNames.length > 0 && <> · Live GDACS event: {liveEventNames.join(", ")}</>}
          </p>
          <p className="text-xs text-slate-500">Generated {fmtStamp(Date.now())} (IST)</p>
        </header>

        <section className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">
          <p>
            <span className="font-semibold">Scenario assumption:</span> {scenario.assumption}
          </p>
          <p className="mt-1">
            <span className="font-semibold">Data vintages:</span> network &amp; wind zones — {networkVintage}
            (static); live weather — {weatherFetchedAt ? `fetched ${fmtStamp(weatherFetchedAt)}` : "not loaded"}.
          </p>
        </section>

        <h2 className="mt-5 text-sm font-bold uppercase tracking-wide text-slate-700">
          Top 25 assets by composite risk
        </h2>
        <table className="mt-2 w-full border-collapse text-xs">
          <thead>
            <tr className="border-b-2 border-slate-400 text-left text-[10px] font-bold uppercase tracking-wide text-slate-500">
              <th className="py-1 pr-2">#</th>
              <th className="py-1 pr-2">Substation</th>
              <th className="py-1 pr-2">kV</th>
              <th className="py-1 pr-2">Circle</th>
              <th className="py-1 pr-2">Coast</th>
              <th className="py-1 pr-2">Wind</th>
              <th className="py-1 pr-2 text-right">Hazard</th>
              <th className="py-1 pr-2 text-right">Vuln</th>
              <th className="py-1 pr-2 text-right">Crit</th>
              <th className="py-1 text-right">Composite</th>
            </tr>
          </thead>
          <tbody>
            {top25.map((r, i) => (
              <tr key={r.ss.id} className="border-b border-slate-200 last:border-0">
                <td className="py-0.5 pr-2 tabular-nums text-slate-400">{i + 1}</td>
                <td className="py-0.5 pr-2 font-medium">
                  {r.ss.name}
                  {r.feedDegree <= 1 && <span className="ml-1 text-[10px] font-semibold text-amber-700">· single-fed</span>}
                  {r.inCone && <span className="ml-1 text-[10px] font-semibold text-red-700">· in cone</span>}
                </td>
                <td className="whitespace-nowrap py-0.5 pr-2 tabular-nums">{r.ss.voltage}</td>
                <td className="py-0.5 pr-2 text-slate-600">{r.ss.circle ?? "—"}</td>
                <td className="whitespace-nowrap py-0.5 pr-2 text-slate-600">
                  {r.coastalBand != null ? COASTAL_BAND_LABEL[r.coastalBand] : "—"}
                </td>
                <td className="whitespace-nowrap py-0.5 pr-2 text-slate-600">{windLabel(r.windVb)}</td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{r.hazard}</td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{r.vulnerability}</td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{r.criticality}</td>
                <td className="py-0.5 text-right font-bold tabular-nums">
                  {r.composite} <span className="font-normal text-slate-500">({r.tier})</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 className="mt-6 text-sm font-bold uppercase tracking-wide text-slate-700">Per-hazard top 5</h2>
        <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:gap-6">
          <MiniTable title="Wind exposure" rows={topWind} value={(r) => `${windLabel(r.windVb)} · h ${r.hazard}`} />
          <MiniTable
            title="Coastal proximity"
            rows={topCoastal}
            value={(r) => `${r.ss.coastalKm!.toLocaleString("en-IN")} km`}
          />
          <MiniTable title="Cyclone cone" rows={topCyclone} value={(r) => `composite ${r.composite}`} />
        </div>

        <footer className="mt-6 border-t border-slate-300 pt-3 text-[10px] leading-relaxed text-slate-500">
          Indicative screening values only — not a hazard model, reliability study or load-flow result.
          Wind zones are an approximate digitisation of IS 875 (Part 3); coastal distance is straight-line;
          connectivity (feed degree, line counts) is inferred from geometric endpoint snapping; cyclone
          envelopes are GDACS model output, not IMD advisories. Scenario presets are screening assumptions.
          Verify against authoritative studies before acting. · AP-TRANSCO Grid Atlas — Risk Room.
        </footer>
      </div>
    </div>,
    document.body,
  );
}
