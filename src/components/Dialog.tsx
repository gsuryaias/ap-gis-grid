// The one modal dialog (Atlas 2.0 phase 3, PR 11): portal + backdrop, focus moved in and trapped
// (Tab / Shift-Tab cycle inside), Escape and a backdrop click close, focus returns to whatever had
// it. Every modal in the app (summary, data quality, weather, sync status, about, glossary,
// shortcuts) renders through this.
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** Keep Tab inside `root` (call from a keydown handler). */
export function trapTab(e: KeyboardEvent | React.KeyboardEvent, root: HTMLElement | null): void {
  if (e.key !== "Tab" || !root) return;
  const els = focusables(root);
  if (!els.length) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = els[0];
  const last = els[els.length - 1];
  if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

export interface DialogProps {
  label: string;
  onClose: () => void;
  /** Classes of the dialog panel (size, padding, layout). */
  className: string;
  /** Bottom sheet on phones, centred card from `sm` up. */
  sheet?: boolean;
  /** Element to focus first (else the first focusable inside). */
  initialFocus?: React.RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function Dialog({ label, onClose, className, sheet = false, initialFocus, children }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const root = panel.current;
    (initialFocus?.current ?? (root && focusables(root)[0]) ?? root)?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
      } else trapTab(e, panel.current);
    };
    // Capture: the dialog owns the keyboard while open (Esc must not also close a drawer behind it).
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, [initialFocus]);

  return createPortal(
    <div
      className={`fixed inset-0 z-[70] flex justify-center bg-black/40 backdrop-blur-[2px] ${sheet ? "items-end sm:items-center sm:p-4" : "items-center p-4"}`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div ref={panel} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className={`outline-none ${className}`}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
