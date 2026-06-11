import { useEffect, useMemo, useState } from "react";
import { graphAnalysis } from "../data/graph-data.ts";
import { connectedLines, connectedSubstations } from "../data/selectors.ts";
import { loadSpotWeather, type SpotWeather } from "../data/weather.ts";
import { compass8, haversineMeters } from "../lib/geo.ts";
import { wmoLabel } from "../lib/weather.ts";
import {
  isBulkLoadSubstation,
  isGeneration,
  isLine,
  isPowerGridLine,
  isPowerGridSubstation,
  isRailwaySubstation,
  isSubstation,
  type BulkLoadSubstationProps,
  type GenerationProps,
  type GridData,
  type LineProps,
  type PowerGridLineProps,
  type PowerGridSubstationProps,
  type RailwaySubstationProps,
  type SubstationProps,
} from "../data/types.ts";
import { ageYears, formatAge, formatDist, formatKm } from "../lib/format.ts";
import { formatMva, lineCapacityFor } from "../lib/capacity.ts";
import { deratedCapacityMva, formatDerating } from "../lib/dlr.ts";
import { COASTAL_BAND_LABEL, riskTier, substationRisk } from "../lib/risk.ts";
import { downloadText, subsetFeatures, substationsToGeoJSON } from "../lib/export.ts";
import { useAppStore } from "../state/store.ts";
import {
  BULKLOAD_COLOR,
  CIRCUIT_LABEL,
  ENERGY_COLOR,
  ENERGY_LABEL,
  POWERGRID_COLOR,
  RAILWAY_COLOR,
} from "../theme/palette.ts";
import {
  BoltIcon,
  CloseIcon,
  DownloadIcon,
  LineIcon,
  SpotlightIcon,
  SubstationIcon,
  TargetIcon,
  TowerIcon,
  WarnIcon,
} from "./icons.tsx";
import { VoltageBadge, VoltageDot } from "./VoltageBadge.tsx";

/**
 * Coloured pill for Power-grid-group features — their voltages fall outside the AP-TRANSCO
 * Voltage union (765 kV PowerGrid, or 0 when a load's source voltage is unparseable).
 */
