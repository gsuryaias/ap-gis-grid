import { create } from "zustand";
import type { FeatureCollection } from "geojson";
import { DISCOM_DEFS, DISCOMS, refDef, type DiscomId, type OverlayDef, type RefCatalogEntry } from "./catalog.ts";

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

const dataUrl = (file: string) => `${import.meta.env.BASE_URL}data/${file}`;

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
  /** Bumped on every change the map must react to. */
  version: number;

  loadCatalog: () => void;
  toggle: (id: string, on?: boolean) => void;
  toggleDiscom: (d: DiscomId) => void;
  restore: () => void;
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
    fetch(dataUrl(def.file))
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json() as Promise<FeatureCollection>;
      })
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
    defs: Object.fromEntries(DISCOM_DEFS.map((d) => [d.id, d])),
    catalogStatus: "idle",
    enabled: {},
    status: {},
    errors: {},
    data: {},
    discoms: { APSPDCL: true, APEPDCL: true, APCPDCL: true },
    version: 0,

    loadCatalog: () => {
      if (get().catalogStatus !== "idle") return;
      set({ catalogStatus: "loading" });
      fetch(dataUrl("ref/catalog.json"))
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json() as Promise<RefCatalogEntry[]>;
        })
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
