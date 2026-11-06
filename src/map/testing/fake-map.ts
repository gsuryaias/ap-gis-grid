// A fake MapLibre map for unit tests (node env, no WebGL). Layers keep RAW spec values — exactly
// what MapLibre's getters return — and an ordered layer list; every mutation is logged in `writes`.
import type { LayerSpecification } from "maplibre-gl";
import type { EngineMap } from "../engine.ts";
import type { SpecMap } from "../spec.ts";

interface FakeLayer {
  filter?: unknown;
  visibility?: string;
  paint: Record<string, unknown>;
}

export class FakeMap {
  layers = new Map<string, FakeLayer>();
  order: string[] = [];
  sources = new Map<string, { data?: unknown; tiles?: unknown; setData: (d: unknown) => void; setTiles: (t: unknown) => void }>();
  featureState = new Map<string, Record<string, unknown>>();
  writes: string[] = [];
  styleLoaded = true;

  addLayer(spec: LayerSpecification, before?: string): void {
    const s = spec as { id: string; filter?: unknown; layout?: { visibility?: string }; paint?: Record<string, unknown> };
    if (this.layers.has(s.id)) throw new Error(`layer ${s.id} already exists`);
    this.writes.push(`add-layer:${s.id}`);
    this.layers.set(s.id, { filter: s.filter, visibility: s.layout?.visibility, paint: { ...(s.paint ?? {}) } });
    this.insert(s.id, before);
  }
  moveLayer(id: string, before?: string): void {
    this.writes.push(`move:${id}`);
    this.order.splice(this.order.indexOf(id), 1);
    this.insert(id, before);
  }
  private insert(id: string, before?: string) {
    const at = before != null ? this.order.indexOf(before) : -1;
    if (at < 0) this.order.push(id);
    else this.order.splice(at, 0, id);
  }
  getLayersOrder(): string[] {
    return [...this.order];
  }
  addSource(id: string, spec?: { data?: unknown; tiles?: unknown }): void {
    if (this.sources.has(id)) throw new Error(`source ${id} already exists`);
    this.writes.push(`add-source:${id}`);
    const src = {
      data: spec?.data,
      tiles: spec?.tiles,
      setData: (d: unknown) => {
        this.writes.push(`set-data:${id}`);
        src.data = d;
      },
      setTiles: (t: unknown) => {
        this.writes.push(`set-tiles:${id}`);
        src.tiles = t;
      },
    };
    this.sources.set(id, src);
  }
  /** Simulate `setStyle`: every custom layer, source and feature-state is dropped. */
  reloadStyle(): void {
    this.layers.clear();
    this.order = [];
    this.sources.clear();
    this.featureState.clear();
  }
  isStyleLoaded() {
    return this.styleLoaded;
  }
  on() {
    return this;
  }
  off() {
    return this;
  }
  getLayer(id: string) {
    return this.layers.get(id);
  }
  getSource(id: string) {
    return this.sources.get(id);
  }
  getFilter(id: string) {
    return this.layers.get(id)!.filter;
  }
  setFilter(id: string, f: unknown) {
    this.writes.push(`filter:${id}`);
    this.layers.get(id)!.filter = f ?? undefined;
  }
  getLayoutProperty(id: string, _p: string) {
    return this.layers.get(id)!.visibility;
  }
  setLayoutProperty(id: string, _p: string, v: string) {
    this.writes.push(`vis:${id}`);
    this.layers.get(id)!.visibility = v;
  }
  getPaintProperty(id: string, p: string) {
    return this.layers.get(id)!.paint[p];
  }
  setPaintProperty(id: string, p: string, v: unknown) {
    this.writes.push(`paint:${id}:${p}`);
    this.layers.get(id)!.paint[p] = v;
  }
  setFeatureState(t: { source: string; id: string }, st: Record<string, unknown>) {
    this.writes.push(`fs:${t.source}:${t.id}`);
    const k = `${t.source}/${t.id}`;
    this.featureState.set(k, { ...this.featureState.get(k), ...st });
  }
  removeFeatureState(t: { source: string; id: string }, key: string) {
    this.writes.push(`fs-rm:${t.source}:${t.id}:${key}`);
    const st = this.featureState.get(`${t.source}/${t.id}`);
    if (st) delete st[key];
  }
  state(source: string, id: string) {
    return this.featureState.get(`${source}/${id}`) ?? {};
  }
  get api(): SpecMap & EngineMap {
    return this as unknown as SpecMap & EngineMap;
  }
}
