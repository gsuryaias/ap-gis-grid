import type { ExpressionSpecification, GeoJSONSource, LayerSpecification, Map as MlMap, MapMouseEvent } from "maplibre-gl";
import type { Feature, FeatureCollection, Position } from "geojson";
import { centroid, formatArea, formatLength, pathLengthMeters, ringAreaMeters } from "../lib/geo.ts";
import { BASEMAPS } from "./basemaps.ts";
import type { Basemap } from "../state/store.ts";

export type MeasureMode = "distance" | "area";

/** Live measurement readout, published to the store for the React control to render. */
export interface MeasureStats {
  mode: MeasureMode;
  /** Committed vertices (excludes the live cursor tip). */
  count: number;
  /** Path length (distance mode) or perimeter (area mode), in metres. */
  lengthM: number;
  /** Polygon area in m² (0 in distance mode). */
  areaM2: number;
  /** True once the user has finished placing points (double-click / Enter). */
  finished: boolean;
}

const SRC = "src-measure";
const L = {
  fill: "measure-fill",
  line: "measure-line",
  rubber: "measure-rubber",
  vertex: "measure-vertex",
  label: "measure-label",
} as const;

/** Magenta — deliberately outside the voltage (orange/blue/green), selection (yellow) and
 *  energy palettes so a measurement never reads as a network feature. Pops on all 3 basemaps. */
const MEASURE_COLOR = "#ff2d95";

