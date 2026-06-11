// Minimal lazy-ECharts host: dynamic-imports the registered runtime on first mount (so the
// charting chunk loads only inside the MIS workspace), tracks container size, and re-applies
// the option whenever the parent rebuilds it (data arrival, dark-mode flip).
import { useEffect, useRef } from "react";
import type { EChartsCoreOption } from "echarts/core";

type EChartsInstance = ReturnType<(typeof import("echarts/core"))["init"]>;

export function Chart({ option, className }: { option: EChartsCoreOption; className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsInstance | null>(null);
  const optionRef = useRef(option);
  optionRef.current = option;

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    void import("./echarts-lazy.ts").then(({ echarts }) => {
      if (disposed || !hostRef.current) return;
      const chart = echarts.init(hostRef.current);
      chartRef.current = chart;
      chart.setOption(optionRef.current);
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
    // notMerge so a dark-mode rebuild fully replaces colours instead of layering options.
    chartRef.current?.setOption(option, true);
  }, [option]);

  return <div ref={hostRef} className={className} />;
}
