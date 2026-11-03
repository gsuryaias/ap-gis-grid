import { useEffect, useState } from "react";
import { DISCOM_COLOR, DISCOMS, formatBytes, GROUP_ORDER, TOWER_DEFS, type OverlayDef } from "../overlays/catalog.ts";
import { useOverlayStore } from "../overlays/store.ts";
import { useLiveStatus } from "../data/live-status.ts";
import { CONNECTIVITY_CSV_URL } from "../data/connectivity.ts";
import { ChevronDown } from "./icons.tsx";
import { Row, Switch } from "./layer-controls.tsx";

function Spinner() {
  return <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent" aria-label="Loading" />;
}

function Swatch({ def, color }: { def: OverlayDef; color: string }) {
  const g = def.geometry;
  if (g === "point") return <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-white/70" style={{ backgroundColor: color }} />;
  if (g === "line")
    return (
      <span
        className="h-0 w-3.5 shrink-0 border-t-2"
        style={{ borderColor: color, borderStyle: def.style.dash ? "dashed" : "solid" }}
      />
    );
  return (
    <span
      className="h-2.5 w-3.5 shrink-0 rounded-[3px] border"
      style={{ borderColor: color, backgroundColor: def.style.fillOpacity ? `${color}55` : "transparent" }}
    />
  );
}

function OverlayRow({ def, color }: { def: OverlayDef; color?: string }) {
  const on = useOverlayStore((s) => !!s.enabled[def.id]);
  const status = useOverlayStore((s) => s.status[def.id]);
  const error = useOverlayStore((s) => s.errors[def.id]);
  const toggle = useOverlayStore((s) => s.toggle);
  const meta = [def.count ? def.count.toLocaleString("en-IN") : null, formatBytes(def.bytes)].filter(Boolean).join(" · ");
  return (
    <>
      <Row>
        <span className="flex min-w-0 items-center gap-2" title={[def.source, def.vintage && `vintage ${def.vintage}`, def.note].filter(Boolean).join(" · ")}>
          <Swatch def={def} color={color ?? def.style.color} />
          <span className="truncate text-ink">{def.label}</span>
          {status === "loading" ? <Spinner /> : meta ? <span className="shrink-0 text-[11px] text-ink-2">{meta}</span> : null}
        </span>
        <Switch checked={on} onChange={() => toggle(def.id)} label={`Toggle ${def.label}`} />
      </Row>
      {status === "error" && <p className="pb-1 text-[11px] text-red-600 dark:text-red-400">Couldn’t load: {error}</p>}
    </>
  );
}

/** AP-TRANSCO transmission towers (live-synced; one lazy layer per voltage). */
export function TransmissionSection() {
  const defs = useOverlayStore((s) => s.defs);
  const anyOn = useOverlayStore((s) => TOWER_DEFS.some((d) => s.enabled[d.id]));
  const live = useLiveStatus();
  const layers = live?.towers?.layers ?? {};
  return (
    <div className="mt-2 border-t border-line pt-1.5">
      <div className="py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Transmission · towers</div>
      {TOWER_DEFS.map((d) => (
        <OverlayRow key={d.id} def={{ ...defs[d.id], count: layers[d.id]?.towers ?? defs[d.id].count }} />
      ))}
      {anyOn && (
        <p className="pb-1 text-[10px] leading-snug text-ink-2/85">
          Visible from zoom {TOWER_DEFS[1].style.minzoom} (400 kV from {TOWER_DEFS[0].style.minzoom}). Larger ringed dots are cut /
          angle points (CP). Tap a tower for its number, type, structure and line details.
        </p>
      )}
    </div>
  );
}

