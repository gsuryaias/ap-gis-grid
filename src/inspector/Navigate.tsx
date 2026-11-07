// "Navigate here" for the inspected feature (Atlas 2.0 phase 5 PR 16). In the Field lens: a bar of
// big buttons under the header — Google Maps directions, the phone's maps app, copy coordinates.
// Elsewhere: one small icon in the header (Google Maps), to keep the header uncluttered.
// Lines navigate to the vertex nearest the user's last fix (Near me), else their middle.
import { useMemo } from "react";
import type { Geometry } from "geojson";
import { CopyIcon, NavigateIcon } from "../components/icons.tsx";
import { formatLength } from "../lib/geo.ts";
import { navLinks, navTarget, type NavTarget } from "../lib/navigate.ts";
import { useAppStore } from "../state/store.ts";
import type { Inspected } from "./types.ts";

function geometryOf(ins: Inspected): Geometry | null {
  if (ins.locate && "center" in ins.locate) return { type: "Point", coordinates: ins.locate.center };
  const g = ins.geojson?.()?.features[0]?.geometry ?? null;
  // Areas (districts, forests…) are not somewhere to drive to.
  return g && g.type !== "Polygon" && g.type !== "MultiPolygon" ? g : null;
}

export function useNavTarget(ins: Inspected): NavTarget | null {
  const origin = useAppStore((s) => s.nearbyOrigin);
  return useMemo(() => navTarget(geometryOf(ins), origin ? [origin.lng, origin.lat] : null), [ins, origin]);
}

const ua = () => (typeof navigator === "undefined" ? "" : navigator.userAgent);

const bigBtn =
  "flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-[13px] font-medium transition-colors";

/** The Field lens's navigate bar. */
export function NavigateBar({ ins }: { ins: Inspected }) {
  const t = useNavTarget(ins);
  const toast = useAppStore((s) => s.toast);
  const origin = useAppStore((s) => s.nearbyOrigin);
  if (!t) return null;
  const [google, app] = navLinks(t.lng, t.lat, ins.header.title, ua());
  const coords = `${t.lat.toFixed(6)}, ${t.lng.toFixed(6)}`;
  const copy = () =>
    void navigator.clipboard?.writeText(coords).then(
      () => toast({ text: `Copied ${coords}`, tone: "success", key: "copy-coords" }),
      () => toast({ text: "Couldn't copy — long-press the coordinates instead.", tone: "error", key: "copy-coords" }),
    );
  return (
    <div className="shrink-0 border-b border-line px-3 py-2">
      <div className="flex gap-1.5">
        <a href={google.href} target="_blank" rel="noreferrer" className={`${bigBtn} border-accent bg-accent text-on-accent hover:opacity-90`}>
          <NavigateIcon width={16} height={16} /> Directions
        </a>
        <a href={app.href} className={`${bigBtn} border-line text-ink hover:bg-surface-2`}>
          {app.label}
        </a>
        <button type="button" onClick={copy} aria-label={`Copy coordinates ${coords}`} title="Copy coordinates" className={`${bigBtn} max-w-14 border-line text-ink-2 hover:bg-surface-2 hover:text-ink`}>
          <CopyIcon width={16} height={16} />
        </button>
      </div>
      <p className="mt-1 select-all text-[11px] tabular-nums text-ink-2">
        {coords}
        {t.how === "nearest" && origin ? ` · nearest point of the line, ${formatLength(t.meters!)} from ${origin.label.toLowerCase()}` : ""}
        {t.how === "middle" ? " · middle of the line (use Near me first to go to its nearest point)" : ""}
        {t.how === "point" && t.meters != null && origin ? ` · ${formatLength(t.meters)} from ${origin.label.toLowerCase()}` : ""}
      </p>
    </div>
  );
}

/** The header's small directions icon (other lenses). */
export function NavigateIconLink({ ins, className }: { ins: Inspected; className: string }) {
  const t = useNavTarget(ins);
  if (!t) return null;
  const [google] = navLinks(t.lng, t.lat, ins.header.title, ua());
  return (
    <a href={google.href} target="_blank" rel="noreferrer" aria-label="Directions in Google Maps" title="Directions in Google Maps" className={className}>
      <NavigateIcon width={16} height={16} />
    </a>
  );
}
