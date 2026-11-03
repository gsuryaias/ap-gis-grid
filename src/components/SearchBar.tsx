import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  dtrShardsFor,
  loadDtrShard,
  loadNetworkIndex,
  looksLikeDtrCode,
  NET_KIND_LABEL,
  useNetworkIndex,
  type NetItem,
} from "../data/network-search.ts";
import { useOverlayStore } from "../overlays/store.ts";
import type { GridData, PlaceItem, SearchItem } from "../data/types.ts";
import { useAppStore } from "../state/store.ts";
import { SearchIcon, CloseIcon, SubstationIcon, LineIcon, PinIcon } from "./icons.tsx";
import { VoltageDot } from "./VoltageBadge.tsx";

function rank(item: { name: string }, q: string): number {
  const name = item.name.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  const wordStart = name.split(/[\s-]+/).some((w) => w.startsWith(q));
  if (wordStart) return 2;
  if (name.includes(q)) return 3;
  return 99;
}

/** Gazetteer hits shown below the grid assets (which stay first-class). */
const PLACE_LIMIT = 8;
/** Map-jump zoom per place type — districts are wide, villages/landmarks are tight. */
const PLACE_ZOOM: Record<string, number> = { state: 7, district: 9, mandal: 11, city: 12 };
const PLACE_ZOOM_DEFAULT = 13;

/** Distribution-network hits (33/11 kV SS, 33 / 11 kV feeders, sections) and transformers. */
const NET_LIMIT = 8;
const DTR_LIMIT = 6;

type Row =
  | { kind: "feature"; item: SearchItem }
  | { kind: "net"; item: NetItem }
  | { kind: "place"; item: PlaceItem };

const GROUP_LABEL: Record<Row["kind"], string> = {
  feature: "",
  net: "Distribution network · 33 / 11 kV",
  place: "Places",
};

