// Lens switcher — one tab per registry lens. Switching keeps the selection and filters.
import { LENS_ICON } from "../lenses/panels.tsx";
import { LENSES } from "../lenses/registry.ts";
import { useAppStore } from "../state/store.ts";

export function LensTabs({ fill = false }: { fill?: boolean }) {
  const lens = useAppStore((s) => s.lens);
  const setLens = useAppStore((s) => s.setLens);
  return (
    <nav
      aria-label="Lens"
      className={`${fill ? "grid w-full grid-cols-4" : "flex shrink-0"} gap-0.5 rounded-lg border border-line bg-surface-2/70 p-0.5`}
    >
      {LENSES.map((l) => {
        const active = lens === l.id;
        const Icon = LENS_ICON[l.id];
        return (
          <button
            key={l.id}
            type="button"
            onClick={() => setLens(l.id)}
            title={`${l.label} · ${l.audience} — ${l.description}`}
            aria-current={active ? "page" : undefined}
            className={`flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
              active ? "bg-accent text-on-accent" : "text-ink-2 hover:bg-surface-3 hover:text-ink"
            }`}
          >
            <Icon width={13} height={13} aria-hidden />
            {l.label}
          </button>
        );
      })}
    </nav>
  );
}
