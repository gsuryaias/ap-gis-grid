import { useEffect, useMemo, useState } from "react";
import type { Feature, FeatureCollection } from "geojson";
import { connectivity, CONNECTIVITY_CSV_URL, LINK_METHOD_LABEL, type FeederTuple } from "../data/connectivity.ts";
import { useResource } from "../data/resources.ts";
import type { SubstationProps } from "../data/types.ts";
import { downloadText, toCsv } from "../lib/export.ts";
import { DISCOM_COLOR, type DiscomId } from "../overlays/catalog.ts";
import { featureRows } from "../overlays/resources.ts";
import { useOverlayStore } from "../overlays/store.ts";

const SHOW = 10;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * "33 kV network (DISCOM)" block for a selected TRANSCO substation: the 33 kV feeders inferred to
 * originate there and the 33/11 kV substations they serve — highlighted on the map, downloadable.
 */
export function DiscomDownstream({ ss }: { ss: SubstationProps }) {
  const conn = useResource(connectivity);
  const idx = conn.data ?? null;
  const error = conn.status === "error";
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const toggle = useOverlayStore((s) => s.toggle);
  const setFocus = useOverlayStore((s) => s.setFocus);
  const fitTo = useOverlayStore((s) => s.fitTo);
  const overlayOn = useOverlayStore((s) => !!s.enabled["discom-lines"]);

  const feeders: FeederTuple[] = useMemo(() => idx?.bySs[ss.id] ?? [], [idx, ss.id]);
  const ssIds = useMemo(() => [...new Set(feeders.flatMap((f) => f[5]))], [feeders]);

  // Highlight this SS's downstream network on the map while it's selected.
  useEffect(() => {
    if (!idx) return;
    setFocus(feeders.length ? { lines: feeders.map((f) => f[0]), ss: ssIds } : null);
    return () => setFocus(null);
  }, [idx, feeders, ssIds, setFocus]);

  useResetOnChange(ss.id, setOpen, setAll);

  if (error) return <p className="px-2 py-1 text-xs text-ink-2">33 kV connectivity unavailable.</p>;
  if (!idx) return <p className="px-2 py-1 text-xs text-ink-2">Loading 33 kV connectivity…</p>;

  const km = Math.round(feeders.reduce((a, f) => a + f[3], 0));
  const byDiscom = new Map<string, number>();
  for (const f of feeders) byDiscom.set(f[2], (byDiscom.get(f[2]) ?? 0) + 1);

  const showOnMap = () => {
    if (!overlayOn) {
      toggle("discom-lines", true);
      toggle("discom-ss", true);
    }
    const pts: Array<[number, number]> = [[ss.lng, ss.lat], ...ssIds.map((id) => [idx.ss[id][2], idx.ss[id][3]] as [number, number])];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    fitTo([[Math.min(...xs) - 0.02, Math.min(...ys) - 0.02], [Math.max(...xs) + 0.02, Math.max(...ys) + 0.02]]);
  };

  const fileBase = `${slug(`${ss.voltage}kv-${ss.name}`)}-33kv`;

  const downloadCsv = () => {
    const rows: unknown[][] = [];
    for (const f of feeders) {
      const served = f[5].length ? f[5] : [null];
      for (const sid of served) {
        const s = sid ? idx.ss[sid] : null;
        rows.push([
          ss.name, ss.ssCode ?? "", ss.voltage, f[2], f[1] ?? "Unnamed 33 kV line", f[0], f[3], LINK_METHOD_LABEL[f[4]],
          s?.[0] ?? "", sid ?? "", s?.[3] ?? "", s?.[2] ?? "",
        ]);
      }
    }
    downloadText(
      `${fileBase}.csv`,
      "text/csv",
      "﻿" +
        toCsv(
          ["TRANSCO substation", "TRANSCO SS code", "TRANSCO kV", "DISCOM", "33 kV feeder", "Feeder id", "Feeder km", "Linked by", "33/11 kV substation", "33/11 kV SS id", "Latitude", "Longitude"],
          rows,
        ),
    );
  };

  const downloadGeo = async () => {
    setBusy(true);
    try {
      // Only the sidecar shards these features live in when the layers are tiled (else the GeoJSON).
      const [lineFeats, ssFeats] = await Promise.all([featureRows("discom-lines", feeders.map((f) => f[0])), featureRows("discom-ss", ssIds)]);
      const transcoPoint: Feature = {
        type: "Feature",
        geometry: { type: "Point", coordinates: [ss.lng, ss.lat] },
        properties: { id: ss.id, kind: "transco-substation", name: ss.name, voltage: ss.voltage, ssCode: ss.ssCode },
      };
      const fc: FeatureCollection = { type: "FeatureCollection", features: [transcoPoint, ...lineFeats, ...ssFeats] };
      downloadText(`${fileBase}.geojson`, "application/geo+json", JSON.stringify(fc));
    } finally {
      setBusy(false);
    }
  };

  const btn = "rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink hover:bg-surface-2 disabled:opacity-50";

  return (
    <div>
      {feeders.length === 0 ? (
        <p className="px-2 py-1 text-sm text-ink-2">
          No DISCOM 33 kV feeder is mapped out of this substation (APSPDCL’s line map is partial).
        </p>
      ) : (
        <>
          <p className="px-2 pb-1 text-sm text-ink">
            <b>{feeders.length}</b> feeder{feeders.length === 1 ? "" : "s"} · <b>{ssIds.length}</b> 33/11 kV SS · {km.toLocaleString("en-IN")} km
            <span className="ml-1 text-xs text-ink-2">
              ({[...byDiscom.entries()].map(([d, n]) => `${d} ${n}`).join(", ")})
            </span>
          </p>
          <div className="flex flex-wrap gap-1.5 px-2 pb-1.5">
            <button className={btn} onClick={showOnMap}>
              Show on map
            </button>
            <button className={btn} onClick={downloadCsv}>
              CSV
            </button>
            <button className={btn} onClick={downloadGeo} disabled={busy}>
              {busy ? "Preparing…" : "GeoJSON"}
            </button>
          </div>
          <div className="-mx-1">
            {(all ? feeders : feeders.slice(0, SHOW)).map((f) => {
              const isOpen = open === f[0];
              return (
                <div key={f[0]}>
                  <button
                    onClick={() => setOpen(isOpen ? null : f[0])}
                    aria-expanded={isOpen}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                    title={`Linked by ${LINK_METHOD_LABEL[f[4]]} — inferred`}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: DISCOM_COLOR[f[2] as DiscomId] ?? "#64748b" }} />
                    <span className="min-w-0 flex-1 truncate text-ink">{f[1] ?? "Unnamed 33 kV line"}</span>
                    <span className="shrink-0 text-xs text-ink-2">
                      {f[3]} km · {f[5].length} SS
                    </span>
                  </button>
                  {isOpen && (
                    <ul className="mb-1 ml-6 border-l border-line pl-2 text-xs">
                      {f[5].length === 0 && <li className="py-0.5 text-ink-2">No 33/11 kV SS within 300 m of this route.</li>}
                      {f[5].map((sid) => {
                        const s = idx.ss[sid];
                        return (
                          <li key={sid}>
                            <button
                              className="py-0.5 text-left text-ink hover:underline"
                              onClick={() => {
                                if (!overlayOn) {
                                  toggle("discom-lines", true);
                                  toggle("discom-ss", true);
                                }
                                fitTo([[s[2] - 0.01, s[3] - 0.01], [s[2] + 0.01, s[3] + 0.01]]);
                              }}
                            >
                              {s[0]} <span className="text-ink-2">33/11 kV</span>
                            </button>
                          </li>
                        );
                      })}
                      <li className="py-0.5 text-[10.5px] text-ink-2">Linked by {LINK_METHOD_LABEL[f[4]]}</li>
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
          {feeders.length > SHOW && (
            <button className="px-2 py-1 text-xs font-medium text-accent hover:underline" onClick={() => setAll((a) => !a)}>
              {all ? "Show fewer" : `Show all ${feeders.length} feeders`}
            </button>
          )}
        </>
      )}
      <p className="px-2 pt-1 text-[10.5px] leading-snug text-ink-2">
        Inferred from each DISCOM’s recorded source substation and route geometry — not a single-line diagram.{" "}
        <a className="font-medium text-accent hover:underline" href={CONNECTIVITY_CSV_URL} download>
          Download statewide TRANSCO → 33 kV table (CSV)
        </a>
      </p>
    </div>
  );
}

// Collapse the expanded feeder / "show all" when the selection moves to another substation.
function useResetOnChange(id: string, setOpen: (v: string | null) => void, setAll: (v: boolean) => void): void {
  const [prev, setPrev] = useState(id);
  if (prev !== id) {
    setPrev(id);
    setOpen(null);
    setAll(false);
  }
}
