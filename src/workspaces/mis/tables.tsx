// Network MIS tables: the pivot breakdown (group → drill) and the asset register (scope → asset).
import { useMemo, useState, type ReactNode } from "react";
import { PagerBar, usePager } from "../../components/Pager.tsx";
import { VoltageBadge } from "../../components/VoltageBadge.tsx";
import { downloadText, toCsv } from "../../lib/export.ts";
import { useAppStore } from "../../state/store.ts";
import {
  AGE_BAND_LABEL,
  DIM_ORDER,
  DIMENSIONS,
  ROLE_LABEL,
  type DimId,
  type GroupRow,
  type Metrics,
  type Scope,
  type SsRow,
} from "./model.ts";
import { Card, gva, nf0, nf1, pct, Segmented, SmallButton, VoltageSegBar } from "./ui.tsx";

const csvFile = (name: string, headers: string[], rows: unknown[][]) =>
  downloadText(name, "text/csv", "﻿" + toCsv(headers, rows));

// ---------------------------------------------------------------------------------------------
// Breakdown (pivot)

type ColId = "label" | "ss" | "ckm" | "route" | "mva" | "age" | "past" | "single" | "cut" | "discom";

interface Col {
  id: ColId;
  label: string;
  title: string;
  value: (m: Metrics, r?: GroupRow) => number | string | null;
  /** Needs substation (s) or line (l) rows to be meaningful under the grouping dimension. */
  needs?: "s" | "l";
}

const COLS: Col[] = [
  { id: "ss", label: "Substations", title: "TRANSCO substations, split by voltage", value: (m) => m.ss, needs: "s" },
  { id: "ckm", label: "Circuit-km", title: "Circuit-km, split by voltage", value: (m) => m.ckm, needs: "l" },
  { id: "route", label: "Route-km", title: "Route km (shared towers counted once)", value: (m) => m.routeKm, needs: "l" },
  { id: "mva", label: "Σ rating", title: "Sum of indicative thermal ratings (conductor nominal ampacity)", value: (m) => m.mva, needs: "l" },
  { id: "age", label: "Avg age", title: "Circuit-km-weighted mean line age", value: (m) => m.meanAge, needs: "l" },
  { id: "past", label: "≥ 35 y", title: "Share of circuit-km at or past the 35-year useful life", value: (m) => m.pctPastLife, needs: "l" },
  { id: "single", label: "Single-fed", title: "Substations fed from one neighbour (inferred)", value: (m) => m.singleFed, needs: "s" },
  { id: "cut", label: "Cut-pt", title: "Substations whose loss splits the inferred grid", value: (m) => m.articulation, needs: "s" },
  { id: "discom", label: "33/11 SS", title: "Distinct 33/11 kV substations on inferred 33 kV feeders", value: (m) => m.discomSs, needs: "s" },
];

/** Which dimension to regroup by after drilling into a value of `dim`. */
const NEXT: Record<DimId, DimId[]> = {
  circle: ["division", "voltage", "role"],
  zone: ["circle", "division", "voltage"],
  division: ["voltage", "role", "age"],
  voltage: ["circle", "division", "age"],
  age: ["circle", "voltage", "conductor"],
  conductor: ["voltage", "circle", "age"],
  role: ["circle", "voltage", "division"],
  coastal: ["circle", "voltage", "role"],
};

export function nextDim(dim: DimId, used: Set<DimId>): DimId {
  return NEXT[dim].find((d) => !used.has(d)) ?? DIM_ORDER.find((d) => !used.has(d) && d !== dim) ?? dim;
}

