// Presentational pieces of the Inspector — one renderer per section kind.
import type { ReactNode } from "react";
import { WarnIcon, LineIcon, SubstationIcon } from "../components/icons.tsx";
import { VoltageDot } from "../components/VoltageBadge.tsx";
import type { MethodId } from "../content/methods.ts";
import { useAppStore } from "../state/store.ts";
import { Hint, Indicative } from "../trust/Indicative.tsx";
import type { FieldRow, LinkRow, Section, Tone, TraceLevel } from "./types.ts";

const TONE_TEXT: Record<Tone, string> = {
  warn: "text-amber-600 dark:text-amber-300",
  bad: "text-red-600 dark:text-red-400",
  info: "text-accent",
};

const go = (ref: string) => useAppStore.getState().select(ref, { fly: true });

export function FieldView({ row }: { row: FieldRow }) {
  const value = row.ref ? (
    <button type="button" onClick={() => go(row.ref!)} className="text-right font-medium text-accent hover:underline">
      {row.value}
    </button>
  ) : (
    <span className={row.tone ? TONE_TEXT[row.tone] : undefined}>{row.value}</span>
  );
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="shrink-0 text-ink-2">
        {row.label}
        {row.hint && <Hint text={row.hint} label={row.label} />}
        {row.method && <Indicative method={row.method} />}
      </span>
      <span className="min-w-0 break-words text-right font-medium text-ink">
        {value}
        {row.sub && <span className="block text-xs font-normal text-ink-2">{row.sub}</span>}
      </span>
    </div>
  );
}

export function SectionTitle({ title, aside, method }: { title: string; aside?: string; method?: MethodId }) {
  return (
    <div className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-2">
      {title}
      {aside && <span className="ml-1 font-normal normal-case text-ink-2">{aside}</span>}
      {method && <Indicative method={method} />}
    </div>
  );
}

function Link({ item }: { item: LinkRow }) {
  return (
    <button type="button" onClick={() => go(item.ref)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2">
      {item.voltage && <VoltageDot voltage={item.voltage} />}
      {item.icon && (
        <span className="shrink-0 text-ink-2">{item.icon === "line" ? <LineIcon width={14} height={14} /> : <SubstationIcon width={14} height={14} />}</span>
      )}
      <span className="min-w-0 flex-1 truncate text-ink" title={item.label}>
        {item.label}
      </span>
      {item.meta && <span className="shrink-0 text-xs tabular-nums text-ink-2">{item.meta}</span>}
      {item.flag && <span className="h-2 w-2 shrink-0 rounded-full bg-[#d03b3b]" title={item.flag} />}
    </button>
  );
}

function Trace({ levels }: { levels: TraceLevel[] }) {
  return (
    <ol className="relative ml-1.5 border-l-2 border-line pl-3">
      {levels.map((l, i) => (
        <li key={i} className="relative pb-2 last:pb-0">
          <span
            className={`absolute -left-[19px] top-1 h-2.5 w-2.5 rounded-full border-2 ${l.here ? "border-amber-500 bg-amber-400" : l.name ? "border-accent bg-surface" : "border-line bg-surface"}`}
            aria-hidden
          />
          <div className="text-[10.5px] uppercase tracking-wide text-ink-2">{l.label}</div>
          {l.name ? (
            l.ref && !l.here ? (
              <button type="button" onClick={() => go(l.ref!)} className="text-left text-sm font-medium text-accent hover:underline">
                {l.name}
              </button>
            ) : (
              <div className="text-sm font-medium text-ink">{l.name}</div>
            )
          ) : (
            <div className="text-xs italic text-ink-2">not traced in the open GIS data</div>
          )}
        </li>
      ))}
    </ol>
  );
}

const CALLOUT: Record<Tone, string> = {
  warn: "bg-amber-100/70 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200",
  bad: "border border-[#d03b3b]/40 bg-[#d03b3b]/5 text-ink",
  info: "bg-surface-2 text-ink",
};

export function SectionView({ section: s }: { section: Section }): ReactNode {
  const title = s.title ? <SectionTitle title={s.title} aside={s.aside} method={s.method} /> : null;
  switch (s.kind) {
    case "fields":
      return (
        <div>
          {title}
          {s.rows.map((r, i) => (
            <FieldView key={`${r.label}-${i}`} row={r} />
          ))}
        </div>
      );
    case "links":
      return (
        <div>
          {title}
          {s.items.length ? (
            <div className="-mx-1">
              {s.items.map((it) => (
                <Link key={it.ref} item={it} />
              ))}
            </div>
          ) : (
            <p className="px-2 py-1 text-sm text-ink-2">{s.empty ?? "None."}</p>
          )}
        </div>
      );
    case "trace":
      return (
        <div>
          {title}
          <Trace levels={s.levels} />
        </div>
      );
    case "callout":
      return (
        <div className={`mt-2 flex items-start gap-2 rounded-lg px-2.5 py-2 text-xs ${CALLOUT[s.tone]}`}>
          {s.tone !== "info" && <WarnIcon width={14} height={14} className="mt-0.5 shrink-0" />}
          <span>
            {s.text}
            {s.action && (
              <>
                {" "}
                <button type="button" onClick={s.action.run} className="font-medium text-accent hover:underline">
                  {s.action.label}
                </button>
              </>
            )}
          </span>
        </div>
      );
    case "note":
      return <p className="mt-3 text-xs leading-snug text-ink-2">{s.text}</p>;
    case "custom":
      return (
        <div>
          {title}
          {s.render()}
        </div>
      );
  }
}
