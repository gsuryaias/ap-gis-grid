import { create } from "zustand";
import type { FeatureCollection } from "geojson";
import { DISCOM11_DEF, DISCOM_DEFS, DISCOMS, refDef, TOWER_DEFS, type DiscomId, type OverlayDef, type RefCatalogEntry } from "./catalog.ts";
import { decodeTowers, type WebTowersFile } from "./towers.ts";
import type { NetItem } from "../data/network-search.ts";
import { dataUrl, defineResource, fetchJson } from "../data/resources.ts";

type LoadStatus = "idle" | "loading" | "ready" | "error";

/** Per-viewer convenience only (which overlays were on last time) — never required state. */
const LS_KEY = "apgg-overlays-v1";

interface Persisted {
  enabled: string[];
  discoms: DiscomId[];
}

function readPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}

function writePersisted(p: Persisted): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* private mode / blocked storage — fine */
  }
}


export interface OverlayFocus {
  lines: string[];
  ss: string[];
  lines11?: string[];
  point?: [number, number] | null;
}

interface OverlayState {
  /** All known overlay definitions, by id (DISCOM always; RTGS refs once catalog.json loads). */
  defs: Record<string, OverlayDef>;
  catalogStatus: LoadStatus;
  enabled: Record<string, boolean>;
  status: Record<string, LoadStatus>;
  errors: Record<string, string>;
  data: Record<string, FeatureCollection>;
  /** DISCOM sub-filter (which utilities' features are drawn). */
  discoms: Record<DiscomId, boolean>;
  /** Highlighted DISCOM features: 33 kV lines / 33/11 kV SS / 11 kV feeders / one point (transient). */
  focus: OverlayFocus | null;
  /** Network search pick (33/11 SS, 33 / 11 kV feeder, section, transformer) shown in the trace panel. */
  netFocus: NetItem | null;
  /** One-shot "fit the map to these bounds" request ([[w,s],[e,n]]). */
  fitSignal: { bounds: [[number, number], [number, number]]; ts: number; maxZoom?: number } | null;
  /** Bumped on every change the map must react to. */
  version: number;

  loadCatalog: () => void;
  toggle: (id: string, on?: boolean) => void;
  toggleDiscom: (d: DiscomId) => void;
  restore: () => void;
  setFocus: (f: OverlayFocus | null) => void;
  fitTo: (bounds: [[number, number], [number, number]], maxZoom?: number) => void;
  /** Open a network search result: switch on its overlay, highlight it, fly there, show the trace. */
  focusNetwork: (item: NetItem | null) => void;
}

