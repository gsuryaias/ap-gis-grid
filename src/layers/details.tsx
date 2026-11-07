// What sits under a switched-on layer: its legend keys and its sub-switches (energy types, POWERGRID
// classes, radar / cyclones, DISCOMs, SC / DC circuits) plus coverage notes. `compact` = the map
// legend: keys only, no switches or notes.
import { useMemo } from "react";
import { CONNECTIVITY_CSV_URL } from "../data/connectivity.ts";
import { useLiveStatus } from "../data/live-status.ts";
import { generationRes, powerGridRes } from "../data/load.ts";
import { useResource } from "../data/resources.ts";
import { ENERGY_TYPES, VOLTAGES, type EnergyType } from "../data/types.ts";
import { weatherRes } from "../data/weather.ts";
import { DISCOM_COLOR, DISCOMS } from "../overlays/catalog.ts";
import { useAppStore } from "../state/store.ts";
import {
  BULKLOAD_COLOR,
  ENERGY_COLOR,
  ENERGY_LABEL,
  POWERGRID_COLOR,
  RAILWAY_COLOR,
  VOLTAGE_COLOR,
  WX_ALERT_COLOR,
  WX_RISK_COLOR,
  WX_TRACK_COLOR,
} from "../theme/palette.ts";
import type { CatEntry } from "./catalogue.ts";
import { Key, Spinner, Switch } from "./ui.tsx";

const Note = ({ children }: { children: React.ReactNode }) => <p className="pt-0.5 text-[11px] leading-snug text-ink-2">{children}</p>;

function CoreLines({ compact }: { compact: boolean }) {
  const voltages = useAppStore((s) => s.filters.voltages);
  const circuits = useAppStore((s) => s.filters.circuits);
  const toggleCircuit = useAppStore((s) => s.toggleCircuit);
  return (
    <>
      {VOLTAGES.filter((v) => voltages[v]).map((v) => (
        <Key key={v} swatch={{ shape: "line", color: VOLTAGE_COLOR[v] }} label={`${v} kV`} />
      ))}
      {compact ? (
        <Key swatch={{ shape: "line", color: "#64748b", dash: true }} label="Double circuit" />
      ) : (
        <>
          <Key swatch={{ shape: "line", color: "#64748b" }} label="Single circuit">
            <Switch checked={circuits.SC} onChange={() => toggleCircuit("SC")} label="Toggle single-circuit" />
          </Key>
          <Key swatch={{ shape: "line", color: "#64748b", dash: true }} label="Double circuit">
            <Switch checked={circuits.DC} onChange={() => toggleCircuit("DC")} label="Toggle double-circuit" />
          </Key>
        </>
      )}
    </>
  );
}

function CoreSs() {
  const voltages = useAppStore((s) => s.filters.voltages);
  return (
    <>
      {VOLTAGES.filter((v) => voltages[v]).map((v) => (
        <Key key={v} swatch={{ shape: "point", color: VOLTAGE_COLOR[v] }} label={`${v} kV`} />
      ))}
    </>
  );
}

function Generation({ compact }: { compact: boolean }) {
  const { status, error, data } = useResource(generationRes, "");
  const genTypes = useAppStore((s) => s.filters.genTypes);
  const toggleGenType = useAppStore((s) => s.toggleGenType);
  const counts = useMemo(() => {
    const c = Object.fromEntries(ENERGY_TYPES.map((t) => [t, 0])) as Record<EnergyType, number>;
    for (const p of data?.plants ?? []) c[p.energy]++;
    return c;
  }, [data]);
  if (status === "loading") return compact ? null : <Note><Spinner /> Loading plants…</Note>;
  if (status === "error") return compact ? null : <Note>Couldn’t load plants. {error}</Note>;
  return (
    <>
      {ENERGY_TYPES.filter((t) => counts[t] > 0 && (!compact || genTypes[t])).map((t) => (
        <Key key={t} swatch={{ shape: "point", color: ENERGY_COLOR[t] }} label={ENERGY_LABEL[t]} sub={compact ? undefined : String(counts[t])}>
          {!compact && <Switch checked={genTypes[t]} onChange={() => toggleGenType(t)} label={`Toggle ${t}`} />}
        </Key>
      ))}
    </>
  );
}

function PowerGrid({ compact }: { compact: boolean }) {
  const { status, error, data } = useResource(powerGridRes, "");
  const pgClasses = useAppStore((s) => s.filters.pgClasses);
  const togglePgClass = useAppStore((s) => s.togglePgClass);
  if (status === "loading") return compact ? null : <Note><Spinner /> Loading networks…</Note>;
  if (status === "error" || !data) return compact ? null : <Note>Couldn’t load networks. {error}</Note>;
  const classes = [
    { key: "powergrid" as const, color: POWERGRID_COLOR, label: "POWERGRID (PGCIL)", count: `${data.lines.length} ln · ${data.substations.length} SS` },
    { key: "railway" as const, color: RAILWAY_COLOR, label: "Railway traction SS", count: String(data.railway.length) },
    { key: "bulkload" as const, color: BULKLOAD_COLOR, label: "Bulk-load / HT SS", count: String(data.bulkload.length) },
  ];
  return (
    <>
      {classes
        .filter((c) => !compact || pgClasses[c.key])
        .map((c) => (
          <Key key={c.key} swatch={{ shape: "point", color: c.color }} label={c.label} sub={compact ? undefined : c.count}>
            {!compact && <Switch checked={pgClasses[c.key]} onChange={() => togglePgClass(c.key)} label={`Toggle ${c.label}`} />}
          </Key>
        ))}
    </>
  );
}

