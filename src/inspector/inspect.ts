// Adapter registry + the pure "ref → Inspected" step.
import { coreLineAdapter, coreSsAdapter } from "./adapters/core.tsx";
import { bulkSsAdapter, pgLineAdapter, pgSsAdapter, plantAdapter, railSsAdapter } from "./adapters/grid-overlays.ts";
import { netAdapter } from "./adapters/net.ts";
import { refAdapter, towerAdapter } from "./adapters/tower.ts";
import { refKind, type RefKind } from "./refs.ts";
import type { Adapter, Inspected, InspectorCtx, Needs, Section } from "./types.ts";

/** Each adapter is typed on its own entity; the registry is heterogeneous. */
export const ADAPTERS: Record<RefKind, Adapter<any>> = {
  "core-ss": coreSsAdapter,
  "core-line": coreLineAdapter,
  plant: plantAdapter,
  "pg-line": pgLineAdapter,
  "pg-ss": pgSsAdapter,
  "rail-ss": railSsAdapter,
  "bulk-ss": bulkSsAdapter,
  net: netAdapter,
  tower: towerAdapter,
  ref: refAdapter,
};

export function adapterFor(ref: string | null): Adapter<unknown> | null {
  const k = ref ? refKind(ref) : null;
  return k ? ADAPTERS[k] : null;
}

export const needsOf = (ref: string | null): Needs => (ref ? (adapterFor(ref)?.needs?.(ref) ?? {}) : {});

/** Resolve a ref against loaded data; null while (or if) it can't be. */
export function inspect(ref: string, ctx: InspectorCtx): Inspected | null {
  const kind = refKind(ref);
  const a = kind ? ADAPTERS[kind] : null;
  if (!kind || !a) return null;
  const entity = a.resolve(ref, ctx);
  if (entity == null) return null;
  return {
    ref,
    kind,
    entity,
    header: a.header(entity, ctx),
    sections: a.sections(entity, ctx).filter((s) => s.kind !== "fields" || s.rows.length > 0),
    locate: a.locate?.(entity, ctx) ?? null,
    focus: a.focus?.(entity, ctx) ?? null,
    geojson: a.geojson ? () => a.geojson!(entity, ctx) : null,
    spotlight: !!a.spotlight,
  };
}

/** Workspace sections over the base ones: same id replaces in place; new ids go right after the overview. */
export function mergeSections(base: Section[], extra: Section[]): Section[] {
  if (!extra.length) return base;
  const byId = new Map(extra.map((s) => [s.id, s]));
  const out = base.map((s) => byId.get(s.id) ?? s);
  const fresh = extra.filter((s) => !base.some((b) => b.id === s.id));
  const at = out.findIndex((s) => s.id === "overview") + 1;
  out.splice(at, 0, ...fresh);
  return out;
}
