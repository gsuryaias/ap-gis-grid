// The glossary dialog — opened from the header ⓘ, a method card's glossary links, ⌘K or "G".
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../components/Dialog.tsx";
import { CloseIcon, SearchIcon } from "../components/icons.tsx";
import { GLOSSARY } from "../content/glossary.ts";
import { useAppStore } from "../state/store.ts";

export function GlossaryDialog() {
  const target = useAppStore((s) => s.glossary);
  const openGlossary = useAppStore((s) => s.openGlossary);
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDListElement>(null);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? GLOSSARY.filter((g) => [g.term, ...(g.aka ?? []), g.text].join(" ").toLowerCase().includes(t)) : GLOSSARY;
  }, [q]);

  // Jump to the requested entry.
  useEffect(() => {
    if (!target) return;
    setQ("");
    requestAnimationFrame(() => list.current?.querySelector(`#gl-${CSS.escape(target)}`)?.scrollIntoView({ block: "center" }));
  }, [target]);

  if (target == null) return null;
  return (
    <Dialog
      label="Glossary"
      onClose={() => openGlossary(null)}
      initialFocus={searchRef}
      sheet
      className="flex max-h-[85dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-[var(--shadow-panel)] sm:rounded-2xl"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="flex-1 text-base font-semibold text-ink">Glossary</h2>
        <button type="button" onClick={() => openGlossary(null)} aria-label="Close glossary" className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink">
          <CloseIcon width={16} height={16} />
        </button>
      </header>
      <div className="shrink-0 px-4 pt-3">
        <label className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 focus-within:border-accent">
          <SearchIcon width={14} height={14} className="shrink-0 text-ink-2" />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a term — N-1, ckm, DTR…"
            aria-label="Find a glossary term"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-2/70"
          />
        </label>
      </div>
      <dl ref={list} tabIndex={0} aria-label="Glossary terms" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2">
        {shown.map((g) => (
          <div key={g.id} id={`gl-${g.id}`} className={`scroll-mt-4 rounded-lg px-2 py-2 ${g.id === target ? "bg-accent/10" : ""}`}>
            <dt className="text-sm font-semibold text-ink">
              {g.term}
              {g.aka?.length ? <span className="ml-1.5 text-[11px] font-normal text-ink-2">also: {g.aka.join(", ")}</span> : null}
            </dt>
            <dd className="mt-0.5 text-[13px] leading-snug text-ink-2">{g.text}</dd>
          </div>
        ))}
        {!shown.length && <p className="px-2 py-4 text-sm text-ink-2">No term matches “{q}”.</p>}
      </dl>
    </Dialog>
  );
}
