// Shared, dependency-free pagination — a hook that slices any array into pages and a compact
// presentational footer. Used by the Atlas data table and the Risk Room register so both paginate
// identically. Page clamping is done in render (no effects), so shrinking the filtered set never
// strands the view on an empty page.
import { useState } from "react";

export interface Pager<T> {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  start: number;
  end: number;
  pageItems: T[];
  setPage: (p: number) => void;
  setPageSize: (n: number) => void;
}

export function usePager<T>(items: T[], initialSize = 50): Pager<T> {
  const [pageSize, setPageSizeRaw] = useState(initialSize);
  const [rawPage, setPage] = useState(0);
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(0, rawPage), pageCount - 1);
  const start = page * pageSize;
  const end = Math.min(start + pageSize, total);
  const pageItems = items.slice(start, end);
  const setPageSize = (n: number) => {
    setPageSizeRaw(n);
    setPage(0);
  };
  return { page, pageCount, pageSize, total, start, end, pageItems, setPage, setPageSize };
}

const SIZES = [25, 50, 100, 250];

export function PagerBar<T>({ pager, label }: { pager: Pager<T>; label: string }) {
  const { page, pageCount, pageSize, total, start, end, setPage, setPageSize } = pager;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line px-4 py-2 text-xs text-ink-2">
      <span className="tabular-nums">
        {total === 0 ? "No" : `${(start + 1).toLocaleString("en-IN")}–${end.toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")}`} {label}
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        <label className="flex items-center gap-1">
          <span className="hidden sm:inline">Rows</span>
          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            className="rounded-md border border-line bg-surface-2 px-1.5 py-1 text-xs text-ink focus:outline-none"
            aria-label="Rows per page"
          >
            {SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setPage(0)}
            disabled={page === 0}
            aria-label="First page"
            className="rounded-md px-1.5 py-1 hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
          >
            «
          </button>
          <button
            type="button"
            onClick={() => setPage(page - 1)}
            disabled={page === 0}
            aria-label="Previous page"
            className="rounded-md px-1.5 py-1 hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
          >
            ‹
          </button>
          <span className="px-1 tabular-nums">
            {page + 1} / {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage(page + 1)}
            disabled={page >= pageCount - 1}
            aria-label="Next page"
            className="rounded-md px-1.5 py-1 hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
          >
            ›
          </button>
          <button
            type="button"
            onClick={() => setPage(pageCount - 1)}
            disabled={page >= pageCount - 1}
            aria-label="Last page"
            className="rounded-md px-1.5 py-1 hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
          >
            »
          </button>
        </div>
      </div>
    </div>
  );
}
