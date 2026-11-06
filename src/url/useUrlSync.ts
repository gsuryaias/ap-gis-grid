// Two-way sync between the app store and URL v2 (`url/v2.ts`), with real browser history:
//   store → URL  navigation (selection, lens, circle, MIS drill) pushes an entry at once; every other
//                change (filters, layers, basemap, camera, …) replaces the current entry, debounced;
//   URL → store  on load (a v1 link is decoded and rewritten to v2) and on Back / Forward / manual
//                edits (popstate / hashchange) — applied as-is, never written back.
import { useEffect } from "react";
import { useAppStore } from "../state/store.ts";
import type { AppState } from "../state/types.ts";
import { decodeUrl, encodeUrl, historyMode, type UrlState } from "./v2.ts";

const REPLACE_DEBOUNCE_MS = 300;

/** Only these feed the URL — hover, measure, panels etc. never re-serialise. */
const URL_INPUTS: ((s: AppState) => unknown)[] = [
  (s) => s.selectedId,
  (s) => s.workspace,
  (s) => s.mapLayout,
  (s) => s.basemap,
  (s) => s.tableOpen,
  (s) => s.filters,
  (s) => s.layers.enabled,
  (s) => s.camera,
  (s) => s.workspaceContext.misBy,
  (s) => s.workspaceContext.misFilters,
  (s) => s.workspaceContext.misTab,
  (s) => s.workspaceContext.misTheme,
];

const currentHash = () => `#${window.location.hash.replace(/^#/, "")}`;

export function useUrlSync(): void {
  useEffect(() => {
    const store = useAppStore;
    let applying = false;
    let timer = 0;
    let pending = false;

    const apply = (hash: string, initial: boolean) => {
      applying = true;
      try {
        store.getState().applyUrl(decodeUrl(hash), { initial });
      } finally {
        applying = false;
      }
    };

    apply(window.location.hash, true);
    let last: UrlState = store.getState().urlState();
    // Normalise once: a v1 link (or none) becomes its v2 form, in place.
    window.history.replaceState(window.history.state, "", encodeUrl(last));

    const write = (mode: "push" | "replace", s: UrlState) => {
      const h = encodeUrl(s);
      if (h === currentHash()) return;
      if (mode === "push") window.history.pushState(null, "", h);
      else window.history.replaceState(window.history.state, "", h);
    };
    const flush = () => {
      if (!pending) return;
      window.clearTimeout(timer);
      pending = false;
      write("replace", last);
    };

    const unsub = store.subscribe((s, prev) => {
      if (applying || !URL_INPUTS.some((get) => get(s) !== get(prev))) return;
      const next = s.urlState();
      const mode = historyMode(last, next);
      if (mode === "none") return;
      if (mode === "push") {
        flush(); // the entry we leave keeps its latest view
        last = next;
        write("push", next);
        return;
      }
      last = next;
      pending = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, REPLACE_DEBOUNCE_MS);
    });

    const onNavigate = () => {
      if (currentHash() === encodeUrl(last)) return; // our own write
      window.clearTimeout(timer);
      pending = false;
      apply(window.location.hash, false);
      last = store.getState().urlState();
      write("replace", last); // e.g. a link without `lyr` now lists the layers that stayed on
    };
    window.addEventListener("popstate", onNavigate);
    window.addEventListener("hashchange", onNavigate);
    window.addEventListener("pagehide", flush);

    return () => {
      flush();
      unsub();
      window.removeEventListener("popstate", onNavigate);
      window.removeEventListener("hashchange", onNavigate);
      window.removeEventListener("pagehide", flush);
    };
  }, []);
}