function OverlayBadge({ voltage, color }: { voltage: number; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white"
      style={{ backgroundColor: color }}
    >
      {voltage > 0 ? `${voltage} kV` : "—"}
    </span>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="shrink-0 text-ink-2">{label}</span>
      <span className="text-right font-medium text-ink">{value}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-2">{children}</div>;
}

function ConnectionRow({
  name,
  voltage,
  meta,
  onClick,
  icon,
}: {
  name: string;
  voltage: 400 | 220 | 132;
  meta?: string;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2"
    >
      <VoltageDot voltage={voltage} />
      <span className="shrink-0 text-ink-2">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-ink">{name}</span>
      {meta && <span className="shrink-0 text-xs text-ink-2">{meta}</span>}
    </button>
  );
}

/**
 * Live spot conditions for a selected substation — rendered only while the weather overlay is
 * enabled (keeps the panel network-silent otherwise). Cached per ~1 km cell in data/weather.ts.
 */
function SpotConditions({ lng, lat }: { lng: number; lat: number }) {
  const showWeather = useAppStore((s) => s.filters.showWeather);
  const [spot, setSpot] = useState<SpotWeather | null>(null);
  useEffect(() => {
    if (!showWeather) return;
    let stale = false;
    setSpot(null);
    loadSpotWeather(lng, lat).then((w) => {
      if (!stale) setSpot(w);
    }).catch(() => {});
    return () => {
      stale = true;
    };
  }, [showWeather, lng, lat]);
  if (!showWeather || !spot) return null;
  return (
    <Field
      label="Weather now"
      value={
        <span title="Live Open-Meteo conditions at this location — indicative">
          {Math.round(spot.tempC)}°C · {wmoLabel(spot.code)} · wind {Math.round(spot.windKmh)} km/h{" "}
          {compass8(spot.windDirDeg)}
        </span>
      }
    />
  );
}

// Tier accent for the vulnerability read-out — reuses the existing amber/red token styles.
const TIER_CLASS: Record<string, string | undefined> = {
  low: undefined,
  moderate: "text-amber-600 dark:text-amber-300",
  elevated: "text-amber-600 dark:text-amber-300",
  high: "text-red-600 dark:text-red-400",
};

function SubstationDetail({ ss, data }: { ss: SubstationProps; data: GridData }) {
  const select = useAppStore((s) => s.select);
  const lines = connectedLines(ss, data);
  const ga = graphAnalysis(data);
  const deg = ga.feedDegrees.get(ss.id) ?? 0;
  const singleFed = ga.singleFedIds.has(ss.id);
  // Core SS carry no commissioning date (`doc` is null in this dataset) → unknown age.
  const risk = substationRisk({ coastalBand: ss.coastalBand, ageYears: null, feedDegree: deg, voltage: ss.voltage });
  const tier = riskTier(risk.score);
  return (
    <>
      <Field label="Substation code" value={ss.ssCode} />
      <Field label="Full name" value={ss.descriptiveName} />
      <Field label="Zone" value={ss.zone} />
      <Field label="Division" value={ss.division} />
      <Field label="Circle" value={ss.circle ? `${ss.circle}${ss.circleInferred ? " (inferred)" : ""}` : null} />
      <Field label="Commissioned" value={ss.doc} />
      <Field label="Coordinates" value={`${ss.lat.toFixed(5)}, ${ss.lng.toFixed(5)}`} />
      <Field
        label="Coast"
        value={
          ss.coastalKm != null && ss.coastalBand != null
            ? `${formatKm(ss.coastalKm)} (${COASTAL_BAND_LABEL[ss.coastalBand]} band)`
            : undefined
        }
      />
      <Field
        label="Vulnerability (indicative)"
        value={
          <span title="Screening score from coastal exposure, inferred redundancy, age and voltage — not a hazard model">
            <span className={TIER_CLASS[tier]}>
              {risk.score} · {tier}
            </span>
            <span className="block text-xs font-normal text-ink-2">{risk.factors.join(" · ")}</span>
          </span>
        }
      />
      <Field
        label="Inferred feed"
        value={
          <span
            className={singleFed ? "text-amber-600 dark:text-amber-300" : undefined}
            title="Distinct neighbouring substations, geometrically inferred — indicative only"
          >
            Fed from {deg} substation{deg === 1 ? "" : "s"}
            {singleFed ? " · single-fed" : ""}
          </span>
        }
      />
      {ga.articulationIds.has(ss.id) && (
        <Field
          label="Criticality"
          value={
            <span title="Removing this SS would split the inferred network">
              Articulation point (inferred)
            </span>
          }
        />
      )}
      <SpotConditions lng={ss.lng} lat={ss.lat} />

      <SectionTitle>
        Connected lines · {lines.length}
        <span className="ml-1 font-normal normal-case text-ink-2">(spatially inferred)</span>
      </SectionTitle>
      {lines.length === 0 ? (
        <p className="px-2 py-1 text-sm text-ink-2">No lines snapped within {data.meta.snapThresholdM} m.</p>
      ) : (
        <div className="-mx-1">
          {lines.map(({ line }) => (
            <ConnectionRow
              key={line.id}
              name={line.name}
              voltage={line.voltage}
              meta={`${line.circuit} · ${formatKm(line.lengthKm)}`}
              icon={<LineIcon width={14} height={14} />}
              onClick={() => select(line.id, { fly: true })}
            />
          ))}
        </div>
      )}
    </>
  );
}

function LineDetail({ line, data }: { line: LineProps; data: GridData }) {
  const select = useAppStore((s) => s.select);
  const weather = useAppStore((s) => s.weather);
  const subs = connectedSubstations(line, data);
  const [from, to] = line.endpointLabels ?? [null, null];
  const capacity = lineCapacityFor(line);
  // Indicative DLR: derate the nominal capacity for the live ambient temperature at the nearest
  // circle centroid (silently absent until the live weather data has loaded).
  const dlr = useMemo(() => {
    const cap = lineCapacityFor(line);
    if (!cap || !weather || weather.circles.length === 0) return null;
    const g = data.linesFc.features.find((f) => f.properties?.id === line.id)?.geometry;
    const anchor =
      g?.type === "LineString" ? g.coordinates[0] : g?.type === "MultiLineString" ? g.coordinates[0]?.[0] : undefined;
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
  }, [line, data, weather]);
  const age = ageYears(line.commissioned, new Date().getFullYear());
  // N-1 screening (inferred): non-empty only when this line is a bridge in the inferred graph.
  const islanded = graphAnalysis(data).bridgeImpacts.get(line.id);
  const islandedNames = (islanded ?? []).slice(0, 5).map((id) => data.byId.get(id)?.name ?? id);
  return (
    <>
      <Field label="Voltage" value={`${line.voltage} kV`} />
      <Field label="Circuit" value={CIRCUIT_LABEL[line.circuit]} />
      <Field label="Route length" value={formatKm(line.lengthKm)} />
      <Field
        label="Circuit-km"
        value={line.ckm != null ? `${formatKm(line.ckm)}${line.circuit === "DC" ? " (2× route)" : ""}` : undefined}
      />
      <Field label="Conductor" value={line.conductor} />
      {capacity && (
        <Field
          label="Indicative capacity"
          value={
            <span title="Derived from conductor type at nominal conditions — not authoritative">
              {formatMva(capacity.totalMva)}
              <span className="ml-1 font-normal text-ink-2">
                ({line.circuit === "DC" ? `${formatMva(capacity.perCircuitMva)}/ckt` : "thermal"})
              </span>
              {dlr && (
                <span
                  className="block text-xs font-normal text-ink-2"
                  title="Nominal capacity derated for the live ambient temperature only — indicative"
                >
                  Now {formatMva(dlr.mva)} ({formatDerating(dlr.factor)} at {Math.round(dlr.tempC)} °C) · indicative
                </span>
              )}
            </span>
          }
        />
      )}
      <Field
        label="Commissioned"
        value={line.commissioned ? `${line.commissioned}${age != null ? ` · ${formatAge(age)}` : ""}` : undefined}
      />
      <Field label="Circle" value={line.circle} />
      <Field
        label="Coast"
        value={
          line.coastalKm != null && line.coastalBand != null
            ? `${formatKm(line.coastalKm)} (${COASTAL_BAND_LABEL[line.coastalBand]} band)`
            : undefined
        }
      />
      {(from || to) && <Field label="Route (from name)" value={`${from ?? "?"} → ${to ?? "?"}`} />}
      {line.externalEndpoints && line.externalEndpoints.length > 0 && (
        <Field
          label="External endpoints"
          value={line.externalEndpoints.map((e) => `${e.name} (${e.category})`).join(", ")}
        />
      )}

      {islanded && islanded.length > 0 && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-100/70 px-2.5 py-2 text-xs text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
          <WarnIcon width={14} height={14} className="mt-0.5 shrink-0" />
          <span title="Pure topology on geometrically-inferred connectivity — not a contingency study">
            Inferred N−1: outage would island {islanded.length} substation{islanded.length === 1 ? "" : "s"} —{" "}
            {islandedNames.join(", ")}
            {islanded.length > islandedNames.length ? ", …" : ""}.
          </span>
        </div>
      )}

      {(line.circuitAmbiguous || line.voltageMismatch) && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-100/70 px-2.5 py-2 text-xs text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
          <WarnIcon width={14} height={14} className="mt-0.5 shrink-0" />
          <span>
            {line.circuitAmbiguous && "Name suggests a mixed SC/DC circuit. "}
            {line.voltageMismatch && "Name voltage differs from its folder. "}
            Classified by source folder.
          </span>
        </div>
      )}

      <SectionTitle>
        Connected substations · {subs.length}
        <span className="ml-1 font-normal normal-case text-ink-2">(spatially inferred)</span>
      </SectionTitle>
      {subs.length === 0 ? (
        <p className="px-2 py-1 text-sm text-ink-2">Endpoints are external (no substation within {data.meta.snapThresholdM} m).</p>
      ) : (
        <div className="-mx-1">
          {subs.map((ss) => {
            const snap = line.fromSS?.ssId === ss.id ? line.fromSS : line.toSS;
            return (
              <ConnectionRow
                key={ss.id}
                name={ss.name}
                voltage={ss.voltage}
                meta={formatDist(snap?.distM ?? null)}
                icon={<SubstationIcon width={14} height={14} />}
                onClick={() => select(ss.id, { fly: true })}
              />
            );
          })}
        </div>
      )}

      {capacity && (
        <p className="mt-3 text-xs text-ink-2">
          Indicative thermal capacity derived from the {capacity.rating.base} conductor at nominal
          conditions (√3·kV·A).
          {dlr ? " “Now” derates only for the nearest circle’s live ambient temperature (no wind, solar or sag)." : ""}{" "}
          Not a load-flow or authoritative rating.
        </p>
      )}
    </>
  );
}

