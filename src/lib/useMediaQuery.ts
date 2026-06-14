import { useEffect, useState } from "react";

/** Subscribe to a CSS media query. SSR-safe (returns false when `window`/matchMedia is absent). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** True on phone-width viewports — matches the point below Tailwind's `sm` breakpoint (640px). */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 639px)");
}
