// Header overflow menu (⋯): the dashboards and sheets that used to be header buttons, plus About.
// An ARIA menu button: arrow keys move, Escape / outside click close, focus returns to the button.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copyText } from "../components/CopyLink.tsx";
import { CloseIcon, DotsIcon } from "../components/icons.tsx";
import type { GridData } from "../data/types.ts";
import { LENS_BY_ID } from "../lenses/registry.ts";
import { useAppStore } from "../state/store.ts";

interface Item {
  label: string;
  hint?: string;
  run: () => void;
}

export function MoreMenu({ withCopyLink = false }: { withCopyLink?: boolean }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const lens = useAppStore((s) => s.lens);
  const s = useAppStore.getState;

  const items: Item[] = [
    { label: "Network summary", hint: "Counts, km and resilience by voltage and circle", run: () => s().toggleSummary(true) },
    { label: "Weather monitor", hint: "Cyclones, circle conditions, sea state", run: () => s().toggleWeatherView(true) },
    ...(LENS_BY_ID[lens].layout === "map"
      ? [{ label: "Data table", hint: "Every substation and line, filterable, CSV / GeoJSON", run: () => s().toggleTable(true) }]
      : []),
    { label: "Data quality", hint: "Coverage and how the data was built", run: () => s().toggleQuality(true) },
    ...(withCopyLink
      ? [{ label: "Copy link to this view", run: () => void copyText(window.location.href).then((ok) => setNote(ok ? "Link copied" : "Copy failed")) }]
      : []),
    { label: "About & sources", run: () => s().toggleAbout(true) },
  ];

  const close = (focusButton = true) => {
    setOpen(false);
    if (focusButton) btn.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onDown = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), 2000);
    return () => window.clearTimeout(t);
  }, [note]);

  const onKey = (e: React.KeyboardEvent) => {
    const els = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = els.length;
      els[(i + (e.key === "ArrowDown" ? 1 : n - 1)) % n]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      els[e.key === "Home" ? 0 : els.length - 1]?.focus();
    } else if (e.key === "Tab") close(false);
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        title="More"
        className="grid h-7 w-7 place-items-center rounded-lg border border-line text-ink-2 hover:bg-surface-2 hover:text-ink"
      >
        <DotsIcon width={16} height={16} />
      </button>
      {note && (
        <span role="status" className="absolute right-0 top-9 z-50 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-[11px] text-surface">
          {note}
        </span>
      )}
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label="More"
          onKeyDown={onKey}
          className="absolute right-0 top-9 z-50 w-64 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-[var(--shadow-panel)]"
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close();
                it.run();
              }}
              className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
            >
              <span className="text-sm text-ink">{it.label}</span>
              {it.hint && <span className="text-[11px] text-ink-2">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** About & sources — opened from the ⋯ menu or ⌘K (store `aboutOpen`). */
export function About({ data }: { data: GridData }) {
  const open = useAppStore((s) => s.aboutOpen);
  const toggle = useAppStore((s) => s.toggleAbout);
  return open ? createPortal(<AboutDialog data={data} onClose={() => toggle(false)} />, document.body) : null;
}

function AboutDialog({ data, onClose }: { data: GridData; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [onClose]);
  const built = new Date(data.meta.generatedAt);
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onClick={(e) => e.stopPropagation()}
        className="max-h-full w-[480px] max-w-full overflow-y-auto rounded-[var(--radius-panel)] border border-line bg-surface p-5 shadow-[var(--shadow-panel)]"
      >
        <div className="flex items-start gap-2">
          <h2 id="about-title" className="flex-1 text-lg font-semibold text-ink">
            About the Grid Atlas
          </h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink">
            <CloseIcon width={16} height={16} />
          </button>
        </div>
        <p className="mt-2 text-sm text-ink-2">
          A public, static map and lookup of the AP-TRANSCO transmission network (400 / 220 / 132 kV) with the DISCOM 33 / 11 kV
          networks, generation, the inter-state grid, reference layers and live weather. Connections, capacities and risk
          screens are <strong className="text-ink">inferred and indicative</strong> — not operational data.
        </p>
        <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Sources</h3>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-2">
          <li>Network: AP-TRANSCO enterprise GIS (open layers) and the DISCOMs' open GIS services</li>
          <li>Reference layers: AP Real-Time Governance Society (RTGS) shapefile library</li>
          <li>Places: GeoNames (CC BY 4.0)</li>
          <li>Weather: Open-Meteo · Radar: RainViewer · Cyclones: GDACS (UN / EC JRC)</li>
          <li>Basemaps: © CARTO, © OpenStreetMap contributors · Satellite: Esri World Imagery</li>
        </ul>
        <p className="mt-4 text-xs text-ink-2">Data built {built.toLocaleString("en-IN")}.</p>
      </div>
    </div>
  );
}
