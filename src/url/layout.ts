export type MapLayout = "open" | "collapsed" | "atlas-only";

/** Sensible default for the split-map pane when no `map=` deep link is present. */
export function defaultMapLayout(): MapLayout {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 768px)").matches) return "collapsed";
  return "open";
}
