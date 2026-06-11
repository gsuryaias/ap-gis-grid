// Pure parser for a Vidyut Pravah (vidyutpravah.in) state page snapshot.
// html in → one typed row out; no I/O. The page is a live dashboard, but its
// "YESTERDAY" figures are the stable previous-day values we keep as a daily series.
import { parse as parseHtml } from "node-html-parser";
import { gate, isoDate, addDays } from "./lib.ts";

export type VidyutDailyRow = {
  /** The day the YESTERDAY figures describe (snapshot date − 1), YYYY-MM-DD. */
  date: string;
  state: string;
  /** State's demand met yesterday (MW). */
  demand_met_mw: number | null;
  /** Shortage during yesterday's peak (MW / %). */
  peak_shortage_mw: number | null;
  peak_shortage_pct: number | null;
  /** Total energy shortage yesterday (MU / %). */
  energy_shortage_mu: number | null;
  energy_shortage_pct: number | null;
  /** Yesterday's power-exchange price (₹/kWh); null when the page shows "-". */
  exchange_price_inr_kwh: number | null;
};

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Parse a dashboard value like "11,186 MW", "10.00 ₹/Unit", "-" → number | null. */
export function parseVidyutNumber(raw: string): number | null {
  const m = raw.replace(/,/g, "").replace(/\u00a0/g, " ").match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** Parse "0 MW (0.00 %)" → { value, pct } (either may be null). */
export function parseValueWithPct(raw: string): { value: number | null; pct: number | null } {
  const cleaned = raw.replace(/,/g, "").replace(/\u00a0/g, " ");
  const pctMatch = cleaned.match(/\((-?\d+(?:\.\d+)?)\s*%\s*\)/);
  const valueMatch = cleaned.match(/(-?\d+(?:\.\d+)?)/);
  return {
    value: valueMatch ? Number(valueMatch[1]) : null,
    pct: pctMatch ? Number(pctMatch[1]) : null,
  };
}

/** Parse a Vidyut Pravah state-data page into one previous-day row. */
export function parseVidyutStateHtml(html: string): VidyutDailyRow {
  const dated = html.match(/DATED\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  gate(dated, "snapshot date ('DATED dd MON yyyy') not found on page");
  const month = MONTHS[dated[2].toLowerCase()];
  gate(month !== undefined, `unrecognised month "${dated[2]}" in snapshot date`);
  const snapshot = new Date(Date.UTC(Number(dated[3]), month, Number(dated[1])));

  const root = parseHtml(html);
  const textOf = (selector: string): string => {
    const el = root.querySelector(selector);
    gate(el, `element ${selector} not found (layout changed?)`);
    return el.text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  };

  const state = textOf(".statenames_en");
  gate(state.length > 0, "state name is empty");

  const peak = parseValueWithPct(textOf(".value_PeakDemand_en"));
  const energy = parseValueWithPct(textOf(".value_TotalEnergy_en"));

  return {
    date: isoDate(addDays(snapshot, -1)),
    state,
    demand_met_mw: parseVidyutNumber(textOf(".value_PrevDemandMET_en")),
    peak_shortage_mw: peak.value,
    peak_shortage_pct: peak.pct,
    energy_shortage_mu: energy.value,
    energy_shortage_pct: energy.pct,
    exchange_price_inr_kwh: parseVidyutNumber(textOf(".value_PrevExchangePrice_en")),
  };
}