/** DISCOM 33 kV sub-transmission network (live-synced from the AP-TRANSCO GIS). */
export function DistributionSection() {
  const defs = useOverlayStore((s) => s.defs);
  const discoms = useOverlayStore((s) => s.discoms);
  const toggleDiscom = useOverlayStore((s) => s.toggleDiscom);
  const anyOn = useOverlayStore((s) => !!(s.enabled["discom-lines"] || s.enabled["discom-ss"]));
  const live = useLiveStatus();
  const stats = live?.discom ?? {};
  const lines = defs["discom-lines"];
  const ss = defs["discom-ss"];

  return (
    <div className="mt-2 border-t border-line pt-1.5">
      <div className="py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Distribution · 33 / 11 kV</div>
      <OverlayRow def={{ ...lines, count: Object.values(stats).reduce((a, x) => a + x.lines, 0) }} color={DISCOM_COLOR.APSPDCL} />
      <OverlayRow def={{ ...ss, count: Object.values(stats).reduce((a, x) => a + x.substations, 0) }} color={DISCOM_COLOR.APEPDCL} />
      {defs["discom-11kv-lines"] && (
        <OverlayRow
          def={{ ...defs["discom-11kv-lines"], count: live?.network ? (live.network.APEPDCL?.feeders ?? 0) + (live.network.APSPDCL?.feeders ?? 0) : 0 }}
          color={DISCOM_COLOR.APEPDCL}
        />
      )}
      {live?.network && (
        <p className="pb-1 text-[10px] leading-snug text-ink-2/85">
          11 kV (from zoom 10): APEPDCL {live.network.APEPDCL?.feeders.toLocaleString("en-IN")} feeders ·{" "}
          {live.network.APEPDCL?.dtrs.toLocaleString("en-IN")} transformers; APSPDCL{" "}
          {live.network.APSPDCL?.routesFrom
            ? `${live.network.APSPDCL.feeders.toLocaleString("en-IN")} feeders · ${live.network.APSPDCL.km.toLocaleString("en-IN")} km (pole survey ${live.network.APSPDCL.routesFrom}, routes only${
                live.network.APSPDCL.routeCirclesSkipped?.length
                  ? `; ${live.network.APSPDCL.routeCirclesSkipped.map((c) => c[0].toUpperCase() + c.slice(1)).join(", ")} partial — open GIS`
                  : ""
              })`
            : "partial"}
          ; APCPDCL not published. Search a feeder name or DTR code to trace it to its TRANSCO source.
        </p>
      )}
      {live?.connectivity && (
        <div className="mb-1 rounded-lg bg-surface-2/70 px-2 py-1.5 text-[11px] leading-snug text-ink-2">
          <span className="font-semibold text-ink">TRANSCO → 33 kV links: </span>
          {Object.entries(live.connectivity.byDiscom)
            .map(([d, c]) => `${d} ${c.substationsTracedToTransco.toLocaleString("en-IN")}/${c.substations.toLocaleString("en-IN")} SS`)
            .join(" · ")}
          . Select a TRANSCO substation to see its feeders.{" "}
          <a className="font-medium text-accent hover:underline" href={CONNECTIVITY_CSV_URL} download>
            Download CSV
          </a>
        </div>
      )}
      {anyOn && (
        <div className="ml-1 mt-0.5 border-l border-line pl-3">
          {DISCOMS.map((d) => {
            const st = stats[d];
            const available = !!st && (st.substations > 0 || st.lines > 0);
            return (
              <Row key={d}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: DISCOM_COLOR[d], opacity: available ? 1 : 0.35 }} />
                  <span className={`font-medium ${available ? "text-ink" : "text-ink-2"}`}>{d}</span>
                  <span className="truncate text-[11px] text-ink-2">
                    {available ? `${st.substations.toLocaleString("en-IN")} ss · ${st.lineKm.toLocaleString("en-IN")} km` : "not published (needs GIS login)"}
                  </span>
                </span>
                {available && <Switch checked={discoms[d]} onChange={() => toggleDiscom(d)} label={`Toggle ${d}`} />}
              </Row>
            );
          })}
          <p className="pb-1 text-[10px] leading-snug text-ink-2/85">
            As digitised in each DISCOM’s GIS — coverage is partial (e.g. APSPDCL lines). Tap a feature for details.
            {Object.entries(stats)
              .filter(([, x]) => x.linesFrom)
              .map(([d, x]) => ` ${d} 33 kV lines: ${x.linesFrom} (not refreshed by updates).`)
              .join("")}
          </p>
        </div>
      )}
    </div>
  );
}

/** RTGS reference layers — boundaries, transport, environment/ROW constraints, water, hazards. */
export function ReferenceSection() {
  const [open, setOpen] = useState(false);
  const defs = useOverlayStore((s) => s.defs);
  const catalogStatus = useOverlayStore((s) => s.catalogStatus);
  const loadCatalog = useOverlayStore((s) => s.loadCatalog);
  const enabledCount = useOverlayStore((s) => Object.entries(s.enabled).filter(([k, v]) => v && !k.startsWith("discom") && !k.startsWith("towers")).length);

  useEffect(() => {
    if (open || enabledCount > 0) loadCatalog();
  }, [open, enabledCount, loadCatalog]);

  const byGroup = GROUP_ORDER.map((g) => ({ g, items: Object.values(defs).filter((d) => d.group === g) })).filter((x) => x.items.length);

  return (
    <div className="mt-2 border-t border-line pt-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between py-1.5 text-left"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">
          Reference layers{enabledCount ? ` · ${enabledCount} on` : ""}
        </span>
        <ChevronDown width={14} height={14} className={`text-ink-2 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div>
          {catalogStatus === "loading" && (
            <p className="flex items-center gap-2 py-1 text-xs text-ink-2">
              <Spinner /> Loading catalogue…
            </p>
          )}
          {catalogStatus === "error" && <p className="py-1 text-xs text-red-600 dark:text-red-400">Couldn’t load the layer catalogue.</p>}
          {byGroup.map(({ g, items }) => (
            <div key={g} className="pt-1">
              <div className="pb-0.5 text-[10.5px] font-medium text-ink-2">{g}</div>
              {items.map((d) => (
                <OverlayRow key={d.id} def={d} />
              ))}
            </div>
          ))}
          {catalogStatus === "ready" && (
            <p className="pt-1 text-[10px] leading-snug text-ink-2/85">
              Source: RTGS (AP Real-Time Governance Society) GIS library, simplified for the web. Indicative — not survey-grade.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
