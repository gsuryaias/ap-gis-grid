// Pure data-export helpers (CSV + GeoJSON) for the network lookup. The download trigger is the only
// impure function and is a no-op outside a browser, so the builders stay unit-testable.
import type { Feature, FeatureCollection } from "geojson";
import type { LineProps, SubstationProps } from "../data/types.ts";

/** RFC-4180-ish escaping: quote a cell when it contains a comma, quote, or newline; double inner quotes. */
export function csvCell(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Join a header row + data rows into a CSV string (values are escaped). */
export function toCsv(headers: string[], rows: readonly unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return lines.join("\r\n");
}

const SS_HEADERS = [
  "id", "name", "full_name", "ss_code", "voltage_kv", "circle", "zone", "division",
  "connected_lines", "longitude", "latitude",
];

export function substationsToCsv(rows: readonly SubstationProps[]): string {
  return toCsv(
    SS_HEADERS,
    rows.map((s) => [
      s.id, s.name, s.descriptiveName ?? "", s.ssCode ?? "", s.voltage, s.circle ?? "",
      s.zone ?? "", s.division ?? "", s.connectedLineCount, s.lng, s.lat,
    ]),
  );
}

const LINE_HEADERS = [
  "id", "name", "voltage_kv", "circuit", "circuit_type", "length_km", "circuit_km",
  "conductor", "commissioned", "circle", "connects_ss", "external_endpoints",
];

export function linesToCsv(rows: readonly LineProps[]): string {
  return toCsv(
    LINE_HEADERS,
    rows.map((l) => [
      l.id, l.name, l.voltage, l.circuit, l.circuitType ?? "", l.lengthKm ?? "", l.ckm ?? "",
      l.conductor ?? "", l.commissioned ?? "", l.circle ?? "",
      l.connectsSS.join(" | "),
      (l.externalEndpoints ?? []).map((e) => `${e.name} (${e.category})`).join(" | "),
    ]),
  );
}

/** Substations → a GeoJSON FeatureCollection of Points (properties carry the full record). */
export function substationsToGeoJSON(rows: readonly SubstationProps[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: rows.map(
      (s): Feature => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
        properties: { ...s },
      }),
    ),
  };
}

/** Keep only the features of a FeatureCollection whose `properties.id` is in `ids` (for line geometry). */
export function subsetFeatures(fc: FeatureCollection, ids: ReadonlySet<string>): FeatureCollection {
  return { type: "FeatureCollection", features: fc.features.filter((f) => ids.has(String(f.properties?.id))) };
}

/** Trigger a client-side file download. No-op outside a browser (so callers stay test-safe). */
export function downloadText(filename: string, mime: string, text: string): void {
  if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") return;
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has been dispatched.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