function Weather({ compact }: { compact: boolean }) {
  const { status, error, data } = useResource(weatherRes, "");
  const wxLayers = useAppStore((s) => s.filters.wxLayers);
  const toggleWxLayer = useAppStore((s) => s.toggleWxLayer);
  if (status === "loading" && !data) return compact ? null : <Note><Spinner /> Fetching live weather…</Note>;
  if (!data) return compact ? null : <Note>Couldn’t load weather. {error}</Note>;
  const radarTime = data.radar ? new Date(data.radar.time * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <>
      {(!compact || wxLayers.radar) && (
        <Key swatch={{ shape: "raster", color: "#58c4f0" }} label="Rain radar" sub={radarTime ?? undefined}>
          {!compact && <Switch checked={wxLayers.radar} onChange={() => toggleWxLayer("radar")} label="Toggle rain radar" />}
        </Key>
      )}
      {(!compact || wxLayers.cyclone) && (
        <Key swatch={{ shape: "line", color: WX_TRACK_COLOR }} label="Cyclone track" sub={data.cyclones.length ? String(data.cyclones.length) : data.sourceErrors.some((e) => /cyclone|gdacs/i.test(e)) ? "feed unavailable" : "none active"}>
          {!compact && <Switch checked={wxLayers.cyclone} onChange={() => toggleWxLayer("cyclone")} label="Toggle cyclone tracks" />}
        </Key>
      )}
      {wxLayers.cyclone && data.cyclones.length > 0 && (
        <>
          <Key swatch={{ shape: "polygon", color: WX_ALERT_COLOR.Orange, fill: true }} label="Forecast cone / alert swath" />
          <Key swatch={{ shape: "point", color: WX_RISK_COLOR }} label="Substation in the warning envelope" />
        </>
      )}
      {!compact && data.sourceErrors.length > 0 && <Note>Some sources didn’t respond: {data.sourceErrors.join(" · ")}</Note>}
    </>
  );
}

function Discom({ id, compact }: { id: string; compact: boolean }) {
  const discoms = useAppStore((s) => s.layers.discoms);
  const toggleDiscom = useAppStore((s) => s.layers.toggleDiscom);
  const live = useLiveStatus();
  const stats = live?.discom ?? {};
  const geometry = id === "discom-ss" ? "point" : "line";
  return (
    <>
      {DISCOMS.map((d) => {
        const st = stats[d];
        const available = id === "discom-11kv-lines" ? d !== "APCPDCL" : !!st && (st.substations > 0 || st.lines > 0);
        if (compact && (!available || !discoms[d])) return null;
        return (
          <Key
            key={d}
            swatch={{ shape: geometry, color: DISCOM_COLOR[d], dash: id === "discom-11kv-lines" }}
            label={d}
            sub={compact ? undefined : !available ? "not published" : id === "discom-ss" && st ? `${st.substations.toLocaleString("en-IN")} SS` : id === "discom-lines" && st ? `${st.lineKm.toLocaleString("en-IN")} km` : undefined}
          >
            {!compact && available && <Switch checked={discoms[d]} onChange={() => toggleDiscom(d)} label={`Toggle ${d}`} />}
          </Key>
        );
      })}
      {!compact && id === "discom-11kv-lines" && live?.network && (
        <Note>
          APEPDCL {live.network.APEPDCL?.feeders.toLocaleString("en-IN")} feeders · {live.network.APEPDCL?.dtrs.toLocaleString("en-IN")} transformers;
          APSPDCL{" "}
          {live.network.APSPDCL?.routesFrom
            ? `${live.network.APSPDCL.feeders.toLocaleString("en-IN")} feeders · ${live.network.APSPDCL.km.toLocaleString("en-IN")} km (pole survey ${live.network.APSPDCL.routesFrom}, routes only${
                live.network.APSPDCL.routeCirclesSkipped?.length
                  ? `; ${live.network.APSPDCL.routeCirclesSkipped.map((c) => c[0].toUpperCase() + c.slice(1)).join(", ")} partial — open GIS`
                  : ""
              })`
            : "partial"}
          ; APCPDCL not published. Search a feeder name or DTR code to trace it to its TRANSCO source.
        </Note>
      )}
      {!compact && id === "discom-lines" && (
        <Note>
          As digitised in each DISCOM’s GIS — coverage is partial (e.g. APSPDCL lines).
          {Object.entries(stats)
            .filter(([, x]) => x.linesFrom)
            .map(([d, x]) => ` ${d} 33 kV lines: ${x.linesFrom}.`)
            .join("")}{" "}
          <a className="font-medium text-accent hover:underline" href={CONNECTIVITY_CSV_URL} download>
            TRANSCO → 33 kV links (CSV)
          </a>
        </Note>
      )}
    </>
  );
}

/** Has anything to show under the entry? (Overlays without sub-keys show their own swatch only.) */
export function hasDetail(id: string, compact = false): boolean {
  return ["ln", "ss", "gen", "pg", "wx", "discom-lines", "discom-ss", "discom-11kv-lines"].includes(id) || (!compact && id.startsWith("towers-"));
}

export function EntryDetail({ entry, compact = false }: { entry: CatEntry; compact?: boolean }) {
  const id = entry.id;
  if (id === "ln") return <CoreLines compact={compact} />;
  if (id === "ss") return <CoreSs />;
  if (id === "gen") return <Generation compact={compact} />;
  if (id === "pg") return <PowerGrid compact={compact} />;
  if (id === "wx") return <Weather compact={compact} />;
  if (id.startsWith("discom")) return <Discom id={id} compact={compact} />;
  if (id.startsWith("towers-"))
    return compact ? null : <Note>Larger ringed dots are cut / angle points (CP). Tap a tower for its number, type and line.</Note>;
  return null;
}