export function SearchBar({ data }: { data: GridData }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const deferred = useDeferredValue(query);
  const select = useAppStore((s) => s.select);
  const places = useAppStore((s) => s.places);
  const placesStatus = useAppStore((s) => s.placesStatus);
  const ensurePlaces = useAppStore((s) => s.ensurePlaces);
  const setNearbyOrigin = useAppStore((s) => s.setNearbyOrigin);
  const inputRef = useRef<HTMLInputElement>(null);
  const netIndex = useNetworkIndex();
  const focusNetwork = useOverlayStore((s) => s.focusNetwork);

  const netMatches = useMemo(() => {
    const q = deferred.trim().toLowerCase();
    if (q.length < 2 || !netIndex) return [];
    return netIndex.items
      .map((it) => ({ it, r: rank({ name: it.label }, q) }))
      .filter((x) => x.r < 99)
      .sort((a, b) => a.r - b.r || a.it.label.localeCompare(b.it.label))
      .slice(0, NET_LIMIT)
      .map((x) => x.it);
  }, [deferred, netIndex]);

  // Transformers: only for code-like queries, and only the shard(s) that code can live in.
  const [dtrMatches, setDtrMatches] = useState<NetItem[]>([]);
  useEffect(() => {
    const q = deferred.trim();
    if (!netIndex || !looksLikeDtrCode(q)) {
      setDtrMatches([]);
      return;
    }
    let live = true;
    const lq = q.toLowerCase();
    Promise.all(dtrShardsFor(q, netIndex.shards).map((k) => loadDtrShard(k, netIndex.chains).catch(() => [])))
      .then((all) => {
        if (!live) return;
        const hits = all.flat().filter((d) => d.label.toLowerCase().startsWith(lq));
        hits.sort((a, b) => a.label.length - b.label.length || a.label.localeCompare(b.label));
        setDtrMatches(hits.slice(0, DTR_LIMIT));
      });
    return () => {
      live = false;
    };
  }, [deferred, netIndex]);

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

  // Gazetteer matches (lazy data — empty until places.json arrives). Ranked like the grid
  // assets, with population as the tie-break so "Tirupati" the city beats its namesake villages.
  const placeMatches = useMemo(() => {
    const q = deferred.trim().toLowerCase();
    if (q.length < 2 || !places) return [];
    return places
      .map((p) => ({ p, r: rank(p, q) }))
      .filter((x) => x.r < 99)
      .sort((a, b) => a.r - b.r || b.p.pop - a.p.pop || a.p.name.localeCompare(b.p.name))
      .slice(0, PLACE_LIMIT)
      .map((x) => x.p);
  }, [deferred, places]);

  const rows = useMemo<Row[]>(
    () => [
      ...matches.map((item): Row => ({ kind: "feature", item })),
      ...[...dtrMatches, ...netMatches].map((item): Row => ({ kind: "net", item })),
      ...placeMatches.map((item): Row => ({ kind: "place", item })),
    ],
    [matches, dtrMatches, netMatches, placeMatches],
  );

  // Which substation names are duplicated → show disambiguating detail.
  const dupNames = useMemo(() => {
    const seen = new Map<string, number>();
    for (const i of data.searchIndex) if (i.kind === "substation") seen.set(i.name, (seen.get(i.name) ?? 0) + 1);
    return seen;
  }, [data.searchIndex]);

  function choose(row: Row) {
    if (row.kind === "feature") {
      focusNetwork(null);
      select(row.item.id, { fly: true });
    } else if (row.kind === "net") {
      // Network assets aren't core features — open the trace panel and fly to the asset.
      select(null);
      setNearbyOrigin(null);
      focusNetwork(row.item);
      setQuery(row.item.label);
      setOpen(false);
      inputRef.current?.blur();
      return;
    } else {
      // A place isn't a selectable feature — jump there and anchor the nearest-SS readout on it.
      const p = row.item;
      select(null);
      setNearbyOrigin({ lng: p.lng, lat: p.lat, label: p.name, fly: true, zoom: PLACE_ZOOM[p.type] ?? PLACE_ZOOM_DEFAULT });
    }
    setQuery(row.item.name);
    setOpen(false);
    inputRef.current?.blur();
  }

  function onKey(e: React.KeyboardEvent) {
    if (!open || !rows.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(rows[active]);
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
          onFocus={() => {
            ensurePlaces(); // first focus kicks off the lazy gazetteer fetch
            void loadNetworkIndex().catch(() => undefined); // …and the distribution-network tier
            setOpen(true);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKey}
          placeholder="Search grid, feeders, DTR code or place…"
          aria-label="Search substations, lines, 33 / 11 kV feeders, transformer codes and Andhra Pradesh places"
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

      {open && rows.length > 0 && (
        <ul
          className="absolute z-30 mt-1.5 max-h-[60vh] w-full overflow-auto rounded-xl border border-line bg-surface/98 py-1 shadow-[var(--shadow-panel)] backdrop-blur"
          role="listbox"
        >
          {rows.map((row, i) => {
            const rowClass = `flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm ${
              i === active ? "bg-surface-3" : "hover:bg-surface-2"
            }`;
            const header =
              row.kind !== "feature" && (i === 0 || rows[i - 1].kind !== row.kind) ? (
                <div className={`px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-ink-2 ${i > 0 ? "mt-1 border-t border-line" : ""}`}>
                  {GROUP_LABEL[row.kind]}
                </div>
              ) : null;
            if (row.kind === "net") {
              const n = row.item;
              return (
                <li key={`n-${n.kind}-${n.ref || n.label}-${n.lng}`} role="option" aria-selected={i === active}>
                  {header}
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(row);
                    }}
                    onMouseEnter={() => setActive(i)}
                    className={rowClass}
                  >
                    <span className="w-[72px] shrink-0 rounded bg-surface-2 px-1 py-0.5 text-center text-[10px] font-medium text-ink-2">
                      {NET_KIND_LABEL[n.kind]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ink">{n.label}</span>
                      <span className="block truncate text-[11px] text-ink-2">{n.sub}</span>
                    </span>
                  </button>
                </li>
              );
            }
            if (row.kind === "place") {
              const p = row.item;
              return (
                <li key={`p-${p.name}-${p.lng}-${p.lat}`} role="option" aria-selected={i === active}>
                  {header}
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(row);
                    }}
                    onMouseEnter={() => setActive(i)}
                    className={rowClass}
                  >
                    <PinIcon width={15} height={15} className="shrink-0 text-ink-2" />
                    <span className="min-w-0 flex-1 truncate text-ink">{p.name}</span>
                    <span className="shrink-0 text-xs text-ink-2">
                      {p.district ? `${p.type} · ${p.district}` : p.type}
                    </span>
                  </button>
                </li>
              );
            }
            const m = row.item;
            const isDup = m.kind === "substation" && (dupNames.get(m.name) ?? 0) > 1;
            return (
              <li key={m.id} role="option" aria-selected={i === active}>
                <button
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(row);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={rowClass}
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
          {placesStatus === "loading" && (
            <li className="px-3 py-2 text-xs text-ink-2">Loading AP places…</li>
          )}
        </ul>
      )}
    </div>
  );
}
