// The omnisearch box (Atlas 2.0 phase 3, PR 10) — replaces SearchBar and the MIS search. One ARIA
// combobox over everything: assets, the distribution network + transformer codes, places, areas
// (→ Plan), layers, actions and lenses. ⌘K / Ctrl-K or "/" focuses it from anywhere; an empty box
// lists lenses and actions (the command palette). ↑ ↓ move, Enter picks, Esc closes.
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { CloseIcon, SearchIcon } from "../components/icons.tsx";
import { VoltageDot } from "../components/VoltageBadge.tsx";
import { generationRes, powerGridRes } from "../data/load.ts";
import { useResource } from "../data/resources.ts";
import { networkTier, placesTier, searchTiers } from "../data/search-client.ts";
import type { SearchHits } from "../data/search-core.ts";
import type { GridData } from "../data/types.ts";
import { useCatalogue } from "../layers/LayerDrawer.tsx";
import { useAppStore } from "../state/store.ts";
import { buildIndex, GROUP_NOTE, groupHits, searchStatic, workerHits, type OmniHit } from "./omni.ts";
import { runTarget } from "./run.ts";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const SEARCH_INPUT_ID = "app-search";

/** ⌘K / Ctrl-K anywhere, or "/" when not typing in a field, focuses the search box. */
function useFocusShortcut(input: React.RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const cmdK = k === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      const slash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing;
      if (!cmdK && !slash) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [input]);
}

export function Omnibox({ data, size = "md" }: { data: GridData; size?: "sm" | "md" }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const deferred = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const lens = useAppStore((s) => s.lens);
  useFocusShortcut(inputRef);

  // Lazy tiers load on first focus: places + the distribution network in the worker; plants and
  // the POWERGRID / railway / HT classes (small) on the main thread.
  const [warm, setWarm] = useState(false);
  const placesStatus = useResource(placesTier, warm ? "" : null).status;
  const netStatus = useResource(networkTier, warm ? "" : null).status;
  const gen = useResource(generationRes, warm ? "" : null).data;
  const pg = useResource(powerGridRes, warm ? "" : null).data;

  const [worker, setWorker] = useState<{ q: string; h: SearchHits }>({ q: "", h: { places: [], net: [], dtr: [] } });
  useEffect(() => {
    const q = deferred.trim();
    if (q.length < 2 || !warm) return;
    let live = true;
    searchTiers(q)
      .then((h) => live && setWorker({ q, h }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // Re-query when a tier finishes loading so its hits appear without another keystroke.
  }, [deferred, warm, placesStatus, netStatus]);

  const index = useMemo(() => buildIndex({ data, gen, pg }), [data, gen, pg]);
  const { entries: layers, on } = useCatalogue();
  const sections = useMemo(() => {
    const q = deferred.trim();
    const hits: OmniHit[] = searchStatic(index, layers, q, { lens, layerOn: (id) => on.has(id) });
    if (worker.q === q) hits.push(...workerHits(worker.h, q));
    return groupHits(hits);
  }, [deferred, index, layers, on, lens, worker]);
  const flat = useMemo(() => sections.flatMap((s) => s.hits), [sections]);
  useEffect(() => setActive(0), [deferred]);

  const choose = (h: OmniHit) => {
    runTarget(h.target, data);
    // Asset / place picks keep their name in the box; commands clear it.
    setQuery(["select", "net", "place"].includes(h.target.t) ? h.label : "");
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (open && query) setQuery("");
      else {
        setOpen(false);
        inputRef.current?.blur();
      }
      return;
    }
    if (!open) {
      if (e.key === "ArrowDown") setOpen(true);
      return;
    }
    if (!flat.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(flat[Math.min(active, flat.length - 1)]);
    }
  };

  const optionId = (i: number) => `${listId}-o${i}`;
  const loading = warm && (placesStatus === "loading" || netStatus === "loading");
  const q = deferred.trim();
  let i = -1;

  return (
    <div className="relative">
      <div
        className={`flex items-center gap-2 rounded-xl border border-line bg-surface/95 px-3 shadow-sm backdrop-blur focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30 ${size === "sm" ? "py-1.5" : "py-2"}`}
      >
        <SearchIcon width={16} height={16} className="shrink-0 text-ink-2" />
        <input
          id={SEARCH_INPUT_ID}
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && flat.length ? optionId(Math.min(active, flat.length - 1)) : undefined}
          aria-label="Search substations, lines, feeders, transformer codes, places, layers and actions"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setWarm(true);
            setOpen(true);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKey}
          placeholder="Search assets, feeders, DTR code, place, layer or action…"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-2/70"
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="shrink-0 text-ink-2 hover:text-ink"
          >
            <CloseIcon width={16} height={16} />
          </button>
        ) : (
          <kbd className="hidden shrink-0 rounded border border-line px-1.5 text-[10px] font-medium text-ink-2 sm:inline">{isMac ? "⌘K" : "Ctrl K"}</kbd>
        )}
      </div>

      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="Search results"
          className="absolute z-50 mt-1.5 max-h-[min(70vh,560px)] w-full min-w-[320px] overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface py-1 shadow-[var(--shadow-panel)]"
        >
          {!q && <p className="px-3 pb-1 pt-1.5 text-[11px] text-ink-2">Type a substation, line, feeder, DTR code, place, circle or layer — or pick a command.</p>}
          {sections.map((sec) => (
            <div key={sec.group} role="group" aria-label={sec.group}>
              <div className="flex items-baseline gap-2 border-t border-line/70 px-3 pb-0.5 pt-2 first:border-t-0">
                <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-2">{sec.group}</span>
              </div>
              {sec.hits.map((h) => {
                i++;
                const idx = i;
                const isActive = idx === Math.min(active, flat.length - 1);
                return (
                  <div
                    key={h.key}
                    id={optionId(idx)}
                    role="option"
                    aria-selected={isActive}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => choose(h)}
                    className={`flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm ${isActive ? "bg-surface-3" : "hover:bg-surface-2"}`}
                  >
                    {h.voltage ? <VoltageDot voltage={h.voltage} /> : <span className="w-2.5 shrink-0" aria-hidden />}
                    {h.tag && (
                      <span className="w-[76px] shrink-0 truncate rounded bg-surface-2 px-1 py-0.5 text-center text-[10px] font-medium text-ink-2">{h.tag}</span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ink">{h.label}</span>
                      {h.sub && <span className="block truncate text-[11px] text-ink-2">{h.sub}</span>}
                    </span>
                  </div>
                );
              })}
              {GROUP_NOTE[sec.group] && q && <p className="px-3 pb-1 text-[10.5px] leading-snug text-ink-2/90">{GROUP_NOTE[sec.group]}</p>}
            </div>
          ))}
          {loading && q.length >= 2 && <p className="px-3 py-1.5 text-xs text-ink-2">Loading places and the distribution network…</p>}
          {q.length >= 2 && !flat.length && !loading && (
            <p className="px-3 py-3 text-sm text-ink-2">
              No match for “{q}”. Distribution coverage is partial (APSPDCL sparse; APCPDCL has no open 11 kV data).
            </p>
          )}
        </div>
      )}
    </div>
  );
}
