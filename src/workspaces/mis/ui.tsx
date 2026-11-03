// Network MIS — small presentational primitives (cards, stat tiles, segmented bars, legends,
// tabs). Colour comes only from data marks; all text wears ink tokens (dataviz convention).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { VOLTAGES, type Voltage } from "../../data/types.ts";
import { VOLTAGE_COLOR } from "../../theme/palette.ts";

export const nf0 = (n: number) => Math.round(n).toLocaleString("en-IN");
export const nf1 = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
export const pct = (x: number | null, digits = 0) => (x == null ? "—" : `${(x * 100).toFixed(digits)}%`);
export const gva = (mva: number) =>
  mva >= 1000 ? `≈ ${(mva / 1000).toLocaleString("en-IN", { maximumFractionDigits: 1 })} GVA` : `≈ ${nf0(mva)} MVA`;
export const yrs = (n: number | null) => (n == null ? "—" : `${nf1(n)} yrs`);

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = "",
  pad = true,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <section className={`rounded-xl border border-line bg-surface shadow-sm ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 pb-2 pt-3">
          <div className="min-w-0 flex-1">
            {title && <h3 className="text-sm font-semibold text-ink">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-2">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={pad ? "px-4 pb-4" : ""}>{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  sub,
  children,
  onClick,
  title,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  const body = (
    <>
      <div className="text-[11px] font-medium text-ink-2">{label}</div>
      <div className="mt-0.5 text-2xl font-semibold leading-tight text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] leading-snug text-ink-2">{sub}</div>}
      {children && <div className="mt-2">{children}</div>}
    </>
  );
  const cls = "min-w-0 rounded-xl border border-line bg-surface px-3.5 py-3 text-left shadow-sm";
  return onClick ? (
    <button type="button" onClick={onClick} title={title} className={`${cls} transition-colors hover:border-accent/50 hover:bg-surface-2`}>
      {body}
    </button>
  ) : (
    <div className={cls} title={title}>
      {body}
    </div>
  );
}

/** Thin segmented bar (one whole split into voltage parts). No text; tooltip names each part. */
export function VoltageSegBar({
  byV,
  unit,
  height = 6,
  scale = 1,
}: {
  byV: Record<Voltage, number>;
  unit: string;
  height?: number;
  /** Fraction (0–1) of the track the whole bar fills — lets rows share one scale. */
  scale?: number;
}) {
  const total = VOLTAGES.reduce((a, v) => a + byV[v], 0);
  const parts = VOLTAGES.filter((v) => byV[v] > 0);
  const label = parts.map((v) => `${v} kV ${nf0(byV[v])} ${unit}`).join(" · ");
  return (
    <div className="flex w-full" style={{ height }} role="img" aria-label={label} title={label}>
      <div className="flex gap-[2px]" style={{ width: `${Math.max(0, Math.min(1, scale)) * 100}%` }}>
        {parts.map((v) => (
          <span
            key={v}
            className="rounded-full"
            style={{ width: `${(byV[v] / total) * 100}%`, minWidth: 2, backgroundColor: VOLTAGE_COLOR[v] }}
          />
        ))}
      </div>
    </div>
  );
}

export function VoltageLegend({ className = "" }: { className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-2 ${className}`}>
      {VOLTAGES.map((v) => (
        <span key={v} className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: VOLTAGE_COLOR[v] }} />
          {v} kV
        </span>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { id: T; label: string }[];
  value: T;
  onChange: (t: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line px-2">
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.id)}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
              on ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.id)}
            className={`whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
              on ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-[11px] leading-snug text-ink-2">{children}</p>;
}

export function SmallButton({
  children,
  onClick,
  title,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** Track an element's content width (for SVG charts that must lay out in pixels). */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}
