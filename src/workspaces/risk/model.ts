// Risk Room model assembly — composes the pure risk engine (lib/risk-engine.ts) with the
// vulnerability index (lib/risk.ts), the inferred connectivity graph (data/graph-data.ts) and
// live GDACS cyclone cones into one per-substation register, then layers SCENARIOS on top.
// Everything here is INDICATIVE SCREENING ONLY: the wind zones are an approximate digitisation
// of IS 875 (Part 3), connectivity is inferred from geometric snapping, and the scenario
// presets are screening assumptions — not meteorological or load-flow results.
import type { FeatureCollection } from "geojson";
import { graphAnalysis } from "../../data/graph-data.ts";
import type { GridData, SubstationProps } from "../../data/types.ts";
import type { WeatherData } from "../../data/weather.ts";
import { toCsv } from "../../lib/export.ts";
import {
  compositeRisk,
  criticalityScore,
  hazardScore,
  windZoneAt,
  type WindVb,
} from "../../lib/risk-engine.ts";
import { riskTier, substationRisk, type CoastalBand, type RiskTier } from "../../lib/risk.ts";
import { assetsInCone } from "../../lib/weather.ts";

// ---------------------------------------------------------------------------
// Wind zones (indicative IS 875 digitisation) — fetched once, cached for the session
// ---------------------------------------------------------------------------

let windZonesPromise: Promise<FeatureCollection> | null = null;

/** Fetch public/data/wind-zones.geojson (same BASE_URL contract as data/load.ts). Cached; a failed fetch resets so the next call retries. */
export function loadWindZones(): Promise<FeatureCollection> {
  if (!windZonesPromise) {
    windZonesPromise = fetch(`${import.meta.env.BASE_URL}data/wind-zones.geojson`).then((res) => {
      if (!res.ok) throw new Error(`Failed to load wind-zones.geojson: ${res.status} ${res.statusText}`);
      return res.json() as Promise<FeatureCollection>;
    });
    windZonesPromise.catch(() => {
      windZonesPromise = null;
    });
  }
  return windZonesPromise;
}

/** Display label for a wind-zone class. */
export function windLabel(vb: WindVb | null): string {
  return vb == null ? "—" : `${vb} m/s`;
}

// ---------------------------------------------------------------------------
// Base rows — the scenario-independent part of the model (memoised per inputs)
// ---------------------------------------------------------------------------

export interface BaseRow {
  ss: SubstationProps;
  /** IS 875 basic wind speed at the asset (indicative digitised zones), null outside every zone. */
  windVb: WindVb | null;
  coastalBand: CoastalBand | undefined;
  /** Inferred feed degree (distinct neighbouring SS) from the connectivity graph. */
  feedDegree: number;
  /** Inside an ACTUAL live GDACS forecast cone / alert swath (false when weather isn't loaded). */
  liveInCone: boolean;
  /** Vulnerability axis (substationRisk; age unknown — core SS carry no commissioning date). */
  vulnerability: number;
  vulnFactors: string[];
  /** Criticality axis (criticalityScore). */
  criticality: number;
  critFactors: string[];
}

/** Pure assembly of the scenario-independent register (exported for tests; use riskBaseRows in the UI). */
export function buildBaseRows(
  data: GridData,
  weather: WeatherData | null,
  zones: FeatureCollection,
): BaseRow[] {
  const ga = graphAnalysis(data);
  const cones = (weather?.cyclones ?? []).flatMap((c) => c.conePolygons);
  const liveIds = new Set(assetsInCone(data.substations, cones).map((s) => s.id));
  return data.substations.map((ss) => {
    const feedDegree = ga.feedDegrees.get(ss.id) ?? 0;
    const vuln = substationRisk({
      coastalBand: ss.coastalBand,
      ageYears: null, // core SS carry no commissioning date in this dataset
      feedDegree,
      voltage: ss.voltage,
    });
    const crit = criticalityScore({
      feedDegree,
      voltage: ss.voltage,
      connectedLineCount: ss.connectedLineCount,
    });
    return {
      ss,
      windVb: windZoneAt(ss.lng, ss.lat, zones),
      coastalBand: ss.coastalBand,
      feedDegree,
      liveInCone: liveIds.has(ss.id),
      vulnerability: vuln.score,
      vulnFactors: vuln.factors,
      criticality: crit.score,
      critFactors: crit.factors,
    };
  });
}

// Single-slot memo keyed on input identity — the (data, weather, zones) triple only changes on
// load / weather refresh, so one slot is enough (same spirit as the WeakMap memo in graph-data).
let memo: {
  data: GridData;
  weather: WeatherData | null;
  zones: FeatureCollection;
  rows: BaseRow[];
} | null = null;