function GenerationDetail({ plant }: { plant: GenerationProps }) {
  return (
    <>
      <Field
        label="Energy source"
        value={
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full ring-1 ring-white/70" style={{ backgroundColor: ENERGY_COLOR[plant.energy] }} />
            {ENERGY_LABEL[plant.energy]}
          </span>
        }
      />
      <Field label="Interconnection" value={`${plant.voltage} kV`} />
      <Field label="Capacity" value={plant.capacityMw != null ? `${plant.capacityMw} MW` : null} />
      <Field label="Full name" value={plant.descriptiveName} />
      <Field label="Plant ID" value={plant.ssCode} />
      <Field label="Circle" value={plant.circle} />
      <Field label="Commissioned" value={plant.doc} />
      <Field label="Coordinates" value={`${plant.lat.toFixed(5)}, ${plant.lng.toFixed(5)}`} />
      <p className="mt-3 text-xs text-ink-2">
        Generation plant overlay — connectivity to the transmission grid is not modelled.
      </p>
    </>
  );
}

function PowerGridNote() {
  return (
    <p className="mt-3 text-xs text-ink-2">
      POWERGRID (PGCIL) national grid overlay — connectivity to the AP-TRANSCO grid is not modelled.
    </p>
  );
}

function PowerGridLineDetail({ line }: { line: PowerGridLineProps }) {
  return (
    <>
      <Field label="Voltage" value={`${line.voltage} kV`} />
      <Field label="Service status" value={line.service} />
      <Field label="Route length" value={formatKm(line.lengthKm)} />
      <Field label="Line" value={line.name} />
      <PowerGridNote />
    </>
  );
}