export const useOverlayStore = create<OverlayState>((set, get) => {
  const persist = () => {
    const s = get();
    writePersisted({
      enabled: Object.keys(s.enabled).filter((k) => s.enabled[k]),
      discoms: DISCOMS.filter((d) => s.discoms[d]),
    });
  };

  const fetchLayer = (id: string) => {
    const def = get().defs[id];
    if (!def || get().status[id] === "loading" || get().status[id] === "ready") return;
    set((s) => ({ status: { ...s.status, [id]: "loading" }, version: s.version + 1 }));
    overlayLayer
      .ensure(id)
      .then((fc) =>
        set((s) => ({
          data: { ...s.data, [id]: fc },
          status: { ...s.status, [id]: "ready" },
          defs: { ...s.defs, [id]: { ...s.defs[id], count: s.defs[id].count || fc.features.length } },
          version: s.version + 1,
        })),
      )
      .catch((e: unknown) =>
        set((s) => ({
          status: { ...s.status, [id]: "error" },
          errors: { ...s.errors, [id]: e instanceof Error ? e.message : String(e) },
          enabled: { ...s.enabled, [id]: false },
          version: s.version + 1,
        })),
      );
  };

  return {
    defs: Object.fromEntries([...DISCOM_DEFS, DISCOM11_DEF, ...TOWER_DEFS].map((d) => [d.id, d])),
    catalogStatus: "idle",
    enabled: {},
    status: {},
    errors: {},
    data: {},
    discoms: { APSPDCL: true, APEPDCL: true, APCPDCL: true },
    focus: null,
    netFocus: null,
    fitSignal: null,
    version: 0,

    setFocus: (focus) => set((s) => ({ focus, version: s.version + 1 })),
    fitTo: (bounds, maxZoom) => set((s) => ({ fitSignal: { bounds, ts: Date.now(), maxZoom }, version: s.version + 1 })),

    focusNetwork: (item) => {
      if (!item) {
        set((s) => ({ netFocus: null, focus: null, version: s.version + 1 }));
        return;
      }
      const layer =
        item.kind === "f33" ? "discom-lines" : item.kind === "ss33" ? "discom-ss" : item.kind === "sec" ? null : "discom-11kv-lines";
      if (layer && !get().enabled[layer]) get().toggle(layer, true);
      const focus: OverlayFocus = {
        lines: item.kind === "f33" ? [item.ref] : [],
        ss: item.kind === "ss33" ? [item.ref] : [],
        lines11: item.kind === "f11" ? [item.ref] : item.kind === "dtr" && item.dtr?.feederId ? [item.dtr.feederId] : [],
        point: item.kind === "dtr" || item.kind === "ss33" ? [item.lng, item.lat] : null,
      };
      const d = item.kind === "dtr" ? 0.004 : item.kind === "ss33" ? 0.01 : item.kind === "sec" ? 0.05 : 0.03;
      const maxZoom = item.kind === "dtr" ? 16.5 : item.kind === "ss33" ? 14 : item.kind === "sec" ? 12 : 13;
      set((s) => ({
        netFocus: item,
        focus,
        fitSignal: { bounds: [[item.lng - d, item.lat - d], [item.lng + d, item.lat + d]], ts: Date.now(), maxZoom },
        version: s.version + 1,
      }));
    },

    loadCatalog: () => {
      if (get().catalogStatus !== "idle") return;
      set({ catalogStatus: "loading" });
      refCatalog
        .ensure()
        .then((entries) => {
          set((s) => ({
            defs: { ...s.defs, ...Object.fromEntries(entries.map((e) => [e.id, refDef(e)])) },
            catalogStatus: "ready",
          }));
          // Layers restored from a previous visit that were waiting for their definition.
          for (const [id, on] of Object.entries(get().enabled)) if (on) fetchLayer(id);
        })
        .catch(() => set({ catalogStatus: "error" }));
    },

    toggle: (id, on) => {
      const next = on ?? !get().enabled[id];
      set((s) => ({ enabled: { ...s.enabled, [id]: next }, version: s.version + 1 }));
      if (next) fetchLayer(id);
      persist();
    },

    toggleDiscom: (d) => {
      set((s) => ({ discoms: { ...s.discoms, [d]: !s.discoms[d] }, version: s.version + 1 }));
      persist();
    },

    restore: () => {
      const p = readPersisted();
      if (!p) return;
      set((s) => ({
        enabled: Object.fromEntries(p.enabled.map((id) => [id, true])),
        discoms: p.discoms?.length
          ? (Object.fromEntries(DISCOMS.map((d) => [d, p.discoms.includes(d)])) as Record<DiscomId, boolean>)
          : s.discoms,
        version: s.version + 1,
      }));
      for (const id of p.enabled) if (get().defs[id]) fetchLayer(id);
      if (p.enabled.some((id) => !get().defs[id])) get().loadCatalog();
    },
  };
});

/** RTGS reference-layer catalogue (public/data/ref/catalog.json). */
export const refCatalog = defineResource<RefCatalogEntry[]>("ref-catalog", {
  load: (_p, signal) => fetchJson<RefCatalogEntry[]>(dataUrl("ref/catalog.json"), signal),
});

/**
 * One overlay layer's features, by overlay id — the single fetch for both the map layer and any
 * other consumer (e.g. the DISCOM GeoJSON download), so a file is never downloaded twice.
 * Towers ship grouped by line and are decoded to GeoJSON here.
 */
export const overlayLayer = defineResource<FeatureCollection>("overlay", {
  load: async (id, signal) => {
    let def = useOverlayStore.getState().defs[id];
    if (!def) {
      await refCatalog.ensure();
      def = useOverlayStore.getState().defs[id];
      if (!def) throw new Error(`unknown overlay "${id}"`);
    }
    const json = await fetchJson<FeatureCollection | WebTowersFile>(dataUrl(def.file), signal);
    return def.format === "towers" ? decodeTowers(id, json as WebTowersFile) : (json as FeatureCollection);
  },
});
