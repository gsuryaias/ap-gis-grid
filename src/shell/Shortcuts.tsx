// Keyboard shortcuts: the global single keys (ignored while typing or with a dialog open) and the
// "?" sheet that lists every shortcut the app has.
import { useEffect } from "react";
import { Dialog } from "../components/Dialog.tsx";
import { CloseIcon } from "../components/icons.tsx";
import { LENSES } from "../lenses/registry.ts";
import { useAppStore } from "../state/store.ts";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const SHORTCUTS: { group: string; keys: string; what: string }[] = [
  { group: "Anywhere", keys: isMac ? "⌘ K  ·  /" : "Ctrl K  ·  /", what: "Search everything (and run commands)" },
  { group: "Anywhere", keys: "1 – 4", what: LENSES.map((l) => l.label).join(" · ") + " lens" },
  { group: "Anywhere", keys: "L", what: "Layers drawer" },
  { group: "Anywhere", keys: "G", what: "Glossary" },
  { group: "Anywhere", keys: "?", what: "This list" },
  { group: "Anywhere", keys: "Esc", what: "Close the dialog, drawer or search" },
  { group: "Anywhere", keys: "Browser Back", what: "Step back through selections, lenses and drill-downs" },
  { group: "Search", keys: "↑ ↓  ·  Enter", what: "Move through results · open the highlighted one" },
  { group: "Layers", keys: "Alt-click a switch", what: "Show only that layer (again to restore)" },
  { group: "Measure", keys: "Click · Double-click / Enter", what: "Add a point · finish" },
  { group: "Measure", keys: "Backspace · Esc", what: "Undo the last point · clear" },
  { group: "Map", keys: "Right-click", what: "List everything under the pointer" },
];

/** Single-key shortcuts — not while typing in a field, holding a modifier or with a modal open. */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (document.querySelector("[aria-modal=true]")) return;
      const s = useAppStore.getState();
      const n = Number(e.key);
      if (e.key === "?") s.toggleShortcuts(true);
      else if (e.key === "l" || e.key === "L") s.toggleLayersDrawer();
      else if (e.key === "g" || e.key === "G") s.openGlossary("");
      else if (n >= 1 && n <= LENSES.length) s.setLens(LENSES[n - 1].id);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function ShortcutsSheet() {
  const open = useAppStore((s) => s.shortcutsOpen);
  const toggle = useAppStore((s) => s.toggleShortcuts);
  if (!open) return null;
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <Dialog
      label="Keyboard shortcuts"
      onClose={() => toggle(false)}
      className="max-h-full w-[520px] max-w-full overflow-y-auto rounded-[var(--radius-panel)] border border-line bg-surface p-5 shadow-[var(--shadow-panel)]"
    >
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-lg font-semibold text-ink">Keyboard shortcuts</h2>
        <button type="button" onClick={() => toggle(false)} aria-label="Close" className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink">
          <CloseIcon width={16} height={16} />
        </button>
      </div>
      {groups.map((g) => (
        <section key={g} className="mt-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">{g}</h3>
          <dl className="mt-1 divide-y divide-line/70">
            {SHORTCUTS.filter((s) => s.group === g).map((s) => (
              <div key={s.keys + s.what} className="flex items-baseline gap-3 py-1.5 text-sm">
                <dt className="w-44 shrink-0">
                  <kbd className="rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ink">{s.keys}</kbd>
                </dt>
                <dd className="text-ink-2">{s.what}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Dialog>
  );
}
