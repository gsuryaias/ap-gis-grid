import { useEffect, useRef, useState } from "react";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type { GridData, LineProps, SubstationProps } from "../data/types.ts";
import { formatKm } from "../lib/format.ts";
import { useAppStore } from "../state/store.ts";
import { CIRCUIT_LABEL } from "../theme/palette.ts";
import { CloseIcon, SearchIcon } from "./icons.tsx";
import { VoltageBadge } from "./VoltageBadge.tsx";

type Tab = "substation" | "line";

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
  filter,
}: {
  rows: T[];
  columns: ColumnDef<T>[];
  filter: string;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const selectedId = useAppStore((s) => s.selectedId);
  const select = useAppStore((s) => s.select);
  const scrollRef = useRef<HTMLDivElement>(null);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: "includesString",
  });

  const model = table.getRowModel();

  useEffect(() => {
    if (!selectedId || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-row-id="${selectedId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  return (
    <div ref={scrollRef} className="h-full overflow-auto">
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
          {model.rows.map((row) => (
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
          {model.rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-ink-2">
                No matches.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function DataTableSheet({ data }: { data: GridData }) {
  const open = useAppStore((s) => s.tableOpen);
  const toggle = useAppStore((s) => s.toggleTable);
  const selectedId = useAppStore((s) => s.selectedId);
  const selectedKind = selectedId ? data.byId.get(selectedId)?.kind : undefined;
  const [tab, setTab] = useState<Tab>("substation");
  const [filter, setFilter] = useState("");

  // Follow the selected feature's kind into the matching tab.
  useEffect(() => {
    if (selectedKind) setTab(selectedKind);
  }, [selectedKind]);

  if (!open) return null;

  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-40 flex h-[46vh] min-h-[280px] flex-col rounded-t-[var(--radius-panel)] border-t border-line bg-surface/97 shadow-[0_-8px_30px_-8px_rgb(13_27_42/0.3)] backdrop-blur">
      <header className="flex items-center gap-3 border-b border-line px-3 py-2">
        <div className="flex rounded-lg bg-surface-2 p-0.5">
          {(["substation", "line"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1 text-sm font-medium ${
                tab === t ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"
              }`}
            >
              {t === "substation" ? `Substations · ${data.substations.length}` : `Lines · ${data.lines.length}`}
            </button>
          ))}
        </div>
        <div className="flex flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5">
          <SearchIcon width={15} height={15} className="text-ink-2" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${tab === "substation" ? "substations" : "lines"}…`}
            className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-2/70"
          />
        </div>
        <button onClick={() => toggle(false)} aria-label="Close table" className="rounded-md p-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink">
          <CloseIcon />
        </button>
      </header>
      <div className="min-h-0 flex-1">
        {tab === "substation" ? (
          <Table rows={data.substations} columns={ssColumns} filter={filter} />
        ) : (
          <Table rows={data.lines} columns={lineColumns} filter={filter} />
        )}
      </div>
    </div>
  );
}
