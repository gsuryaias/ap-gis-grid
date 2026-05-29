import { useEffect } from "react";
import { useAppStore } from "../state/store.ts";
import { parseHash, serializeHash } from "./hash.ts";

/**
 * Two-way sync between the app store and the URL hash.
 * - Store → URL via history.replaceState (shareable, no history spam, no event loop).
 * - URL → store on hashchange/popstate (manual edits, back/forward).
 */
export function useHashSync(): void {
  useEffect(() => {
    useAppStore.getState().applyHash(parseHash(window.location.hash));

    const onHash = () => useAppStore.getState().applyHash(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);

    const unsub = useAppStore.subscribe((s) => {
      const next = serializeHash(s.hashState());
      const current = `#${window.location.hash.replace(/^#/, "")}`;
      if (next !== current) window.history.replaceState(null, "", next);
    });

    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
      unsub();
    };
  }, []);
}
