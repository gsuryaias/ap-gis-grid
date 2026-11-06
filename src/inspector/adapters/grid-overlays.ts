// Generation plants + the power-grid group (POWERGRID lines / SS, railway traction, bulk-load HT).
import type {
  BulkLoadSubstationProps,
  GenerationProps,
  PowerGridLineProps,
  PowerGridSubstationProps,
  RailwaySubstationProps,
} from "../../data/types.ts";
import { formatKm } from "../../lib/format.ts";
import { BULKLOAD_COLOR, ENERGY_COLOR, ENERGY_LABEL, POWERGRID_COLOR, RAILWAY_COLOR } from "../../theme/palette.ts";
import type { Adapter, Badge } from "../types.ts";
import { coords, fields, locateGeometry, oneFeature, pointAt } from "./util.ts";

const kvBadge = (voltage: number, color: string): Badge => ({ text: voltage > 0 ? `${voltage} kV` : "—", color });
const kvOrNull = (v: number) => (v > 0 ? `${v} kV` : null);

export const plantAdapter: Adapter<GenerationProps> = {
  kind: "plant",
  needs: () => ({ gen: true }),
  resolve: (ref, { gen }) => gen?.byId.get(ref) ?? null,
  header: (p) => ({ kicker: `${ENERGY_LABEL[p.energy]} plant`, title: p.name, badge: { text: ENERGY_LABEL[p.energy], color: ENERGY_COLOR[p.energy] }, icon: "plant" }),
  sections: (p) => [
    {
      id: "overview",
      kind: "fields",
      rows: fields(
        ["Energy source", ENERGY_LABEL[p.energy]],
        ["Interconnection", `${p.voltage} kV`],
        ["Capacity", p.capacityMw != null ? `${p.capacityMw} MW` : null],
        ["Units", p.units ?? null],
        ["Full name", p.descriptiveName],
        ["Plant ID", p.ssCode],
        ["Circle", p.circle],
        ["Commissioned", p.doc],
        ["Coordinates", coords(p.lng, p.lat)],
      ),
    },
    { id: "provenance", kind: "note", text: "Generation plant overlay — connectivity to the transmission grid is not modelled." },
  ],
  locate: (p) => pointAt(p.lng, p.lat),
  geojson: (p, { gen }) => oneFeature(gen?.fc.features.find((f) => f.properties?.id === p.id)),
};

const PG_NOTE = "POWERGRID (PGCIL) national grid overlay — connectivity to the AP-TRANSCO grid is not modelled.";

export const pgLineAdapter: Adapter<PowerGridLineProps> = {
  kind: "pg-line",
  needs: () => ({ pg: true }),
  resolve: (ref, { pg }) => {
    const f = pg?.byId.get(ref);
    return f?.kind === "pg-line" ? f : null;
  },
  header: (l) => ({ kicker: "POWERGRID line", title: l.name, badge: kvBadge(l.voltage, POWERGRID_COLOR), icon: "line" }),
  sections: (l) => [
    {
      id: "overview",
      kind: "fields",
      rows: fields(["Voltage", kvOrNull(l.voltage)], ["Service status", l.service], ["Route length", formatKm(l.lengthKm)], ["Line", l.name]),
    },
    { id: "provenance", kind: "note", text: PG_NOTE },
  ],
  locate: (l, { pg }) => locateGeometry(pg?.linesFc.features.find((f) => f.properties?.id === l.id)?.geometry, 11.5, 12),
  geojson: (l, { pg }) => oneFeature(pg?.linesFc.features.find((f) => f.properties?.id === l.id)),
};

export const pgSsAdapter: Adapter<PowerGridSubstationProps> = {
  kind: "pg-ss",
  needs: () => ({ pg: true }),
  resolve: (ref, { pg }) => {
    const f = pg?.byId.get(ref);
    return f?.kind === "pg-substation" ? f : null;
  },
  header: (s) => ({ kicker: "POWERGRID substation", title: s.name, badge: kvBadge(s.voltage, POWERGRID_COLOR), icon: "ss" }),
  sections: (s) => [
    { id: "overview", kind: "fields", rows: fields(["Full name", s.fullName], ["Voltage", kvOrNull(s.voltage)], ["Coordinates", coords(s.lng, s.lat)]) },
    { id: "provenance", kind: "note", text: PG_NOTE },
  ],
  locate: (s) => pointAt(s.lng, s.lat),
  geojson: (s, { pg }) => oneFeature(pg?.substationsFc.features.find((f) => f.properties?.id === s.id)),
};

export const railSsAdapter: Adapter<RailwaySubstationProps> = {
  kind: "rail-ss",
  needs: () => ({ pg: true }),
  resolve: (ref, { pg }) => {
    const f = pg?.byId.get(ref);
    return f?.kind === "rail-substation" ? f : null;
  },
  header: (s) => ({ kicker: "Railway traction SS", title: s.name, badge: kvBadge(s.voltage, RAILWAY_COLOR), icon: "ss" }),
  sections: (s) => [
    {
      id: "overview",
      kind: "fields",
      rows: fields(
        ["Name", s.displayName ?? s.name],
        ["Voltage", kvOrNull(s.voltage)],
        ["Connected SS", s.connectedSs],
        ["Capacity", s.mva != null ? `${s.mva} MVA` : null],
        ["Circle", s.circle],
        ["District", s.district],
        ["Coordinates", coords(s.lng, s.lat)],
      ),
    },
    { id: "provenance", kind: "note", text: "Railway traction substation — connection to the AP-TRANSCO grid is indicative." },
  ],
  locate: (s) => pointAt(s.lng, s.lat),
  geojson: (s, { pg }) => oneFeature(pg?.railwayFc.features.find((f) => f.properties?.id === s.id)),
};

export const bulkSsAdapter: Adapter<BulkLoadSubstationProps> = {
  kind: "bulk-ss",
  needs: () => ({ pg: true }),
  resolve: (ref, { pg }) => {
    const f = pg?.byId.get(ref);
    return f?.kind === "bulk-substation" ? f : null;
  },
  header: (s) => ({ kicker: "Bulk-load / HT SS", title: s.name, badge: kvBadge(s.voltage, BULKLOAD_COLOR), icon: "ss" }),
  sections: (s) => [
    {
      id: "overview",
      kind: "fields",
      rows: fields(
        ["Voltage", kvOrNull(s.voltage)],
        ["Consumer type", s.ssType],
        ["Connected SS", s.connectedSs],
        ["Capacity", s.mva != null ? `${s.mva} MVA` : null],
        ["Circle", s.circle],
        ["District", s.district],
        ["Coordinates", coords(s.lng, s.lat)],
      ),
    },
    { id: "provenance", kind: "note", text: "Bulk HT consumer — connection to the AP-TRANSCO grid is indicative." },
  ],
  locate: (s) => pointAt(s.lng, s.lat),
  geojson: (s, { pg }) => oneFeature(pg?.bulkloadFc.features.find((f) => f.properties?.id === s.id)),
};
