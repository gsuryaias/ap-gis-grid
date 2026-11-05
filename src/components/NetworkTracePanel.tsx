import { NET_KIND_LABEL } from "../data/network-search.ts";
import { lookupNetRef } from "../data/search-client.ts";
import { fieldLabel } from "../overlays/catalog.ts";
import { useOverlayStore } from "../overlays/store.ts";
import { useAppStore } from "../state/store.ts";
import { CloseIcon } from "./icons.tsx";

const SHOW_FIELDS: Record<string, string[]> = {
  f11: ["code", "ss", "linkMethod", "section", "subdivision", "division", "circle", "lengthKm", "poles", "dtrs", "dtrKva", "abSwitches"],
  ss33: ["code", "ssType", "capacity", "section", "subdivision", "division", "circle", "mandal", "district", "feedersIn", "feedersOut", "nearestTranscoSs"],
  f33: ["code", "sourceSs", "linkMethod", "section", "division", "circle", "lengthKm", "spans", "servesSs"],
};
const LINK: Record<string, string> = {
  recorded: "recorded SS id",
  name: "recorded name match",
  proximity: "line end at the SS (inferred)",
  "feeder-group": "same feeder",
};

/**
 * Trace card for a distribution-network search pick: the asset's attributes and its inferred
 * upstream path TRANSCO SS → 33 kV feeder → 33/11 kV SS → 11 kV feeder → asset (each level clickable).
 */
export function NetworkTracePanel() {
  const item = useOverlayStore((s) => s.netFocus);
  const focusNetwork = useOverlayStore((s) => s.focusNetwork);
  const data = useOverlayStore((s) => s.data);
  const select = useAppStore((s) => s.select);
  if (!item) return null;

  const layer = item.kind === "f11" ? "discom-11kv-lines" : item.kind === "ss33" ? "discom-ss" : item.kind === "f33" ? "discom-lines" : null;
  const props = layer ? (data[layer]?.features.find((f) => f.properties?.id === item.ref)?.properties ?? null) : null;
  const rows: Array<[string, string]> = [];
  if (item.dtr) for (const [k, v] of Object.entries(item.dtr.attrs)) rows.push([k, String(v)]);
  if (props)
    for (const k of SHOW_FIELDS[item.kind] ?? []) {
      const v = props[k];
      if (v == null || v === "") continue;
      rows.push([fieldLabel(k), k === "linkMethod" ? (LINK[String(v)] ?? String(v)) : typeof v === "number" ? v.toLocaleString("en-IN") : String(v)]);
    }

  const go = (ref: string | null) => {
    if (!ref) return;
    void lookupNetRef(ref)
      .then((it) => it && focusNetwork(it))
      .catch(() => undefined);
  };
  const c = item.chain;
  const levels: Array<{ label: string; name: string | null; onClick?: () => void; here?: boolean }> = [
    { label: "TRANSCO substation", name: c?.[5] ?? null, onClick: c?.[4] ? () => select(c[4]!, { fly: true }) : undefined },
    { label: "33 kV feeder", name: c?.[3] ?? null, onClick: c?.[2] ? () => go(c[2]) : undefined, here: item.kind === "f33" },
    { label: "33/11 kV substation", name: c?.[1] ?? null, onClick: c?.[0] && item.kind !== "ss33" ? () => go(c[0]) : undefined, here: item.kind === "ss33" },
  ];
  if (item.kind === "f11" || item.kind === "dtr")
    levels.push({
      label: "11 kV feeder",
      name: item.kind === "f11" ? item.label : (item.dtr?.feederName ?? null),
      onClick: item.kind === "dtr" && item.dtr?.feederId ? () => go(item.dtr!.feederId) : undefined,
      here: item.kind === "f11",
    });
  if (item.kind === "dtr") levels.push({ label: "Transformer", name: item.label, here: true });
  const visible = item.kind === "sec" ? [] : item.kind === "f33" ? levels.slice(0, 2) : levels;

  return (
    <section className="pointer-events-auto flex max-h-full w-[340px] max-w-full flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface/95 shadow-[var(--shadow-panel)] backdrop-blur">
      <header className="flex items-start gap-2 border-b border-line px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-2">{NET_KIND_LABEL[item.kind]}</span>
          <h2 className="mt-1 break-words text-[15px] font-semibold leading-snug text-ink">{item.label}</h2>
          <p className="text-xs text-ink-2">{item.sub}</p>
        </div>
        <button type="button" onClick={() => focusNetwork(null)} aria-label="Close" className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink">
          <CloseIcon width={16} height={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-2.5">
        {rows.length > 0 && (
          <table className="mb-2 w-full text-sm">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k}>
                  <th className="py-0.5 pr-3 text-left align-top font-normal text-ink-2">{k}</th>
                  <td className="py-0.5 text-right font-medium text-ink">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {visible.length > 0 && (
          <>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Supply path (inferred)</div>
            <ol className="relative ml-1.5 border-l-2 border-line pl-3">
              {visible.map((l, i) => (
                <li key={i} className="relative pb-2 last:pb-0">
                  <span
                    className={`absolute -left-[19px] top-1 h-2.5 w-2.5 rounded-full border-2 ${l.here ? "border-amber-500 bg-amber-400" : l.name ? "border-accent bg-surface" : "border-line bg-surface"}`}
                    aria-hidden
                  />
                  <div className="text-[10.5px] uppercase tracking-wide text-ink-2">{l.label}</div>
                  {l.name ? (
                    l.onClick ? (
                      <button type="button" onClick={l.onClick} className="text-left text-sm font-medium text-accent hover:underline">
                        {l.name}
                      </button>
                    ) : (
                      <div className="text-sm font-medium text-ink">{l.name}</div>
                    )
                  ) : (
                    <div className="text-xs italic text-ink-2">not traced in the open GIS data</div>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
        <p className="mt-2.5 text-[10.5px] leading-snug text-ink-2">
          Links are inferred from the DISCOM GIS (recorded ids / names, else geometry). Coverage is partial: APEPDCL is
          complete, APSPDCL sparse, APCPDCL 11 kV not published. HT consumer services are deliberately not shown.
        </p>
      </div>
    </section>
  );
}
