// Storm situation (Atlas 2.0 phase 5, PR 15). This pure, dependency-free code turns live cyclone
// geometry plus the static grid analytics into the control room's situation picture:
//
//   1. the WARNING ENVELOPE: substations inside a forecast cone / alert swath, PLUS substations
//      near the coast (coastal band ≤ 1, i.e. < 25 km from the sea) within `trackKm` of the forecast
//      track. This follows the NHC lesson that people just outside the cone think they're safe, and
//      that landfall impacts hit the coast well beyond the cone edge.
//   2. SUPPLY EXPOSURE: substations that are not in the envelope themselves but whose radial feed
//      crosses an exposed line or substation (supply-security bridge path), or that are islanded
//      when an exposed cut-point substation is lost. These are grouped into exposed radial pockets
//      and exposed cut points.
//   3. DOWNSTREAM: the 33 kV feeders and 33/11 kV substations behind every at-risk TRANSCO SS,
//      taken from the inferred TRANSCO → 33 kV index.
//   4. a 13-CIRCLE STATUS BOARD. Grey means "no information", FEMA-style: a circle is never
//      reported "clear" unless both the cyclone feed and its forecast answered.
//
// Everything is INDICATIVE: GDACS envelopes are model output, connectivity is inferred, and the
// thresholds are screening rules, not IMD warnings.
import { exposedLines, warningEnvelope, type EnvelopeHit, type EnvelopeLine, type EnvelopeOpts, type EnvelopeSs, type StormSystem } from "./storm-envelope.ts";
import { isGenNode, type SupplySecurity } from "./supply-security.ts";

export * from "./storm-envelope.ts";

/** IMD "gale" lower bound (34 kt), used on Open-Meteo's daily max gust. */
export const GALE_KMH = 62;
/** IMD "very heavy rainfall" lower bound, per day. */
export const VERY_HEAVY_RAIN_MM = 115.6;

// ---- 2 + 3. supply exposure and downstream ------------------------------------------------------

export type AtRiskVia = "envelope" | "feed" | "cut";

/** [feederId, name, discom, km, method, servedSsIds], as in `transco-33kv.json`. */
export type StormFeeder = [string, string | null, string, number, string, string[]];

export interface ExposedPocket {
  key: string;
  headId: string;
  ssIds: string[];
  /** Pocket SS that are at risk (in the envelope or behind an exposed element). */
  atRiskIds: string[];
  entryCircuits: number;
  generation: string[];
  /** Distinct 33/11 kV SS fed from the at-risk pocket SS. */
  discomSs: number;
}

export interface ExposedCut {
  id: string;
  islanded: string[];
  /** Distinct 33/11 kV SS fed from the islanded SS. */
  discomSs: number;
}

export interface DownstreamRow {
  transcoId: string;
  via: AtRiskVia;
  feeder: StormFeeder;
}

export interface StormSituation {
  envelope: EnvelopeHit[];
  envelopeIds: Set<string>;
  lineIds: Set<string>;
  /** Every at-risk TRANSCO SS → why: in the envelope, radial feed crosses exposure, or islanded by an exposed cut point. */
  atRisk: Map<string, AtRiskVia>;
  pockets: ExposedPocket[];
  cuts: ExposedCut[];
  downstream: {
    rows: DownstreamRow[];
    feeders: number;
    discomSs: number;
    /** DISCOM → feeders / distinct 33/11 kV SS. */
    byDiscom: Array<{ discom: string; feeders: number; discomSs: number }>;
  };
}

export interface SituationInput {
  substations: readonly EnvelopeSs[];
  lines: readonly EnvelopeLine[];
  sec: Pick<SupplySecurity, "bySs" | "corridors" | "pockets" | "cutImpacts">;
  /** TRANSCO SS id → its 33 kV feeders; null while the index hasn't loaded. */
  feeders: Record<string, StormFeeder[]> | null;
  systems: readonly StormSystem[];
  opts?: EnvelopeOpts;
}