const e = (x: unknown): ExpressionSpecification => x as ExpressionSpecification;
const isKind = (k: string): ExpressionSpecification => e(["==", ["get", "kind"], k]);

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function buildLayers(basemap: Basemap): LayerSpecification[] {
  const def = BASEMAPS[basemap];
  return [
    {
      id: L.fill,
      type: "fill",
      source: SRC,
      filter: isKind("area"),
      paint: { "fill-color": MEASURE_COLOR, "fill-opacity": 0.14 },
    },
    {
      id: L.line,
      type: "line",
      source: SRC,
      filter: isKind("path"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": MEASURE_COLOR, "line-width": 2.5, "line-opacity": 0.95 },
    },
    {
      id: L.rubber,
      type: "line",
      source: SRC,
      filter: isKind("rubber"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": MEASURE_COLOR, "line-width": 2, "line-opacity": 0.8, "line-dasharray": [2, 2] },
    },
    {
      id: L.vertex,
      type: "circle",
      source: SRC,
      filter: isKind("vertex"),
      paint: {
        "circle-radius": 4.5,
        "circle-color": "#ffffff",
        "circle-stroke-color": MEASURE_COLOR,
        "circle-stroke-width": 2.5,
      },
    },
    {
      id: L.label,
      type: "symbol",
      source: SRC,
      filter: isKind("total"),
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Open Sans Bold"],
        "text-size": 13,
        "text-offset": [0, -0.7],
        "text-anchor": "bottom",
        "text-allow-overlap": true,
      },
      paint: { "text-color": def.labelColor, "text-halo-color": def.labelHalo, "text-halo-width": 2 },
    },
  ] as LayerSpecification[];
}

type Pt = (kind: string, extra?: Record<string, unknown>) => (coords: Position) => Feature;
const point: Pt = (kind, extra) => (coords) => ({
  type: "Feature",
  properties: { kind, ...extra },
  geometry: { type: "Point", coordinates: coords },
});
const lineFeature = (kind: string, coords: Position[]): Feature => ({
  type: "Feature",
  properties: { kind },
  geometry: { type: "LineString", coordinates: coords },
});

/**
 * Owns the entire measurement interaction for one map: a dedicated GeoJSON source +
 * overlay layers, plus click / move / double-click / keyboard handling. The instance
 * lives for the map's lifetime; `setMode` toggles it on and off. Idempotent layer setup
 * means `ensureLayers` can be re-run after every basemap style reload (which drops them).
 */
export class MeasureController {
  private map: MlMap;
  private onStats: (s: MeasureStats | null) => void;
  private onExit: () => void;
  private mode: MeasureMode | null = null;
  private points: Position[] = [];
  private cursor: Position | null = null;
  private finished = false;

  constructor(map: MlMap, opts: { onStats: (s: MeasureStats | null) => void; onExit: () => void }) {
    this.map = map;
    this.onStats = opts.onStats;
    this.onExit = opts.onExit;
    map.on("click", this.handleClick);
    map.on("mousemove", this.handleMove);
    map.on("dblclick", this.handleDblClick);
    window.addEventListener("keydown", this.handleKey);
  }

  /** Add the source + layers if absent. Safe to call repeatedly (e.g. after setStyle). */
  ensureLayers(basemap: Basemap): void {
    if (!this.map.getSource(SRC)) this.map.addSource(SRC, { type: "geojson", data: EMPTY });
    for (const layer of buildLayers(basemap)) if (!this.map.getLayer(layer.id)) this.map.addLayer(layer);
    if (this.mode) this.redraw(); // restore any in-progress drawing after a style reload
  }

  setMode(mode: MeasureMode | null): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.points = [];
    this.cursor = null;
    this.finished = false;
    const canvas = this.map.getCanvas();
    if (mode) {
      this.ensureLayers(this.currentBasemap());
      canvas.style.cursor = "crosshair";
      this.map.doubleClickZoom.disable();
    } else {
      canvas.style.cursor = "";
      this.map.doubleClickZoom.enable();
    }
    this.redraw();
    this.emit();
  }

  /** Reset the current drawing but stay in the active mode. */
  clear(): void {
    if (!this.mode) return;
    this.points = [];
    this.cursor = null;
    this.finished = false;
    this.redraw();
    this.emit();
  }

  destroy(): void {
    this.map.off("click", this.handleClick);
    this.map.off("mousemove", this.handleMove);
    this.map.off("dblclick", this.handleDblClick);
    window.removeEventListener("keydown", this.handleKey);
    this.map.doubleClickZoom.enable();
    if (this.map.getCanvas()) this.map.getCanvas().style.cursor = "";
  }

  // The store is the source of truth for the basemap; read it lazily without coupling
  // the class to a specific store import path (passed in via the module that owns it).
  private currentBasemap: () => Basemap = () => "light";
  setBasemapGetter(fn: () => Basemap): void {
    this.currentBasemap = fn;
  }

  private handleClick = (ev: MapMouseEvent): void => {
    if (!this.mode) return;
    const p: Position = [ev.lngLat.lng, ev.lngLat.lat];
    if (this.finished) {
      // A click after finishing starts a fresh measurement.
      this.points = [p];
      this.finished = false;
    } else {
      this.points.push(p);
    }
    this.redraw();
    this.emit();
  };

  private handleMove = (ev: MapMouseEvent): void => {
    if (!this.mode || this.finished) return;
    this.cursor = [ev.lngLat.lng, ev.lngLat.lat];
    if (this.points.length) {
      this.redraw();
      this.emit();
    }
  };

  private handleDblClick = (): void => {
    if (!this.mode) return;
    // The first of the double-click's two clicks already appended a duplicate vertex; drop it.
    if (this.points.length >= 2) {
      const a = this.points[this.points.length - 1];
      const b = this.points[this.points.length - 2];
      if (a[0] === b[0] && a[1] === b[1]) this.points.pop();
    }
    this.finish();
  };

  private handleKey = (ev: KeyboardEvent): void => {
    if (!this.mode) return;
    if (ev.key === "Escape") {
      if (this.points.length) this.clear();
      else this.onExit();
    } else if (ev.key === "Enter") {
      this.finish();
    } else if (ev.key === "Backspace" && !this.finished && this.points.length) {
      ev.preventDefault();
      this.points.pop();
      this.redraw();
      this.emit();
    }
  };

  private finish(): void {
    this.finished = true;
    this.cursor = null;
    this.redraw();
    this.emit();
  }

  /** Effective geometry including the live cursor tip while drawing. */
  private livePoints(): Position[] {
    if (this.finished || !this.cursor || !this.points.length) return this.points;
    return [...this.points, this.cursor];
  }

  private emit(): void {
    if (!this.mode || this.points.length === 0) {
      this.onStats(null);
      return;
    }
    const pts = this.livePoints();
    if (this.mode === "distance") {
      this.onStats({ mode: "distance", count: this.points.length, lengthM: pathLengthMeters(pts), areaM2: 0, finished: this.finished });
    } else {
      const ring = pts.length >= 3 ? [...pts, pts[0]] : pts;
      this.onStats({
        mode: "area",
        count: this.points.length,
        lengthM: pathLengthMeters(ring),
        areaM2: ringAreaMeters(pts),
        finished: this.finished,
      });
    }
  }

  private redraw(): void {
    const src = this.map.getSource(SRC) as GeoJSONSource | undefined;
    if (!src) return;
    const features: Feature[] = [];
    const { points, cursor, finished, mode } = this;
    if (!mode || points.length === 0) {
      src.setData(EMPTY);
      return;
    }
    const tip = !finished && cursor ? cursor : null;
    const pts = tip ? [...points, tip] : points;

    // Vertices (committed only).
    for (const p of points) features.push(point("vertex")(p));

    if (mode === "distance") {
      if (points.length >= 2) features.push(lineFeature("path", points));
      if (tip) features.push(lineFeature("rubber", [points[points.length - 1], tip]));
      const labelAt = tip ?? points[points.length - 1];
      features.push(point("total", { label: formatLength(pathLengthMeters(pts)) })(labelAt));
    } else {
      // Area: solid outline of committed edges; dashed "rubber" closes the ring through the cursor.
      if (finished && points.length >= 3) features.push(lineFeature("path", [...points, points[0]]));
      else if (points.length >= 2) features.push(lineFeature("path", points));
      if (tip) {
        const rubber = points.length >= 2 ? [points[points.length - 1], tip, points[0]] : [points[points.length - 1], tip];
        features.push(lineFeature("rubber", rubber));
      }
      if (pts.length >= 3) {
        features.push({
          type: "Feature",
          properties: { kind: "area" },
          geometry: { type: "Polygon", coordinates: [[...pts, pts[0]]] },
        });
        features.push(point("total", { label: formatArea(ringAreaMeters(pts)) })(centroid(pts)));
      }
    }
    src.setData({ type: "FeatureCollection", features });
  }
}
