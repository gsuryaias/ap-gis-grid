// "Start here" — a dismissible first-run card per lens (dismissal is a per-viewer convenience).
import { useState } from "react";
import { CloseIcon } from "../components/icons.tsx";
import { LENS_BY_ID, type LensId } from "./registry.ts";

const key = (lens: LensId) => `apgg-start-${lens}`;

function dismissed(lens: LensId): boolean {
  try {
    return localStorage.getItem(key(lens)) === "1";
  } catch {
    return false;
  }
}

export function StartHere({ lens }: { lens: LensId }) {
  const [hidden, setHidden] = useState(() => dismissed(lens));
  if (hidden) return null;
  const { title, tips } = LENS_BY_ID[lens].startHere;
  const close = () => {
    setHidden(true);
    try {
      localStorage.setItem(key(lens), "1");
    } catch {
      /* private mode — it just shows again next time */
    }
  };
  return (
    <section aria-label={title} className="rounded-xl border border-accent/30 bg-accent/[0.06] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-xs font-semibold text-ink">{title}</h3>
        <button type="button" onClick={close} aria-label={`Dismiss “${title}”`} className="rounded-md p-0.5 text-ink-2 hover:bg-surface-2 hover:text-ink">
          <CloseIcon width={14} height={14} />
        </button>
      </div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12px] leading-snug text-ink-2">
        {tips.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </section>
  );
}

/** A titled block inside a lens panel. */
export function PanelSection({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-line pt-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-ink-2">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
