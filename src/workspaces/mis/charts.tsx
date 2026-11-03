// Network MIS charts — dependency-free SVG/HTML. Mark specs follow the dataviz conventions:
// ≤ 24 px bars with a 4 px rounded data-end, 2 px surface gaps between stacked segments,
// hairline recessive grid, a legend for ≥ 2 series, per-mark hover tooltips, text in ink tokens.
import { useState, type ReactNode } from "react";
import { VOLTAGES, type Voltage } from "../../data/types.ts";
import { VOLTAGE_COLOR } from "../../theme/palette.ts";
import { nf0, useWidth } from "./ui.tsx";

// ---------------------------------------------------------------------------------------------
// Stacked column chart (x = ordered category, stack = voltage)

export interface StackedColumn {
  key: string;
  label: string;
  byV: Record<Voltage, number>;
  /** Extra tooltip line. */
  note?: string;
  /** Visually emphasised (e.g. bins past useful life). */
  emphasis?: boolean;
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
};
const tick = (v: number) => (v >= 10000 ? `${Math.round(v / 1000)}K` : nf0(v));

export function StackedColumns({
  columns,
  unit,
  height = 190,
  ariaLabel,
  marker,
}: {
  columns: StackedColumn[];
  unit: string;
  height?: number;
  ariaLabel: string;
  /** Vertical reference rule drawn before column index `at` (e.g. the useful-life threshold). */
  marker?: { at: number; label: string };
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const padL = 40;
  const padR = 8;
  const padT = 10;
  const axisH = 34;
  const plotH = height - padT - axisH;
  const totals = columns.map((c) => VOLTAGES.reduce((a, v) => a + c.byV[v], 0));
  const max = niceMax(Math.max(0, ...totals));
  const n = columns.length;
  const plotW = Math.max(0, width - padL - padR);
  const band = n ? plotW / n : 0;
  const barW = Math.min(24, Math.max(4, band * 0.62));
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const labelEvery = band < 34 ? Math.ceil(34 / Math.max(band, 1)) : 1;

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} />
              <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--color-ink-2)" className="tabular-nums">
                {tick(t)}
              </text>
            </g>
          ))}
          {marker && marker.at > 0 && marker.at < n && (
            <g>
              <line
                x1={padL + band * marker.at}
                x2={padL + band * marker.at}
                y1={padT - 4}
                y2={padT + plotH}
                stroke="var(--color-ink-2)"
                strokeWidth={1}
              />
              <text x={padL + band * marker.at - 4} y={padT + 6} textAnchor="end" fontSize={10} fill="var(--color-ink-2)">
                {marker.label}
              </text>
            </g>
          )}
          {columns.map((c, i) => {
            const cx = padL + band * i + band / 2;
            let acc = 0;
            const segs = VOLTAGES.filter((v) => c.byV[v] > 0);
            return (
              <g key={c.key} opacity={hover == null || hover === i ? 1 : 0.55}>
                {segs.map((v, si) => {
                  const h = (c.byV[v] / max) * plotH;
                  const top = y(acc + c.byV[v]);
                  acc += c.byV[v];
                  const isTop = si === segs.length - 1;
                  // 2 px surface gap between stacked segments (trim the segment's top edge).
                  const gap = isTop ? 0 : Math.min(2, h / 2);
                  return (
                    <path
                      key={v}
                      d={roundedTop(cx - barW / 2, top + gap, barW, Math.max(0, h - gap), isTop ? Math.min(4, h / 2) : 0)}
                      fill={VOLTAGE_COLOR[v]}
                    />
                  );
                })}
                {i % labelEvery === 0 && (
                  <text x={cx} y={padT + plotH + 14} textAnchor="middle" fontSize={10} fill="var(--color-ink-2)" className="tabular-nums">
                    {c.label}
                  </text>
                )}
                {/* Hit target: the whole band, taller than the mark. */}
                <rect
                  x={padL + band * i}
                  y={padT}
                  width={band}
                  height={plotH + axisH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                >
                  <title>{`${c.label}: ${nf0(totals[i])} ${unit}`}</title>
                </rect>
              </g>
            );
          })}
          <line x1={padL} x2={width - padR} y1={padT + plotH} y2={padT + plotH} stroke="var(--color-ink-2)" strokeOpacity={0.4} />
        </svg>
      )}
      {hover != null && columns[hover] && (
        <Tooltip x={padL + band * hover + band / 2} width={width}>
          <div className="font-semibold text-ink">{columns[hover].label}</div>
          {VOLTAGES.filter((v) => columns[hover].byV[v] > 0).map((v) => (
            <div key={v} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: VOLTAGE_COLOR[v] }} />
              <span className="text-ink-2">{v} kV</span>
              <span className="ml-auto pl-3 tabular-nums text-ink">{nf0(columns[hover].byV[v])}</span>
            </div>
          ))}
          <div className="mt-0.5 flex border-t border-line pt-0.5">
            <span className="text-ink-2">Total</span>
            <span className="ml-auto pl-3 font-semibold tabular-nums text-ink">
              {nf0(totals[hover])} {unit}
            </span>
          </div>
          {columns[hover].note && <div className="text-ink-2">{columns[hover].note}</div>}
        </Tooltip>
      )}
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const w = 170;
  const left = Math.max(0, Math.min(width - w, x - w / 2));
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11px] shadow-[var(--shadow-panel)]"
      style={{ left, width: w }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Ranked bar list (HTML) — one row per item, optional voltage stack, clickable rows

export interface BarItem {
  key: string;
  label: ReactNode;
  value: number;
  /** Stacked voltage split; when absent the bar is one colour. */
  byV?: Record<Voltage, number>;
  color?: string;
  display?: string;
  sub?: ReactNode;
  title?: string;
}

export function BarList({
  items,
  onPick,
  max: maxIn,
  pickLabel,
}: {
  items: BarItem[];
  onPick?: (key: string) => void;
  max?: number;
  pickLabel?: string;
}) {
  const max = maxIn ?? Math.max(0, ...items.map((i) => i.value));
  return (
    <ul className="space-y-1">
      {items.map((it) => {
        const frac = max > 0 ? it.value / max : 0;
        const body = (
          <>
            <div className="flex items-baseline gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-ink">{it.label}</span>
              <span className="shrink-0 tabular-nums font-medium text-ink">{it.display ?? nf0(it.value)}</span>
            </div>
            <div className="mt-1 flex h-2 w-full">
              <div className="flex gap-[2px]" style={{ width: `${frac * 100}%` }}>
                {it.byV ? (
                  VOLTAGES.filter((v) => it.byV![v] > 0).map((v) => (
                    <span
                      key={v}
                      className="rounded-full"
                      style={{ width: `${(it.byV![v] / it.value) * 100}%`, minWidth: 2, backgroundColor: VOLTAGE_COLOR[v] }}
                    />
                  ))
                ) : (
                  <span className="w-full rounded-full" style={{ backgroundColor: it.color ?? "#2a78d6" }} />
                )}
              </div>
            </div>
            {it.sub && <div className="mt-0.5 text-[11px] text-ink-2">{it.sub}</div>}
          </>
        );
        return (
          <li key={it.key}>
            {onPick ? (
              <button
                type="button"
                onClick={() => onPick(it.key)}
                title={it.title ?? pickLabel}
                className="block w-full rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
              >
                {body}
              </button>
            ) : (
              <div className="px-1.5 py-1" title={it.title}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
