// Phone bottom sheet with three detents — peek (title row only), half, full — dragged by its handle
// with pointer events and snapped to the nearest detent (a quick flick goes one step further). No
// dependency. The handle is also a button: tap / Enter cycles peek → half → full → peek, and the
// arrow keys step. At peek the body is inert (not focusable, hidden from screen readers).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type Snap = "peek" | "half" | "full";
const ORDER: Snap[] = ["peek", "half", "full"];
const PEEK_PX = 76;
const TOP_GAP_PX = 8;

function heights(container: number): Record<Snap, number> {
  const full = Math.max(PEEK_PX + 40, container - TOP_GAP_PX);
  return { peek: PEEK_PX, half: Math.max(PEEK_PX + 20, Math.min(full, Math.round(container * 0.5))), full };
}

export interface BottomSheetProps {
  snap: Snap;
  onSnap: (s: Snap) => void;
  /** Accessible name of the sheet (a region). */
  label: string;
  /** Always-visible row under the handle (title, close button…). */
  header?: ReactNode;
  /**
   * `panel`: the body scrolls and is inert at peek (only `header` shows). `fill`: the child fills the
   * sheet and scrolls itself (the Inspector) — at peek its own top row shows.
   */
  body?: "panel" | "fill";
  children: ReactNode;
}

export function BottomSheet({ snap, onSnap, label, header, body = "panel", children }: BottomSheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [containerH, setContainerH] = useState(0);
  const [dragH, setDragH] = useState<number | null>(null);
  const drag = useRef<{ y: number; h: number; t: number; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(() => setContainerH(parent.clientHeight));
    ro.observe(parent);
    setContainerH(parent.clientHeight);
    return () => ro.disconnect();
  }, []);

  const hs = heights(containerH);
  const height = dragH ?? hs[snap];
  const step = (dir: 1 | -1) => onSnap(ORDER[Math.min(2, Math.max(0, ORDER.indexOf(snap) + dir))]);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, h: hs[snap], t: performance.now(), moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = d.y - e.clientY;
    if (!d.moved && Math.abs(dy) < 4) return;
    d.moved = true;
    setDragH(Math.min(hs.full, Math.max(hs.peek, d.h + dy)));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      onSnap(ORDER[(ORDER.indexOf(snap) + 1) % 3]);
      return;
    }
    const h = d.h + (d.y - e.clientY);
    const v = (d.y - e.clientY) / Math.max(1, performance.now() - d.t); // px/ms, + = up
    // A flick goes to the next detent in its direction from where it was let go; a slow drag to the nearest.
    const next: Snap =
      Math.abs(v) > 0.6
        ? v > 0
          ? (ORDER.find((s) => hs[s] >= h - 1) ?? "full")
          : ([...ORDER].reverse().find((s) => hs[s] <= h + 1) ?? "peek")
        : ORDER.reduce((a, b) => (Math.abs(hs[b] - h) < Math.abs(hs[a] - h) ? b : a));
    setDragH(null);
    onSnap(next);
  };

  // The body is inert at peek, and scrolls back to the top when collapsed.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (snap === "peek") bodyRef.current?.scrollTo({ top: 0 });
  }, [snap]);
  const peeking = body === "panel" && snap === "peek" && dragH == null;

  return (
    <section
      ref={ref}
      aria-label={label}
      data-snap={snap}
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-30 flex flex-col overflow-hidden rounded-t-2xl border-t border-line bg-surface shadow-[0_-8px_30px_-8px_rgb(13_27_42/0.35)]"
      style={{ height, transition: dragH == null ? "height 220ms cubic-bezier(.2,.8,.2,1)" : "none" }}
    >
      <button
        type="button"
        aria-label={`Resize panel (${snap})`}
        aria-expanded={snap !== "peek"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
          setDragH(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") (e.preventDefault(), step(1));
          else if (e.key === "ArrowDown") (e.preventDefault(), step(-1));
        }}
        onClick={(e) => {
          // Keyboard activation (pointer taps are handled on pointer-up).
          if (e.detail === 0) onSnap(ORDER[(ORDER.indexOf(snap) + 1) % 3]);
        }}
        className="flex h-5 w-full shrink-0 touch-none items-center justify-center focus:outline-none focus-visible:bg-surface-2"
      >
        <span className="h-1 w-10 rounded-full bg-line" />
      </button>
      {header && <div className="shrink-0">{header}</div>}
      <div
        ref={bodyRef}
        inert={peeking}
        aria-hidden={peeking}
        className={`min-h-0 flex-1 ${body === "fill" ? "flex flex-col overflow-hidden" : "overflow-y-auto overscroll-contain"} ${peeking ? "invisible" : ""}`}
      >
        {children}
      </div>
    </section>
  );
}
