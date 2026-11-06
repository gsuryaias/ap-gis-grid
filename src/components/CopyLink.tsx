import { useAppStore } from "../state/store.ts";
import { LinkIcon } from "./icons.tsx";

/** Copy the current URL — the full view (lens, camera, layers, filters, selection) is in it. */
export async function copyText(text: string): Promise<boolean> {
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

/** Copy the current view's link and say so in a toast. */
export function copyViewLink(): void {
  void copyText(window.location.href).then((ok) =>
    useAppStore.getState().toast(ok ? { key: "copy", text: "Link to this view copied.", tone: "success" } : { key: "copy", text: "Couldn’t copy the link — copy it from the address bar.", tone: "error" }),
  );
}

export function CopyLinkButton({ className = "" }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={copyViewLink}
      title="Copy a link to exactly this view"
      className={`flex items-center justify-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] font-medium text-ink hover:bg-surface-2 ${className}`}
    >
      <LinkIcon width={12} height={12} />
      <span>Copy link</span>
    </button>
  );
}
