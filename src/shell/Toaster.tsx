// The one toast system (Atlas 2.0 phase 3, PR 11): "link copied", "network data updated — reload",
// layer / location errors. `useAppStore.getState().toast({...})` from anywhere; this renders the
// stack bottom-centre (above the phone sheet's title row), announced politely (errors assertively).
import { useEffect } from "react";
import { CloseIcon } from "../components/icons.tsx";
import { useNewerDataAvailable } from "../data/live-status.ts";
import { useAppStore } from "../state/store.ts";
import type { Toast } from "../state/types.ts";

const TONE: Record<Toast["tone"], string> = {
  info: "border-line",
  success: "border-emerald-500/60",
  error: "border-red-500/70",
};

function ToastItem({ t }: { t: Toast }) {
  const dismiss = useAppStore((s) => s.dismissToast);
  useEffect(() => {
    if (t.ttl == null) return;
    const h = window.setTimeout(() => dismiss(t.id), t.ttl);
    return () => window.clearTimeout(h);
  }, [t, dismiss]);
  return (
    <div
      role={t.tone === "error" ? "alert" : "status"}
      className={`pointer-events-auto flex max-w-[min(92vw,460px)] items-center gap-3 rounded-full border bg-surface px-4 py-2 text-sm text-ink shadow-[var(--shadow-panel)] ${TONE[t.tone]}`}
    >
      <span className="min-w-0">{t.text}</span>
      {t.action && (
        <button
          type="button"
          onClick={() => {
            t.action!.run();
            dismiss(t.id);
          }}
          className="shrink-0 rounded-full bg-accent px-3 py-1 text-xs font-semibold text-on-accent"
        >
          {t.action.label}
        </button>
      )}
      <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="shrink-0 text-ink-2 hover:text-ink">
        <CloseIcon width={14} height={14} />
      </button>
    </div>
  );
}

/** "Network data was updated" — once per newer build, as a sticky toast with Reload. */
function useNewDataNotice() {
  const loadedAt = useAppStore((s) => s.data?.meta.generatedAt);
  const newer = useNewerDataAvailable(loadedAt);
  useEffect(() => {
    if (newer)
      useAppStore.getState().toast({ key: "new-data", text: "Network data was updated.", action: { label: "Reload", run: () => location.reload() }, ttl: null });
  }, [newer]);
}

export function Toaster() {
  const toasts = useAppStore((s) => s.toasts);
  useNewDataNotice();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[max(5.5rem,calc(env(safe-area-inset-bottom)+5.5rem))] z-[80] flex flex-col items-center gap-2 px-3 sm:bottom-[max(1.25rem,env(safe-area-inset-bottom))]">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  );
}
