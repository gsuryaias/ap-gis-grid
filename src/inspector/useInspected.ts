// React side of the Inspector: load whatever the selected ref's adapter needs (through the one
// resource loader), resolve it, and keep the map in step (overlay on, amber focus, camera).
import { useEffect, useMemo, useRef } from "react";
import { generationRes, powerGridRes } from "../data/load.ts";
import { useResource, useResourceSnapshot, type ResStatus } from "../data/resources.ts";
import { weatherRes } from "../data/weather.ts";
import { featureRow, overlayLayer, rowKey } from "../overlays/resources.ts";
import { useAppStore } from "../state/store.ts";
import { inspect, needsOf } from "./inspect.ts";
import { refKind } from "./refs.ts";
import { netItemRes } from "./resources.ts";
import type { Inspected, InspectorCtx } from "./types.ts";

export interface InspectedState {
  ins: Inspected | null;
  /** loading while something it needs is in flight; missing = nothing matches the ref. */
  status: "idle" | "loading" | "ready" | "missing" | "error";
}

const YEAR = new Date().getFullYear();

export function useInspected(ref: string | null): InspectedState {
  const data = useAppStore((s) => s.data);
  const defs = useAppStore((s) => s.layers.defs);
  const needs = needsOf(ref);
  const overlay = useResource(overlayLayer, needs.overlay && needs.layer ? needs.layer : null);
  const row = useResource(featureRow, needs.row && needs.layer && ref ? rowKey(needs.layer, ref) : null);
  const net = useResource(netItemRes, needs.net && ref ? ref : null);
  const gen = useResource(generationRes, needs.gen ? "" : null);
  const pg = useResource(powerGridRes, needs.pg ? "" : null);
  // Observe only: DLR in the line overview appears once something has loaded live weather.
  const weather = useResourceSnapshot(weatherRes).data;
  const genData = useResourceSnapshot(generationRes).data;
  const pgData = useResourceSnapshot(powerGridRes).data;

  return useMemo((): InspectedState => {
    if (!ref || !data) return { ins: null, status: "idle" };
    const ctx: InspectorCtx = {
      data,
      gen: genData,
      pg: pgData,
      weather,
      overlay: (id) => overlayLayer.peek(id), // `overlay.data` (a dep) is the needed layer's entry
      overlayDef: (id) => defs[id],
      row: row.data ?? null,
      netItem: net.data ?? null,
      year: YEAR,
    };
    const ins = inspect(ref, ctx);
    if (ins) return { ins, status: "ready" };
    const pending: ResStatus[] = [overlay.status, row.status, net.status, gen.status, pg.status];
    if (pending.includes("loading")) return { ins: null, status: "loading" };
    if (pending.includes("error")) return { ins: null, status: "error" };
    return { ins: null, status: "missing" };
  }, [ref, data, defs, overlay.data, overlay.status, row.data, row.status, net.data, net.status, gen.status, pg.status, genData, pgData, weather]);
}

/** Kinds whose camera move `useMapCamera` already does from `flySignal` (sync data, `flyToFeature`). */
const NATIVE_CAMERA = new Set(["core-ss", "core-line", "plant", "pg-line", "pg-ss", "rail-ss", "bulk-ss"]);

/**
 * Keep the map in step with the Inspector's selection (mounted once by the shell):
 *  - a selected DISCOM / tower / reference feature's layer is switched on (deep links, search picks);
 *  - its amber focus highlight is shown while it is inspected;
 *  - a `fly` selection moves the camera once the entity has resolved.
 */
export function useInspectorSync(): void {
  const ref = useAppStore((s) => s.selectedId);
  const fly = useAppStore((s) => s.flySignal);
  const { ins } = useInspected(ref);

  // Switch the feature's layer on once per new selection (the user may switch it off afterwards).
  useEffect(() => {
    const layer = needsOf(ref).layer;
    if (!layer) return;
    const L = useAppStore.getState().layers;
    if (L.enabled[layer]) return;
    if (!L.defs[layer]) L.loadCatalog();
    L.toggle(layer, true);
  }, [ref]);

  const focus = ins?.focus ?? null;
  const focusKey = focus ? JSON.stringify(focus) : null;
  useEffect(() => {
    if (!focusKey) return;
    const L = useAppStore.getState().layers;
    L.setFocus(JSON.parse(focusKey));
    return () => useAppStore.getState().layers.setFocus(null);
  }, [focusKey]);

  const flown = useRef(0);
  useEffect(() => {
    if (!fly || !ins || fly.id !== ins.ref || flown.current === fly.ts || !ins.locate) return;
    if (NATIVE_CAMERA.has(refKind(ins.ref) ?? "")) return;
    flown.current = fly.ts;
    const l = ins.locate;
    const L = useAppStore.getState().layers;
    if ("bounds" in l) L.fitTo(l.bounds, l.maxZoom);
    else L.fitTo([l.center, l.center], l.zoom);
  }, [fly, ins]);
}