/** Memoised buildBaseRows: recomputed only when the (data, weather, zones) identities change. */
export function riskBaseRows(
  data: GridData,
  weather: WeatherData | null,
  zones: FeatureCollection,
): BaseRow[] {
  if (memo && memo.data === data && memo.weather === weather && memo.zones === zones) return memo.rows;
  const rows = buildBaseRows(data, weather, zones);
  memo = { data, weather, zones, rows };
  return rows;
}

// ---------------------------------------------------------------------------
// Scenarios — screening assumptions that scale the hazard axis
// ---------------------------------------------------------------------------

export type ScenarioId = "normal" | "watch" | "severe" | "active";

export interface ScenarioDef {
  id: ScenarioId;
  label: string;
  /** The documented screening assumption, shown verbatim in the UI and the briefing. */
  assumption: string;
  /**
   * Cyclone presets force `inCycloneCone` for substations whose coastal band is ≤ this value
   * (null = no forcing: "normal" assumes no cone at all, "active" uses the live GDACS cone).
   */
  forceConeBandMax: CoastalBand | null;
  /** Storm-wide multiplier applied to every hazard score, clamped at 100. */
  hazardFactor: number;
}

export const SCENARIOS: ScenarioDef[] = [
  {
    id: "normal",
    label: "Normal",
    assumption:
      "Baseline exposure: wind zone + coastal proximity only. No cyclone is assumed, even if a live event exists.",
    forceConeBandMax: null,
    hazardFactor: 1,
  },
  {
    id: "watch",
    label: "Cyclone watch (Cat 1–2)",
    assumption:
      "Screening assumption — NOT a forecast: substations within 25 km of the coast (bands 0–1) are treated as in-cone, and every hazard score is scaled ×1.15 (clamped at 100) for the storm-wide wind field.",
    forceConeBandMax: 1,
    hazardFactor: 1.15,
  },
  {
    id: "severe",
    label: "Severe cyclone (Cat 3+)",
    assumption:
      "Screening assumption — NOT a forecast: substations within 50 km of the coast (bands 0–2) are treated as in-cone, and every hazard score is scaled ×1.3 (clamped at 100) for the storm-wide wind field.",
    forceConeBandMax: 2,
    hazardFactor: 1.3,
  },
  {
    id: "active",
    label: "Active event",
    assumption:
      "Live GDACS forecast envelope of the current system — assets inside the actual cone / alert swaths score the in-cone hazard term. No synthetic scaling. Indicative model output, not an IMD advisory.",
    forceConeBandMax: null,
    hazardFactor: 1,
  },
];

export interface RiskRow extends BaseRow {
  /** In-cone under the ACTIVE SCENARIO (forced by presets; live cone for "active"). */
  inCone: boolean;
  hazard: number;
  hazardFactors: string[];
  composite: number;
  tier: RiskTier;
}

/**
 * Apply a scenario to the base register: resolve the in-cone flag per the scenario's rule,
 * compute the hazard axis (× the documented storm-wide factor, clamped at 100) and blend the
 * composite. Returns a NEW array sorted by composite, descending (name tie-break).
 */
export function applyScenario(rows: BaseRow[], scenario: ScenarioDef): RiskRow[] {
  return rows
    .map((r): RiskRow => {
      const inCone =
        scenario.id === "active"
          ? r.liveInCone
          : scenario.forceConeBandMax != null
            ? r.coastalBand != null && r.coastalBand <= scenario.forceConeBandMax
            : false;
      const h = hazardScore({ windVb: r.windVb, coastalBand: r.coastalBand, inCycloneCone: inCone });
      const hazard = Math.min(100, Math.round(h.score * scenario.hazardFactor));
      const composite = compositeRisk({
        hazard,
        vulnerability: r.vulnerability,
        criticality: r.criticality,
      });
      return { ...r, inCone, hazard, hazardFactors: h.factors, composite, tier: riskTier(composite) };
    })
    .sort((a, b) => b.composite - a.composite || a.ss.name.localeCompare(b.ss.name));
}

// ---------------------------------------------------------------------------
// Briefing-pack CSV (full register under the active scenario)
// ---------------------------------------------------------------------------

export const REGISTER_CSV_HEADERS = [
  "name", "voltage_kv", "circle", "coastal_km", "wind_vb_ms", "feed_degree",
  "hazard", "vulnerability", "criticality", "composite", "tier",
];

export function registerToCsv(rows: readonly RiskRow[]): string {
  return toCsv(
    REGISTER_CSV_HEADERS,
    rows.map((r) => [
      r.ss.name, r.ss.voltage, r.ss.circle ?? "", r.ss.coastalKm ?? "", r.windVb ?? "",
      r.feedDegree, r.hazard, r.vulnerability, r.criticality, r.composite, r.tier,
    ]),
  );
}
