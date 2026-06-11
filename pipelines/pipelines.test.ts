import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parsePspXls, parsePspNumber, parseReportDate } from "./psp-parse.ts";
import { parseVidyutStateHtml, parseVidyutNumber, parseValueWithPct } from "./vidyut-parse.ts";
import { istToday, addDays, isoDate, fiscalYear } from "./lib.ts";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

describe("pipeline date helpers", () => {
  it("computes IST dates and fiscal years", () => {
    // 2026-06-10 20:00 UTC is already 2026-06-11 in IST
    expect(isoDate(istToday(new Date("2026-06-10T20:00:00Z")))).toBe("2026-06-11");
    expect(isoDate(istToday(new Date("2026-06-10T12:00:00Z")))).toBe("2026-06-10");
    expect(fiscalYear(new Date("2026-06-09T00:00:00Z"))).toBe("2026-27");
    expect(fiscalYear(new Date("2026-03-31T00:00:00Z"))).toBe("2025-26");
    expect(fiscalYear(new Date("2026-04-01T00:00:00Z"))).toBe("2026-27");
    expect(isoDate(addDays(new Date("2026-06-01T00:00:00Z"), -1))).toBe("2026-05-31");
  });
});

describe("Grid-India daily PSP parser", () => {
  it("parses report cells and dates", () => {
    expect(parsePspNumber("1,904")).toBe(1904);
    expect(parsePspNumber("0.41")).toBe(0.41);
    expect(parsePspNumber("256.26*")).toBe(256.26);
    expect(parsePspNumber("-")).toBeNull();
    expect(parsePspNumber(null)).toBeNull();
    expect(isoDate(parseReportDate("10-Jun-2026"))).toBe("2026-06-10");
    expect(isoDate(parseReportDate("9-Jun-26"))).toBe("2026-06-09");
  });

  it("parses the committed NLDC PSP fixture (09 Jun 2026)", () => {
    const { reportingDate, dataDate, rows } = parsePspXls(fixture("09.06.26_NLDC_PSP.xls"));
    expect(reportingDate).toBe("2026-06-10");
    expect(dataDate).toBe("2026-06-09");
    expect(rows.length).toBeGreaterThanOrEqual(40);
    expect(rows.every((r) => r.date === "2026-06-09")).toBe(true);

    const byEntity = new Map(rows.map((r) => [r.entity, r]));

    // Section A: All India + regions
    const allIndia = byEntity.get("All India")!;
    expect(allIndia.entity_type).toBe("all-india");
    expect(allIndia.energy_met_mu).toBe(5698);
    expect(allIndia.evening_peak_demand_mw).toBe(240683);
    expect(allIndia.max_demand_met_mw).toBe(259448);
    expect(allIndia.peak_shortage_mw).toBe(0);
    expect(allIndia.energy_shortage_mu).toBe(0.48);

    const sr = byEntity.get("SR")!;
    expect(sr.entity_type).toBe("region");
    expect(sr.energy_met_mu).toBe(1274);
    expect(sr.evening_peak_demand_mw).toBe(53468);
    expect(sr.max_demand_met_mw).toBe(59781);

    // Section C: states
    const ap = byEntity.get("Andhra Pradesh")!;
    expect(ap.entity_type).toBe("state");
    expect(ap.max_demand_met_mw).toBe(13535);
    expect(ap.peak_shortage_mw).toBe(0);
    expect(ap.energy_met_mu).toBe(265.0);
    expect(ap.energy_shortage_mu).toBe(0);
    expect(ap.evening_peak_demand_mw).toBeNull();

    expect(byEntity.get("Tamil Nadu")!.max_demand_met_mw).toBe(20095);
    expect(rows.filter((r) => r.entity_type === "region")).toHaveLength(5);
  });

  it("rejects a document that is not the PSP layout", () => {
    expect(() => parsePspXls(new TextEncoder().encode("<html>not a sheet</html>"))).toThrow();
  });
});

describe("Vidyut Pravah parser", () => {
  it("parses dashboard values", () => {
    expect(parseVidyutNumber("11,186\u00a0MW")).toBe(11186);
    expect(parseVidyutNumber("10.00")).toBe(10);
    expect(parseVidyutNumber("-")).toBeNull();
    expect(parseValueWithPct("0\u00a0MW\u00a0(0.00 %)")).toEqual({ value: 0, pct: 0 });
    expect(parseValueWithPct("123 MU (4.56 %)")).toEqual({ value: 123, pct: 4.56 });
  });

  it("parses the committed AP state-page fixture (snapshot 11 Jun 2026)", () => {
    const row = parseVidyutStateHtml(fixture("vidyutpravah-ap-2026-06-11.html").toString("utf8"));
    expect(row.state).toBe("Andhra Pradesh");
    expect(row.date).toBe("2026-06-10"); // YESTERDAY figures = snapshot date − 1
    expect(row.demand_met_mw).toBe(11186);
    expect(row.peak_shortage_mw).toBe(0);
    expect(row.peak_shortage_pct).toBe(0);
    expect(row.energy_shortage_mu).toBe(0);
    expect(row.energy_shortage_pct).toBe(0);
    expect(row.exchange_price_inr_kwh).toBe(10);
  });

  it("rejects a page without the expected markers", () => {
    expect(() => parseVidyutStateHtml("<html><body>maintenance</body></html>")).toThrow();
  });
});
