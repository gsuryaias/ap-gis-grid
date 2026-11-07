// Storm lens panel (lazy chunk, Atlas 2.0 phase 5 PR 15) — the control room's situation picture:
// headline status, then active systems, then substations in the warning envelope (cone ∪ coast
// near the track), then supply exposure (radial pockets + cut points), then downstream 33/11 kV,
// then the 13-circle board and live conditions, plus a printable briefing. All the analysis is in
// `lib/storm.ts` (pure) via `data/storm.ts` (memoised), shared with the map halo and the briefing.
import { useMemo, useState } from "react";
import { connectivity } from "../data/connectivity.ts";
import { useResource } from "../data/resources.ts";
import { atRiskRows, stormHeadline, stormPicture, type AtRiskRow, type StormPicture } from "../data/storm.ts";
import type { GridData } from "../data/types.ts";
import { weatherRes, type WeatherData } from "../data/weather.ts";
import { CycloneIcon, DownloadIcon, PrintIcon, RefreshIcon } from "../components/icons.tsx";
import { ErrorState, LoadingState } from "../components/states.tsx";
import { CircleConditions, fmtTime, Outlook, SeaState, WeatherSources } from "../components/WeatherView.tsx";
import { downloadText, toCsv } from "../lib/export.ts";
import { STATUS_LABEL, overallStatus, type CircleStatus, type StormSituation } from "../lib/storm.ts";
import { SUPPLY_LABEL } from "../lib/supply-security.ts";
import { PrintSheet, printSheet } from "../shell/PrintSheet.tsx";
import { useAppStore } from "../state/store.ts";
import { STORM_STATUS_COLOR, WX_ALERT_COLOR } from "../theme/palette.ts";
import { Indicative } from "../trust/Indicative.tsx";
import { LayersBlock } from "./ExplorePanel.tsx";
import { PanelSection, StartHere } from "./StartHere.tsx";
import { StormBriefing } from "./StormBriefing.tsx";

const n = (x: number) => x.toLocaleString("en-IN");
const plural = (x: number, one: string, many = one === "SS" ? one : `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;

function StatusChip({ status, size = "sm" }: { status: CircleStatus; size?: "sm" | "lg" }) {
  const color = STORM_STATUS_COLOR[status];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border font-semibold text-ink ${size === "lg" ? "px-2.5 py-1 text-[13px]" : "px-1.5 py-px text-[10.5px]"}`}
      style={{ borderColor: color, backgroundColor: `${color}1f` }}
    >
      <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {STATUS_LABEL[status]}
    </span>
  );
}

function SsButton({ id, children }: { id: string; children: React.ReactNode }) {
  const select = useAppStore((s) => s.select);
  return (
    <button
      type="button"
      onClick={() => select(id, { fly: true })}
      className="flex min-h-[28px] w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[12.5px] hover:bg-surface-2"
    >
      {children}
    </button>
  );
}

function CsvButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10.5px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
    >
      <DownloadIcon width={12} height={12} /> CSV
    </button>
  );
}

