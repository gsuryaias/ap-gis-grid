// The one detail view for every selectable feature (replaces DetailPanel, the MIS Dossier,
// NetworkTracePanel and the overlay tap popups). Renders the selection's adapter sections, a back
// breadcrumb, the "What's here" list of everything under the last tap, and the usual actions
// (spotlight, GeoJSON, centre, close). Workspaces add sections through `extend`.
import { useState, type ReactNode } from "react";
import {
  AreaIcon,
  BoltIcon,
  CloseIcon,
  DownloadIcon,
  LineIcon,
  PinIcon,
  SpotlightIcon,
  SubstationIcon,
  TargetIcon,
  TowerIcon,
} from "../components/icons.tsx";
import { VoltageBadge } from "../components/VoltageBadge.tsx";
import { downloadText } from "../lib/export.ts";
import { useAppStore } from "../state/store.ts";
import type { HereItem } from "../state/types.ts";
import { mergeSections } from "./inspect.ts";
import type { Header, Inspected, InspectorExtension } from "./types.ts";
import { SectionView } from "./ui.tsx";
import { useInspected } from "./useInspected.ts";

/** Titles of refs seen this session — for the "Back to …" breadcrumb. */
const titles = new Map<string, string>();

const ICON: Record<Header["icon"], ReactNode> = {
  ss: <SubstationIcon />,
  line: <LineIcon />,
  plant: <BoltIcon />,
  tower: <TowerIcon />,
  point: <PinIcon />,
  area: <AreaIcon />,
};

const iconBtn = "rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink";

export interface InspectorProps {
  /** `panel`: the floating card (map lenses); `sheet`: fills the phone bottom sheet; `inline`: a card in an analysis column. */
  variant?: "panel" | "sheet" | "inline";
  extend?: InspectorExtension;
}

const SHELL_CLASS = {
  panel:
    "pointer-events-auto flex min-h-0 max-h-full w-[340px] max-w-[92vw] flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface/96 shadow-[var(--shadow-panel)] backdrop-blur",
  sheet: "flex h-full min-h-0 w-full flex-col overflow-hidden",
  inline: "flex flex-col overflow-hidden rounded-xl border border-accent/40 bg-surface shadow-[var(--shadow-panel)]",
};

function Shell({ variant, label, children }: { variant: "panel" | "sheet" | "inline"; label: string; children: ReactNode }) {
  return (
    <aside aria-label={label} className={SHELL_CLASS[variant]}>
      {children}
    </aside>
  );
}

