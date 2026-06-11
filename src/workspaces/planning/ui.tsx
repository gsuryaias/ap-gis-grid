// Small presentational primitives shared across the Planning Studio — app design tokens
// only (surface/ink/line/accent + the voltage palette), dark-aware via the token overrides.
import type { ReactNode } from "react";
import type { Voltage } from "../../data/types.ts";
import { HONESTY_NOTE } from "./scenario.ts";

export function Card({
  title,
  subtitle,
  right,
  children,
  className,
}: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface shadow-[var(--shadow-panel)] ${className ?? ""}`}
    >
      {(title || right) && (
        <header className="flex items-start justify-between gap-2 border-b border-line px-4 py-2.5">
          <div className="min-w-0">
            {title && <h2 className="text-[13px] font-bold leading-tight text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[11px] leading-snug text-ink-2">{subtitle}</p>}
          </div>
          {right && <div className="flex shrink-0 items-center gap-1.5">{right}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** The mandatory honesty convention, attached to the foot of every readout. */
export function HonestyFootnote() {
  return (
    <p className="border-t border-line bg-surface-2/60 px-4 py-2 text-[10px] leading-snug text-ink-2/90">
      {HONESTY_NOTE}
    </p>
  );
}

const VOLT_TEXT: Record<Voltage, string> = { 400: "text-v400", 220: "text-v220", 132: "text-v132" };

export function VoltTag({ v }: { v: Voltage }) {
  return <span className={`whitespace-nowrap text-[10px] font-bold ${VOLT_TEXT[v]}`}>{v} kV</span>;
}

export type UtilTier = "ok" | "warn" | "crit";

export function utilisationTier(pct: number): UtilTier {
  return pct >= 100 ? "crit" : pct >= 80 ? "warn" : "ok";
}

const TIER_PILL: Record<UtilTier, string> = {
  ok: "bg-surface-2 text-ink-2",
  warn: "bg-amber-100/70 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200",
  crit: "bg-red-100/70 text-red-900 dark:bg-red-500/15 dark:text-red-300",
};

const TIER_BAR: Record<UtilTier, string> = {
  ok: "bg-accent",
  warn: "bg-amber-500",
  crit: "bg-red-500",
};

/** Utilisation % as a tier-coloured pill (≥ 80 % amber, ≥ 100 % red) with a tiny load bar. */
export function PctPill({ pct }: { pct: number }) {
  const tier = utilisationTier(pct);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block min-w-[44px] rounded-full px-1.5 py-0.5 text-center text-[10px] font-semibold tabular-nums ${TIER_PILL[tier]}`}>
        {pct.toFixed(0)}%
      </span>
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-surface-3">
        <span className={`block h-full ${TIER_BAR[tier]}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
    </span>
  );
}

/** Signed delta vs the no-growth base — positive = more stress (red), negative = relief (green). */
export function DeltaTag({ value, unit = "", digits = 0 }: { value: number; unit?: string; digits?: number }) {
  const rounded = Number(value.toFixed(digits));
  if (rounded === 0) return <span className="text-[10px] font-medium text-ink-2">±0{unit} vs base</span>;
  const up = rounded > 0;
  const cls = up ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400";
  return (
    <span className={`text-[10px] font-semibold tabular-nums ${cls}`}>
      {up ? "▲" : "▼"} {up ? "+" : "−"}
      {Math.abs(rounded).toLocaleString("en-IN", { maximumFractionDigits: digits })}
      {unit} vs base
    </span>
  );
}

/** Loading skeleton for a table body while the worker computes a first result. */
export function SkeletonRows({ rows }: { rows: number }) {
  return (
    <div className="space-y-2 px-4 py-3" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="h-5 animate-pulse rounded bg-surface-3"
          style={{ opacity: Math.max(0.25, 1 - i * 0.08) }}
        />
      ))}
    </div>
  );
}

export function ComputingBadge({ phase }: { phase: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-ink-2">
      <span className="h-2.5 w-2.5 animate-spin rounded-full border border-line border-t-accent" />
      {phase ?? "Computing"}…
    </span>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <p className="px-4 py-3 text-xs text-red-700 dark:text-red-400">
      Flow computation failed: {message}
    </p>
  );
}

/** Compact integer / 1-dp formats (en-IN grouping, matching the rest of the app). */
export const fmtInt = (n: number): string => Math.round(n).toLocaleString("en-IN");
export const fmt1 = (n: number): string =>
  n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 1 });

/** Small bordered action button (CSV export etc.). */
export function MiniButton({ onClick, children, disabled }: { onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-line bg-surface px-2 py-1 text-[11px] font-medium text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
