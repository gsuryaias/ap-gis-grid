// The on-demand dialogs, code-split: each module loads the first time its dialog opens, so the
// summary, data-quality, weather and glossary code + content stay out of the initial bundle.
import { lazy, Suspense } from "react";
import { useShallow } from "zustand/react/shallow";
import type { GridData } from "../data/types.ts";
import { useAppStore } from "../state/store.ts";

const SummaryView = lazy(() => import("../components/SummaryView.tsx").then((m) => ({ default: m.SummaryView })));
const DataQualityView = lazy(() => import("../components/DataQualityView.tsx").then((m) => ({ default: m.DataQualityView })));
const WeatherView = lazy(() => import("../components/WeatherView.tsx").then((m) => ({ default: m.WeatherView })));
const GlossaryDialog = lazy(() => import("../trust/Glossary.tsx").then((m) => ({ default: m.GlossaryDialog })));

export function OnDemandDialogs({ data }: { data: GridData }) {
  const open = useAppStore(
    useShallow((s) => ({ summary: s.summaryOpen, quality: s.qualityOpen, weather: s.weatherOpen, glossary: s.glossary != null })),
  );
  return (
    <Suspense fallback={null}>
      {open.summary && <SummaryView data={data} />}
      {open.quality && <DataQualityView data={data} />}
      {open.weather && <WeatherView data={data} />}
      {open.glossary && <GlossaryDialog />}
    </Suspense>
  );
}
