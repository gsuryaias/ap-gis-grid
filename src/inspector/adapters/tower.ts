// Transmission towers (the old tower popup) and RTGS reference-layer features (the old overlay popup).
import type { Feature } from "geojson";
import type { OverlayDef } from "../../overlays/catalog.ts";
import { towerAttributes, towerRows, type WebTowersFile } from "../../overlays/towers.ts";
import { parseRefFeature, parseTowerRef } from "../refs.ts";
import type { Adapter } from "../types.ts";
import { locateGeometry, oneFeature } from "./util.ts";
import { propertyRows } from "./net.ts";

export interface TowerEntity {
  layer: string;
  index: number;
  label: string;
  line: WebTowersFile["lines"][number];
  props: Record<string, unknown>;
  feature: Feature | undefined;
}

export const towerAdapter: Adapter<TowerEntity> = {
  kind: "tower",
  needs: (ref) => ({ layer: parseTowerRef(ref)?.layer ?? null, overlay: true }),
  resolve: (ref, ctx) => {
    const t = parseTowerRef(ref);
    const fc = t ? ctx.overlay(t.layer) : undefined; // loaded ⇒ decoded
    const a = t && fc ? towerAttributes(t.layer, t.index) : null;
    if (!t || !a) return null;
    return { ...t, label: ctx.overlayDef(t.layer)?.label ?? t.layer, line: a.line, props: a.props, feature: fc!.features[t.index] };
  },
  header: (t) => ({ kicker: `Transmission · ${t.label}`, title: `Tower ${t.props.tower_number ?? "—"}`, icon: "tower" }),
  sections: (t) => [
    {
      id: "overview",
      kind: "fields",
      rows: [{ label: "Line", value: t.line.name, ref: t.line.lineId ?? undefined }, ...towerRows(t.props)],
    },
    {
      id: "provenance",
      kind: "note",
      text:
        "AP-TRANSCO enterprise GIS — tower layers (live). Tower type / CP-SP as recorded; in “DA+3” the letters are the design type " +
        "and +n is usually the body extension in metres (indicative).",
    },
  ],
  locate: (t) => locateGeometry(t.feature?.geometry, 16, 16),
  focus: (t) => {
    const g = t.feature?.geometry;
    return g?.type === "Point" ? { lines: [], ss: [], point: [g.coordinates[0], g.coordinates[1]] } : null;
  },
};

export interface RefEntity {
  def: OverlayDef;
  index: number;
  feature: Feature;
}

export const refAdapter: Adapter<RefEntity> = {
  kind: "ref",
  needs: (ref) => ({ layer: parseRefFeature(ref)?.layer ?? null, overlay: true }),
  resolve: (ref, ctx) => {
    const r = parseRefFeature(ref);
    const def = r ? ctx.overlayDef(r.layer) : undefined;
    const feature = r ? ctx.overlay(r.layer)?.features[r.index] : undefined;
    return r && def && feature ? { def, index: r.index, feature } : null;
  },
  header: ({ def, feature }) => {
    const p = feature.properties ?? {};
    const title = (def.labelField && (p[def.labelField] as string)) || (p.name as string) || def.label;
    return { kicker: `${def.group} · ${def.label}`, title: String(title), icon: def.geometry === "polygon" ? "area" : def.geometry === "line" ? "line" : "point" };
  },
  sections: ({ def, feature }) => [
    { id: "overview", kind: "fields", rows: propertyRows(feature.properties ?? {}, 18) },
    {
      id: "provenance",
      kind: "note",
      text: [def.source, def.vintage ? `vintage ${def.vintage}` : null, def.note].filter(Boolean).join(" · "),
    },
  ],
  locate: ({ feature }) => locateGeometry(feature.geometry, 13, 13),
  geojson: ({ feature }) => oneFeature(feature),
};
