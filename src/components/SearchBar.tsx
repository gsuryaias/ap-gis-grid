import { useDeferredValue, useMemo, useRef, useState } from "react";
import type { GridData, SearchItem } from "../data/types.ts";
import { useAppStore } from "../state/store.ts";
import { SearchIcon, CloseIcon, SubstationIcon, LineIcon } from "./icons.tsx";
import { VoltageDot } from "./VoltageBadge.tsx";

function rank(item: SearchItem, q: string): number {
  const name = item.name.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  const wordStart = name.split(/[\s-]+/).some((w) => w.startsWith(q));
  if (wordStart) return 2;
  if (name.includes(q)) return 3;
  return 99;
}

export function SearchBar({ data }: { data: GridData }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const deferred = useDeferredValue(query);
  const select = useAppStore((s) => s.select);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const q = deferred.trim().toLowerCase();
    if (q.length < 2) return [];
    return data.searchIndex
      .map((item) => ({ item, r: rank(item, q) }))
      .filter((x) => x.r < 99)
      .sort((a, b) => a.r - b.r || b.item.voltage - a.item.voltage || a.item.name.localeCompare(b.item.name))
      .slice(0, 40)
      .map((x) => x.item);
  }, [deferred, data.searchIndex]);

  // Which substation names are duplicated → show disambiguating detail.
  const dupNames = useMemo(() => {
    const seen = new Map<string, number>();
    for (const i of data.searchIndex) if (i.kind === "substation") seen.set(i.name, (seen.get(i.name) ?? 0) + 1);
    return seen;
  }, [data.searchIndex]);

  function choose(item: SearchItem) {
    select(item.id, { fly: true });
    setQuery(item.name);
    setOpen(false);
    inputRef.current?.blur();
  }

  function onKey(e: React.KeyboardEvent) {
    if (!open || !matches.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(matches[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface/95 px-3 py-2 shadow-sm backdrop-blur focus-within:border-accent">
        <SearchIcon className="shrink-0 text-ink-2" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKey}
          placeholder="Search substations & lines…"
          aria-label="Search substations and lines"
          className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-2/70"
        />
        {query && (
          <button
            onClick={() => {
              setQuery("");
              setOpen(false);
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="shrink-0 text-ink-2 hover:text-ink"
          >
            <CloseIcon width={16} height={16} />
          </button>
        )}
      </div>

      {open && matches.length > 0 && (
        <ul
          className="absolute z-30 mt-1.5 max-h-[60vh] w-full overflow-auto rounded-xl border border-line bg-surface/98 py-1 shadow-[var(--shadow-panel)] backdrop-blur"
          role="listbox"
        >
          {matches.map((m, i) => {
            const isDup = m.kind === "substation" && (dupNames.get(m.name) ?? 0) > 1;
            return (
              <li key={m.id} role="option" aria-selected={i === active}>
                <button
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(m);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm ${
                    i === active ? "bg-surface-3" : "hover:bg-surface-2"
                  }`}
                >
                  <VoltageDot voltage={m.voltage} />
                  {m.kind === "substation" ? (
                    <SubstationIcon width={15} height={15} className="shrink-0 text-ink-2" />
                  ) : (
                    <LineIcon width={15} height={15} className="shrink-0 text-ink-2" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-ink">{m.name}</span>
                  {(isDup || m.kind === "line") && m.sub && (
                    <span className="shrink-0 text-xs text-ink-2">{m.sub}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
