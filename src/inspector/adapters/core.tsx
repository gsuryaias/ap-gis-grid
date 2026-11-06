// TRANSCO substations + lines — the old DetailPanel's SubstationDetail / LineDetail as data.
import { LineTowers } from "../../components/LineTowers.tsx";
import { DiscomDownstream } from "../../components/DiscomDownstream.tsx";
import { graphAnalysis } from "../../data/graph-data.ts";
import { connectedLines, connectedSubstations } from "../../data/selectors.ts";
import { isLine, isSubstation, type GridData, type LineProps, type SubstationProps } from "../../data/types.ts";
import type { WeatherData } from "../../data/weather.ts";
import { formatMva, lineCapacityFor } from "../../lib/capacity.ts";
import { deratedCapacityMva, formatDerating } from "../../lib/dlr.ts";
import { ageYears, formatAge, formatDist, formatKm } from "../../lib/format.ts";
import { haversineMeters } from "../../lib/geo.ts";
import { riskTier, substationRisk } from "../../lib/risk.ts";
import { substationsToGeoJSON, subsetFeatures } from "../../lib/export.ts";
import { CIRCUIT_LABEL } from "../../theme/palette.ts";
import type { Adapter, Section, Tone } from "../types.ts";
import { SpotConditions } from "../widgets.tsx";
import { coast, coords, fields, locateGeometry, pointAt } from "./util.ts";

const TIER_TONE: Record<string, Tone | undefined> = { moderate: "warn", elevated: "warn", high: "bad" };

export const coreSsAdapter: Adapter<SubstationProps> = {
  kind: "core-ss",
  spotlight: true,
  resolve: (ref, { data }) => {
    const f = data.byId.get(ref);
    return f && isSubstation(f) ? f : null;
  },
  header: (ss) => ({ kicker: "Substation", title: ss.name, badge: { voltage: ss.voltage }, icon: "ss" }),
  sections: (ss, { data }) => {
    const ga = graphAnalysis(data);
    const deg = ga.feedDegrees.get(ss.id) ?? 0;
    const singleFed = ga.singleFedIds.has(ss.id);
    // Core SS carry no commissioning date (`doc` is null in this dataset) → unknown age.
    const risk = substationRisk({ coastalBand: ss.coastalBand, ageYears: null, feedDegree: deg, voltage: ss.voltage });
    const tier = riskTier(risk.score);
    const lines = connectedLines(ss, data);
    return [
      {
        id: "overview",
        kind: "fields",
        rows: fields(
          ["Substation code", ss.ssCode],
          ["Full name", ss.descriptiveName],
          ["Zone", ss.zone],
          ["Division", ss.division],
          ["Circle", ss.circle ? `${ss.circle}${ss.circleInferred ? " (inferred)" : ""}` : null],
          ["Commissioned", ss.doc],
          ["Coordinates", coords(ss.lng, ss.lat)],
          ["Coast", coast(ss.coastalKm, ss.coastalBand)],
        ),
      },
      {
        id: "risk",
        kind: "fields",
        rows: fields(
          [
            "Vulnerability (indicative)",
            `${risk.score} · ${tier}`,
            { sub: risk.factors.join(" · "), tone: TIER_TONE[tier], hint: "Screening score from coastal exposure, inferred redundancy, age and voltage — not a hazard model" },
          ],
          [
            "Inferred feed",
            `Fed from ${deg} substation${deg === 1 ? "" : "s"}${singleFed ? " · single-fed" : ""}`,
            { tone: singleFed ? "warn" : undefined, hint: "Distinct neighbouring substations, geometrically inferred — indicative only" },
          ],
          ["Criticality", ga.articulationIds.has(ss.id) ? "Articulation point (inferred)" : null, { hint: "Removing this SS would split the inferred network" }],
        ),
      },
      { id: "weather", kind: "custom", render: () => <SpotConditions lng={ss.lng} lat={ss.lat} /> },
      {
        id: "connectivity",
        kind: "links",
        title: `Connected lines · ${lines.length}`,
        aside: "(spatially inferred)",
        empty: `No lines snapped within ${data.meta.snapThresholdM} m.`,
        items: lines.map(({ line }) => ({
          ref: line.id,
          label: line.name,
          meta: `${line.circuit} · ${formatKm(line.lengthKm)}`,
          voltage: line.voltage,
          icon: "line" as const,
        })),
      },
      {
        id: "downstream",
        kind: "custom",
        title: "33 kV network (DISCOM)",
        aside: "(inferred)",
        render: () => <DiscomDownstream ss={ss} />,
      },
    ];
  },
  locate: (ss) => pointAt(ss.lng, ss.lat),
  geojson: (ss) => substationsToGeoJSON([ss]),
};

