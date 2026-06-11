// Minimal lazy-ECharts host: dynamic-imports the registered runtime on first mount (so the
// charting chunk loads only inside the MIS workspace), tracks container size, and re-applies
// the option whenever the parent rebuilds it (data arrival, dark-mode flip). Supports click
// drill-down and shared brush/dataZoom range propagation.
import { useEffect, useRef } from "react";
import type { EChartsCoreOption } from "echarts/core";
import type { DateRange } from "./analytics.ts";

type EChartsInstance = ReturnType<(typeof import("echarts/core"))["init"]>;

export interface ChartRangeEvent {
  start: string;
  end: string;
}

type DataZoomBatch = {
  start?: number;
  end?: number;
  startValue?: number | string;
  endValue?: number | string;
};

function rangeFromDataZoom(
  ds: string[],
  dz: DataZoomBatch,
): ChartRangeEvent | null | undefined {
  let startIdx = -1;
  let endIdx = -1;
  const startVal = dz.startValue;
  const endVal = dz.endValue;
  if (startVal != null && endVal != null) {
    startIdx = typeof startVal === "number" ? Math.round(startVal) : ds.indexOf(String(startVal));
    endIdx = typeof endVal === "number" ? Math.round(endVal) : ds.indexOf(String(endVal));
  } else if (dz.start != null && dz.end != null) {
    if (dz.start <= 0.05 && dz.end >= 99.95) return null;
    const n = ds.length;
    if (n > 1) {
      startIdx = Math.round((dz.start / 100) * (n - 1));
      endIdx = Math.round((dz.end / 100) * (n - 1));
    } else {
      startIdx = 0;
      endIdx = 0;
    }
  } else {
    return null;
  }

  if (startIdx < 0 || endIdx < 0) return undefined;
  const lo = Math.min(startIdx, endIdx);
  const hi = Math.max(startIdx, endIdx);
  if (ds[lo] === ds[0] && ds[hi] === ds[ds.length - 1]) return null;
  return { start: ds[lo]!, end: ds[hi]! };
}

export function Chart({
  option,
  className,
  dates,
  dateRange,
  onDateClick,
  onDateRangeChange,
}: {
  option: EChartsCoreOption;
  className?: string;
  /** Category-axis labels — needed to map brush/dataZoom indices back to ISO dates. */
  dates?: string[];
  /** Controlled zoom range (synced across charts). */
  dateRange?: DateRange | null;
  onDateClick?: (date: string) => void;
  onDateRangeChange?: (range: ChartRangeEvent | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsInstance | null>(null);
  const optionRef = useRef(option);
  const datesRef = useRef(dates);
  const onClickRef = useRef(onDateClick);
  const onRangeRef = useRef(onDateRangeChange);
  const syncingRangeRef = useRef(false);
  const suppressRangeEmitRef = useRef(false);
  optionRef.current = option;
  datesRef.current = dates;
  onClickRef.current = onDateClick;
  onRangeRef.current = onDateRangeChange;

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    void import("./echarts-lazy.ts").then(({ echarts }) => {
      if (disposed || !hostRef.current) return;
      const chart = echarts.init(hostRef.current);
      chartRef.current = chart;
      suppressRangeEmitRef.current = true;
      chart.setOption(optionRef.current);
      queueMicrotask(() => {
        suppressRangeEmitRef.current = false;
      });

      chart.on("click", (params) => {
        if (params.componentType !== "series") return;
        const d = String(params.name ?? "");
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) onClickRef.current?.(d);
      });

      const emitRange = (batch?: DataZoomBatch) => {
        if (syncingRangeRef.current || suppressRangeEmitRef.current) return;
        const cb = onRangeRef.current;
        const ds = datesRef.current;
        if (!cb || !ds?.length) return;

        const dz =
          batch ??
          (chart.getOption() as { dataZoom?: DataZoomBatch[] }).dataZoom?.[0];
        if (!dz) return;

        const next = rangeFromDataZoom(ds, dz);
        if (next === undefined) return;
        cb(next);
      };

      chart.on("datazoom", (raw: unknown) => {
        const params = raw as { batch?: DataZoomBatch[]; start?: number; end?: number };
        emitRange(params.batch?.[0] ?? params);
      });
      chart.on("brushEnd", (raw: unknown) => {
        const params = raw as { areas?: Array<{ coordRange?: number[] }> };
        const cb = onRangeRef.current;
        const ds = datesRef.current;
        if (!cb || !ds?.length) return;
        const areaList = params.areas ?? [];
        if (areaList.length === 0) {
          cb(null);
          return;
        }
        const coordRange = areaList[0]?.coordRange;
        if (!coordRange || coordRange.length < 2) return;
        const lo = Math.max(0, Math.floor(coordRange[0]!));
        const hi = Math.min(ds.length - 1, Math.ceil(coordRange[1]!));
        cb({ start: ds[lo]!, end: ds[hi]! });
      });

      ro = new ResizeObserver(() => chart.resize());
      ro.observe(hostRef.current);
    });
    return () => {
      disposed = true;
      ro?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    // notMerge so a dark-mode rebuild fully replaces colours instead of layering options.
    suppressRangeEmitRef.current = true;
    chartRef.current.setOption(option, true);
    queueMicrotask(() => {
      suppressRangeEmitRef.current = false;
    });
  }, [option]);

  useEffect(() => {
    if (!dates?.length || !chartRef.current) return;
    suppressRangeEmitRef.current = true;
    syncingRangeRef.current = true;
    if (!dateRange) {
      chartRef.current.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
    } else {
      const startIdx = dates.findIndex((d) => d >= dateRange.start);
      const endIdx = dates.reduce((acc, d, i) => (d <= dateRange.end ? i : acc), -1);
      if (startIdx < 0 || endIdx < 0) {
        queueMicrotask(() => {
          suppressRangeEmitRef.current = false;
          syncingRangeRef.current = false;
        });
        return;
      }
      chartRef.current.dispatchAction({
        type: "dataZoom",
        startValue: dates[startIdx],
        endValue: dates[endIdx],
      });
    }
    queueMicrotask(() => {
      suppressRangeEmitRef.current = false;
      syncingRangeRef.current = false;
    });
  }, [dateRange, dates]);

  return <div ref={hostRef} className={className} />;
}
