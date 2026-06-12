import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parsePspXls, parsePspNumber, parseReportDate } from "./psp-parse.ts";
import {
  parseVidyutStateHtml,
  parseVidyutBlockHtml,
  parseVidyutBlockLabel,
  parseVidyutNumber,
  parseValueWithPct,
} from "./vidyut-parse.ts";
import {
  parseCeaMonthLabel,
  parseCeaNumber,
  parseCeaPowerGenerationJson,
  parseCeaRenewableJson,
  parseCeaMonthlyHtml,
  mergeCeaRows,
  normalizeCeaSource,
  buToMu,
} from "./cea-parse.ts";
import { istToday, addDays, isoDate, fiscalYear, mergedCaBundle, fetchText } from "./lib.ts";

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

  it("loads the extra CA bundle without comment lines", () => {
    const cas = mergedCaBundle();
    expect(cas?.length).toBeGreaterThan(1);
    expect(cas!.some((c) => c.includes("BEGIN CERTIFICATE"))).toBe(true);
    expect(cas!.every((c) => !c.startsWith("#"))).toBe(true);
  });

  it("fetches Vidyut Pravah without NODE_EXTRA_CA_CERTS (programmatic TLS)", async () => {
    const prev = process.env.NODE_EXTRA_CA_CERTS;
    delete process.env.NODE_EXTRA_CA_CERTS;
    try {
      const html = await fetchText("https://vidyutpravah.in/state-data/andhra-pradesh", { timeoutMs: 30_000 });
      expect(html).toContain("Andhra Pradesh");
    } finally {
      if (prev === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = prev;
    }
  }, 45_000);
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
    const { reportingDate, dataDate, rows, frequencyRows } = parsePspXls(
      fixture("09.06.26_NLDC_PSP.xls"),
    );
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

    // Section B: frequency profile (+ TimeSeries net exchange on All India)
    expect(frequencyRows).toHaveLength(1);
    const freq = frequencyRows[0];
    expect(freq.entity).toBe("All India");
    expect(freq.entity_type).toBe("all-india");
    expect(freq.fvi).toBe(0.04);
    expect(freq.pct_lt_49_7).toBe(0);
    expect(freq.pct_49_7_49_8).toBe(0);
    expect(freq.pct_49_8_49_9).toBe(2.43);
    expect(freq.pct_lt_49_9).toBe(2.43);
    expect(freq.pct_49_9_50_05).toBe(73.73);
    expect(freq.pct_gt_50_05).toBe(23.84);
    expect(freq.interchange_mw).toBeCloseTo(5.875, 2);
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

  it("parses exchange block labels", () => {
    expect(parseVidyutBlockLabel("00:15 - 00:30")).toEqual({
      block_start: "00:15",
      block_end: "00:30",
    });
  });

  it("parses the committed AP block fixture (snapshot 11 Jun 2026, block 00:15–00:30)", () => {
    const row = parseVidyutBlockHtml(fixture("vidyutpravah-ap-2026-06-11.html").toString("utf8"));
    expect(row.state).toBe("Andhra Pradesh");
    expect(row.date).toBe("2026-06-11");
    expect(row.block_start).toBe("00:15");
    expect(row.block_end).toBe("00:30");
    expect(row.demand_mw).toBe(10121);
    expect(row.exchange_price).toBeNull();
  });

  it("rejects a page without the expected markers", () => {
    expect(() => parseVidyutStateHtml("<html><body>maintenance</body></html>")).toThrow();
  });
});

describe("CEA monthly energy-mix parser", () => {
  it("parses month labels and numeric cells", () => {
    expect(parseCeaMonthLabel("Apr-2024")).toBe("2024-04-01");
    expect(parseCeaMonthLabel("Feb-25")).toBe("2025-02-01");
    expect(parseCeaNumber("1,078.07")).toBe(1078.07);
    expect(parseCeaNumber("-")).toBeNull();
    expect(normalizeCeaSource("THERMAL")).toBe("thermal");
    expect(normalizeCeaSource("small_hydel")).toBe("hydro");
    expect(buToMu(110.4)).toBe(110_400);
  });

  it("parses the committed All-India power_generation fixture (FY 2024-25)", () => {
    const raw = JSON.parse(fixture("cea-power-generation-2024-2025.json").toString("utf8"));
    const rows = parseCeaPowerGenerationJson(raw);
    expect(rows.length).toBeGreaterThanOrEqual(20);
    const feb = rows.filter((r) => r.month === "2025-02-01" && r.region_state === "All India");
    expect(feb.length).toBeGreaterThanOrEqual(4);
    const thermal = feb.find((r) => r.source === "thermal")!;
    expect(thermal.generation_mu).toBeCloseTo(110_400.15, 0);
    expect(thermal.fy).toBe("2024-2025");
    const shares = feb.reduce((s, r) => s + r.share_pct, 0);
    expect(shares).toBeCloseTo(100, 0);
  });

  it("parses the committed AP renewable_energy fixture (FY 2024-25)", () => {
    const raw = JSON.parse(fixture("cea-renewable-ap-2024-2025.json").toString("utf8"));
    const rows = parseCeaRenewableJson(raw, ["Andhra Pradesh"]);
    expect(rows.length).toBeGreaterThanOrEqual(8);
    const jul = rows.filter((r) => r.month === "2024-07-01");
    const solar = jul.find((r) => r.source === "solar")!;
    const wind = jul.find((r) => r.source === "wind")!;
    expect(solar.generation_mu).toBeCloseTo(580.95, 1);
    expect(wind.generation_mu).toBeCloseTo(1078.07, 1);
    expect(solar.share_pct + wind.share_pct).toBeLessThan(100);
  });

  it("parses the committed monthly-report HTML table fixture", () => {
    const rows = parseCeaMonthlyHtml(fixture("cea-monthly-report-table.html").toString("utf8"));
    const apJul = rows.filter((r) => r.month === "2024-07-01" && r.region_state === "Andhra Pradesh");
    expect(apJul.find((r) => r.source === "thermal")!.generation_mu).toBe(5210.4);
    expect(apJul.find((r) => r.source === "wind")!.generation_mu).toBe(1078.1);
    const ai = rows.filter((r) => r.region_state === "All India" && r.month === "2024-04-01");
    expect(ai.find((r) => r.source === "nuclear")!.generation_mu).toBe(4054.3);
  });

  it("merges JSON + HTML without duplicate keys", () => {
    const power = parseCeaPowerGenerationJson(
      JSON.parse(fixture("cea-power-generation-2024-2025.json").toString("utf8")),
    );
    const res = parseCeaRenewableJson(
      JSON.parse(fixture("cea-renewable-ap-2024-2025.json").toString("utf8")),
      ["Andhra Pradesh"],
    );
    const html = parseCeaMonthlyHtml(fixture("cea-monthly-report-table.html").toString("utf8"));
    const merged = mergeCeaRows(power, html, res);
    const apJulWind = merged.filter(
      (r) => r.month === "2024-07-01" && r.region_state === "Andhra Pradesh" && r.source === "wind",
    );
    expect(apJulWind).toHaveLength(1);
    expect(apJulWind[0]!.generation_mu).toBeCloseTo(1078.07, 0);
  });

  it("rejects HTML without the expected table marker", () => {
    expect(() => parseCeaMonthlyHtml("<html><body>maintenance</body></html>")).toThrow();
  });
});
