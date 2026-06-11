// ECharts, tree-shaken to exactly what the MIS dashboards draw. This module is ONLY ever
// reached via dynamic import (Chart.tsx), so the whole charting runtime is its own async chunk
// inside the MIS workspace — never part of the Atlas entry bundle.
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export { echarts };