function Systems({ weather, pic }: { weather: WeatherData; pic: StormPicture }) {
  const perSystem = useMemo(() => {
    const m = new Map<number, number>();
    for (const h of pic.situation.envelope) for (const id of h.systemIds) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  }, [pic]);
  if (!weather.cyclones.length)
    return <p className="text-[12px] text-ink-2">{pic.cycloneFeedOk ? "No active cyclone systems in the basin (GDACS)." : "Cyclone feed unavailable."}</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {weather.cyclones.map((ev) => {
        const color = WX_ALERT_COLOR[ev.alertLevel];
        return (
          <li key={ev.id} className="rounded-lg border px-2.5 py-1.5" style={{ borderColor: color, backgroundColor: `${color}14` }}>
            <div className="flex items-center gap-1.5">
              <CycloneIcon width={15} height={15} style={{ color }} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{ev.name}</span>
              <span className="text-[10.5px] font-bold uppercase tracking-wide text-ink">{ev.alertLevel}</span>
            </div>
            <p className="text-[11.5px] text-ink-2">
              {ev.severityText ?? "Tropical cyclone"} · {plural(perSystem.get(ev.id) ?? 0, "SS")} in its envelope
              {ev.reportUrl && (
                <>
                  {" · "}
                  <a href={ev.reportUrl} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
                    GDACS report
                  </a>
                </>
              )}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

const SHOW = 12;

function AtRiskList({ rows, title, empty }: { rows: AtRiskRow[]; title: string; empty?: string }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return empty ? <p className="text-[12px] text-ink-2">{empty}</p> : null;
  const shown = all ? rows : rows.slice(0, SHOW);
  return (
    <div>
      <ul aria-label={title} className="-mx-1.5">
        {shown.map((r) => (
          <li key={r.id}>
            <SsButton id={r.id}>
              <span className="min-w-0 flex-1 truncate text-ink">{r.name}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-ink-2">{r.voltage} kV</span>
              <span className="shrink-0 text-[11px] text-ink-2">{r.why}</span>
            </SsButton>
          </li>
        ))}
      </ul>
      {rows.length > SHOW && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-0.5 text-[11px] font-medium text-accent hover:underline">
          {all ? "Show fewer" : `Show all ${n(rows.length)}`}
        </button>
      )}
    </div>
  );
}

function SupplyExposure({ sit, data }: { sit: StormSituation; data: GridData }) {
  const name = (id: string) => data.substations.find((s) => s.id === id)?.name ?? id;
  if (!sit.pockets.length && !sit.cuts.length)
    return <p className="text-[12px] text-ink-2">No radial pocket or cut point is exposed.</p>;
  return (
    <div className="flex flex-col gap-2">
      {sit.pockets.length > 0 && (
        <div>
          <h4 className="text-[11.5px] font-semibold text-ink">Radial pockets · {n(sit.pockets.length)}</h4>
          <ul className="-mx-1.5">
            {sit.pockets.slice(0, 8).map((p) => (
              <li key={p.key}>
                <SsButton id={p.atRiskIds[0]}>
                  <span className="min-w-0 flex-1 truncate text-ink">
                    {name(p.atRiskIds[0])}
                    {p.atRiskIds.length > 1 ? ` +${p.atRiskIds.length - 1}` : ""}
                    <span className="text-ink-2"> · off {name(p.headId)}</span>
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-ink-2">
                    {n(p.atRiskIds.length)}/{n(p.ssIds.length)} SS · {p.entryCircuits === 1 ? "1 ckt" : `${p.entryCircuits} ckts`}
                    {p.discomSs ? ` · ${n(p.discomSs)} 33/11` : ""}
                  </span>
                </SsButton>
              </li>
            ))}
          </ul>
        </div>
      )}
      {sit.cuts.length > 0 && (
        <div>
          <h4 className="text-[11.5px] font-semibold text-ink">Cut points in the envelope · {n(sit.cuts.length)}</h4>
          <ul className="-mx-1.5">
            {sit.cuts.slice(0, 8).map((c) => (
              <li key={c.id}>
                <SsButton id={c.id}>
                  <span className="min-w-0 flex-1 truncate text-ink">{name(c.id)}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-ink-2">
                    islands {plural(c.islanded.length, "SS")}
                    {c.discomSs ? ` · ${n(c.discomSs)} 33/11` : ""}
                  </span>
                </SsButton>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Downstream({ pic, data }: { pic: StormPicture; data: GridData }) {
  const d = pic.situation.downstream;
  if (!pic.downstreamReady) return <LoadingState label="Loading the 33 kV links…" />;
  const exportCsv = () => {
    const name = new Map(data.substations.map((s) => [s.id, s.name]));
    downloadText(
      "storm-downstream-33kv.csv",
      "text/csv",
      toCsv(
        ["transco_ss", "transco_ss_id", "at_risk_because", "feeder_id", "feeder", "discom", "feeder_km", "link_method", "served_33_11kv_ss"],
        d.rows.map((r) => [name.get(r.transcoId) ?? r.transcoId, r.transcoId, r.via, r.feeder[0], r.feeder[1] ?? "", r.feeder[2], r.feeder[3], r.feeder[4], r.feeder[5].length]),
      ),
    );
  };
  return (
    <div>
      <div className="flex items-baseline gap-3">
        <p className="text-[12.5px] text-ink">
          <span className="text-base font-semibold tabular-nums">{n(d.discomSs)}</span> 33/11 kV SS ·{" "}
          <span className="font-semibold tabular-nums">{n(d.feeders)}</span> 33 kV feeders
        </p>
        {d.rows.length > 0 && <CsvButton onClick={exportCsv} label="Export the downstream 33 kV feeders as CSV" />}
      </div>
      {d.byDiscom.length > 0 && (
        <p className="mt-0.5 text-[11.5px] tabular-nums text-ink-2">
          {d.byDiscom.map((x) => `${x.discom} ${n(x.discomSs)} SS / ${n(x.feeders)} feeders`).join(" · ")}
        </p>
      )}
      <p className="mt-1 text-[11px] text-ink-2">Inferred TRANSCO → 33 kV links; APSPDCL’s 33 kV map is partial, so its count is low.</p>
    </div>
  );
}

function CircleBoard({ pic }: { pic: StormPicture }) {
  return (
    <ul aria-label="Circle status" className="flex flex-col">
      {pic.board.map((r) => (
        <li key={r.circle} className="flex items-start gap-2 border-b border-line/60 py-1 last:border-0">
          <span className="w-[92px] shrink-0">
            <StatusChip status={r.status} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium text-ink">{r.circle}</span>
            {r.reasons.length > 0 && <span className="block text-[11px] text-ink-2">{r.reasons.join(" · ")}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function StormPanel({ data }: { data: GridData }) {
  // An active consumer: keeps the 10-min re-poll alive while the Storm lens is open.
  const { data: weather, status, error } = useResource(weatherRes, "");
  // The 33 kV index is only worth fetching once there is something to trace downstream.
  const active = !!weather?.cyclones.length;
  const { data: conn } = useResource(connectivity, active ? "" : null);
  const pic = useMemo(() => (weather ? stormPicture(data, weather, conn ?? null) : null), [data, weather, conn]);
  const rows = useMemo(() => (pic ? atRiskRows(pic, data, conn ?? null) : []), [pic, data, conn]);
  const refresh = () => void weatherRes.refresh().catch(() => undefined);
  const toggleWeatherView = useAppStore((s) => s.toggleWeatherView);

  const exportAtRisk = () =>
    downloadText(
      "storm-substations-at-risk.csv",
      "text/csv",
      toCsv(
        ["name", "id", "voltage_kv", "circle", "at_risk_because", "track_km", "coastal_km", "supply", "feeders_33kv"],
        rows.map((r) => [r.name, r.id, r.voltage, r.circle ?? "", r.why, r.trackKm ?? "", r.coastalKm ?? "", r.supply ? SUPPLY_LABEL[r.supply] : "", r.feeders ?? ""]),
      ),
    );

  const overall = pic ? overallStatus(pic.board) : "noinfo";
  const envelopeRows = rows.filter((r) => r.via === "envelope");
  const feedRows = rows.filter((r) => r.via !== "envelope");

  return (
    <div className="flex flex-col gap-3">
      <StartHere lens="storm" />
      <PanelSection
        title={
          <>
            Situation <Indicative method="storm" label="Screening" />
          </>
        }
        action={
          <span className="flex items-center gap-1.5">
            {weather && <span className="text-[10.5px] tabular-nums text-ink-2">updated {fmtTime(weather.fetchedAt)}</span>}
            <button type="button" onClick={refresh} aria-label="Refresh weather" title="Refresh" className="rounded-md p-0.5 text-ink-2 hover:bg-surface-2 hover:text-ink">
              <RefreshIcon width={14} height={14} />
            </button>
          </span>
        }
      >
        {pic && weather ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-start gap-2">
              <StatusChip status={overall} size="lg" />
              <p className="flex-1 text-[12.5px] leading-snug text-ink">{stormHeadline(pic)}</p>
            </div>
            <button
              type="button"
              onClick={printSheet}
              className="flex items-center gap-1.5 self-start rounded-lg border border-line px-2.5 py-1 text-[12px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <PrintIcon width={14} height={14} /> Print briefing
            </button>
          </div>
        ) : status === "error" ? (
          <ErrorState title="Couldn’t load weather data." message={error} onRetry={refresh} />
        ) : (
          <LoadingState label="Fetching live weather…" />
        )}
      </PanelSection>

      {pic && weather && (
        <>
          <PanelSection title={<>Active systems <Indicative method="weather" label="Model output" /></>}>
            <Systems weather={weather} pic={pic} />
          </PanelSection>

          {active && (
            <>
              <PanelSection
                title={`Warning envelope · ${n(envelopeRows.length)} SS`}
                action={rows.length > 0 ? <CsvButton onClick={exportAtRisk} label="Export every at-risk substation as CSV" /> : undefined}
              >
                <AtRiskList rows={envelopeRows} title="Substations in the warning envelope" empty="No AP-TRANSCO substation in the cone or on the coast near the track." />
                <p className="mt-1 text-[11px] text-ink-2">Inside a cone / alert swath, or under 25 km from the coast and within 150 km of the track. Haloed amber on the map.</p>
              </PanelSection>

              <PanelSection title={<>Supply exposure <Indicative method="supply" /></>}>
                {feedRows.length > 0 && (
                  <>
                    <p className="mb-1 text-[12px] text-ink">
                      {plural(feedRows.length, "more substation")} outside the envelope {feedRows.length === 1 ? "is" : "are"} fed through it.
                    </p>
                    <AtRiskList rows={feedRows} title="Substations fed through exposure" />
                  </>
                )}
                <div className={feedRows.length ? "mt-2" : ""}>
                  <SupplyExposure sit={pic.situation} data={data} />
                </div>
              </PanelSection>

              <PanelSection title={<>Downstream 33/11 kV at risk <Indicative method="connectivity" label="Inferred" /></>}>
                <Downstream pic={pic} data={data} />
              </PanelSection>
            </>
          )}

          <PanelSection title={<>Circles <Indicative method="storm" label="Screening" /></>}>
            <CircleBoard pic={pic} />
          </PanelSection>

          <details className="group border-t border-line pt-2.5">
            <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-ink-2 hover:text-ink">
              Conditions, sea state &amp; 3-day outlook
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              <CircleConditions weather={weather} compact />
              <SeaState weather={weather} compact />
              <Outlook weather={weather} />
            </div>
          </details>
          <div className="-mt-3">
            <WeatherSources weather={weather} />
          </div>
          <button type="button" onClick={() => toggleWeatherView(true)} className="-mt-1 self-start text-[11px] font-medium text-accent hover:underline">
            Open the full weather monitor
          </button>

          <PrintSheet label="Storm briefing">
            <StormBriefing pic={pic} weather={weather} data={data} rows={rows} overall={overall} />
          </PrintSheet>
        </>
      )}
      <LayersBlock />
    </div>
  );
}
