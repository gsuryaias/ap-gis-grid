// The printable Storm briefing (Atlas 2.0 phase 5 PR 15): the situation laid out for paper or PDF,
// with timestamp, data vintage, sources and the method. Rendered inside a `PrintSheet`, hidden on
// screen. Plain semantic HTML; the print CSS lives in index.css (`.print-sheet`).
import type { AtRiskRow, StormPicture } from "../data/storm.ts";
import { stormHeadline } from "../data/storm.ts";
import type { GridData } from "../data/types.ts";
import type { WeatherData } from "../data/weather.ts";
import { METHODS } from "../content/methods.ts";
import { STATUS_LABEL, type CircleStatus } from "../lib/storm.ts";
import { SUPPLY_LABEL } from "../lib/supply-security.ts";
import { STORM_STATUS_COLOR } from "../theme/palette.ts";

const IST: Intl.DateTimeFormatOptions = { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" };
const when = (t: number | string) => `${new Date(t).toLocaleString("en-IN", IST)} IST`;
const n = (x: number) => x.toLocaleString("en-IN");
const MAX_ROWS = 120;

function Status({ s }: { s: CircleStatus }) {
  return (
    <span className="ps-status" style={{ backgroundColor: STORM_STATUS_COLOR[s] }}>
      {STATUS_LABEL[s]}
    </span>
  );
}

export function StormBriefing({
  pic,
  weather,
  data,
  rows,
  overall,
}: {
  pic: StormPicture;
  weather: WeatherData;
  data: GridData;
  rows: AtRiskRow[];
  overall: CircleStatus;
}) {
  const sit = pic.situation;
  const name = new Map(data.substations.map((s) => [s.id, s.name]));
  const perSystem = new Map<number, number>();
  for (const h of sit.envelope) for (const id of h.systemIds) perSystem.set(id, (perSystem.get(id) ?? 0) + 1);
  const fc = new Map(pic.board.map((r) => [r.circle, r.forecast]));

  return (
    <>
      <h1>AP-TRANSCO Storm briefing</h1>
      <p className="ps-meta">
        Printed {when(Date.now())} · weather fetched {when(weather.fetchedAt)} · network data as of {when(data.meta.generatedAt)}
      </p>
      <p className="ps-meta">{typeof location !== "undefined" ? location.href : ""}</p>

      <h2>Situation</h2>
      <p>
        <Status s={overall} /> {stormHeadline(pic)}
      </p>

      <h2>Active systems</h2>
      {weather.cyclones.length ? (
        <table>
          <thead>
            <tr>
              <th>System</th>
              <th>GDACS alert</th>
              <th>Period</th>
              <th>Severity</th>
              <th className="num">SS in envelope</th>
            </tr>
          </thead>
          <tbody>
            {weather.cyclones.map((ev) => (
              <tr key={ev.id}>
                <td>{ev.name}</td>
                <td>{ev.alertLevel}</td>
                <td>
                  {new Date(ev.fromDate).toLocaleDateString("en-IN")} – {new Date(ev.toDate).toLocaleDateString("en-IN")}
                </td>
                <td>{ev.severityText ?? "—"}</td>
                <td className="num">{n(perSystem.get(ev.id) ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>{pic.cycloneFeedOk ? "No active cyclone systems in the basin." : "Cyclone feed (GDACS) unavailable."}</p>
      )}

      <h2>Circles</h2>
      <table>
        <thead>
          <tr>
            <th>Circle</th>
            <th>Status</th>
            <th className="num">SS in envelope</th>
            <th className="num">Fed through exposure</th>
            <th className="num">Max gust km/h</th>
            <th className="num">Wettest day mm</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {pic.board.map((r) => {
            const f = fc.get(r.circle);
            return (
              <tr key={r.circle}>
                <td>{r.circle}</td>
                <td>{STATUS_LABEL[r.status]}</td>
                <td className="num">{r.envelope || ""}</td>
                <td className="num">{r.atRisk || ""}</td>
                <td className="num">{f ? Math.round(f.gustMaxKmh) : "—"}</td>
                <td className="num">{f ? Math.round(f.rainMaxMm) : "—"}</td>
                <td>{r.reasons.join("; ")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {rows.length > 0 && (
        <>
          <h2>Substations at risk · {n(rows.length)}</h2>
          <table>
            <thead>
              <tr>
                <th>Substation</th>
                <th className="num">kV</th>
                <th>Circle</th>
                <th>Why</th>
                <th className="num">Coast km</th>
                <th>Supply</th>
                <th className="num">33 kV feeders</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, MAX_ROWS).map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td className="num">{r.voltage}</td>
                  <td>{r.circle ?? "—"}</td>
                  <td>{r.why}</td>
                  <td className="num">{r.coastalKm != null ? Math.round(r.coastalKm) : "—"}</td>
                  <td>{r.supply ? SUPPLY_LABEL[r.supply] : "—"}</td>
                  <td className="num">{r.feeders ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > MAX_ROWS && <p className="ps-note">+{n(rows.length - MAX_ROWS)} more — export the CSV from the Storm lens for the full list.</p>}
        </>
      )}

      {(sit.pockets.length > 0 || sit.cuts.length > 0) && (
        <>
          <h2>Supply exposure</h2>
          {sit.pockets.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Radial pocket (SS at risk)</th>
                  <th>Hangs off</th>
                  <th className="num">SS at risk / in pocket</th>
                  <th className="num">Entry circuits</th>
                  <th className="num">33/11 kV SS</th>
                  <th>Generation inside</th>
                </tr>
              </thead>
              <tbody>
                {sit.pockets.map((p) => (
                  <tr key={p.key}>
                    <td>{p.atRiskIds.map((id) => name.get(id) ?? id).join(", ")}</td>
                    <td>{name.get(p.headId) ?? p.headId}</td>
                    <td className="num">
                      {p.atRiskIds.length} / {p.ssIds.length}
                    </td>
                    <td className="num">{p.entryCircuits}</td>
                    <td className="num">{p.discomSs || ""}</td>
                    <td>{p.generation.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {sit.cuts.length > 0 && (
            <table style={{ marginTop: "6pt" }}>
              <thead>
                <tr>
                  <th>Cut point in the envelope</th>
                  <th className="num">SS islanded on its loss</th>
                  <th className="num">33/11 kV SS behind them</th>
                </tr>
              </thead>
              <tbody>
                {sit.cuts.map((c) => (
                  <tr key={c.id}>
                    <td>{name.get(c.id) ?? c.id}</td>
                    <td className="num">{c.islanded.length}</td>
                    <td className="num">{c.discomSs || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {sit.atRisk.size > 0 && (
        <>
          <h2>Downstream 33/11 kV</h2>
          {pic.downstreamReady ? (
            <p>
              {n(sit.downstream.discomSs)} 33/11 kV substations on {n(sit.downstream.feeders)} 33 kV feeders
              {sit.downstream.byDiscom.length > 0 && <> — {sit.downstream.byDiscom.map((d) => `${d.discom} ${n(d.discomSs)} SS / ${n(d.feeders)} feeders`).join("; ")}</>}.
              Inferred links; APSPDCL’s 33 kV map is partial.
            </p>
          ) : (
            <p>The 33 kV link index had not loaded when this was printed.</p>
          )}
        </>
      )}

      {weather.marine.length > 0 && (
        <>
          <h2>Coastal sea state</h2>
          <table>
            <thead>
              <tr>
                <th>Point</th>
                <th className="num">Wave m</th>
                <th className="num">Swell m</th>
              </tr>
            </thead>
            <tbody>
              {weather.marine.map((m) => (
                <tr key={m.name}>
                  <td>{m.name}</td>
                  <td className="num">{m.waveM != null ? m.waveM.toFixed(1) : "—"}</td>
                  <td className="num">{m.swellM != null ? m.swellM.toFixed(1) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Method, sources and caveats</h2>
      <p className="ps-note">{METHODS.storm.rule}</p>
      <p className="ps-note">Sources: {METHODS.storm.source} Radar: RainViewer. Marine: Open-Meteo.</p>
      {weather.sourceErrors.length > 0 && <p className="ps-note">Sources that did not respond: {weather.sourceErrors.join("; ")}.</p>}
      <p className="ps-note">
        <strong>{METHODS.storm.caveat}</strong> Verify against IMD advisories before acting.
      </p>
    </>
  );
}
