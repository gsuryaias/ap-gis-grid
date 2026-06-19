import { useEffect, useRef, useState } from "react";
import {
  type ColumnDef,
  type Row,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { CIRCUITS, VOLTAGES, type GridData, type LineProps, type SubstationProps, type Voltage } from "../data/types.ts";
import { formatKm } from "../lib/format.ts";
import { useAppStore } from "../state/store.ts";
import { CIRCUIT_LABEL, VOLTAGE_COLOR } from "../theme/palette.ts";
import { downloadText, linesToCsv, subsetFeatures, substationsToCsv, substationsToGeoJSON } from "../lib/export.ts";
import { CloseIcon, DownloadIcon, SearchIcon } from "./icons.tsx";
import { VoltageBadge } from "./VoltageBadge.tsx";
import { usePager, PagerBar } from "./Pager.tsx";

type Tab = "substation" | "line";
const SHEET_H_KEY = "dss-table-h";

/** Mirror the table's case-insensitive text filter over the visible columns, so an export
 *  reflects exactly the rows the user is looking at. */
function matchSubstation(s: SubstationProps, q: string): boolean {
  if (!q) return true;
  return [s.name, s.voltage, s.circle, s.ssCode, s.connectedLineCount].some((v) =>
    String(v ?? "").toLowerCase().includes(q),
  );
}
function matchLine(l: LineProps, q: string): boolean {
  if (!q) return true;
  return [l.name, l.voltage, CIRCUIT_LABEL[l.circuit], l.lengthKm, l.connectsSS.length].some((v) =>
    String(v ?? "").toLowerCase().includes(q),
  );
}

const ssColumns: ColumnDef<SubstationProps>[] = [
  { accessorKey: "name", header: "Substation", cell: (c) => <span className="font-medium text-ink">{c.getValue<string>()}</span> },
  { accessorKey: "voltage", header: "kV", cell: (c) => <VoltageBadge voltage={c.row.original.voltage} small /> },
  { accessorKey: "circle", header: "Circle", cell: (c) => c.getValue<string>() ?? "—" },
  { accessorKey: "ssCode", header: "Code", cell: (c) => <span className="text-xs text-ink-2">{c.getValue<string>() ?? "—"}</span> },
  { accessorKey: "connectedLineCount", header: "Lines", cell: (c) => c.getValue<number>() },
];

const lineColumns: ColumnDef<LineProps>[] = [
  { accessorKey: "name", header: "Line", cell: (c) => <span className="font-medium text-ink">{c.getValue<string>()}</span> },
  { accessorKey: "voltage", header: "kV", cell: (c) => <VoltageBadge voltage={c.row.original.voltage} small /> },
  { accessorKey: "circuit", header: "Circuit", cell: (c) => CIRCUIT_LABEL[c.getValue<string>()] },
  { accessorFn: (r) => r.lengthKm ?? 0, id: "lengthKm", header: "Length", cell: (c) => formatKm(c.row.original.lengthKm) },
  { accessorFn: (r) => r.connectsSS.length, id: "conn", header: "SS", cell: (c) => c.row.original.connectsSS.length },
];

function Table<T extends { id: string }>({
  rows,
  columns,
  unit,
}: {
  rows: T[];
  columns: ColumnDef<T>[];
  unit: string;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const selectedId = useAppStore((s) => s.selectedId);
  const select = useAppStore((s) => s.select);
  const scrollRef = useRef<HTMLDivElement>(null);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const sortedRows = table.getRowModel().rows;
  const pager = usePager<Row<T>>(sortedRows, 50);

  // Reset to the first page whenever the filtered set changes (so a filter never strands the view).
  const { setPage } = pager;
  useEffect(() => {
    setPage(0);
  }, [rows, setPage]);

  useEffect(() => {
    if (!selectedId || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-row-id="${selectedId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId, pager.page]);

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-surface-2">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    onClick={h.column.getToggleSortingHandler()}
                    className="cursor-pointer select-none border-b border-line px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-2 hover:text-ink"
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {{ asc: " ↑", desc: " ↓" }[h.column.getIsSorted() as string] ?? ""}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {pager.pageItems.map((row) => (
              <tr
                key={row.id}
                data-row-id={row.original.id}
                onClick={() => select(row.original.id, { fly: true })}
                onMouseEnter={() => useAppStore.getState().setHover(row.original.id)}
                onMouseLeave={() => useAppStore.getState().setHover(null)}
                className={`cursor-pointer border-b border-line/60 ${
                  row.original.id === selectedId ? "bg-accent/12" : "hover:bg-surface-2"
                }`}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-1.5 align-middle">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {sortedRows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-ink-2">
                  No matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <PagerBar pager={pager} label={unit} />
    </div>
  );
}

/** Toggle chip for a voltage facet — coloured by the voltage palette when active. */
function VoltChip({ v, on, onToggle }: { v: Voltage; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors ${
        on ? "border-transparent text-white" : "border-line text-ink-2 hover:text-ink"
      }`}
      style={on ? { background: VOLTAGE_COLOR[v] } : undefined}
    >
      {v}
    </button>
  );
}

export function DataTableSheet({ data }: { data: GridData }) {
  const open = useAppStore((s) => s.tableOpen);
  const toggle = useAppStore((s) => s.toggleTable);
  const selectedId = useAppStore((s) => s.selectedId);
  const selectedKind = selectedId ? data.byId.get(selectedId)?.kind : undefined;
  const [tab, setTab] = useState<Tab>("substation");
  const [filter, setFilter] = useState("");
  const [volts, setVolts] = useState<Record<Voltage, boolean>>({ 400: true, 220: true, 132: true });
  const [circle, setCircle] = useState("");
  const [circuit, setCircuit] = useState("");

  // Resizable sheet height (drag the top edge), persisted across reloads.
  const [sheetH, setSheetH] = useState<number | null>(null);
  const draggingH = useRef(false);
  useEffect(() => {
    const s = Number(localStorage.getItem(SHEET_H_KEY));
    if (Number.isFinite(s) && s >= 200) setSheetH(s);
  }, []);

  // Follow the selected feature's kind into the matching tab (generation isn't a table tab).
  useEffect(() => {
    if (selectedKind === "substation" || selectedKind === "line") setTab(selectedKind);
  }, [selectedKind]);

  const q = filter.trim().toLowerCase();
  const ssRows = data.substations.filter(
    (s) => volts[s.voltage] && (!circle || s.circle === circle) && matchSubstation(s, q),
  );
  const lineRows = data.lines.filter(
    (l) => volts[l.voltage] && (!circuit || l.circuit === circuit) && matchLine(l, q),
  );

  const filtersActive = !!q || !volts[400] || !volts[220] || !volts[132] || !!circle || !!circuit;
  const clearFilters = () => {
    setFilter("");
    setVolts({ 400: true, 220: true, 132: true });
    setCircle("");
    setCircuit("");
  };

  const suffix = filtersActive ? "-filtered" : "";
  const exportCsv = () => {
    if (tab === "substation") {
      downloadText(`aptransco-substations${suffix}.csv`, "text/csv", substationsToCsv(ssRows));
    } else {
      downloadText(`aptransco-lines${suffix}.csv`, "text/csv", linesToCsv(lineRows));
    }
  };
  const exportGeoJson = () => {
    if (tab === "substation") {
      const fc = substationsToGeoJSON(ssRows);
      downloadText(`aptransco-substations${suffix}.geojson`, "application/geo+json", JSON.stringify(fc));
    } else {
      const ids = new Set(lineRows.map((l) => l.id));
      const fc = subsetFeatures(data.linesFc, ids);
      downloadText(`aptransco-lines${suffix}.geojson`, "application/geo+json", JSON.stringify(fc));
    }
  };

  const onDragMove = (e: React.PointerEvent) => {
    if (!draggingH.current) return;
    const h = Math.round(Math.min(Math.max(window.innerHeight - e.clientY, 200), window.innerHeight * 0.9));
    setSheetH(h);
    localStorage.setItem(SHEET_H_KEY, String(h));
  };
  const onDragEnd = (e: React.PointerEvent) => {
    if (!draggingH.current) return;
    draggingH.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    document.body.style.userSelect = "";
  };

  if (!open) return null;

  return (
    <div
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-40 flex min-h-[200px] flex-col rounded-t-[var(--radius-panel)] border-t border-line bg-surface/97 shadow-[0_-8px_30px_-8px_rgb(13_27_42/0.3)] backdrop-blur"
      style={{ height: sheetH != null ? `${sheetH}px` : "46vh" }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize table"
        onPointerDown={(e) => {
          draggingH.current = true;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          document.body.style.userSelect = "none";
        }}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        title="Drag to resize the table"
        className="group flex h-3 w-full shrink-0 cursor-row-resize touch-none items-center justify-center"
      >
        <span className="h-1 w-10 rounded-full bg-line group-hover:bg-accent" />
      </div>

      <header className="flex flex-wrap items-center gap-3 px-3 pb-2">
        <div className="flex rounded-lg bg-surface-2 p-0.5">
          {(["substation", "line"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1 text-sm font-medium ${
                tab === t ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"
              }`}
            >
              {t === "substation"
                ? `Substations · ${ssRows.length.toLocaleString("en-IN")}`
                : `Lines · ${lineRows.length.toLocaleString("en-IN")}`}
            </button>
          ))}
        </div>
        <div className="flex min-w-[160px] flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5">
          <SearchIcon width={15} height={15} className="text-ink-2" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${tab === "substation" ? "substations" : "lines"}…`}
            className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-2/70"
          />
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={exportCsv}
            title={`Export the ${tab === "substation" ? "substations" : "lines"} shown as CSV`}
            className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <DownloadIcon width={14} height={14} /> CSV
          </button>
          <button
            onClick={exportGeoJson}
            title={`Export the ${tab === "substation" ? "substations" : "lines"} shown as GeoJSON`}
            className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <DownloadIcon width={14} height={14} /> GeoJSON
          </button>
        </div>
        <button onClick={() => toggle(false)} aria-label="Close table" className="rounded-md p-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink">
          <CloseIcon />
        </button>
      </header>

      {/* Facet filter bar — voltage chips + circle (SS) / circuit (lines). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-y border-line bg-surface-2/40 px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-ink-2">kV</span>
          {VOLTAGES.map((v) => (
            <VoltChip key={v} v={v} on={volts[v]} onToggle={() => setVolts((s) => ({ ...s, [v]: !s[v] }))} />
          ))}
        </div>
        {tab === "substation" ? (
          <label className="flex items-center gap-1.5 text-[11px] text-ink-2">
            Circle
            <select
              value={circle}
              onChange={(e) => setCircle(e.target.value)}
              className="rounded-md border border-line bg-surface px-1.5 py-1 text-xs text-ink focus:outline-none"
            >
              <option value="">All</option>
              {data.meta.circles.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="flex items-center gap-1.5 text-[11px] text-ink-2">
            Circuit
            <select
              value={circuit}
              onChange={(e) => setCircuit(e.target.value)}
              className="rounded-md border border-line bg-surface px-1.5 py-1 text-xs text-ink focus:outline-none"
            >
              <option value="">All</option>
              {CIRCUITS.map((c) => (
                <option key={c} value={c}>
                  {CIRCUIT_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
        )}
        {filtersActive && (
          <button
            onClick={clearFilters}
            className="ml-auto rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-2 hover:bg-surface hover:text-ink"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {tab === "substation" ? (
          <Table rows={ssRows} columns={ssColumns} unit="substations" />
        ) : (
          <Table rows={lineRows} columns={lineColumns} unit="lines" />
        )}
      </div>
    </div>
  );
}
