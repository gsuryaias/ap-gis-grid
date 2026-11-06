// Shared empty / loading / error states (Atlas 2.0 phase 3, PR 11) — one look and one wording
// pattern for every panel, sheet and dialog.
import type { ReactNode } from "react";

export function Spinner({ size = "sm" }: { size?: "sm" | "md" | "lg" }) {
  const cls = size === "lg" ? "h-8 w-8" : size === "md" ? "h-4 w-4" : "h-3 w-3";
  return <span className={`${cls} inline-block shrink-0 animate-spin rounded-full border-2 border-line border-t-accent`} aria-hidden />;
}

/** "Loading …" with a spinner; `block` = centred in a full panel. */
export function LoadingState({ label, block = false }: { label: string; block?: boolean }) {
  return (
    <div role="status" className={block ? "grid h-full place-items-center p-6" : "flex items-center gap-2 px-1 py-4"}>
      <span className={block ? "flex flex-col items-center gap-3 text-sm text-ink-2" : "flex items-center gap-2 text-sm text-ink-2"}>
        <Spinner size={block ? "lg" : "md"} />
        {label}
      </span>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-center text-sm text-ink-2">{children}</p>;
}

/** What failed, in plain words, + Retry. */
export function ErrorState({ title, message, onRetry, block = false }: { title: string; message?: string | null; onRetry?: () => void; block?: boolean }) {
  return (
    <div role="alert" className={block ? "grid h-full place-items-center p-6" : "py-2"}>
      <div className={block ? "max-w-md rounded-[var(--radius-panel)] border border-line bg-surface p-6 text-center shadow-[var(--shadow-panel)]" : "rounded-lg bg-surface-2 px-3 py-2.5"}>
        <p className={block ? "text-lg font-semibold text-ink" : "text-sm font-medium text-ink"}>{title}</p>
        {message && <p className="mt-1 text-sm text-ink-2">{message}</p>}
        {onRetry && (
          <button type="button" onClick={onRetry} className={block ? "mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:opacity-90" : "mt-1.5 text-sm font-medium text-accent hover:underline"}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
