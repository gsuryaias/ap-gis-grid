// DISCOM / RTGS / tower overlays — the former `overlays/store.ts`, now the `layers` slice of the one
// app store. Feature data lives in the `overlayLayer` resource, not here.
import type { PersistStorage, StorageValue } from "zustand/middleware";
import { lensOnlyOverlays } from "../../lenses/registry.ts";
import { DISCOMS, refDef, type DiscomId } from "../../overlays/catalog.ts";
import { overlayLayer, refCatalog, STATIC_OVERLAY_DEFS } from "../../overlays/resources.ts";
import type { AppState, LayersSlice, LayersState, OverlayFocus, PersistedLayers, SliceCreator } from "../types.ts";

/** Per-viewer convenience only (which overlays were on last time) — never required state. */
export const LAYERS_STORAGE_KEY = "apgg-overlays-v1";
export const LAYERS_STORAGE_VERSION = 1;

/**
 * Sanitise whatever is stored under the legacy key. The old overlay store wrote the raw
 * `{enabled: string[], discoms: DiscomId[]}` (no zustand envelope); tolerate that, a zustand
 * `{state, version}` envelope, and junk.
 */
export function parseStoredLayers(raw: unknown): PersistedLayers | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = (raw as { state?: unknown }).state && typeof (raw as { state?: unknown }).state === "object" ? (raw as { state: object }).state : raw;
  const { enabled, discoms } = obj as { enabled?: unknown; discoms?: unknown };
  return {
    enabled: Array.isArray(enabled) ? [...new Set(enabled.filter((x): x is string => typeof x === "string" && x.length > 0))] : [],
    discoms: Array.isArray(discoms) ? DISCOMS.filter((d) => discoms.includes(d)) : [],
  };
}

/**
 * What the store persists: exactly the legacy on-disk shape, so old and new builds share it. Overlays
 * that are on only because the current lens presets them are not the viewer's own choice, so they are
 * left out (entering the lens again brings them back).
 */
export function partializeLayers(s: AppState): PersistedLayers {
  const preset = lensOnlyOverlays(s.lens);
  return {
    enabled: Object.keys(s.layers.enabled).filter((k) => s.layers.enabled[k] && !preset.has(k)),
    discoms: DISCOMS.filter((d) => s.layers.discoms[d]),
  };
}

/** Fold persisted choices into the live state (an empty DISCOM list keeps the default: all on). */
export function mergeLayers(persisted: unknown, current: AppState): AppState {
  const p = parseStoredLayers(persisted);
  if (!p) return current;
  return {
    ...current,
    layers: {
      ...current.layers,
      enabled: Object.fromEntries(p.enabled.map((id) => [id, true])),
      discoms: p.discoms.length
        ? (Object.fromEntries(DISCOMS.map((d) => [d, p.discoms.includes(d)])) as Record<DiscomId, boolean>)
        : current.layers.discoms,
    },
  };
}

/**
 * localStorage adapter for `persist`: reads the raw legacy shape (wrapping it in zustand's
 * envelope), writes the raw shape back, never throws (private mode / blocked storage), and skips
 * the write when nothing persisted changed — `persist` calls setItem after EVERY store update.
 */
export function layersStorage(getStorage: () => Storage | undefined = () => globalThis.localStorage): PersistStorage<PersistedLayers> {
  let last: string | null = null;
  return {
    getItem: (name) => {
      try {
        const raw = getStorage()?.getItem(name);
        if (!raw) return null;
        last = raw;
        const state = parseStoredLayers(JSON.parse(raw));
        return state ? { state, version: LAYERS_STORAGE_VERSION } : null;
      } catch {
        return null;
      }
    },
    setItem: (name, value: StorageValue<PersistedLayers>) => {
      try {
        const str = JSON.stringify({ enabled: value.state.enabled, discoms: value.state.discoms });
        if (str === last) return;
        last = str;
        getStorage()?.setItem(name, str);
      } catch {
        /* private mode / blocked storage — fine */
      }
    },
    removeItem: (name) => {
      try {
        last = null;
        getStorage()?.removeItem(name);
      } catch {
        /* ignore */
      }
    },
  };
}

export const createLayersSlice: SliceCreator<LayersSlice> = (set, get) => {
  const L = () => get().layers;
  const setL = (fn: (l: LayersState) => Partial<LayersState>) =>
    set((s) => ({ layers: { ...s.layers, ...fn(s.layers), version: s.layers.version + 1 } }));

  const fetchLayer = (id: string) => {
    const st = L().status[id];
    if (!L().defs[id] || st === "loading" || st === "ready") return;
    setL((l) => ({ status: { ...l.status, [id]: "loading" } }));
    overlayLayer
      .ensure(id)
      .then((fc) =>
        setL((l) => ({
          status: { ...l.status, [id]: "ready" },
          defs: { ...l.defs, [id]: { ...l.defs[id], count: l.defs[id].count || fc.features.length } },
        })),
      )
      .catch((e: unknown) =>
        setL((l) => ({
          status: { ...l.status, [id]: "error" },
          errors: { ...l.errors, [id]: e instanceof Error ? e.message : String(e) },
          enabled: { ...l.enabled, [id]: false },
        })),
      );
  };

  return {
    layers: {
      defs: { ...STATIC_OVERLAY_DEFS },
      catalogStatus: "idle",
      enabled: {},
      status: {},
      errors: {},
      discoms: { APSPDCL: true, APEPDCL: true, APCPDCL: true },
      focus: null,
      fitSignal: null,
      opacity: {},
      version: 0,

      setOpacity: (id, v) => setL((l) => ({ opacity: { ...l.opacity, [id]: Math.min(1, Math.max(0, v)) } })),
      setFocus: (focus: OverlayFocus | null) => setL(() => ({ focus })),
      fitTo: (bounds, maxZoom) => setL(() => ({ fitSignal: { bounds, ts: Date.now(), maxZoom } })),

      loadCatalog: () => {
        if (L().catalogStatus !== "idle") return;
        setL(() => ({ catalogStatus: "loading" }));
        refCatalog
          .ensure()
          .then((entries) => {
            setL((l) => ({
              defs: { ...l.defs, ...Object.fromEntries(entries.map((e) => [e.id, refDef(e)])) },
              catalogStatus: "ready",
            }));
            // Layers restored from a previous visit that were waiting for their definition.
            for (const [id, on] of Object.entries(L().enabled)) if (on) fetchLayer(id);
          })
          .catch(() => setL(() => ({ catalogStatus: "error" })));
      },

      toggle: (id, on) => {
        const next = on ?? !L().enabled[id];
        setL((l) => ({ enabled: { ...l.enabled, [id]: next } }));
        if (next) fetchLayer(id);
      },

      toggleDiscom: (d) => setL((l) => ({ discoms: { ...l.discoms, [d]: !l.discoms[d] } })),

      restore: () => {
        const on = Object.keys(L().enabled).filter((id) => L().enabled[id]);
        for (const id of on) fetchLayer(id);
        if (on.some((id) => !L().defs[id])) L().loadCatalog();
      },
    },
  };
};
