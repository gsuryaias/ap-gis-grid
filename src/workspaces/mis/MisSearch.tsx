// Network MIS search — one box for everything an analyst types into an MIS:
//   - a scope (circle / zone / division)      → drills the whole page + map into it
//   - a TRANSCO substation or line              → opens its dossier and flies the map
//   - a DISCOM 33/11 kV substation              → opens the TRANSCO substation that feeds it (inferred)
// Keyboard: "/" focuses, ↑/↓ moves, Enter picks, Esc closes.
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { CloseIcon, SearchIcon } from "../../components/icons.tsx";
import { VoltageDot } from "../../components/VoltageBadge.tsx";
import type { ConnectivityIndex } from "../../data/connectivity.ts";
import type { Voltage } from "../../data/types.ts";
import { SUPPLY_LABEL } from "../../lib/supply-security.ts";
import { DIMENSIONS, isRadial, NONE, type DimId, type MisModel } from "./model.ts";

type Hit =
  | { kind: "scope"; key: string; label: string; dim: DimId; value: string; sub: string }
  | { kind: "ss"; key: string; label: string; id: string; voltage: Voltage; sub: string }
  | { kind: "line"; key: string; label: string; id: string; voltage: Voltage; sub: string }
  | { kind: "discom"; key: string; label: string; id: string; sub: string };

const GROUP: Record<Hit["kind"], string> = {
  scope: "Drill into",
  ss: "TRANSCO substations",
  line: "Lines",
  discom: "33/11 kV substations → TRANSCO source",
};
const LIMIT: Record<Hit["kind"], number> = { scope: 5, ss: 8, line: 6, discom: 6 };

function rank(name: string, q: string): number {
  const n = name.toLowerCase();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.split(/[\s\-./(]+/).some((w) => w.startsWith(q))) return 2;
  if (n.includes(q)) return 3;
  return 99;
}

interface Entry {
  hit: Hit;
  /** Lower-cased text the query is ranked against. */
  text: string;
}

export function MisSearch({
  model,
  conn,
  onDrill,
  onPick,
}: {
  model: MisModel;
  conn: ConnectivityIndex | null;
  onDrill: (dim: DimId, value: string) => void;
  /** Open a TRANSCO substation / line dossier. */
  onPick: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const deferred = useDeferredValue(q);
  const inputRef = useRef<HTMLInputElement>(null);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const dim of ["circle", "zone", "division"] as DimId[]) {
      const d = DIMENSIONS[dim];
      const counts = new Map<string, number>();
      for (const r of model.ss) {
        const v = d.ss!(r);
        if (v !== NONE) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      for (const [v, n] of counts) {
        out.push({
          hit: { kind: "scope", key: `${dim}:${v}`, label: d.format(v), dim, value: v, sub: `${d.label} · ${n} SS` },
          text: v.toLowerCase(),
        });
      }
    }
    for (const r of model.ss) {
      const sup = isRadial(r) ? ` · ${SUPPLY_LABEL[r.supply.cls]}` : "";
      out.push({
        hit: {
          kind: "ss",
          key: r.id,
          label: r.ss.name,
          id: r.id,
          voltage: r.voltage,
          sub: [r.ss.ssCode, r.circle, r.division].filter(Boolean).join(" · ") + sup,
        },
        text: `${r.ss.name} ${r.ss.ssCode ?? ""}`.toLowerCase(),
      });
    }
    for (const r of model.lines) {
      out.push({
        hit: { kind: "line", key: r.id, label: r.line.name, id: r.id, voltage: r.voltage, sub: [r.line.conductor, r.circle].filter(Boolean).join(" · ") },
        text: r.line.name.toLowerCase(),
      });
    }
    if (conn) {
      const source = new Map<string, string[]>();
      for (const r of model.ss) for (const id of r.discomSsIds) (source.get(id) ?? source.set(id, []).get(id)!).push(r.id);
      for (const [id, t] of Object.entries(conn.ss)) {
        const src = source.get(id);
        if (!src?.length) continue;
        const names = src.map((s) => model.ssById.get(s)?.ss.name).filter(Boolean);
        out.push({
          hit: { kind: "discom", key: `d:${id}`, label: t[0], id: src[0], sub: `${t[1]} · fed from ${names.join(" / ")}` },
          text: t[0].toLowerCase(),
        });
      }
    }
    return out;
  }, [model, conn]);

  const hits = useMemo(() => {
    const query = deferred.trim().toLowerCase();
    if (!query) return [];
    const byKind: Record<Hit["kind"], { e: Entry; r: number }[]> = { scope: [], ss: [], line: [], discom: [] };
    for (const e of entries) {
      const r = rank(e.text, query);
      if (r < 99) byKind[e.hit.kind].push({ e, r });
    }
    const out: Hit[] = [];
    for (const kind of ["scope", "ss", "line", "discom"] as Hit["kind"][]) {
      byKind[kind]
        .sort((a, b) => a.r - b.r || a.e.hit.label.localeCompare(b.e.hit.label))
        .slice(0, LIMIT[kind])
        .forEach((x) => out.push(x.e.hit));
    }
    return out;
  }, [entries, deferred]);

  useEffect(() => setActive(0), [deferred]);

  // "/" focuses the box from anywhere in the workspace (not while typing in another field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const choose = (h: Hit) => {
    if (h.kind === "scope") onDrill(h.dim, h.value);
    else onPick(h.id);
    setQ("");
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(hits.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter" && hits[active]) {
      e.preventDefault();
      choose(hits[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const showList = open && q.trim().length > 0;
  return (
    <div className="relative min-w-0 flex-1 sm:max-w-sm">
      <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 focus-within:border-accent">
        <SearchIcon width={14} height={14} className="shrink-0 text-ink-2" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls="mis-search-list"
          aria-autocomplete="list"
          aria-activedescendant={showList && hits[active] ? `mis-hit-${active}` : undefined}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
          placeholder="Search substation, line, circle, division, 33/11 kV SS…  ( / )"
          aria-label="Search the network MIS"
          className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-ink placeholder:text-ink-2/70 focus:outline-none"
        />
        {q && (
          <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="rounded p-0.5 text-ink-2 hover:text-ink">
            <CloseIcon width={12} height={12} />
          </button>
        )}
      </div>
      {showList && (
        <ul
          id="mis-search-list"
          role="listbox"
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-[60vh] overflow-y-auto rounded-lg border border-line bg-surface py-1 text-xs shadow-[var(--shadow-panel)]"
        >
          {hits.map((h, i) => (
            <li key={`${h.kind}:${h.key}`} role="presentation">
              {(i === 0 || hits[i - 1].kind !== h.kind) && (
                <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-2">{GROUP[h.kind]}</div>
              )}
              <button
                id={`mis-hit-${i}`}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(h)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${i === active ? "bg-accent/10" : ""}`}
              >
                {h.kind === "ss" || h.kind === "line" ? (
                  <VoltageDot voltage={h.voltage} />
                ) : (
                  <span className="w-2.5 shrink-0 text-center text-ink-2" aria-hidden>
                    {h.kind === "scope" ? "›" : "·"}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink">{h.label}</span>
                  {h.sub && <span className="block truncate text-[10px] text-ink-2">{h.sub}</span>}
                </span>
              </button>
            </li>
          ))}
          {!hits.length && <li className="px-3 py-2 text-ink-2">No match{conn ? "" : " (33/11 kV index still loading)"}.</li>}
        </ul>
      )}
    </div>
  );
}