export function Breakdown({
  rows,
  by,
  onBy,
  onDrill,
  total,
  usedDims,
}: {
  rows: GroupRow[];
  by: DimId;
  onBy: (d: DimId) => void;
  onDrill: (key: string) => void;
  total: Metrics;
  usedDims: Set<DimId>;
}) {
  const dim = DIMENSIONS[by];
  const [sort, setSort] = useState<{ col: ColId; desc: boolean } | null>(null);
  const hasS = !!dim.ss;
  const hasL = !!dim.line;
  const cols = COLS.filter((c) => (c.needs === "s" ? hasS : hasL));

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = COLS.find((c) => c.id === sort.col);
    const val = (r: GroupRow) => (sort.col === "label" ? r.label : (col?.value(r.m) ?? -Infinity));
    return [...rows].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const c = typeof va === "string" ? va.localeCompare(String(vb)) : (va as number) - (vb as number);
      return sort.desc ? -c : c;
    });
  }, [rows, sort]);

  const maxSs = Math.max(1, ...rows.map((r) => r.m.ss));
  const maxCkm = Math.max(1, ...rows.map((r) => r.m.ckm));

  const toggleSort = (col: ColId) =>
    setSort((s) => (s?.col === col ? (s.desc ? { col, desc: false } : null) : { col, desc: col !== "label" }));

  const exportCsv = () =>
    csvFile(
      `ap-transco-mis-by-${by}.csv`,
      [dim.label, "Substations", "400 kV SS", "220 kV SS", "132 kV SS", "Line rows", "Circuit-km", "Route-km", "Sum indicative rating (MVA)", "Rated lines", "Mean line age (yrs, ckm-weighted)", "Share of ckm >= 35 yrs", "Single-fed SS", "Cut-point SS", "Bridge lines", "33 kV feeders", "33/11 kV SS"],
      rows.map((r) => [
        r.label, hasS ? r.m.ss : "", hasS ? r.m.ssByV[400] : "", hasS ? r.m.ssByV[220] : "", hasS ? r.m.ssByV[132] : "",
        hasL ? r.m.lines : "", hasL ? r.m.ckm.toFixed(1) : "", hasL ? r.m.routeKm.toFixed(1) : "", hasL ? Math.round(r.m.mva) : "",
        hasL ? r.m.ratedLines : "", r.m.meanAge?.toFixed(1) ?? "", r.m.pctPastLife?.toFixed(3) ?? "",
        hasS ? r.m.singleFed : "", hasS ? r.m.articulation : "", hasL ? r.m.bridges : "", hasS ? r.m.feeders : "", hasS ? r.m.discomSs : "",
      ]),
    );

  const cell = (c: Col, m: Metrics): ReactNode => {
    switch (c.id) {
      case "ss":
        return (
          <div className="min-w-[84px]">
            <div className="tabular-nums">{nf0(m.ss)}</div>
            <VoltageSegBar byV={m.ssByV} unit="SS" height={5} scale={m.ss / maxSs} />
          </div>
        );
      case "ckm":
        return (
          <div className="min-w-[96px]">
            <div className="tabular-nums">{nf0(m.ckm)}</div>
            <VoltageSegBar byV={m.ckmByV} unit="ckm" height={5} scale={m.ckm / maxCkm} />
          </div>
        );
      case "route":
        return nf0(m.routeKm);
      case "mva":
        return m.ratedLines ? gva(m.mva).replace("≈ ", "") : "—";
      case "age":
        return m.meanAge == null ? "—" : nf1(m.meanAge);
      case "past":
        return pct(m.pctPastLife);
      case "single":
        return m.singleFed || "·";
      case "cut":
        return m.articulation || "·";
      case "discom":
        return m.discomSs ? nf0(m.discomSs) : "·";
      default:
        return null;
    }
  };

  const options = DIM_ORDER.map((d) => ({ id: d, label: DIMENSIONS[d].label }));

  return (
    <Card
      pad={false}
      title={
        <span className="flex flex-wrap items-center gap-2">
          Breakdown by
          <select
            value={by}
            onChange={(e) => {
              setSort(null);
              onBy(e.target.value as DimId);
            }}
            className="rounded-md border border-line bg-surface-2 px-2 py-1 text-xs font-medium text-ink focus:outline-none"
            aria-label="Group by"
          >
            {options.map((o) => (
              <option key={o.id} value={o.id} disabled={usedDims.has(o.id)}>
                {o.label}
                {usedDims.has(o.id) ? " (filtered)" : ""}
              </option>
            ))}
          </select>
        </span>
      }
      subtitle="Click a row to drill into it — the whole page, the register and the map follow."
      actions={<SmallButton onClick={exportCsv}>CSV</SmallButton>}
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-y border-line bg-surface-2/70 text-left text-[11px] text-ink-2">
              <Th onClick={() => toggleSort("label")} sort={sort?.col === "label" ? sort : null} className="sticky left-0 bg-surface-2 pl-4">
                {dim.label}
              </Th>
              {cols.map((c) => (
                <Th key={c.id} onClick={() => toggleSort(c.id)} sort={sort?.col === c.id ? sort : null} title={c.title} right>
                  {c.label}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={r.key}
                onClick={() => onDrill(r.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onDrill(r.key);
                  }
                }}
                tabIndex={0}
                className="group cursor-pointer border-b border-line/70 hover:bg-accent/5 focus:bg-accent/10 focus:outline-none"
                title={`Drill into ${dim.label.toLowerCase()} “${r.label}”`}
              >
                <td className="sticky left-0 max-w-[180px] bg-surface py-2 pl-4 pr-3 font-medium text-ink group-hover:bg-surface-2">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{r.label}</span>
                    <span className="text-ink-2 opacity-0 group-hover:opacity-100" aria-hidden>
                      ›
                    </span>
                  </span>
                </td>
                {cols.map((c) => (
                  <td key={c.id} className="px-2.5 py-2 text-right align-top tabular-nums text-ink">
                    <div className="flex justify-end">{cell(c, r.m)}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line text-ink">
              <td className="sticky left-0 bg-surface py-2 pl-4 pr-3 font-semibold">Total in scope</td>
              {cols.map((c) => (
                <td key={c.id} className="px-2.5 py-2 text-right font-semibold tabular-nums">
                  {c.id === "ss"
                    ? nf0(total.ss)
                    : c.id === "ckm"
                      ? nf0(total.ckm)
                      : cell(c, total)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="px-4 py-2 text-[11px] leading-snug text-ink-2">
        {dim.note ? `${dim.note} ` : ""}
        {!hasS && "Substation columns are hidden: this dimension describes lines. "}
        {!hasL && "Line columns are hidden: this dimension describes substations. "}
        Σ rating is indicative (conductor nominal ampacity, not a load-flow); N-1 roles and 33 kV links are inferred
        from geometry.
      </p>
    </Card>
  );
}

function Th({
  children,
  onClick,
  sort,
  right,
  title,
  className = "",
}: {
  children: ReactNode;
  onClick: () => void;
  sort: { desc: boolean } | null;
  right?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <th
      scope="col"
      aria-sort={sort ? (sort.desc ? "descending" : "ascending") : "none"}
      className={`whitespace-nowrap px-2.5 py-2 font-medium ${right ? "text-right" : ""} ${className}`}
      title={title}
    >
      <button type="button" onClick={onClick} className="inline-flex items-center gap-0.5 hover:text-ink">
        {children}
        <span className="w-2 text-[9px]" aria-hidden>
          {sort ? (sort.desc ? "▼" : "▲") : ""}
        </span>
      </button>
    </th>
  );
}

// ---------------------------------------------------------------------------------------------
// Asset register

type RegKind = "ss" | "lines";

export function Register({ scope, label }: { scope: Scope; label: string }) {
  const [kind, setKind] = useState<RegKind>("ss");
  const [q, setQ] = useState("");
  const select = useAppStore((s) => s.select);
  const setHover = useAppStore((s) => s.setHover);
  const selectedId = useAppStore((s) => s.selectedId);
  const needle = q.trim().toLowerCase();

  const ssRows = useMemo(
    () =>
      scope.ss
        .filter((r) => !needle || `${r.ss.name} ${r.ss.ssCode ?? ""} ${r.division ?? ""}`.toLowerCase().includes(needle))
        .sort((a, b) => b.voltage - a.voltage || a.ss.name.localeCompare(b.ss.name)),
    [scope.ss, needle],
  );
  const lineRows = useMemo(
    () =>
      scope.lines
        .filter((r) => !needle || `${r.line.name} ${r.line.conductor ?? ""}`.toLowerCase().includes(needle))
        .sort((a, b) => b.voltage - a.voltage || b.ckm - a.ckm),
    [scope.lines, needle],
  );
  const ssPager = usePager(ssRows, 25);
  const linePager = usePager(lineRows, 25);

  const exportCsv = () => {
    if (kind === "ss") {
      csvFile(
        `ap-transco-mis-substations.csv`,
        ["Name", "SS code", "kV", "Zone", "Circle", "Division", "N-1 role (inferred)", "Feed degree", "Lines connected", "33 kV feeders", "33 kV feeder km", "33/11 kV SS served", "DISCOMs", "Coastal km", "Longitude", "Latitude"],
        ssRows.map((r) => [
          r.ss.name, r.ss.ssCode ?? "", r.voltage, r.zone ?? "", r.circle ?? "", r.division ?? "", ROLE_LABEL[r.role], r.feedDegree,
          r.ss.connectedLineCount, r.feeders, r.feederKm.toFixed(1), r.discomSsIds.length, r.discoms.join("; "), r.ss.coastalKm ?? "",
          r.ss.lng, r.ss.lat,
        ]),
      );
    } else {
      csvFile(
        `ap-transco-mis-lines.csv`,
        ["Name", "kV", "Tower", "Circuits (this row)", "Length km", "Route-km share", "Circuit-km", "Conductor", "Indicative MVA", "Commissioned", "Age (yrs)", "Age band", "Circle", "Zone (from end SS)", "Division (from end SS)", "Bridge: SS islanded (inferred)"],
        lineRows.map((r) => [
          r.line.name, r.voltage, r.line.circuitType ?? r.line.circuit, r.circuits, r.line.lengthKm ?? "", r.routeKm.toFixed(2), r.ckm.toFixed(2),
          r.line.conductor ?? "", r.mva ?? "", r.line.commissioned ?? "", r.age ?? "", AGE_BAND_LABEL[r.ageBand], r.circle ?? "", r.zone ?? "",
          r.division ?? "", r.islanded.length || "",
        ]),
      );
    }
  };

  const rowCls = (id: string) =>
    `cursor-pointer border-b border-line/70 hover:bg-accent/5 ${selectedId === id ? "bg-accent/10" : ""}`;
  const pick = (id: string) => select(id, { fly: true });

  return (
    <Card
      pad={false}
      title="Asset register"
      subtitle={`Every asset in ${label}. Click one for its dossier; hover to find it on the map.`}
      actions={
        <>
          <Segmented
            label="Register type"
            value={kind}
            onChange={setKind}
            options={[
              { id: "ss", label: `Substations ${nf0(scope.ss.length)}` },
              { id: "lines", label: `Lines ${nf0(scope.lines.length)}` },
            ]}
          />
          <SmallButton onClick={exportCsv}>CSV</SmallButton>
        </>
      }
    >
      <div className="px-4 pb-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={kind === "ss" ? "Filter by name, code or division…" : "Filter by name or conductor…"}
          className="w-full rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs text-ink placeholder:text-ink-2/70 focus:border-accent focus:outline-none"
          aria-label="Filter register"
        />
      </div>
      <div className="overflow-x-auto" onMouseLeave={() => setHover(null)}>
        {kind === "ss" ? (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-y border-line bg-surface-2/70 text-left text-[11px] text-ink-2">
                <th className="py-2 pl-4 pr-2 font-medium">Substation</th>
                <th className="px-2 font-medium">Division</th>
                <th className="px-2 font-medium" title="Inferred from the connectivity graph">N-1 role</th>
                <th className="px-2 text-right font-medium" title="Distinct neighbouring substations">Feeds</th>
                <th className="px-2 text-right font-medium" title="33 kV feeders traced out of this SS">Feeders</th>
                <th className="px-2 pr-4 text-right font-medium" title="33/11 kV substations on those feeders">33/11 SS</th>
              </tr>
            </thead>
            <tbody>
              {ssPager.pageItems.map((r) => (
                <tr key={r.id} className={rowCls(r.id)} onClick={() => pick(r.id)} onMouseEnter={() => setHover(r.id)}>
                  <td className="py-1.5 pl-4 pr-2">
                    <span className="flex items-center gap-1.5">
                      <VoltageBadge voltage={r.voltage} small />
                      <span className="truncate font-medium text-ink">{r.ss.name}</span>
                    </span>
                  </td>
                  <td className="px-2 text-ink-2">{r.division ?? "—"}</td>
                  <td className="px-2 text-ink-2">
                    <RoleText role={r.role} />
                  </td>
                  <td className="px-2 text-right tabular-nums">{r.feedDegree}</td>
                  <td className="px-2 text-right tabular-nums">{r.feeders || "·"}</td>
                  <td className="px-2 pr-4 text-right tabular-nums">{r.discomSsIds.length || "·"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-y border-line bg-surface-2/70 text-left text-[11px] text-ink-2">
                <th className="py-2 pl-4 pr-2 font-medium">Line</th>
                <th className="px-2 text-right font-medium">ckm</th>
                <th className="px-2 font-medium">Conductor</th>
                <th className="px-2 text-right font-medium">Year</th>
                <th className="px-2 pr-4 text-right font-medium" title="Inferred: an outage would island substations">N-1</th>
              </tr>
            </thead>
            <tbody>
              {linePager.pageItems.map((r) => (
                <tr key={r.id} className={rowCls(r.id)} onClick={() => pick(r.id)} onMouseEnter={() => setHover(r.id)}>
                  <td className="max-w-[320px] py-1.5 pl-4 pr-2">
                    <span className="flex items-center gap-1.5">
                      <VoltageBadge voltage={r.voltage} small />
                      <span className="truncate text-ink" title={r.line.name}>
                        {r.line.name}
                      </span>
                    </span>
                  </td>
                  <td className="px-2 text-right tabular-nums">{nf1(r.ckm)}</td>
                  <td className="px-2 text-ink-2">{r.line.conductor ?? "—"}</td>
                  <td className="px-2 text-right tabular-nums text-ink-2">
                    {r.year ?? "—"}
                    {r.age != null && r.age >= 35 && <span className="ml-1 text-ink">({r.age}y)</span>}
                  </td>
                  <td className="px-2 pr-4 text-right">
                    {r.islanded.length ? (
                      <span className="inline-flex items-center gap-1 text-ink" title={`Islands ${r.islanded.length} SS`}>
                        <span className="h-2 w-2 rounded-full bg-[#d03b3b]" aria-hidden />
                        Bridge
                      </span>
                    ) : (
                      "·"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {kind === "ss" ? <PagerBar pager={ssPager} label="substations" /> : <PagerBar pager={linePager} label="lines" />}
    </Card>
  );
}

const ROLE_DOT: Partial<Record<string, string>> = { articulation: "#d03b3b", "single-fed": "#ec835a" };

export function RoleText({ role }: { role: SsRow["role"] }) {
  const c = ROLE_DOT[role];
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {c && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: c }} aria-hidden />}
      {ROLE_LABEL[role]}
    </span>
  );
}
