import { useEffect, useState } from "react";
import { LinkIcon } from "./icons.tsx";

/** Copy the current URL — the full view (lens, camera, layers, filters, selection) is in it. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older / insecure-context browsers: the selection fallback.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export function CopyLinkButton({ className = "" }: { className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      onClick={() => void copyText(window.location.href).then((ok) => setState(ok ? "copied" : "failed"))}
      title="Copy a link to exactly this view"
      className={`flex items-center justify-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] font-medium text-ink hover:bg-surface-2 ${className}`}
    >
      <LinkIcon width={12} height={12} />
      <span aria-live="polite">{state === "copied" ? "Link copied" : state === "failed" ? "Copy failed" : "Copy link"}</span>
    </button>
  );
}
