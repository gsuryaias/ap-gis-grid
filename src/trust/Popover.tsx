// A small anchored popover that works on touch (explanations used to live in hover-only `title`
// text). Click / tap toggles; Escape, an outside tap or scrolling the page away closes; focus moves in
// and returns to the trigger. Portalled + fixed-positioned so a scrolling panel never clips it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface PopoverProps {
  /** Accessible name of the popover. */
  label: string;
  /** The trigger's contents. */
  trigger: ReactNode;
  triggerClass: string;
  triggerLabel?: string;
  children: ReactNode;
  width?: number;
}

export function Popover({ label, trigger, triggerClass, triggerLabel, children, width = 300 }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; above: boolean } | null>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const place = () => {
      const r = btn.current!.getBoundingClientRect();
      const h = pop.current?.offsetHeight ?? 200;
      const above = r.bottom + 8 + h > window.innerHeight && r.top - 8 - h > 0;
      const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), window.innerWidth - width - 8);
      setPos({ top: above ? r.top - 8 - h : r.bottom + 8, left, above });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, width]);

  useEffect(() => {
    if (!open) return;
    pop.current?.focus({ preventScroll: true });
    const close = (focusTrigger: boolean) => {
      setOpen(false);
      if (focusTrigger) btn.current?.focus({ preventScroll: true });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) close(false);
    };
    const onScroll = (e: Event) => {
      if (!pop.current?.contains(e.target as Node)) close(false);
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={triggerLabel}
        className={triggerClass}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? 0, width }}
            className="fixed z-[90] max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-surface p-3 text-left text-[12.5px] leading-snug text-ink shadow-[var(--shadow-panel)] outline-none"
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