/** Indicative DLR: derate the nominal capacity for the live ambient temperature at the nearest circle centroid. */
export function lineDlr(line: LineProps, data: GridData, weather: WeatherData | undefined) {
  const cap = lineCapacityFor(line);
  if (!cap || !weather || weather.circles.length === 0) return null;
  const g = data.linesFc.features.find((f) => f.properties?.id === line.id)?.geometry;
  const anchor = g?.type === "LineString" ? g.coordinates[0] : g?.type === "MultiLineString" ? g.coordinates[0]?.[0] : undefined;
  if (!anchor) return null;
  let nearest = weather.circles[0];
  let bestM = Infinity;
  for (const cw of weather.circles) {
    const m = haversineMeters(anchor, [cw.lng, cw.lat]);
    if (m < bestM) {
      bestM = m;
      nearest = cw;
    }
  }
  const derated = deratedCapacityMva(cap.totalMva, nearest.current.tempC);
  return derated ? { ...derated, tempC: nearest.current.tempC } : null;
}

export const coreLineAdapter: Adapter<LineProps> = {
  kind: "core-line",
  spotlight: true,
  resolve: (ref, { data }) => {
    const f = data.byId.get(ref);
    return f && isLine(f) ? f : null;
  },
  header: (line) => ({ kicker: `${line.circuit} line`, title: line.name, badge: { voltage: line.voltage }, icon: "line" }),
  sections: (line, { data, weather, year }) => {
    const capacity = lineCapacityFor(line);
    const dlr = lineDlr(line, data, weather);
    const age = ageYears(line.commissioned, year);
    const [from, to] = line.endpointLabels ?? [null, null];
    const circuits = line.circuits ?? (line.circuit === "DC" ? 2 : 1);
    const islanded = graphAnalysis(data).bridgeImpacts.get(line.id) ?? [];
    const islandedNames = islanded.slice(0, 5).map((id) => data.byId.get(id)?.name ?? id);
    const subs = connectedSubstations(line, data);
    const out: Section[] = [
      {
        id: "overview",
        kind: "fields",
        rows: fields(
          ["Voltage", `${line.voltage} kV`],
          ["Circuit", CIRCUIT_LABEL[line.circuit]],
          ["Route length", formatKm(line.lengthKm)],
          [
            "Circuit-km",
            line.ckm != null
              ? `${formatKm(line.ckm)}${circuits > 1 ? " (2 circuits)" : line.circuit === "DC" ? " (one circuit of a DC tower line)" : ""}`
              : null,
          ],
          ["Conductor", line.conductor],
          [
            "Indicative capacity",
            capacity ? `${formatMva(capacity.totalMva)} (${line.circuit === "DC" ? `${formatMva(capacity.perCircuitMva)}/ckt` : "thermal"})` : null,
            {
              hint: "Derived from conductor type at nominal conditions — not authoritative",
              sub: dlr ? `Now ${formatMva(dlr.mva)} (${formatDerating(dlr.factor)} at ${Math.round(dlr.tempC)} °C) · indicative` : undefined,
            },
          ],
          ["Commissioned", line.commissioned ? `${line.commissioned}${age != null ? ` · ${formatAge(age)}` : ""}` : null],
          ["Circle", line.circle],
          ["Coast", coast(line.coastalKm, line.coastalBand)],
          ["Route (from name)", from || to ? `${from ?? "?"} → ${to ?? "?"}` : null],
          ["External endpoints", line.externalEndpoints?.length ? line.externalEndpoints.map((e) => `${e.name} (${e.category})`).join(", ") : null],
        ),
      },
      { id: "towers", kind: "custom", render: () => <LineTowers line={line} /> },
    ];
    if (islanded.length) {
      out.push({
        id: "supply",
        kind: "callout",
        tone: "warn",
        text: `Inferred N−1: outage would island ${islanded.length} substation${islanded.length === 1 ? "" : "s"} — ${islandedNames.join(", ")}${islanded.length > islandedNames.length ? ", …" : ""}.`,
      });
    }
    out.push({
      id: "connectivity",
      kind: "links",
      title: `Connected substations · ${subs.length}`,
      aside: "(spatially inferred)",
      empty: `Endpoints are external (no substation within ${data.meta.snapThresholdM} m).`,
      items: subs.map((ss) => ({
        ref: ss.id,
        label: ss.name,
        meta: formatDist((line.fromSS?.ssId === ss.id ? line.fromSS : line.toSS)?.distM ?? null),
        voltage: ss.voltage,
        icon: "ss" as const,
      })),
    });
    if (capacity) {
      out.push({
        id: "provenance",
        kind: "note",
        text:
          `Indicative thermal capacity derived from the ${capacity.rating.base} conductor at nominal conditions (√3·kV·A).` +
          (dlr ? " “Now” derates only for the nearest circle’s live ambient temperature (no wind, solar or sag)." : "") +
          " Not a load-flow or authoritative rating.",
      });
    }
    return out;
  },
  locate: (line, { data }) => locateGeometry(data.linesFc.features.find((f) => f.properties?.id === line.id)?.geometry, 12, 13),
  geojson: (line, { data }) => subsetFeatures(data.linesFc, new Set([line.id])),
};