function PowerGridSubstationDetail({ ss }: { ss: PowerGridSubstationProps }) {
  return (
    <>
      <Field label="Full name" value={ss.fullName} />
      <Field label="Voltage" value={`${ss.voltage} kV`} />
      <Field label="Coordinates" value={`${ss.lat.toFixed(5)}, ${ss.lng.toFixed(5)}`} />
      <PowerGridNote />
    </>
  );
}

function RailwaySubstationDetail({ ss }: { ss: RailwaySubstationProps }) {
  return (
    <>
      <Field label="Name" value={ss.displayName ?? ss.name} />
      <Field label="Voltage" value={ss.voltage > 0 ? `${ss.voltage} kV` : null} />
      <Field label="Connected SS" value={ss.connectedSs} />
      <Field label="Capacity" value={ss.mva != null ? `${ss.mva} MVA` : null} />
      <Field label="Circle" value={ss.circle} />
      <Field label="District" value={ss.district} />
      <Field label="Coordinates" value={`${ss.lat.toFixed(5)}, ${ss.lng.toFixed(5)}`} />
      <p className="mt-3 text-xs text-ink-2">
        Railway traction substation — connection to the AP-TRANSCO grid is indicative.
      </p>
    </>
  );
}

function BulkLoadSubstationDetail({ ss }: { ss: BulkLoadSubstationProps }) {
  return (
    <>
      <Field label="Voltage" value={ss.voltage > 0 ? `${ss.voltage} kV` : null} />
      <Field label="Consumer type" value={ss.ssType} />
      <Field label="Connected SS" value={ss.connectedSs} />
      <Field label="Capacity" value={ss.mva != null ? `${ss.mva} MVA` : null} />
      <Field label="Circle" value={ss.circle} />
      <Field label="District" value={ss.district} />
      <Field label="Coordinates" value={`${ss.lat.toFixed(5)}, ${ss.lng.toFixed(5)}`} />
      <p className="mt-3 text-xs text-ink-2">
        Bulk HT consumer — connection to the AP-TRANSCO grid is indicative.
      </p>
    </>
  );
}

