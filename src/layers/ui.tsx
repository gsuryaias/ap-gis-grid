// Small shared controls of the Layers drawer + legend.
import type { ReactNode } from "react";
import type { Swatch } from "./catalogue.ts";

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (e: React.MouseEvent) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-accent" : "bg-line"}`}
    >
      {/* Tailwind v4: an arbitrary translate-x collides with `left` — position the thumb inline. */}
      <span
        className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
        style={{ transform: checked ? "translateX(18px)" : "translateX(2px)" }}
      />
    </button>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-between gap-3 py-1 text-sm">{children}</div>;
}

export function SwatchMark({ s }: { s: Swatch }) {
  if (s.shape === "point") return <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-white/70" style={{ backgroundColor: s.color }} />;
  if (s.shape === "line")
    return <span className="h-0 w-3.5 shrink-0 border-t-2" style={{ borderColor: s.color, borderStyle: s.dash ? "dashed" : "solid" }} />;
  if (s.shape === "raster")
    return <span className="h-2.5 w-3.5 shrink-0 rounded-[3px]" style={{ background: `linear-gradient(90deg, ${s.color}, #2563eb, #facc15)` }} />;
  return (
    <span
      className="h-2.5 w-3.5 shrink-0 rounded-[3px] border"
      style={{ borderColor: s.color, backgroundColor: s.fill ? `${s.color}55` : "transparent", borderStyle: s.dash ? "dashed" : "solid" }}
    />
  );
}

/** One legend key: a swatch and its label (+ optional count / toggle). */
export function Key({ swatch, label, sub, children }: { swatch: Swatch; label: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5 text-[12px]">
      <span className="flex min-w-0 items-center gap-2">
        <SwatchMark s={swatch} />
        <span className="truncate text-ink">{label}</span>
        {sub && <span className="shrink-0 text-[11px] text-ink-2">{sub}</span>}
      </span>
      {children}
    </div>
  );
}

export function Spinner() {
  return <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent" aria-label="Loading" />;
}
