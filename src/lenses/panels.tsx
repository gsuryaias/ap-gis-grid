// The React side of the lens registry: icons, and the side panel each lens shows. Explore and Field
// are inline (the default + the phone-first lens); Storm and Plan (the Network MIS) are lazy chunks.
import { lazy, Suspense, type ComponentType, type SVGProps } from "react";
import { ChartIcon, CompassIcon, CycloneIcon, WrenchIcon } from "../components/icons.tsx";
import type { GridData } from "../data/types.ts";
import ExplorePanel from "./ExplorePanel.tsx";
import FieldPanel from "./FieldPanel.tsx";
import type { LensId } from "./registry.ts";

export const LENS_ICON: Record<LensId, ComponentType<SVGProps<SVGSVGElement>>> = {
  explore: CompassIcon,
  field: WrenchIcon,
  plan: ChartIcon,
  storm: CycloneIcon,
};

const StormPanel = lazy(() => import("./StormPanel.tsx"));

/** The Plan lens body — the Network MIS (lazy). */
export const PlanWorkspace = lazy(() => import("../workspaces/mis/MisWorkspace.tsx"));

export function PanelLoading() {
  return (
    <div className="flex items-center gap-2 px-1 py-6 text-sm text-ink-2">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" aria-hidden />
      Loading…
    </div>
  );
}

/** The side panel of a map lens (Plan has its own split layout). */
export function LensPanel({ lens, data }: { lens: LensId; data: GridData }) {
  if (lens === "field") return <FieldPanel data={data} />;
  if (lens === "storm")
    return (
      <Suspense fallback={<PanelLoading />}>
        <StormPanel data={data} />
      </Suspense>
    );
  return <ExplorePanel data={data} />;
}