export function DetailPanel({ data }: { data: GridData }) {
  const selectedId = useAppStore((s) => s.selectedId);
  const history = useAppStore((s) => s.history);
  const select = useAppStore((s) => s.select);
  const back = useAppStore((s) => s.back);
  const flyTo = useAppStore((s) => s.select);
  const spotlight = useAppStore((s) => s.spotlight);
  const toggleSpotlight = useAppStore((s) => s.toggleSpotlight);
  const generation = useAppStore((s) => s.generation);
  const powergrid = useAppStore((s) => s.powergrid);
  // Overlay features (generation, PowerGrid) live in their own lazily-loaded byId maps,
  // not the transmission byId map.
  const lookup = (id: string) =>
    data.byId.get(id) ?? generation?.byId.get(id) ?? powergrid?.byId.get(id) ?? null;
  const feature = selectedId ? lookup(selectedId) : null;
  if (!feature) return null;

  const prev = history.length ? lookup(history[history.length - 1]) : null;

  return (
    <aside
      className="pointer-events-auto flex min-h-0 max-h-full w-[340px] max-w-[92vw] flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface/96 shadow-[var(--shadow-panel)] backdrop-blur"
      aria-label="Feature details"
    >
      {prev && (
        <button
          onClick={back}
          className="flex shrink-0 items-center gap-1.5 border-b border-line bg-surface-2/60 px-4 py-1.5 text-left text-xs font-medium text-ink-2 hover:text-ink"
        >
          <span aria-hidden className="text-sm leading-none">←</span>
          <span className="truncate">Back to {prev.name}</span>
        </button>
      )}
      <header className="flex shrink-0 items-start gap-2 border-b border-line px-4 py-3">
        <span className="mt-0.5 text-ink-2">
          {isSubstation(feature) ? (
            <SubstationIcon />
          ) : isGeneration(feature) ? (
            <BoltIcon />
          ) : isPowerGridSubstation(feature) || isPowerGridLine(feature) ? (
            <TowerIcon />
          ) : isRailwaySubstation(feature) || isBulkLoadSubstation(feature) ? (
            <SubstationIcon />
          ) : (
            <LineIcon />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            {isPowerGridLine(feature) || isPowerGridSubstation(feature) ? (
              <OverlayBadge voltage={feature.voltage} color={POWERGRID_COLOR} />
            ) : isRailwaySubstation(feature) ? (
              <OverlayBadge voltage={feature.voltage} color={RAILWAY_COLOR} />
            ) : isBulkLoadSubstation(feature) ? (
              <OverlayBadge voltage={feature.voltage} color={BULKLOAD_COLOR} />
            ) : (
              <VoltageBadge voltage={feature.voltage} small />
            )}
            <span className="text-[11px] uppercase tracking-wide text-ink-2">
              {isSubstation(feature)
                ? "Substation"
                : isGeneration(feature)
                  ? `${ENERGY_LABEL[feature.energy]} plant`
                  : isPowerGridSubstation(feature)
                    ? "POWERGRID substation"
                    : isPowerGridLine(feature)
                      ? "POWERGRID line"
                      : isRailwaySubstation(feature)
                        ? "Railway traction SS"
                        : isBulkLoadSubstation(feature)
                          ? "Bulk-load / HT SS"
                          : `${feature.circuit} line`}
            </span>
          </div>
          <h2 className="text-[15px] font-semibold leading-snug text-ink">{feature.name}</h2>
        </div>
        <div className="flex shrink-0 gap-1">
          {(isSubstation(feature) || isLine(feature)) && (
            <button
              onClick={toggleSpotlight}
              aria-label="Spotlight inferred connections on the map"
              aria-pressed={spotlight}
              title="Spotlight inferred connections on the map"
              className={`rounded-md p-1 ${
                spotlight ? "bg-surface-3 text-accent" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
              }`}
            >
              <SpotlightIcon width={16} height={16} />
            </button>
          )}
          {(isSubstation(feature) || isLine(feature)) && (
            <button
              onClick={() => {
                const fc = isSubstation(feature)
                  ? substationsToGeoJSON([feature])
                  : isLine(feature)
                    ? subsetFeatures(data.linesFc, new Set([feature.id]))
                    : null;
                if (fc) downloadText(`${feature.id}.geojson`, "application/geo+json", JSON.stringify(fc));
              }}
              aria-label="Download as GeoJSON"
              title="Download as GeoJSON"
              className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <DownloadIcon width={16} height={16} />
            </button>
          )}
          <button
            onClick={() => flyTo(feature.id, { fly: true })}
            aria-label="Center on map"
            className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <TargetIcon width={16} height={16} />
          </button>
          <button
            onClick={() => select(null)}
            aria-label="Close details"
            className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <CloseIcon width={16} height={16} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2">
        {isSubstation(feature) ? (
          <SubstationDetail ss={feature} data={data} />
        ) : isLine(feature) ? (
          <LineDetail line={feature} data={data} />
        ) : isGeneration(feature) ? (
          <GenerationDetail plant={feature} />
        ) : isPowerGridLine(feature) ? (
          <PowerGridLineDetail line={feature} />
        ) : isPowerGridSubstation(feature) ? (
          <PowerGridSubstationDetail ss={feature} />
        ) : isRailwaySubstation(feature) ? (
          <RailwaySubstationDetail ss={feature} />
        ) : isBulkLoadSubstation(feature) ? (
          <BulkLoadSubstationDetail ss={feature} />
        ) : null}
      </div>
    </aside>
  );
}
