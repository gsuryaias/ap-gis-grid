// Network MIS — the drill-down records panel: the assets behind any number on the page.
// Opened by a <DrillNum>; lists the records with the columns that matter for that metric, a
// reconciling footer (the clicked figure, recomputed from the rows), CSV, map highlight, and —
// where a dimension captures the set exactly — "Apply as filter" to make it the page scope.
import { useMemo, useState, type ReactNode } from "react";
import { PagerBar, usePager } from "../../components/Pager.tsx";
import { VoltageBadge } from "../../components/VoltageBadge.tsx";
import { LINK_METHOD_LABEL } from "../../data/connectivity.ts";
import { SUPPLY_LABEL } from "../../lib/supply-security.ts";
import { useAppStore } from "../../state/store.ts";
import { METRICS, type DiscomRec, type DrillRecords, type DrillSpec, type FeederRec } from "./drill.ts";
import { AGE_BAND_LABEL, formatFilter, LINE_USEFUL_LIFE_YRS, nodeName, ROLE_LABEL, type LineRow, type MapFocus, type MisModel, type SsRow } from "./model.ts";
import { csvFile, RoleText, SupplyText } from "./tables.tsx";
import { Card, gva, nf0, nf1, SmallButton } from "./ui.tsx";
import type { InterfaceFeed } from "../../lib/supply-security.ts";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function DrillPanel({
  model,
  spec,
  records,
  loading,
  scopeLabel,
  mapOn,
  onToggleMap,
  onApply,
  onClose,
  onFocus,
}: {
  model: MisModel;
  spec: DrillSpec;
  records: DrillRecords;
  /** The 33 kV index isn't loaded yet (DISCOM / feeder lists are empty until it is). */
  loading: boolean;
  scopeLabel: string;
  mapOn: boolean;
  onToggleMap: () => void;
  /** Make the record set the page scope (only when the metric maps onto a dimension). */
  onApply?: () => void;
  onClose: () => void;
  onFocus: (f: MapFocus | null) => void;
}) {
  const def = METRICS[spec.metric];
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const select = useAppStore((s) => s.select);
  const setHover = useAppStore((s) => s.setHover);
  const selectedId = useAppStore((s) => s.selectedId);
  const pick = (id: string | undefined) => id && select(id, { fly: true });

  const filtered = useMemo((): DrillRecords => {
    if (!needle) return records;
    const has = (...parts: (string | null | undefined)[]) => parts.join(" ").toLowerCase().includes(needle);
    switch (records.kind) {
      case "ss":
        return { kind: "ss", rows: records.rows.filter((r) => has(r.ss.name, r.ss.ssCode, r.circle, r.division)) };
      case "lines":
        return { kind: "lines", rows: records.rows.filter((r) => has(r.line.name, r.line.conductor, r.circle)) };
      case "discom":
        return { kind: "discom", rows: records.rows.filter((r) => has(r.name, r.discom, ...r.sourceIds.map((id) => nodeName(model, id)))) };
      case "feeders":
        return { kind: "feeders", rows: records.rows.filter((r) => has(r.name, r.discom, nodeName(model, r.sourceId))) };
      case "ifaces":
        return { kind: "ifaces", rows: records.rows.filter((r) => has(r.name, r.category, ...r.ssIds.map((id) => nodeName(model, id)))) };
    }
  }, [records, needle, model]);

  const pager = usePager<unknown>(filtered.rows as unknown[], 25);
  const n = records.rows.length;
  const context = [spec.group ? spec.group.label : null, scopeLabel].filter(Boolean).join(" · ");
  const fileBase = `ap-transco-${slug(def.title)}${spec.group ? `-${slug(spec.group.label)}` : ""}`;

  const exportCsv = () => {
    const f = filtered;
    if (f.kind === "ss")
      csvFile(`${fileBase}.csv`, ["Substation", "SS code", "kV", "Zone", "Circle", "Division", "Supply security (inferred)", "Radial feed from", "Weakest corridor (circuits)", "Radial route km", "N-1 role (inferred)", "Feed degree", "SS islanded by a bus outage", "33 kV feeders", "33/11 kV SS served", "Coastal km", "Longitude", "Latitude"],
        f.rows.map((r) => [r.ss.name, r.ss.ssCode ?? "", r.voltage, r.zone ?? "", r.circle ?? "", r.division ?? "", SUPPLY_LABEL[r.supply.cls], r.supply.headId ? nodeName(model, r.supply.headId) : "", r.supply.bottleneck ?? "", r.supply.radialKm ? r.supply.radialKm.toFixed(1) : "", ROLE_LABEL[r.role], r.feedDegree, r.cutIslands.length || "", r.feeders, r.discomSsIds.length, r.ss.coastalKm ?? "", r.ss.lng, r.ss.lat]));
    else if (f.kind === "lines")
      csvFile(`${fileBase}.csv`, ["Line", "kV", "Tower", "Circuits (this row)", "Circuit-km", "Route-km share", "Conductor", "Indicative MVA", "Commissioned", "Age (yrs)", "Age band", "Circle", "Division (from end SS)", "Bridge: SS islanded (inferred)", "Corridor circuits", "Corridor is a single point of failure"],
        f.rows.map((r) => [r.line.name, r.voltage, r.line.circuitType ?? r.line.circuit, r.circuits, r.ckm.toFixed(2), r.routeKm.toFixed(2), r.line.conductor ?? "", r.mva ?? "", r.line.commissioned ?? "", r.age ?? "", AGE_BAND_LABEL[r.ageBand], r.circle ?? "", r.division ?? "", r.islanded.length || "", r.corridorCircuits ?? "", r.corridorBridge ? "yes" : ""]));
    else if (f.kind === "discom")
      csvFile(`${fileBase}.csv`, ["33/11 kV substation", "DISCOM", "TRANSCO source(s) (inferred)", "33 kV feeder(s)", "Longitude", "Latitude"],
        f.rows.map((r) => [r.name, r.discom, r.sourceIds.map((id) => nodeName(model, id)).join("; "), r.feeders.join("; "), r.lng, r.lat]));
    else if (f.kind === "feeders")
      csvFile(`${fileBase}.csv`, ["33 kV feeder", "DISCOM", "TRANSCO source (inferred)", "Link method", "Route km", "33/11 kV SS on feeder"],
        f.rows.map((r) => [r.name, r.discom, nodeName(model, r.sourceId), LINK_METHOD_LABEL[r.method] ?? r.method, r.km.toFixed(1), r.served]));
    else
      csvFile(`${fileBase}.csv`, ["Interface", "Category", "Circuits", "TRANSCO substation(s)", "Lines"],
        f.rows.map((r) => [r.name, r.category, r.circuits, r.ssIds.map((id) => nodeName(model, id)).join("; "), r.lineIds.map((id) => model.lineById.get(id)?.line.name ?? id).join("; ")]));
  };

  const rowCls = (id: string) => `cursor-pointer border-b border-line/70 hover:bg-accent/5 ${selectedId === id ? "bg-accent/10" : ""}`;
  const page = pager.pageItems;

  let table: ReactNode;
  if (filtered.kind === "ss") {
    const radialCols = spec.metric.startsWith("radial");
    const cutCol = spec.metric === "cut";
    table = (
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-y border-line bg-surface-2/70 text-left text-[11px] text-ink-2">
            <th className="py-2 pl-4 pr-2 font-medium">Substation</th>
            <th className="px-2 font-medium">Circle</th>
            <th className="px-2 font-medium">Division</th>
            {radialCols ? (
              <>
                <th className="px-2 font-medium">Supply</th>
                <th className="px-2 font-medium">Fed radially from</th>
                <th className="px-2 text-right font-medium" title="Route km of the radial feed back to the meshed grid">Radial km</th>
              </>
            ) : (
              <>
                <th className="px-2 font-medium">Supply</th>
                <th className="px-2 font-medium">N-1 role</th>
              </>
            )}
            {cutCol && <th className="px-2 text-right font-medium" title="TRANSCO SS islanded by a total outage here">Islands</th>}
            <th className="px-2 pr-4 text-right font-medium" title="33/11 kV substations on traced 33 kV feeders">33/11 SS</th>
          </tr>
        </thead>
        <tbody>
          {(page as SsRow[]).map((r) => (
            <tr key={r.id} className={rowCls(r.id)} onClick={() => pick(r.id)} onMouseEnter={() => setHover(r.id)}>
              <td className="py-1.5 pl-4 pr-2">
                <span className="flex items-center gap-1.5">
                  <VoltageBadge voltage={r.voltage} small />
                  <span className="truncate font-medium text-ink">{r.ss.name}</span>
                </span>
              </td>
              <td className="px-2 text-ink-2">{r.circle ?? "—"}</td>
              <td className="px-2 text-ink-2">{r.division ?? "—"}</td>
              <td className="px-2 text-ink-2">
                <SupplyText cls={r.supply.cls} />
              </td>
              {radialCols ? (
                <>
                  <td className="px-2 text-ink-2">{r.supply.headId ? nodeName(model, r.supply.headId) : "—"}</td>
                  <td className="px-2 text-right tabular-nums">{r.supply.radialKm ? nf1(r.supply.radialKm) : "—"}</td>
                </>
              ) : (
                <td className="px-2 text-ink-2">
                  <RoleText role={r.role} />
                </td>
              )}
              {cutCol && <td className="px-2 text-right tabular-nums">{r.cutIslands.length || "·"}</td>}
              <td className="px-2 pr-4 text-right tabular-nums">{r.discomSsIds.length || "·"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else if (filtered.kind === "lines") {
    table = (
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-y border-line bg-surface-2/70 text-left text-[11px] text-ink-2">
            <th className="py-2 pl-4 pr-2 font-medium">Line</th>
            <th className="px-2 text-right font-medium">ckm</th>
            <th className="px-2 text-right font-medium" title="Route-km share (sibling circuits split the route)">Route</th>
            <th className="px-2 font-medium">Conductor</th>
            <th className="px-2 text-right font-medium" title="Indicative thermal rating">MVA</th>
            <th className="px-2 text-right font-medium">Year</th>
            <th className="px-2 pr-4 text-right font-medium" title="Inferred: circuit outage (Bridge) or tower-line outage (Corridor) islands substations">N-1</th>
          </tr>
        </thead>
        <tbody>
          {(page as LineRow[]).map((r) => (
            <tr key={r.id} className={rowCls(r.id)} onClick={() => pick(r.id)} onMouseEnter={() => setHover(r.id)}>
              <td className="max-w-[300px] py-1.5 pl-4 pr-2">
                <span className="flex items-center gap-1.5">
                  <VoltageBadge voltage={r.voltage} small />
                  <span className="truncate text-ink" title={r.line.name}>
                    {r.line.name}
                  </span>
                </span>
              </td>
              <td className="px-2 text-right tabular-nums">{nf1(r.ckm)}</td>
              <td className="px-2 text-right tabular-nums text-ink-2">{nf1(r.routeKm)}</td>
              <td className="max-w-[120px] truncate px-2 text-ink-2" title={r.line.conductor ?? undefined}>
                {r.line.conductor ?? "—"}
              </td>
              <td className="px-2 text-right tabular-nums">{r.mva != null ? nf0(r.mva) : "—"}</td>
              <td className="whitespace-nowrap px-2 text-right tabular-nums text-ink-2">
                {r.year ?? "—"}
                {r.age != null && <span className={`ml-1 ${r.age >= LINE_USEFUL_LIFE_YRS ? "font-semibold text-ink" : ""}`}>({r.age}y)</span>}
              </td>
              <td className="whitespace-nowrap px-2 pr-4 text-right">
                {r.islanded.length ? (
                  <span className="inline-flex items-center gap-1 text-ink" title={`Islands ${r.islanded.length} SS`}>
                    <span className="h-2 w-2 rounded-full bg-[#d03b3b]" aria-hidden />
                    Bridge · {r.islanded.length}
                  </span>
                ) : r.corridorBridge ? (
                  <span className="inline-flex items-center gap-1 text-ink">
                    <span className="h-2 w-2 rounded-full bg-[#ec835a]" aria-hidden />
                    Corridor
                  </span>
                ) : (
                  "·"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else if (filtered.kind === "discom") {
    table = (
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-y border-line bg-surface-2/70 text-left text-[11px] text-ink-2">
            <th className="py-2 pl-4 pr-2 font-medium">33/11 kV substation</th>
            <th className="px-2 font-medium">DISCOM</th>
            <th className="px-2 font-medium">TRANSCO source (inferred)</th>
            <th className="px-2 pr-4 font-medium">33 kV feeder</th>
          </tr>
        </thead>
        <tbody>
          {(page as DiscomRec[]).map((r) => (
            <tr key={r.id} className={rowCls(r.sourceIds[0])} onClick={() => pick(r.sourceIds[0])} onMouseEnter={() => setHover(r.sourceIds[0])} title="Open the TRANSCO substation that feeds it">
              <td className="py-1.5 pl-4 pr-2 font-medium text-ink">{r.name}</td>
              <td className="px-2 text-ink-2">{r.discom}</td>
              <td className="px-2 text-ink">{r.sourceIds.map((id) => nodeName(model, id)).join(", ")}</td>
              <td className="max-w-[200px] truncate px-2 pr-4 text-ink-2" title={r.feeders.join(", ")}>
                {r.feeders.join(", ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else if (filtered.kind === "feeders") {
    table = (
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-y border-line bg-surface-2/70 text-left text-[11px] text-ink-2">
            <th className="py-2 pl-4 pr-2 font-medium">33 kV feeder</th>
            <th className="px-2 font-medium">DISCOM</th>
            <th className="px-2 font-medium">TRANSCO source</th>
            <th className="px-2 font-medium" title="How the source was inferred">Link</th>
            <th className="px-2 text-right font-medium">km</th>
            <th className="px-2 pr-4 text-right font-medium">33/11 SS</th>
          </tr>
        </thead>
        <tbody>
          {(page as FeederRec[]).map((r, i) => (
            <tr key={`${r.id}-${r.sourceId}-${i}`} className={rowCls(r.sourceId)} onClick={() => pick(r.sourceId)} onMouseEnter={() => setHover(r.sourceId)}>
              <td className="max-w-[220px] truncate py-1.5 pl-4 pr-2 font-medium text-ink" title={r.name}>
                {r.name}
              </td>
              <td className="px-2 text-ink-2">{r.discom}</td>
              <td className="px-2 text-ink">{nodeName(model, r.sourceId)}</td>
              <td className="px-2 text-ink-2">{LINK_METHOD_LABEL[r.method] ?? r.method}</td>
              <td className="px-2 text-right tabular-nums">{nf1(r.km)}</td>
              <td className="px-2 pr-4 text-right tabular-nums">{r.served || "·"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else {
    table = (
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-y border-line bg-surface-2/70 text-left text-[11px] text-ink-2">
            <th className="py-2 pl-4 pr-2 font-medium">Interface</th>
            <th className="px-2 font-medium">Category</th>
            <th className="px-2 font-medium">Tied to</th>
            <th className="px-2 pr-4 font-medium">Line</th>
          </tr>
        </thead>
        <tbody>
          {(page as InterfaceFeed[]).map((f) => (
            <tr
              key={`${f.category}|${f.name}`}
              className="cursor-pointer border-b border-line/70 hover:bg-accent/5"
              onClick={() => onFocus({ key: `iface:${f.category}:${f.name}`, label: `${f.name} (${f.category})`, ssIds: f.ssIds, lineIds: f.lineIds })}
              title="Highlight its connection on the map"
            >
              <td className="py-1.5 pl-4 pr-2 font-medium text-ink">{f.name}</td>
              <td className="px-2 text-ink-2">{f.category === "Railway" ? "Traction SS" : "Generating station"}</td>
              <td className="px-2 text-ink">{f.ssIds.map((id) => nodeName(model, id)).join(", ") || "unresolved"}</td>
              <td className="max-w-[260px] truncate px-2 pr-4 text-ink-2">
                {f.lineIds.map((id) => model.lineById.get(id)?.line.name ?? id).join(", ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <Card
      pad={false}
      className="border-accent/40 ring-1 ring-accent/20"
      title={
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="tabular-nums">{nf0(n)}</span>
          <span>{def.title}</span>
        </span>
      }
      subtitle={
        <>
          <span className="font-medium text-ink">{context}</span>
          <span className="mx-1">·</span>
          {def.hint}
        </>
      }
      actions={
        <>
          {onApply && def.asFilter && (
            <SmallButton onClick={onApply} title={`Make this the page scope: ${formatFilter(def.asFilter)}`}>
              Apply as filter
            </SmallButton>
          )}
          <SmallButton onClick={onToggleMap} title={mapOn ? "Stop highlighting these on the map" : "Highlight these on the map"}>
            <span aria-hidden>{mapOn ? "◉" : "○"}</span> Map
          </SmallButton>
          <SmallButton onClick={exportCsv} disabled={!filtered.rows.length}>
            CSV
          </SmallButton>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drill-down"
            className="grid h-6 w-6 place-items-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            ×
          </button>
        </>
      }
    >
      {n > 8 && (
        <div className="px-4 pb-2">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter these records…"
            className="w-full rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs text-ink placeholder:text-ink-2/70 focus:border-accent focus:outline-none"
            aria-label="Filter drill-down records"
          />
        </div>
      )}
      {loading ? (
        <p className="px-4 pb-4 text-xs text-ink-2">Loading the 33 kV connectivity index…</p>
      ) : !n ? (
        <p className="px-4 pb-4 text-xs text-ink-2">None in this scope.</p>
      ) : (
        <>
          <div className="max-h-[440px] overflow-auto" onMouseLeave={() => setHover(null)}>
            {table}
          </div>
          <PagerBar pager={pager} label="records" />
          <p className="border-t border-line px-4 py-2 text-[11px] leading-snug text-ink-2">
            <Totals model={model} recs={filtered} filteredFrom={needle ? n : null} />
          </p>
        </>
      )}
    </Card>
  );
}

/** The reconciling footer: the clicked figure, recomputed from the (filtered) rows. */
function Totals({ model, recs, filteredFrom }: { model: MisModel; recs: DrillRecords; filteredFrom: number | null }) {
  const of = filteredFrom != null ? ` (filtered from ${nf0(filteredFrom)})` : "";
  switch (recs.kind) {
    case "lines": {
      const ckm = recs.rows.reduce((a, r) => a + r.ckm, 0);
      const route = recs.rows.reduce((a, r) => a + r.routeKm, 0);
      const rated = recs.rows.filter((r) => r.mva != null);
      const mva = rated.reduce((a, r) => a + r.mva!, 0);
      const aged = recs.rows.filter((r) => r.age != null);
      const agedCkm = aged.reduce((a, r) => a + r.ckm, 0);
      const meanAge = agedCkm ? aged.reduce((a, r) => a + r.age! * r.ckm, 0) / agedCkm : null;
      return (
        <>
          {nf0(recs.rows.length)} line rows{of} · Σ {nf0(ckm)} ckm · {nf0(route)} route-km · Σ rating {gva(mva)} ({nf0(rated.length)} rated)
          {meanAge != null && ` · ckm-weighted age ${nf1(meanAge)} yrs`}
        </>
      );
    }
    case "ss": {
      const d = new Set(recs.rows.flatMap((r) => r.discomSsIds)).size;
      const byV = [400, 220, 132].map((v) => recs.rows.filter((r) => r.voltage === v).length);
      return (
        <>
          {nf0(recs.rows.length)} substations{of} · 400 / 220 / 132 kV: {byV.join(" / ")}
          {model.hasDownstream && ` · ${nf0(d)} distinct 33/11 kV SS fed from them`}
        </>
      );
    }
    case "discom": {
      const by = new Map<string, number>();
      for (const r of recs.rows) by.set(r.discom, (by.get(r.discom) ?? 0) + 1);
      return (
        <>
          {nf0(recs.rows.length)} distinct 33/11 kV substations{of} ·{" "}
          {[...by.entries()].map(([k, v]) => `${k} ${nf0(v)}`).join(" · ")} · links inferred (APSPDCL 33 kV map partial)
        </>
      );
    }
    case "feeders": {
      const km = recs.rows.reduce((a, r) => a + r.km, 0);
      return (
        <>
          {nf0(recs.rows.length)} feeder runs{of} · {nf0(km)} km of 33 kV route · TRANSCO source inferred
        </>
      );
    }
    case "ifaces":
      return (
        <>
          {nf0(recs.rows.length)} interfaces{of} · counted per terminal as digitised
        </>
      );
  }
}