export function stormSituation(inp: SituationInput): StormSituation {
  const envelope = warningEnvelope(inp.substations, inp.systems, inp.opts);
  const envelopeIds = new Set(envelope.map((h) => h.id));
  const lineIds = exposedLines(inp.lines, inp.systems, inp.opts);
  const { sec } = inp;

  const atRisk = new Map<string, AtRiskVia>();
  for (const id of envelopeIds) atRisk.set(id, "envelope");

  // A radial feed crosses exposure when any bridge corridor on its path carries an exposed line, or
  // has an exposed substation at either end (other than the SS itself).
  for (const [id, sup] of sec.bySs) {
    // Generation switchyards are corridor-graph nodes, not TRANSCO substations.
    if (atRisk.has(id) || sup.path.length === 0 || isGenNode(id)) continue;
    const crosses = sup.path.some((key) => {
      const c = sec.corridors.get(key);
      if (!c) return false;
      return c.lineIds.some((l) => lineIds.has(l)) || [c.a, c.b].some((n) => n !== id && envelopeIds.has(n));
    });
    if (crosses) atRisk.set(id, "feed");
  }

  const discomOf = (ids: Iterable<string>) => {
    const set = new Set<string>();
    for (const id of ids) for (const f of inp.feeders?.[id] ?? []) for (const d of f[5]) set.add(d);
    return set.size;
  };

  const cuts: ExposedCut[] = [];
  for (const id of envelopeIds) {
    const islanded = sec.cutImpacts.get(id);
    if (!islanded?.length) continue;
    for (const n of islanded) if (!atRisk.has(n)) atRisk.set(n, "cut");
    cuts.push({ id, islanded, discomSs: discomOf(islanded) });
  }
  cuts.sort((a, b) => b.islanded.length - a.islanded.length || a.id.localeCompare(b.id));

  const pockets: ExposedPocket[] = [];
  for (const p of sec.pockets) {
    const atRiskIds = p.ssIds.filter((id) => atRisk.has(id));
    if (!atRiskIds.length) continue;
    pockets.push({
      key: p.key,
      headId: p.headId,
      ssIds: p.ssIds,
      atRiskIds,
      entryCircuits: p.entryCircuits,
      generation: p.generation,
      discomSs: discomOf(atRiskIds),
    });
  }
  pockets.sort((a, b) => b.discomSs - a.discomSs || b.atRiskIds.length - a.atRiskIds.length || a.key.localeCompare(b.key));

  const rows: DownstreamRow[] = [];
  const allDiscomSs = new Set<string>();
  const byDiscom = new Map<string, { feeders: number; ss: Set<string> }>();
  for (const [id, via] of atRisk) {
    for (const f of inp.feeders?.[id] ?? []) {
      rows.push({ transcoId: id, via, feeder: f });
      const d = byDiscom.get(f[2]) ?? { feeders: 0, ss: new Set<string>() };
      d.feeders++;
      for (const s of f[5]) {
        d.ss.add(s);
        allDiscomSs.add(s);
      }
      byDiscom.set(f[2], d);
    }
  }
  rows.sort((a, b) => a.transcoId.localeCompare(b.transcoId) || a.feeder[0].localeCompare(b.feeder[0]));

  return {
    envelope,
    envelopeIds,
    lineIds,
    atRisk,
    pockets,
    cuts,
    downstream: {
      rows,
      feeders: rows.length,
      discomSs: allDiscomSs.size,
      byDiscom: [...byDiscom.entries()]
        .map(([discom, d]) => ({ discom, feeders: d.feeders, discomSs: d.ss.size }))
        .sort((a, b) => b.discomSs - a.discomSs || a.discom.localeCompare(b.discom)),
    },
  };
}

// ---- 4. circle status board ------------------------------------------------------------------

export type CircleStatus = "warning" | "watch" | "clear" | "noinfo";
export const STATUS_ORDER: CircleStatus[] = ["warning", "watch", "noinfo", "clear"];
export const STATUS_LABEL: Record<CircleStatus, string> = {
  warning: "Warning",
  watch: "Watch",
  clear: "Clear",
  noinfo: "No information",
};

export interface CircleForecast {
  circle: string;
  /** Max daily gust over the outlook (km/h). */
  gustMaxKmh: number;
  /** Wettest day of the outlook (mm). */
  rainMaxMm: number;
}

export interface CircleBoardRow {
  circle: string;
  status: CircleStatus;
  /** Why (short phrases), in severity order. */
  reasons: string[];
  envelope: number;
  atRisk: number;
  forecast: CircleForecast | null;
}

/**
 * One row per circle. Warning: an SS in the envelope. Watch: supply at risk from elsewhere, a gale
 * gust, or very heavy rain in the outlook. Clear: needs BOTH an answer from the cyclone feed and the
 * circle's forecast, otherwise the row is "No information".
 */
export function circleBoard(
  circles: readonly string[],
  ssCircle: (id: string) => string | null | undefined,
  sit: Pick<StormSituation, "envelopeIds" | "atRisk">,
  forecasts: readonly CircleForecast[],
  cycloneFeedOk: boolean,
): CircleBoardRow[] {
  const fc = new Map(forecasts.map((f) => [f.circle, f]));
  const env = new Map<string, number>();
  const risk = new Map<string, number>();
  for (const [id, via] of sit.atRisk) {
    const c = ssCircle(id);
    if (!c) continue;
    if (via === "envelope") env.set(c, (env.get(c) ?? 0) + 1);
    else risk.set(c, (risk.get(c) ?? 0) + 1);
  }
  return circles
    .map((circle): CircleBoardRow => {
      const f = fc.get(circle) ?? null;
      const e = env.get(circle) ?? 0;
      const r = risk.get(circle) ?? 0;
      const reasons: string[] = [];
      if (e) reasons.push(`${e} SS in the warning envelope`);
      if (r) reasons.push(`${r} SS fed through exposure`);
      if (f && f.gustMaxKmh >= GALE_KMH) reasons.push(`gusts to ${Math.round(f.gustMaxKmh)} km/h`);
      if (f && f.rainMaxMm >= VERY_HEAVY_RAIN_MM) reasons.push(`${Math.round(f.rainMaxMm)} mm/day rain`);
      let status: CircleStatus;
      if (e) status = "warning";
      else if (reasons.length) status = "watch";
      else if (f && cycloneFeedOk) status = "clear";
      else {
        status = "noinfo";
        if (!cycloneFeedOk) reasons.push("cyclone feed unavailable");
        if (!f) reasons.push("no forecast");
      }
      return { circle, status, reasons, envelope: e, atRisk: r, forecast: f };
    })
    .sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
        b.envelope - a.envelope ||
        b.atRisk - a.atRisk ||
        a.circle.localeCompare(b.circle),
    );
}

/** The headline status = the worst circle (no circles → no information). */
export function overallStatus(rows: readonly CircleBoardRow[]): CircleStatus {
  if (!rows.length) return "noinfo";
  return STATUS_ORDER.find((s) => rows.some((r) => r.status === s)) ?? "noinfo";
}
