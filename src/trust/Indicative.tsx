// Trust layer (Atlas 2.0 phase 3, PR 11): an "Indicative" chip on every derived figure that opens
// its method card (rule · source · vintage · coverage · what it is not · glossary links), and an ⓘ
// hint that shows a field's explanation on touch as well as hover.
import { GLOSSARY_BY_ID } from "../content/glossary.ts";
import { METHODS, type MethodId } from "../content/methods.ts";
import { useAppStore } from "../state/store.ts";
import { Popover } from "./Popover.tsx";

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="mt-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-2">{k}</div>
      <div>{v}</div>
    </div>
  );
}

export function MethodCardView({ id }: { id: MethodId }) {
  const m = METHODS[id];
  const openGlossary = useAppStore((s) => s.openGlossary);
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:bg-amber-500/20 dark:text-amber-200">Indicative</span>
        <h3 className="text-sm font-semibold text-ink">{m.title}</h3>
      </div>
      <Row k="How it is worked out" v={m.rule} />
      <Row k="Source" v={m.source} />
      <Row k="How current" v={m.vintage} />
      <Row k="Coverage" v={m.coverage} />
      <p className="mt-2 rounded-lg bg-surface-2 px-2 py-1.5 text-ink-2">{m.caveat}</p>
      {m.terms.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px]">
          <span className="text-ink-2">Glossary:</span>
          {m.terms
            .filter((t) => GLOSSARY_BY_ID[t])
            .map((t) => (
              <button key={t} type="button" onClick={() => openGlossary(t)} className="font-medium text-accent hover:underline">
                {GLOSSARY_BY_ID[t].term}
              </button>
            ))}
        </div>
      )}
    </>
  );
}

/** The chip. `label` overrides the visible text ("Inferred", "Model output"…). */
export function Indicative({ method, label = "Indicative" }: { method: MethodId; label?: string }) {
  return (
    <Popover
      label={METHODS[method].title}
      triggerLabel={`${label}: how “${METHODS[method].title}” is worked out`}
      triggerClass="ml-1.5 inline-flex shrink-0 items-center rounded-full border border-amber-500/50 bg-amber-50 px-1.5 py-px align-middle text-[9.5px] font-semibold uppercase tracking-wide text-amber-800 hover:bg-amber-100 dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-200"
      trigger={label}
    >
      <MethodCardView id={method} />
    </Popover>
  );
}

/** ⓘ — a field's explanation, readable on touch (was a hover-only `title`). */
export function Hint({ text, label }: { text: string; label: string }) {
  return (
    <Popover
      label={label}
      triggerLabel={`About “${label}”`}
      width={260}
      triggerClass="ml-1 inline-grid h-4 w-4 shrink-0 place-items-center rounded-full border border-line align-middle text-[9px] font-bold text-ink-2 hover:border-accent hover:text-accent"
      trigger="i"
    >
      <p>{text}</p>
    </Popover>
  );
}
