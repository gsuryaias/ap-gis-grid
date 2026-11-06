// Header overflow menu (⋯): the dashboards and sheets that used to be header buttons, plus About.
// An ARIA menu button: arrow keys move, Escape / outside click close, focus returns to the button.
import { useEffect, useRef, useState } from "react";
import { copyViewLink } from "../components/CopyLink.tsx";
import { DotsIcon } from "../components/icons.tsx";
import { LENS_BY_ID } from "../lenses/registry.ts";
import { useAppStore } from "../state/store.ts";

interface Item {
  label: string;
  hint?: string;
  run: () => void;
}

export function MoreMenu({ withCopyLink = false }: { withCopyLink?: boolean }) {
  const [open, setOpen] = useState(false);
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
      ? [{ label: "Copy link to this view", run: copyViewLink }]
      : []),
    { label: "Glossary", hint: "N-1, ckm, radial feeds, DTR… in plain words", run: () => s().openGlossary("") },
    { label: "Keyboard shortcuts", hint: "Press ? anywhere", run: () => s().toggleShortcuts(true) },
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