function HereList({ items, current, onPick }: { items: HereItem[]; current: string | null; onPick: (ref: string) => void }) {
  return (
    <ul className="divide-y divide-line/70">
      {items.map((h) => (
        <li key={h.ref}>
          <button
            type="button"
            onClick={() => onPick(h.ref)}
            aria-current={h.ref === current ? "true" : undefined}
            className={`flex w-full flex-col items-start px-4 py-1.5 text-left hover:bg-surface-2 ${h.ref === current ? "bg-accent/10" : ""}`}
          >
            <span className="text-[10.5px] uppercase tracking-wide text-ink-2">{h.kind}</span>
            <span className="w-full truncate text-sm font-medium text-ink">{h.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Header({ ins, onClose }: { ins: Inspected; onClose: () => void }) {
  const spotlight = useAppStore((s) => s.spotlight);
  const toggleSpotlight = useAppStore((s) => s.toggleSpotlight);
  const select = useAppStore((s) => s.select);
  const h = ins.header;
  return (
    <header className="flex shrink-0 items-start gap-2 border-b border-line px-4 py-3">
      <span className="mt-0.5 text-ink-2">{ICON[h.icon]}</span>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          {h.badge &&
            ("voltage" in h.badge ? (
              <VoltageBadge voltage={h.badge.voltage} small />
            ) : (
              <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white" style={{ backgroundColor: h.badge.color }}>
                {h.badge.text}
              </span>
            ))}
          <span className="text-[11px] uppercase tracking-wide text-ink-2">{h.kicker}</span>
        </div>
        <h2 className="break-words text-[15px] font-semibold leading-snug text-ink">{h.title}</h2>
        {h.sub && <p className="text-xs text-ink-2">{h.sub}</p>}
      </div>
      <div className="flex shrink-0 gap-1">
        {ins.spotlight && (
          <button
            type="button"
            onClick={toggleSpotlight}
            aria-label="Spotlight inferred connections on the map"
            aria-pressed={spotlight}
            title="Spotlight inferred connections on the map"
            className={`rounded-md p-1 ${spotlight ? "bg-surface-3 text-accent" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}
          >
            <SpotlightIcon width={16} height={16} />
          </button>
        )}
        {ins.geojson && (
          <button
            type="button"
            onClick={() => {
              const fc = ins.geojson!();
              if (fc) downloadText(`${ins.ref.replace(/[^a-zA-Z0-9-]+/g, "-")}.geojson`, "application/geo+json", JSON.stringify(fc));
            }}
            aria-label="Download as GeoJSON"
            title="Download as GeoJSON"
            className={iconBtn}
          >
            <DownloadIcon width={16} height={16} />
          </button>
        )}
        {ins.locate && (
          <button type="button" onClick={() => select(ins.ref, { fly: true, keepHere: true })} aria-label="Center on map" title="Center on map" className={iconBtn}>
            <TargetIcon width={16} height={16} />
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="Close details" className={iconBtn}>
          <CloseIcon width={16} height={16} />
        </button>
      </div>
    </header>
  );
}

export function Inspector({ variant = "panel", extend }: InspectorProps) {
  const ref = useAppStore((s) => s.selectedId);
  const history = useAppStore((s) => s.history);
  const here = useAppStore((s) => s.here);
  const select = useAppStore((s) => s.select);
  const back = useAppStore((s) => s.back);
  const setHere = useAppStore((s) => s.setHere);
  const { ins, status } = useInspected(ref);
  const [hereOpen, setHereOpen] = useState(false);
  const pickHere = (r: string) => select(r, { keepHere: true });

  // Nothing selected: the "What's here" list of a tap / right-click with several features.
  if (!ref) {
    if (!here?.length) return null;
    return (
      <Shell variant={variant} label="What's here">
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
          <h2 className="flex-1 text-sm font-semibold text-ink">What's here · {here.length}</h2>
          <button type="button" onClick={() => setHere(null)} aria-label="Close" className={iconBtn}>
            <CloseIcon width={16} height={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <HereList items={here} current={null} onPick={pickHere} />
        </div>
      </Shell>
    );
  }

  if (!ins) {
    // A deep link to something that is still loading, or no longer in the data.
    return (
      <Shell variant={variant} label="Feature details">
        <div className="flex items-center gap-2 px-4 py-3 text-sm text-ink-2">
          {status === "loading" ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" aria-hidden />
          ) : null}
          <span className="flex-1">
            {status === "loading" ? "Loading…" : status === "error" ? "Couldn't load this feature's data." : "This feature is not in the current data."}
          </span>
          <button type="button" onClick={() => select(null)} aria-label="Close details" className={iconBtn}>
            <CloseIcon width={16} height={16} />
          </button>
        </div>
      </Shell>
    );
  }

  titles.set(ins.ref, ins.header.title);
  const prev = history.length ? history[history.length - 1] : null;
  const sections = extend ? mergeSections(ins.sections, extend(ins)) : ins.sections;
  const others = here && here.some((h) => h.ref === ins.ref) ? here.length - 1 : 0;

  return (
    <Shell variant={variant} label="Feature details">
      {prev && (
        <button
          type="button"
          onClick={back}
          className="flex shrink-0 items-center gap-1.5 border-b border-line bg-surface-2/60 px-4 py-1.5 text-left text-xs font-medium text-ink-2 hover:text-ink"
        >
          <span aria-hidden className="text-sm leading-none">
            ←
          </span>
          <span className="truncate">Back to {titles.get(prev) ?? "previous"}</span>
        </button>
      )}
      <Header ins={ins} onClose={() => select(null)} />
      {others > 0 && (
        <div className="shrink-0 border-b border-line">
          <button
            type="button"
            onClick={() => setHereOpen((o) => !o)}
            aria-expanded={hereOpen}
            className="flex w-full items-center gap-1.5 px-4 py-1.5 text-left text-xs font-medium text-ink-2 hover:text-ink"
          >
            <span aria-hidden>{hereOpen ? "▾" : "▸"}</span>
            Also here · {others}
          </button>
          {hereOpen && (
            <div className="max-h-48 overflow-y-auto">
              <HereList items={here!} current={ins.ref} onPick={pickHere} />
            </div>
          )}
        </div>
      )}
      <div className={variant === "inline" ? "px-4 py-2" : "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2"}>
        {sections.map((s) => (
          <SectionView key={s.id} section={s} />
        ))}
      </div>
    </Shell>
  );
}
