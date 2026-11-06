// Tap popups for the catalog overlays (DISCOM / RTGS reference) — HTML built from feature
// properties, every value escaped. Towers have their own (`towerPopupHtml` in towers.ts).
import type { MapGeoJSONFeature } from "maplibre-gl";
import { DISCOM_NAME, fieldLabel, type DiscomId, type OverlayDef } from "./catalog.ts";

const LINK_LABEL: Record<string, string> = {
  recorded: "recorded 33/11 kV SS id",
  name: "recorded source SS (name match)",
  proximity: "feeder end at the SS (≤ 1.5 km)",
  "feeder-group": "another run of the same feeder",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function formatValue(k: string, v: unknown): string | null {
  if (v == null || v === "") return null;
  if (k === "discom") return `${v} — ${DISCOM_NAME[v as DiscomId] ?? ""}`.replace(/ — $/, "");
  if (typeof v === "number") return k.toLowerCase().includes("km") || k.toLowerCase().includes("ha") ? v.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : v.toLocaleString("en-IN");
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

export function popupHtml(def: OverlayDef, f: MapGeoJSONFeature): string {
  const p = (f.properties ?? {}) as Record<string, unknown>;
  const title = (p.name as string) || (def.id.startsWith("discom") ? `Unnamed ${def.label.replace(/s$/, "")}` : def.label);
  const skip = new Set(["name", "id", "kind", "lng", "lat", "transcoSsId"]);
  // Connectivity first — it's what ties the 33 kV network to the TRANSCO grid.
  const PRIORITY = ["discom", "transcoSs", "linkMethod", "sourceSs", "feeders", "nearestTranscoSs", "servesSsCount", "servesSs"];
  const rank = (k: string) => (PRIORITY.includes(k) ? PRIORITY.indexOf(k) : PRIORITY.length);
  const rows = Object.entries(p)
    .filter(([k]) => !skip.has(k))
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([k, v]) => [k, fieldLabel(k), formatValue(k, v)] as const)
    .filter(([, , v]) => v != null)
    .slice(0, 18)
    .map(([k, label, v]) => {
      const cell =
        k === "transcoSs" && p.transcoSsId
          ? `<button type="button" class="ov-link" data-select="${esc(String(p.transcoSsId))}">${esc(v!)}</button>`
          : k === "linkMethod"
            ? esc(LINK_LABEL[String(v)] ?? v!)
            : esc(v!);
      return `<tr><th>${esc(label)}</th><td>${cell}</td></tr>`;
    })
    .join("");
  const meta = [def.source, def.vintage ? `vintage ${def.vintage}` : null].filter(Boolean).join(" · ");
  return (
    `<div class="ov-popup"><div class="ov-popup-kicker">${esc(def.group)} · ${esc(def.label)}</div>` +
    `<div class="ov-popup-title">${esc(title)}</div>` +
    (rows ? `<table>${rows}</table>` : "") +
    `<div class="ov-popup-src">${esc(meta)}</div></div>`
  );
}
